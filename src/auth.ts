import { errorResponseAs } from "./errors";
import type { Env } from "./types";
import { accountingEvent, emitAspectEvent, mintCorrelationId } from "./aspect-logging";
import { verifyGoogleIdToken } from "./google-oauth";

/**
 * Dashboard OAuth sign-on (issue #252 P2): provider-parameterized GitHub +
 * Google flows backed by app-scoped sessions minted by the IdentityAgent.
 *
 * Endpoints:
 *   GET  /auth/login           → start GitHub OAuth flow
 *   GET  /auth/callback        → GitHub redirect target, exchanges code
 *   GET  /auth/google/login    → start Google OAuth flow
 *   GET  /auth/google/callback → Google redirect target, exchanges code
 *   GET  /auth/me              → current user (session or legacy cookie)
 *   POST /auth/logout          → revoke session + clear cookies
 *
 * Session is held in the httpOnly `app_session` cookie whose value is the
 * opaque session token minted by IdentityAgent.loginComplete. Max-Age is
 * 86400 (24h sliding); the absolute cap is enforced server-side by the
 * identity core. The provider access token is NEVER stored: on callback
 * success it is exchanged, used once for the user lookup, and discarded.
 *
 * The existing X-API-Key sign-on is untouched.
 */

export const APP_SESSION_COOKIE = "app_session";

export type OAuthProvider = "github" | "google";

const GH_STATE_COOKIE = "gh_oauth_state";
const GO_STATE_COOKIE = "go_oauth_state";
/** DEPRECATED (kept one release): legacy GitHub access-token session cookie. */
const LEGACY_TOKEN_COOKIE = "gh_access_token";
const STATE_TTL_SECONDS = 600; // 10 minutes

export function buildCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, "", { maxAge: 0, secure });
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}

/** Identity backend contract (test seam). */
export interface IdentityBackend {
  loginComplete(
    provider: string,
    subject: string,
    profile: { login?: string | null; email?: string | null; name?: string | null },
  ): Promise<{
    user: { id: string; primaryEmail: string | null; createdAt: string; lastSeenAt: string };
    created: boolean;
    session: { token: string };
  }>;
  validateSession(
    token: string,
  ): Promise<{ session: unknown; user: { id: string; primaryEmail: string | null; createdAt?: string } } | null>;
  revokeSession(token: string): Promise<unknown>;
}

/**
 * Default backend: the IdentityAgent Durable Object's @callable surface via
 * a stub. The `agents` SDK import stays dynamic inside agent-stubs.ts so this
 * module's top level remains SDK-free.
 */
export function defaultIdentityBackend(env: any): IdentityBackend {
  async function id(): Promise<any> {
    const { identityStub } = (await import("./agent-stubs")) as any;
    return identityStub(env);
  }
  return {
    loginComplete: (provider, subject, profile) =>
      id().then((stub) => stub.loginComplete(provider, subject, profile)),
    validateSession: (token) => id().then((stub) => stub.validateSession(token)),
    revokeSession: (token) => id().then((stub) => stub.revokeSession(token)),
  };
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Exchange an OAuth code for a GitHub access token. */
async function exchangeCodeForToken(
  code: string,
  env: Env,
  redirectUri: string,
): Promise<string | null> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GH_CLIENT_ID,
      client_secret: env.GH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return null;
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  return tokenData.access_token ?? null;
}

/** Fetch the GitHub user for an access token. */
async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cfpay-dashboard",
    },
  });
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string | null;
  };
  return { id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null };
}

/** Validate a presented access token by calling GitHub /user. */
async function validateToken(token: string): Promise<GitHubUser | null> {
  return fetchGitHubUser(token);
}

/**
 * Resolve the legacy OAuth user from the request's legacy session cookie.
 * Behavior is unchanged from before the #252 P2 rewrite (legacy branch).
 */
export async function getOAuthUserFromRequest(
  request: Request,
): Promise<GitHubUser | null> {
  const token = getCookie(request, LEGACY_TOKEN_COOKIE);
  if (!token) return null;
  return validateToken(token);
}

function authnFailure(
  env: Env,
  provider: OAuthProvider,
  reason: string,
  correlationId: string,
): void {
  emitAspectEvent(
    accountingEvent("authn.failure", {
      tenantId: "unknown",
      userId: "unknown",
      correlationId,
      agent: "identity",
      detail: { provider, reason },
    }),
    env,
  );
}

function authnSuccessEvents(
  env: Env,
  provider: OAuthProvider,
  tenantId: string,
  userId: string,
  created: boolean,
): void {
  const correlationId = mintCorrelationId();
  emitAspectEvent(
    accountingEvent("authn.success", {
      tenantId,
      userId,
      correlationId,
      agent: "identity",
      detail: { provider, created },
    }),
    env,
  );
  emitAspectEvent(
    accountingEvent("session.mint", {
      tenantId,
      userId,
      correlationId,
      agent: "identity",
      detail: { provider },
    }),
    env,
  );
}

