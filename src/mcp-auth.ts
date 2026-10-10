import type { Env } from "./types";
import { allowsDiscovery, resourceMetadataUrl } from "./mcp-oauth";
import { isAcceptedAccessToken } from "./mcp-oauth-server";

/**
 * Authorisation for the /mcp endpoint.
 *
 * Which credential types are accepted is chosen by MCP_AUTH_MODE:
 *
 *   "either" (default) — a static bearer token OR a valid GitHub token
 *   "static"           — only the static bearer token
 *   "github"           — only a valid GitHub token
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
 * X-Slack-Signature and never attaches an Authorization header (see src/slack.ts).
 *
 * Only the Authorization header is read. Query parameters are rejected on
 * purpose, because the Worker has observability enabled and would log them.
 */

export type McpAuthMode = "either" | "static" | "github" | "none";

/** How long a validated GitHub token is trusted before re-checking. */
const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the cache so a flood of bogus tokens cannot grow it without limit. */
const GITHUB_CACHE_MAX = 200;

/** Hash of a validated credential -> expiry timestamp (ms). Per isolate. */
const githubTokenCache = new Map<string, number>();

/**
 * Constant-time comparison, so a wrong secret cannot be recovered by measuring
 * how long the check takes.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Resolve MCP_AUTH_MODE. Returns null when the value is unrecognised, so an
 * operator typo fails closed rather than silently picking a mode.
 */
export function resolveMcpAuthMode(raw: string | undefined): McpAuthMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "either";
  if (value === "either" || value === "static" || value === "github" || value === "none") {
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
function permittedPaths(mode: McpAuthMode): { static: boolean; github: boolean } {
  switch (mode) {
    case "static":
      return { static: true, github: false };
    case "github":
      return { static: false, github: true };
    case "either":
      return { static: true, github: true };
    default:
      return { static: false, github: false };
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
      'MCP_AUTH_MODE is not one of "either", "static", "github" or "none"; refusing /mcp.',
    );
    return jsonResponse({ error: "MCP authorisation is misconfigured." }, 503);
  }

  // Explicit opt-out, and deliberately loud: this serves the tool surface openly.
  if (mode === "none") {
    console.warn("MCP_AUTH_MODE=none: /mcp is serving WITHOUT authentication.");
    return null;
  }

  const staticSecret = (env.MCP_AUTH_TOKEN ?? "").trim();
  const requiredOrg = (env.MCP_GITHUB_ORG ?? "").trim();
  const paths = permittedPaths(mode);

  // Fail closed when the selected mode has nothing to authenticate against.
  const staticReady = paths.static && Boolean(staticSecret);
  const githubReady = paths.github && Boolean(requiredOrg);

  if (!staticReady && !githubReady) {
    console.error(
      `MCP authorisation is enabled (mode=${mode}) but no usable credential is configured; refusing /mcp.`,
    );
    return jsonResponse({ error: "MCP is not configured." }, 503);
  }

  const header = request.headers.get("Authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (presented) {
    // 1) Static secret, when permitted.
    if (paths.static && staticSecret && timingSafeStringEqual(presented, staticSecret)) {
      return null;
    }

    // 2) OAuth access token issued by our own authorization server.
    if (await isAcceptedAccessToken(presented, env)) {
      return null;
    }

    // 3) GitHub credential, when permitted. Shape-checked first so stray strings
    //    never cost an outbound API call.
    if (paths.github && looksLikeGitHubToken(presented)) {
      if (await verifyGitHubToken(presented, requiredOrg || undefined)) {
        return null;
      }
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

  return jsonResponse({ error: "Unauthorized" }, 401, challenge);
}
