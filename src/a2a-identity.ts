/**
 * A2A edge identity (issue #252 P3, design §4).
 *
 * The /a2a/* edge used to accept exactly one credential — the dashboard
 * API key — and every dispatch ran as the operator tenant. P3 resolves the
 * calling tenant per credential:
 *
 *   1. Dashboard key (Authorization: Bearer or X-API-Key) → operator tenant
 *      (unchanged).
 *   2. app_session cookie → the session's user → that tenant. NEW in P3.
 *   3. Scoped JWT Bearer (MCP_JWT_SECRET) → the token's tenant_id claim,
 *      bound to sub by the JWT verification itself. NEW in P3.
 *
 * Otherwise the call is unauthenticated (401 behavior unchanged).
 *
 * The resolved tenant drives instance resolution (`<base>:<tenantId>`) and
 * the dispatch trace; the qa singleton additionally gates user tenants to
 * read-class operations at its branch.
 */

import { timingSafeEqual } from "./crypto-hmac";
import { getSessionUserFromRequest, type IdentityBackend } from "./auth";
import { looksLikeJwt, verifyToken } from "./mcp-jwt";
import { resolveTenant, type ResolvedTenant } from "./tenancy";
import type { Env } from "./types";

export interface A2AIdentity extends ResolvedTenant {
  /** Which credential produced this identity. */
  source: "operator-key" | "session" | "jwt";
  /** JWT id, when source is "jwt" (the FGA subject for token checks). */
  jti?: string;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

/** True when the request presents the dashboard API key (either header). */
export function a2aKeyMatches(request: Request, env: Env): boolean {
  const expected = (env.DASHBOARD_API_KEY ?? "").trim();
  if (!expected) return false; // fail closed, as everywhere else in this Worker
  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : (request.headers.get("x-api-key") ?? "").trim();
  if (!presented) return false;
  return timingSafeStringEqual(presented, expected);
}

function bearerOf(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * Resolve the calling identity for an /a2a/* request, or null when no
 * credential authorises it. Async: session and JWT validation are I/O.
 * `deps.sessionBackend` is the test seam (mirrors require-auth.ts).
 */
export async function resolveA2AIdentity(
  request: Request,
  env: Env,
  deps?: { sessionBackend?: IdentityBackend },
): Promise<A2AIdentity | null> {
  // 1) Dashboard key → operator tenant (unchanged).
  if (a2aKeyMatches(request, env)) {
    return { ...resolveTenant({ kind: "operator-key" }), source: "operator-key" };
  }

  // 2) app_session cookie → that user's tenant. NEW in P3: a signed-in
  // dashboard user calling A2A directly reaches their own tenant's
  // instances, not the operator singletons.
  try {
    const sess = await getSessionUserFromRequest(request, env, deps?.sessionBackend);
    if (sess) {
      return {
        ...resolveTenant({ kind: "session", userId: sess.userId, tenantId: sess.tenantId }),
        source: "session",
      };
    }
  } catch {
    /* an identity-store outage must not fail open into the JWT branch */
    return null;
  }

  // 3) Scoped JWT Bearer → tenant_id claim (bound to sub). NEW in P3.
  const bearer = bearerOf(request);
  const jwtSecret = (env.MCP_JWT_SECRET ?? "").trim();
  if (bearer && jwtSecret && looksLikeJwt(bearer)) {
    try {
      const verified = await verifyToken(jwtSecret, bearer, {
        issuer: (env.MCP_JWT_ISSUER ?? "").trim() || undefined,
        audience: (env.MCP_JWT_AUDIENCE ?? "").trim() || undefined,
      });
      const sub = String(verified.claims.sub ?? "");
      if (sub) {
        return {
          ...resolveTenant({
            kind: "mcp-jwt",
            sub,
            tenantId: String(verified.claims.tenant_id ?? "operator"),
          }),
          source: "jwt",
          jti: verified.claims.jti,
        };
      }
    } catch {
      /* not a valid JWT for us → unauthenticated */
    }
  }

  return null;
}