/** GET /auth/login — start the GitHub OAuth flow. */
export function handleAuthLogin(request: Request, env: Env): Response {
  if (!env.GH_CLIENT_ID) {
    return new Response("GitHub OAuth not configured", { status: 503, headers: noStoreHeaders() });
  }
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/auth/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);

  const secure = isSecure(request);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": buildCookie(GH_STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, secure }),
      ...noStoreHeaders(),
    },
  });
}

/**
 * GET /auth/callback — GitHub redirect target.
 *
 * Exchanges the code, fetches the GitHub user, mints an app session via the
 * identity backend, sets the app_session cookie, DISCARDS the GitHub access
 * token (it is never stored), and 302s to "/".
 */
export async function handleAuthCallback(
  request: Request,
  env: Env,
  backend?: IdentityBackend,
): Promise<Response> {
  const secure = isSecure(request);
  const url = new URL(request.url);
  const headers = new Headers(noStoreHeaders());
  // Always clear the state cookie.
  headers.append("Set-Cookie", clearCookie(GH_STATE_COOKIE, secure));
  const correlationId = mintCorrelationId();

  const error = url.searchParams.get("error");
  if (error) {
    authnFailure(env, "github", "provider_error", correlationId);
    return new Response(`OAuth error: ${error}`, { status: 400, headers });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, GH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    authnFailure(env, "github", "invalid_state", correlationId);
    return new Response("Invalid OAuth state", { status: 400, headers });
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const token = await exchangeCodeForToken(code, env, redirectUri);
  if (!token) {
    authnFailure(env, "github", "exchange_failed", correlationId);
    return new Response("OAuth token exchange failed", { status: 502, headers });
  }
  const user = await fetchGitHubUser(token);
  if (!user) {
    authnFailure(env, "github", "user_lookup_failed", correlationId);
    return new Response("OAuth user lookup failed", { status: 502, headers });
  }

  // Mint the app session; the GitHub access token is discarded here (not stored).
  const id = backend ?? defaultIdentityBackend(env);
  const result = await id.loginComplete("github", String(user.id), {
    login: user.login,
    email: null,
    name: user.name,
  });
  const tenantId = result.user.id;
  authnSuccessEvents(env, "github", tenantId, tenantId, result.created);

  headers.append(
    "Set-Cookie",
    buildCookie(APP_SESSION_COOKIE, result.session.token, { maxAge: 86400, secure }),
  );
  headers.set("Location", "/");
  return new Response(null, { status: 302, headers });
}

/** GET /auth/google/login — start the Google OAuth flow. */
export function handleGoogleAuthLogin(request: Request, env: Env): Response {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response("Google OAuth not configured", { status: 503, headers: noStoreHeaders() });
  }
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/auth/google/callback`;
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);

  const secure = isSecure(request);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": buildCookie(GO_STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, secure }),
      ...noStoreHeaders(),
    },
  });
}

/**
 * GET /auth/google/callback — Google redirect target.
 *
 * Exchanges the code for tokens, verifies the id_token, mints an app session
 * via the identity backend, sets the app_session cookie, and 302s to "/".
 */
export async function handleGoogleAuthCallback(
  request: Request,
  env: Env,
  backend?: IdentityBackend,
): Promise<Response> {
  const secure = isSecure(request);
  const url = new URL(request.url);
  const headers = new Headers(noStoreHeaders());
  headers.append("Set-Cookie", clearCookie(GO_STATE_COOKIE, secure));
  const correlationId = mintCorrelationId();

  if (!env.GOOGLE_CLIENT_ID) {
    authnFailure(env, "google", "not_configured", correlationId);
    return new Response("Google OAuth not configured", { status: 503, headers });
  }

  const error = url.searchParams.get("error");
  if (error) {
    authnFailure(env, "google", "provider_error", correlationId);
    return new Response(`OAuth error: ${error}`, { status: 400, headers });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, GO_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    authnFailure(env, "google", "invalid_state", correlationId);
    return new Response("Invalid OAuth state", { status: 400, headers });
  }

  const redirectUri = `${url.origin}/auth/google/callback`;
  let tokenData: { id_token?: string };
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`);
    tokenData = (await tokenRes.json()) as { id_token?: string };
  } catch {
    authnFailure(env, "google", "exchange_failed", correlationId);
    return new Response("OAuth token exchange failed", { status: 502, headers });
  }

  let claims;
  try {
    if (!tokenData.id_token) throw new Error("No id_token in token response");
    claims = await verifyGoogleIdToken(tokenData.id_token, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    authnFailure(env, "google", "user_lookup_failed", correlationId);
    return new Response("OAuth user lookup failed", { status: 502, headers });
  }

  const id = backend ?? defaultIdentityBackend(env);
  const result = await id.loginComplete("google", claims.sub, {
    login: claims.email ? claims.email.split("@")[0] : null,
    email: claims.email ?? null,
    name: claims.name ?? null,
  });
  const tenantId = result.user.id;
  authnSuccessEvents(env, "google", tenantId, tenantId, result.created);

  headers.append(
    "Set-Cookie",
    buildCookie(APP_SESSION_COOKIE, result.session.token, { maxAge: 86400, secure }),
  );
  headers.set("Location", "/");
  return new Response(null, { status: 302, headers });
}

