import { errorResponseAs } from "./errors";
import type { Env } from "./types";

/**
 * GitHub OAuth sign-on for the dashboard.
 *
 * Additive auth capability: the existing X-API-Key sign-on is untouched.
 * This module provides:
 *   GET  /auth/login    → start GitHub OAuth flow
 *   GET  /auth/callback → GitHub redirect target, exchanges code for token
 *   GET  /auth/me       → current OAuth user (or 401)
 *   POST /auth/logout   → clear session cookies
 *
 * Session is held in httpOnly cookies (no tokens in localStorage).
 * Follows the pattern from cloudflare/agents examples/auth-agent.
 */

const STATE_COOKIE = "gh_oauth_state";
const TOKEN_COOKIE = "gh_access_token";
const STATE_TTL_SECONDS = 600; // 10 minutes

function buildCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, "", { maxAge: 0, secure });
}

function getCookie(request: Request, name: string): string | null {
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
 * Resolve the OAuth user from the request's session cookie.
 * Returns null when there is no session or the token is invalid.
 */
export async function getOAuthUserFromRequest(
  request: Request,
): Promise<GitHubUser | null> {
  const token = getCookie(request, TOKEN_COOKIE);
  if (!token) return null;
  return validateToken(token);
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
      "Set-Cookie": buildCookie(STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, secure }),
      ...noStoreHeaders(),
    },
  });
}

/** GET /auth/callback — GitHub redirect target. */
export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const secure = isSecure(request);
  const url = new URL(request.url);
  const headers = new Headers(noStoreHeaders());
  // Always clear the state cookie.
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE, secure));

  const error = url.searchParams.get("error");
  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400, headers });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state", { status: 400, headers });
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const token = await exchangeCodeForToken(code, env, redirectUri);
  if (!token) {
    return new Response("OAuth token exchange failed", { status: 502, headers });
  }
  const user = await fetchGitHubUser(token);
  if (!user) {
    return new Response("OAuth user lookup failed", { status: 502, headers });
  }

  // NOTE: same simplification as the auth-agent example — the GitHub access
  // token is stored directly in the httpOnly session cookie. For a production
  // deployment, exchange it for an app-scoped session token instead.
  headers.append(
    "Set-Cookie",
    buildCookie(TOKEN_COOKIE, token, { secure }), // session cookie (no Max-Age)
  );
  headers.set("Location", "/");
  return new Response(null, { status: 302, headers });
}

/** GET /auth/me — current OAuth user or 401. */
export async function handleAuthMe(request: Request): Promise<Response> {
  const user = await getOAuthUserFromRequest(request);
  const secure = isSecure(request);
  if (!user) {
    const headers: Record<string, string> = { ...noStoreHeaders() };
    // Clear a stale token cookie.
    if (getCookie(request, TOKEN_COOKIE)) {
      headers["Set-Cookie"] = clearCookie(TOKEN_COOKIE, secure);
    }
    return errorResponseAs("UNAUTHORIZED", "Unauthorized", { "Content-Type": "application/json", ...headers });
  }
  return new Response(JSON.stringify(user), {
    headers: { "Content-Type": "application/json", ...noStoreHeaders() },
  });
}

/** POST /auth/logout — clear session cookies. */
export function handleAuthLogout(request: Request): Response {
  const secure = isSecure(request);
  // Multiple Set-Cookie headers: join via array is not supported in plain
  // object; use Headers.
  const headers = new Headers(noStoreHeaders());
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE, secure));
  headers.append("Set-Cookie", clearCookie(TOKEN_COOKIE, secure));
  return new Response(null, { status: 204, headers });
}
