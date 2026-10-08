import type { Env } from "./types";

/**
 * Authorisation for the unauthenticated-by-design phase-1 /mcp endpoint.
 *
 * Two credential types are accepted, so that both classes of client can connect:
 *
 *   1. A static bearer token (`MCP_AUTH_TOKEN`) — a shared secret. Simple, and
 *      the only thing that works for clients you cannot give GitHub credentials.
 *   2. A GitHub token (classic `ghp_...`, or fine-grained `github_pat_...`) —
 *      validated against the GitHub API, giving per-user identity and central
 *      revocation: revoking the token immediately ends access.
 *
 * Slack is a separate case and cannot use either: Slack signs its requests with
 * `X-Slack-Signature` and never attaches an arbitrary Authorization header, so
 * it needs the signature path (see src/slack.ts) instead.
 *
 * Fails CLOSED: with no credential configured, every request is refused rather
 * than leaving the endpoint open.
 *
 * Only the Authorization header is read. Query parameters are rejected on
 * purpose, because the Worker has observability enabled and would log them.
 */

/** How long a validated GitHub token is trusted before re-checking. */
const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the cache so a flood of bogus tokens cannot grow it without limit. */
const GITHUB_CACHE_MAX = 200;

/** tokenHash -> expiry timestamp (ms). Per isolate, so best-effort only. */
const githubTokenCache = new Map<string, number>();

/**
 * Constant-time comparison, so a wrong token cannot be recovered by measuring
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
    // Drop the oldest entry; Map preserves insertion order.
    const oldest = githubTokenCache.keys().next();
    if (!oldest.done) githubTokenCache.delete(oldest.value);
  }
  githubTokenCache.set(key, Date.now() + GITHUB_CACHE_TTL_MS);
}

/**
 * Validate a GitHub token, optionally requiring membership of an organisation.
 * Returns false on any failure, including GitHub being unreachable — an
 * authorisation check must not fail open because a dependency is down.
 */
async function verifyGitHubToken(token: string, requiredOrg?: string): Promise<boolean> {
  const cacheKey = await sha256Hex(token + "|" + (requiredOrg ?? ""));
  if (cacheGet(cacheKey)) return true;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // GitHub requires a User-Agent.
    "User-Agent": "cfmail-agent-mcp",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

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
    console.error("GitHub token verification failed:", error);
    return false;
  }

  // Avoid caching a token when an org was required but the response we cached
  // against did not actually include it; the key includes the org, so this is safe.
  cacheSet(cacheKey);
  return true;
}

/**
 * Authorise an /mcp request. Returns the response to send instead, or null to
 * continue.
 */
export async function authorizeMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const staticToken = (env.MCP_AUTH_TOKEN ?? "").trim();
  const requiredOrg = (env.MCP_GITHUB_ORG ?? "").trim();

  if (!staticToken && !requiredOrg) {
    console.error(
      "MCP authorisation is not configured (MCP_AUTH_TOKEN / MCP_GITHUB_ORG unset); refusing /mcp.",
    );
    return new Response(JSON.stringify({ error: "MCP is not configured." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const header = request.headers.get("Authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (presented) {
    // 1) Configured static token.
    if (staticToken && timingSafeStringEqual(presented, staticToken)) {
      return null;
    }

    // 2) GitHub token. Only attempted when an org is configured, or when the
    //    value has GitHub token shape — otherwise every stray string would cost
    //    an outbound API call.
    if (requiredOrg || looksLikeGitHubToken(presented)) {
      if (await verifyGitHubToken(presented, requiredOrg || undefined)) {
        return null;
      }
    }
  }

  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="cfmail-mcp"',
    },
  });
}
