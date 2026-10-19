import type { Env } from "./types";
import { allowsDiscovery, resourceMetadataUrl } from "./mcp-oauth";
import { isAcceptedAccessToken } from "./mcp-oauth-server";
import { looksLikeJwt, requiredScopesForCall, verifyToken, WRITE_TOOLS } from "./mcp-jwt";
import { errorBody, errorBodyAs } from "./errors";
import { timingSafeEqual } from "./crypto-hmac";

/**
 * Authorisation for the /mcp endpoint.
 *
 * Which credential types are accepted is chosen by MCP_AUTH_MODE:
 *
 *   "either" (default) — a static bearer token, a valid GitHub token, a
 *     valid Google token, or an OAuth access token issued by this server's
 *     own authorization server
 *   "static"           — only the static bearer token
 *   "github"           — only a valid GitHub token
 *   "google"           — only a valid Google token (verified against Google's
 *                        tokeninfo endpoint; no shape pre-check — Google
 *                        access tokens are opaque, so the GitHub regex
 *                        cannot apply). Requires GOOGLE_CLIENT_ID to be set:
 *                        tokens must be issued to our client (aud match),
 *                        and without it the mode fails closed like the
 *                        other credential paths.
 *   "jwt"              — only a scoped JWT (issue #214), signed with
 *                        MCP_JWT_SECRET and enforced per method
 *   "none"             — no authorisation; the endpoint is public
 *
 * "none" must be requested explicitly. An unset mode defaults to "either" and
 * still refuses everything when no credential is configured, so the endpoint is
 * never opened by omission — only by saying so.
 *
 * Credentials:
 *   MCP_AUTH_TOKEN  — a shared secret, compared in constant time. Identifies
 *                     nobody; anyone holding it has the same access.
 *   MCP_GITHUB_ORG  — optional organisation. When set, a GitHub token must belong
 *                     to it. Gives per-user identity and central revocation.
 *
 * Slack is a separate case and cannot use either path: Slack signs with
 * X-Slack-Signature and never attaches an Authorization header (see src/slack-verify.ts).
 *
 * Only the Authorization header is read. Query parameters are rejected on
 * purpose, because the Worker has observability enabled and would log them.
 */

export type McpAuthMode = "either" | "static" | "github" | "google" | "jwt" | "none";

/** How long a validated GitHub token is trusted before re-checking. */
const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the cache so a flood of bogus tokens cannot grow it without limit. */
const GITHUB_CACHE_MAX = 200;

/** Hash of a validated credential -> expiry timestamp (ms). Per isolate. */
const githubTokenCache = new Map<string, number>();

/** How long a validated Google token is trusted before re-checking. */
const GOOGLE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the cache so a flood of bogus tokens cannot grow it without limit. */
const GOOGLE_CACHE_MAX = 200;

/** Same cache shape as the GitHub one, keyed by the Google token's hash. */
const googleTokenCache = new Map<string, number>();

/**
 * Constant-time comparison, so a wrong secret cannot be recovered by measuring
 * how long the check takes. Delegates to the single-owner byte comparison
 * (issue #269, remainder): UTF-8 encoding is injective, so outcomes are
 * identical for all inputs; the bearer tokens compared here are ASCII.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

/**
 * Resolve MCP_AUTH_MODE. Returns null when the value is unrecognised, so an
 * operator typo fails closed rather than silently picking a mode.
 */
export function resolveMcpAuthMode(raw: string | undefined): McpAuthMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "either";
  if (value === "either" || value === "static" || value === "github" || value === "google" || value === "jwt" || value === "none") {
    return value;
  }
  return null;
}