/** Best-effort provider list for a user; falls back to ["github"]. */
async function resolveProviders(
  backend: IdentityBackend,
  userId: string,
): Promise<string[]> {
  try {
    const getIdentities = (backend as { getUserIdentities?: (userId: string) => Promise<Array<{ provider: string }>> })
      .getUserIdentities;
    if (typeof getIdentities === "function") {
      const identities = await getIdentities.call(backend, userId);
      const providers = [...new Set(identities.map((i) => i.provider))];
      if (providers.length > 0) return providers;
    }
  } catch {
    /* fall through to default */
  }
  return ["github"];
}

/**
 * GET /auth/me — current user or 401.
 *
 * New branch: the app_session cookie → 200 with the user record
 * { id, tenantId: id, providers, primaryEmail, createdAt } (tenant = user 1:1).
 *
 * DEPRECATED branch (kept one release): the legacy gh_access_token cookie →
 * the old GitHubUser shape, unchanged.
 */
export async function handleAuthMe(
  request: Request,
  env: Env,
  backend?: IdentityBackend,
): Promise<Response> {
  const secure = isSecure(request);

  const sessionToken = getCookie(request, APP_SESSION_COOKIE);
  if (sessionToken) {
    const id = backend ?? defaultIdentityBackend(env);
    try {
      const validated = await id.validateSession(sessionToken);
      if (validated) {
        const user = validated.user;
        const providers = await resolveProviders(id, user.id);
        return new Response(
          JSON.stringify({
            id: user.id,
            tenantId: user.id,
            providers,
            primaryEmail: user.primaryEmail ?? null,
            createdAt: (user as { createdAt?: string }).createdAt ?? null,
          }),
          { headers: { "Content-Type": "application/json", ...noStoreHeaders() } },
        );
      }
    } catch {
      /* invalid session → fall through to 401 */
    }
    const headers = new Headers(noStoreHeaders());
    headers.append("Set-Cookie", clearCookie(APP_SESSION_COOKIE, secure));
    return errorResponseAs("UNAUTHORIZED", "Unauthorized", {
      "Content-Type": "application/json",
      ...Object.fromEntries(headers),
    });
  }

  // DEPRECATED legacy branch: gh_access_token cookie → old GitHubUser shape.
  const user = await getOAuthUserFromRequest(request);
  if (!user) {
    const headers: Record<string, string> = { ...noStoreHeaders() };
    if (getCookie(request, LEGACY_TOKEN_COOKIE)) {
      headers["Set-Cookie"] = clearCookie(LEGACY_TOKEN_COOKIE, secure);
    }
    return errorResponseAs("UNAUTHORIZED", "Unauthorized", { "Content-Type": "application/json", ...headers });
  }
  return new Response(JSON.stringify(user), {
    headers: { "Content-Type": "application/json", ...noStoreHeaders() },
  });
}

/** POST /auth/logout — revoke the app session and clear cookies. */
export async function handleAuthLogout(
  request: Request,
  env: Env,
  backend?: IdentityBackend,
): Promise<Response> {
  const secure = isSecure(request);
  const token = getCookie(request, APP_SESSION_COOKIE);
  if (token) {
    const id = backend ?? defaultIdentityBackend(env);
    try {
      await id.revokeSession(token);
      emitAspectEvent(
        accountingEvent("session.revoke", {
          tenantId: "unknown",
          userId: "unknown",
          correlationId: mintCorrelationId(),
          agent: "identity",
          detail: { provider: "unknown" },
        }),
        env,
      );
    } catch {
      /* revoke is best-effort; cookie clearing still happens */
    }
  }
  const headers = new Headers(noStoreHeaders());
  headers.append("Set-Cookie", clearCookie(APP_SESSION_COOKIE, secure));
  headers.append("Set-Cookie", clearCookie(GH_STATE_COOKIE, secure));
  headers.append("Set-Cookie", clearCookie(GO_STATE_COOKIE, secure));
  // DEPRECATED: clear the legacy cookie too.
  headers.append("Set-Cookie", clearCookie(LEGACY_TOKEN_COOKIE, secure));
  return new Response(null, { status: 204, headers });
}

/**
 * New session branch for requireAuth (wired into api.ts by a sibling lane).
 * Resolves the app_session cookie to the session user; null when missing/invalid.
 */
export async function getSessionUserFromRequest(
  request: Request,
  env: Env,
  backend?: IdentityBackend,
): Promise<{
  userId: string;
  tenantId: string;
  kind: "session";
  login?: string | null;
  providers: string[];
  primaryEmail: string | null;
} | null> {
  const token = getCookie(request, APP_SESSION_COOKIE);
  if (!token) return null;
  const id = backend ?? defaultIdentityBackend(env);
  try {
    const validated = await id.validateSession(token);
    if (!validated) return null;
    const user = validated.user;
    const providers = await resolveProviders(id, user.id);
    return {
      userId: user.id,
      tenantId: user.id, // tenant = user 1:1 (issue #252 §8)
      kind: "session",
      providers,
      primaryEmail: user.primaryEmail ?? null,
    };
  } catch {
    return null;
  }
}
