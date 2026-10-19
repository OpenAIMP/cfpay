/**
 * Dashboard API auth decision (issue #252 P2).
 *
 * SDK-free pure module so Vitest can test the branch logic directly —
 * src/api.ts's requireAuth is a thin wrapper around decideAuth (api.ts
 * itself is not Vitest-safe: it imports the agents SDK at top level).
 *
 * Three branches, in order:
 *   1. X-API-Key vs DASHBOARD_API_KEY (constant-time) → "operator".
 *      The API-key path is unchanged by P2 and skips CSRF (no cookies).
 *   2. app_session cookie → validated against the IdentityAgent →
 *      "session". Cookie-authenticated mutations (POST/PUT/DELETE/PATCH)
 *      get a CSRF check: the Origin or Referer host must match the request
 *      host, else the decision carries csrfFailed.
 *   3. Legacy gh_access_token cookie (deprecated, kept one release) →
 *      "oauth-legacy".
 * Otherwise "none" (caller sends 401).
 */

import { timingSafeEqual } from "./crypto-hmac";
import type { Env } from "./types";
import {
  getOAuthUserFromRequest,
  getSessionUserFromRequest,
  type IdentityBackend,
} from "./auth";

export type AuthKind = "operator" | "session" | "oauth-legacy" | "none";

export interface AuthDecision {
  kind: AuthKind;
  userId: string;
  tenantId: string;
  /** Set on the session branch when a mutation fails the CSRF check. */
  csrfFailed?: boolean;
}

export interface RequireAuthDeps {
  sessionBackend?: IdentityBackend;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

/** Host of an Origin/Referer header value, or "" when absent/unparseable. */
export function hostOfHeader(value: string | undefined | null): string {
  if (!value) return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * CSRF check for cookie-authenticated mutations: at least one of Origin /
 * Referer must be present and match the request host. Safe methods skip
 * the check entirely (the caller only invokes this on the cookie branch).
 */
export function csrfCheckPasses(request: Request): boolean {
  if (!MUTATING_METHODS.has((request.method ?? "").toUpperCase())) return true;
  let reqHost = "";
  try {
    reqHost = new URL(request.url).host.toLowerCase();
  } catch {
    return false;
  }
  if (!reqHost) return false;
  return (
    hostOfHeader(request.headers.get("Origin")) === reqHost ||
    hostOfHeader(request.headers.get("Referer")) === reqHost
  );
}

export async function decideAuth(
  request: Request,
  env: Env,
  deps?: RequireAuthDeps,
): Promise<AuthDecision> {
  // Branch 1: API key — unchanged, permanent, maps to the operator tenant.
  const presented = request.headers.get("X-API-Key") ?? "";
  if (env.DASHBOARD_API_KEY && timingSafeStringEqual(presented, env.DASHBOARD_API_KEY)) {
    return { kind: "operator", userId: "operator", tenantId: "operator" };
  }

  // Branch 2: app session (P2 model).
  const sessUser = await getSessionUserFromRequest(request, env, deps?.sessionBackend);
  if (sessUser) {
    const decision: AuthDecision = {
      kind: "session",
      userId: sessUser.userId,
      tenantId: sessUser.tenantId,
    };
    if (!csrfCheckPasses(request)) decision.csrfFailed = true;
    return decision;
  }

  // Branch 3: legacy GitHub-token cookie (deprecated, kept one release).
  const oauthUser = await getOAuthUserFromRequest(request);
  if (oauthUser) {
    return { kind: "oauth-legacy", userId: `legacy:${oauthUser.login}`, tenantId: "operator" };
  }

  return { kind: "none", userId: "", tenantId: "" };
}