/** Cheap shape check, so random strings are not sent to GitHub at all. */
function looksLikeGitHubToken(value: string): boolean {
  return /^(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheGet(key: string): boolean {
  const expiry = githubTokenCache.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    githubTokenCache.delete(key);
    return false;
  }
  return true;
}

function cacheSet(key: string): void {
  if (githubTokenCache.size >= GITHUB_CACHE_MAX) {
    const oldest = githubTokenCache.keys().next();
    if (!oldest.done) githubTokenCache.delete(oldest.value);
  }
  githubTokenCache.set(key, Date.now() + GITHUB_CACHE_TTL_MS);
}

function googleCacheGet(key: string): boolean {
  const expiry = googleTokenCache.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    googleTokenCache.delete(key);
    return false;
  }
  return true;
}

function googleCacheSet(key: string): void {
  if (googleTokenCache.size >= GOOGLE_CACHE_MAX) {
    const oldest = googleTokenCache.keys().next();
    if (!oldest.done) googleTokenCache.delete(oldest.value);
  }
  googleTokenCache.set(key, Date.now() + GOOGLE_CACHE_TTL_MS);
}

/** Build the outbound request headers for a GitHub API call. */
function githubHeaders(credential: string): Headers {
  const headers = new Headers();
  headers.set("User-Agent", "cfmail-agent-mcp");
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("Authorization", "Bearer " + credential);
  return headers;
}

/**
 * Validate a GitHub credential, optionally requiring membership of an
 * organisation. Returns false on any failure, including GitHub being
 * unreachable — an authorisation check must not fail open because a dependency
 * is down.
 */
