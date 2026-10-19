/**
 * WS1 authorization aspect (issue #252, design §2.4).
 *
 * The same seams as the other aspects, deny-by-default. Every protected
 * operation declares { objectType, objectId, relation } it requires; the
 * aspect resolves identity, runs the RBAC coarse gate, then the FGA check.
 *
 * P1 (this slice): the FGA store ships with the owner-tenant bootstrap only
 * — `(operator, owner, tenant:operator)` — and all other checks short-circuit
 * to tenant-equality. The seam is live; the tuple graph is populated in
 * P2/P3. Today's behavior (single tenant) is exactly "all tuples true for
 * the operator", so the aspect is purely additive in P1.
 *
 * The full declaration register lives in DECLARATIONS below, not scattered
 * in route code (design §2.4).
 *
 * SDK-free (imports only ./aspect-logging).
 */

import type { AspectAuthDecision, AspectTrace } from "./aspect-logging";
import {
  accountingEvent,
  emitAspectEvent,
  type AspectEvent,
  type AspectEnv,
} from "./aspect-logging";

export type AuthzRole = "operator" | "owner" | "viewer";

export interface AuthzIdentity {
  kind: "operator" | "session" | "jwt" | "api_key";
  tenantId: string;
  userId: string;
  role: AuthzRole;
}

export interface AuthzDeclaration {
  objectType: string;
  objectId: string;
  relation: string;
}

export interface AuthzCheck {
  allow: boolean;
  decision: AspectAuthDecision;
}

/**
 * P1 identity resolution: the dashboard API key maps to the operator
 * tenant (design §4: "the dashboard key permanently maps to the operator
 * tenant"). Session/JWT identity arrives in P2.
 */
export function resolveAuthzIdentity(_request?: Request): AuthzIdentity {
  return { kind: "operator", tenantId: "operator", userId: "operator", role: "operator" };
}

/**
 * P1 check: the operator is owner of the operator tenant, so every
 * declared check allows. Deny-by-default is structural — unknown or
 * non-operator identities fall through to { allow: false }.
 */
export function checkAuthz(
  identity: AuthzIdentity,
  declaration: AuthzDeclaration,
): AuthzCheck {
  const object = `${declaration.objectType}:${declaration.objectId}`;
  if (
    identity.tenantId === "operator" &&
    (identity.role === "operator" || identity.role === "owner")
  ) {
    return {
      allow: true,
      decision: { relation: declaration.relation, object, allow: true },
    };
  }
  return {
    allow: false,
    decision: { relation: declaration.relation, object, allow: false },
  };
}

/**
 * The declared check points (design §2.4). Keyed by HTTP method + route
 * pattern; A2A/MCP operation-level declarations are registered here too
 * and activated at the dispatch seams in P2/P3.
 */
const HTTP_DECLARATIONS: Record<string, AuthzDeclaration> = {
  "POST /api/public/trades/:id/decision": {
    objectType: "trade_proposal",
    objectId: ":id",
    relation: "approver",
  },
  "POST /api/dashboard/scheduled-goals": {
    objectType: "tenant",
    objectId: "operator",
    relation: "owner",
  },
  "DELETE /api/dashboard/scheduled-goals/:id": {
    objectType: "scheduled_goal",
    objectId: ":id",
    relation: "owner",
  },
  "POST /api/dashboard/autopilot/objective": {
    objectType: "tenant",
    objectId: "operator",
    relation: "owner",
  },
  "POST /api/dashboard/mcp/tokens": {
    objectType: "tenant",
    objectId: "operator",
    relation: "owner",
  },
};

/** Operation-level declarations for the A2A/MCP seams (activated P2/P3). */
const OPERATION_DECLARATIONS: Record<string, AuthzDeclaration> = {
  cfpay_autopilot_run_cycle: {
    objectType: "objective",
    objectId: "operator",
    relation: "actor_for",
  },
  "orchestrator.run": { objectType: "tenant", objectId: "operator", relation: "owner" },
  "slack.post": { objectType: "tenant", objectId: "operator", relation: "owner" },
};

export function findHttpDeclaration(
  method: string,
  routePath: string,
): AuthzDeclaration | null {
  return HTTP_DECLARATIONS[`${method.toUpperCase()} ${routePath}`] ?? null;
}

export function findOperationDeclaration(operation: string): AuthzDeclaration | null {
  return OPERATION_DECLARATIONS[operation] ?? null;
}

export function declarationCount(): number {
  return Object.keys(HTTP_DECLARATIONS).length + Object.keys(OPERATION_DECLARATIONS).length;
}

/**
 * Bind a trace's identity to the check (design §2.4: checks run at the
 * seam with the trace's tenant). In P1 the trace tenant is the operator.
 */
export function identityFromTrace(trace: AspectTrace): AuthzIdentity {
  if (trace.tenantId === "operator") {
    return { kind: "operator", tenantId: "operator", userId: trace.userId, role: "operator" };
  }
  return { kind: "session", tenantId: trace.tenantId, userId: trace.userId, role: "viewer" };
}

/**
 * Emit the authz decision as an accounting event (IAAA "Accounting"):
 * operation "authz.allow"/"authz.deny", same AspectEvent shape as every
 * other event, so the P2 accounting sink persists it unchanged. Both
 * allows AND denies are emitted — the deny trail is the point.
 */
export function emitAuthzDecision(
  identity: AuthzIdentity,
  declaration: AuthzDeclaration,
  check: AuthzCheck,
  opts: {
    correlationId: string;
    durationMs?: number;
    env?: AspectEnv | null;
  },
): void {
  const event: AspectEvent = accountingEvent(
    check.allow ? "authz.allow" : "authz.deny",
    {
      tenantId: identity.tenantId,
      userId: identity.userId,
      correlationId: opts.correlationId,
      agent: "authz",
      durationMs: opts.durationMs ?? 0,
      authDecision: check.decision,
      detail: { kind: identity.kind, role: identity.role },
    },
  );
  emitAspectEvent(event, opts.env ?? null);
}