async function verifyGitHubToken(credential: string, requiredOrg?: string): Promise<boolean> {
  const cacheKey = await sha256Hex(credential + "|" + (requiredOrg ?? ""));
  if (cacheGet(cacheKey)) return true;

  const headers = githubHeaders(credential);

  try {
    const userRes = await fetch("https://api.github.com/user", { headers });
    if (!userRes.ok) return false;

    if (requiredOrg) {
      const orgRes = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(requiredOrg)}`,
        { headers },
      );
      if (!orgRes.ok) return false;
      const membership = (await orgRes.json()) as { state?: string };
      if (membership.state !== "active") return false;
    }
  } catch (error) {
    console.error("GitHub credential verification failed:", error);
    return false;
  }

  cacheSet(cacheKey);
  return true;
}

/**
 * Validate a Google access token against Google's tokeninfo endpoint.
 *
 * There is no shape pre-check: Google access tokens are opaque (no
 * "ya29."-style prefix can be relied on for all Google-issued tokens), so
 * the GitHub regex approach cannot apply. The only authority on whether a
 * presented credential is a live Google token is Google itself.
 *
 * Returns false on any failure, including Google being unreachable — an
 * authorisation check must not fail open because a dependency is down.
 * When MCP_GOOGLE_HOSTED_DOMAIN is set, the token's hd claim must equal it
 * (Workspace tenancy); consumer tokens carry no hd claim, so they fail
 * closed under that restriction.
 */
async function verifyGoogleToken(credential: string, env: Env): Promise<boolean> {
  const hostedDomain = (
    (env as unknown as Record<string, string | undefined>).MCP_GOOGLE_HOSTED_DOMAIN ?? ""
  ).trim();
  const cacheKey = await sha256Hex("google|" + credential + "|" + hostedDomain);
  if (googleCacheGet(cacheKey)) return true;

  try {
    const res = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(credential),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return false;
    const info = (await res.json()) as { aud?: unknown; hd?: unknown; expires_in?: unknown };
    // An aud claim identifies which client the token was issued to; a
    // tokeninfo response without one is not a usable identity. When
    // GOOGLE_CLIENT_ID is configured, the token must have been issued to
    // OUR client — a token minted for someone else's app is not our user.
    if (typeof info.aud !== "string" || info.aud === "") return false;
    const expectedClientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
    if (expectedClientId && info.aud !== expectedClientId) return false;
    if (hostedDomain && info.hd !== hostedDomain) return false;
  } catch (error) {
    console.error("Google credential verification failed:", error);
    return false;
  }

  googleCacheSet(cacheKey);
  return true;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** JSON-RPC methods that only establish a session and expose no data. */
const HANDSHAKE_METHODS = new Set(["initialize", "notifications/initialized", "ping"]);

/**
 * True when this request is only the MCP handshake, so it may be answered
 * without a credential.
 *
 * The body is read through request.clone() so the original stream stays intact
 * for the MCP handler. Non-POST requests, including the GET SSE stream, are not
 * treated as a handshake.
 */
async function isHandshakeOnly(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return false;

  try {
    const body = (await request.clone().json()) as { method?: unknown };
    const method = typeof body?.method === "string" ? body.method : "";
    return HANDSHAKE_METHODS.has(method);
  } catch {
    return false;
  }
}

/** Whether an unauthenticated handshake is answered rather than refused. */
function allowsAnonymousHandshake(env: Env): boolean {
  // Opt-out only: anything other than an explicit "false" keeps the default.
  return (env.MCP_ANON_INITIALIZE ?? "").trim().toLowerCase() !== "false";
}

/** Which credential paths the resolved mode permits. */
function permittedPaths(mode: McpAuthMode): { static: boolean; github: boolean; jwt: boolean; google: boolean } {
  switch (mode) {
    case "static":
      return { static: true, github: false, jwt: false, google: false };
    case "github":
      return { static: false, github: true, jwt: false, google: false };
    case "google":
      return { static: false, github: false, jwt: false, google: true };
    case "jwt":
      return { static: false, github: false, jwt: true, google: false };
    case "either":
      return { static: true, github: true, jwt: true, google: true };
    default:
      return { static: false, github: false, jwt: false, google: false };
  }
}

/**
 * The JSON-RPC method (and tool name, for tools/call) of a request,
 * read through a clone so the MCP handler still gets the body.
 */
async function peekRpcCall(request: Request): Promise<{ method: string; toolName?: string }> {
  if (request.method !== "POST") return { method: "" };
  try {
    const body = (await request.clone().json()) as { method?: unknown; params?: { name?: unknown } };
    return {
      method: typeof body?.method === "string" ? body.method : "",
      toolName: typeof body?.params?.name === "string" ? body.params.name : undefined,
    };
  } catch {
    return { method: "" };
  }
}

/**
 * Authorise an /mcp request. Returns the response to send instead, or null to
 * continue.
 */
export async function authorizeMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const mode = resolveMcpAuthMode(env.MCP_AUTH_MODE);

  // A typo must not silently downgrade to a weaker mode.
  if (mode === null) {
    console.error(
      'MCP_AUTH_MODE is not one of "either", "static", "github", "google", "jwt" or "none"; refusing /mcp.',
    );
    return jsonResponse(errorBodyAs("FEATURE_NOT_CONFIGURED", "MCP authorisation is misconfigured."), 503);
  }

  // Explicit opt-out, and deliberately loud: this serves the tool surface openly.
  if (mode === "none") {
    // Defense in depth since issue #173 gave the endpoint WRITE
    // tools (send / post / process / create / delete): "none" may
    // serve reads and actions openly if the operator insists, but
    // a write-class tool call always needs a credential - and in
    // "none" mode there is nothing to check one against, so it is
    // refused. A configuration slip can therefore never expose the
    // mutating surface to the open internet.
    const { method, toolName } = await peekRpcCall(request);
    if (method === "tools/call" && toolName && WRITE_TOOLS.has(toolName)) {
      console.warn(`MCP_AUTH_MODE=none: refused unauthenticated write tool call (${toolName}).`);
      return jsonResponse(
        errorBodyAs("UNAUTHORIZED", "Write tools require authentication; MCP_AUTH_MODE=none serves read and action tools only."),
        401,
      );
    }
    console.warn("MCP_AUTH_MODE=none: /mcp is serving WITHOUT authentication.");
    return null;
  }

  const staticSecret = (env.MCP_AUTH_TOKEN ?? "").trim();
  const requiredOrg = (env.MCP_GITHUB_ORG ?? "").trim();
  const jwtSecret = (env.MCP_JWT_SECRET ?? "").trim();
  // The google path is gated on GOOGLE_CLIENT_ID, mirroring the GitHub
  // path's MCP_GITHUB_ORG gate: with no client id configured there is
  // nothing to bind tokens against, so the mode must fail closed (503),
  // not silently accept any live Google token. Unreachable Google fails
  // closed in verifyGoogleToken instead.
  const googleClientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const paths = permittedPaths(mode);

  // Fail closed when the selected mode has nothing to authenticate against.
  const staticReady = paths.static && Boolean(staticSecret);
  const githubReady = paths.github && Boolean(requiredOrg);
  const jwtReady = paths.jwt && Boolean(jwtSecret);
  const googleReady = paths.google && Boolean(googleClientId);

  if (!staticReady && !githubReady && !jwtReady && !googleReady) {
    console.error(
      `MCP authorisation is enabled (mode=${mode}) but no usable credential is configured; refusing /mcp.`,
    );
    return jsonResponse(errorBodyAs("FEATURE_NOT_CONFIGURED", "MCP is not configured."), 503);
  }

  const header = request.headers.get("Authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (presented) {
    // 1) Static secret, when permitted.
    if (paths.static && staticSecret && timingSafeStringEqual(presented, staticSecret)) {
      return null;
    }

    // 2) OAuth access token issued by our own authorization server. Only in
    //    "either" mode: "static" and "github" are documented as exclusive, so
    //    an OAuth token must not satisfy them.
    if (mode === "either" && (await isAcceptedAccessToken(presented, env))) {
      return null;
    }

    // 3) GitHub credential, when permitted. Shape-checked first so stray strings
    //    never cost an outbound API call.
    if (paths.github && looksLikeGitHubToken(presented)) {
      if (await verifyGitHubToken(presented, requiredOrg || undefined)) {
        return null;
      }
    }

    // 4) Scoped JWT (issue #214), when permitted and configured. A valid
    //    token is then held to its scopes for this exact call: listing
    //    needs mcp:tools:list, a tool call needs mcp:tools:call (the
    //    mcp:read OAuth scope satisfies both while tools are
    //    read-only), write tools need mcp:tools:write.
    if (paths.jwt && jwtSecret && looksLikeJwt(presented)) {
      try {
        const verified = await verifyToken(jwtSecret, presented, {
          issuer: (env.MCP_JWT_ISSUER ?? "").trim() || undefined,
          audience: (env.MCP_JWT_AUDIENCE ?? "").trim() || undefined,
        });
        const { method, toolName } = await peekRpcCall(request);
        const required = requiredScopesForCall(method, toolName);
        if (required && !verified.hasAnyScope(...required)) {
          return jsonResponse(
            { ...errorBody("INSUFFICIENT_SCOPE"), required },
            403,
          );
        }
        return null;
      } catch {
        // Not a valid JWT - fall through to the refusal below.
      }
    }

    // 5) Google credential, when permitted. Verified live against Google's
    //    tokeninfo endpoint; optionally restricted to a hosted domain via
    //    MCP_GOOGLE_HOSTED_DOMAIN.
    if (paths.google && presented) {
      if (await verifyGoogleToken(presented, env)) return null;
    }
  }

  // Answer the handshake so clients do not classify this as an OAuth resource.
  // Nothing beyond initialize/initialized/ping is served without a credential,
  // and no WWW-Authenticate header is sent, for the same reason.
  if (allowsAnonymousHandshake(env) && (await isHandshakeOnly(request))) {
    return null;
  }

  // Advertise the discovery document only when it is actually published, so a
  // client never follows a pointer to a 404 - which is how the original OAuth
  // misclassification happened.
  const challenge: Record<string, string> = allowsDiscovery(env)
    ? {
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl(request, env)}"`,
      }
    : {};

  return jsonResponse(errorBodyAs("UNAUTHORIZED", "Unauthorized"), 401, challenge);
}

/* ------------------------- P3 MCP identity ------------------------- */

export interface McpIdentity {
  /** Which credential produced this identity. */
  source: "static" | "oauth" | "github" | "jwt" | "google" | "anonymous";
  tenantId: string;
  userId: string;
  /** JWT id, when source is "jwt" (the FGA subject for token checks). */
  jti?: string;
  /** JWT subject, when source is "jwt". */
  sub?: string;
}

/**
 * Resolve the calling identity for an authorised /mcp request (issue
 * #252 P3, design §4). Mirrors authorizeMcpRequest's credential order, so
 * the two can never disagree about which credential authorised the call —
 * call it only after authorizeMcpRequest returned null.
 *
 * Tenant mapping: a scoped JWT resolves to its tenant_id claim (bound to
 * sub by the verification); every other credential is operator-scoped
 * (the static secret identifies nobody, our OAuth access tokens are
 * client-bound with no user subject, GitHub/Google tokens carry no tenant
 * binding), as is the anonymous handshake. Only JWT-issued tokens get
 * per-tenant instances; everything else keeps today's operator behavior.
 */
export async function resolveMcpIdentity(
  request: Request,
  env: Env,
): Promise<McpIdentity> {
  const mode = resolveMcpAuthMode(env.MCP_AUTH_MODE);
  const staticSecret = (env.MCP_AUTH_TOKEN ?? "").trim();
  const requiredOrg = (env.MCP_GITHUB_ORG ?? "").trim();
  const jwtSecret = (env.MCP_JWT_SECRET ?? "").trim();
  const paths = permittedPaths(mode ?? "none");

  const header = request.headers.get("Authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

  const anonymous: McpIdentity = { source: "anonymous", tenantId: "operator", userId: "operator" };
  if (!presented) return anonymous;

  // 1) Static secret, when permitted.
  if (paths.static && staticSecret && timingSafeStringEqual(presented, staticSecret)) {
    return { source: "static", tenantId: "operator", userId: "operator" };
  }

  // 2) OAuth access token issued by our own authorization server (either
  //    mode only, mirroring the gate). Client-bound: no user subject, so
  //    the operator tenant.
  if (mode === "either" && (await isAcceptedAccessToken(presented, env))) {
    return { source: "oauth", tenantId: "operator", userId: "operator" };
  }

  // 3) GitHub credential, when permitted.
  if (paths.github && looksLikeGitHubToken(presented)) {
    if (await verifyGitHubToken(presented, requiredOrg || undefined)) {
      return { source: "github", tenantId: "operator", userId: "operator" };
    }
  }

  // 4) Scoped JWT, when permitted and configured. tenant_id claim, bound
  //    to sub — the only credential that resolves to a user tenant.
  if (paths.jwt && jwtSecret && looksLikeJwt(presented)) {
    try {
      const verified = await verifyToken(jwtSecret, presented, {
        issuer: (env.MCP_JWT_ISSUER ?? "").trim() || undefined,
        audience: (env.MCP_JWT_AUDIENCE ?? "").trim() || undefined,
      });
      const sub = String(verified.claims.sub ?? "");
      if (sub) {
        return {
          source: "jwt",
          tenantId: String(verified.claims.tenant_id ?? "operator"),
          userId: sub,
          jti: verified.claims.jti,
          sub,
        };
      }
    } catch {
      /* not a valid JWT for us — fall through to anonymous */
    }
  }

  // 5) Google credential, when permitted.
  if (paths.google && presented) {
    if (await verifyGoogleToken(presented, env)) {
      return { source: "google", tenantId: "operator", userId: "operator" };
    }
  }

  return anonymous;
}
