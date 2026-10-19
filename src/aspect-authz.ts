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
  /**
   * P3: for JWT identities, the token id (jti) — the FGA subject for
   * token-bound checks (actor_for). userId carries the JWT sub.
   */
  tokenId?: string;
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
 *
 * P3: declarations are tenant-parameterized — `{tenant}` in objectId is
 * replaced with the calling tenant at the seam (the register stays the
 * single source of truth; no per-route tuple literals in route code).
 */
const HTTP_DECLARATIONS: Record<string, AuthzDeclaration> = {
  "POST /api/public/trades/:id/decision": {
    objectType: "trade_proposal",
    objectId: ":id",
    relation: "approver",
  },
  "POST /api/dashboard/scheduled-goals": {
    objectType: "tenant",
    objectId: "{tenant}",
    relation: "owner",
  },
  "DELETE /api/dashboard/scheduled-goals/:id": {
    objectType: "scheduled_goal",
    objectId: ":id",
    relation: "owner",
  },
  "POST /api/dashboard/autopilot/objective": {
    objectType: "tenant",
    objectId: "{tenant}",
    relation: "owner",
  },
  "POST /api/dashboard/mcp/tokens": {
    objectType: "tenant",
    objectId: "{tenant}",
    relation: "owner",
  },
};

/** Operation-level declarations for the A2A/MCP seams (activated P2/P3). */
const OPERATION_DECLARATIONS: Record<string, AuthzDeclaration> = {
  cfpay_autopilot_run_cycle: {
    objectType: "objective",
    objectId: "{tenant}",
    relation: "actor_for",
  },
  "orchestrator.run": { objectType: "tenant", objectId: "{tenant}", relation: "owner" },
  "slack.post": { objectType: "tenant", objectId: "{tenant}", relation: "owner" },
};

/**
 * Instantiate a declaration for one call: `{tenant}` → the calling
 * tenant, `:id` → the route's object id.
 */
export function instantiateDeclaration(
  declaration: AuthzDeclaration,
  values: { tenantId?: string; id?: string },
): AuthzDeclaration {
  const objectId = declaration.objectId
    .replace("{tenant}", values.tenantId ?? "operator")
    .replace(":id", values.id ?? ":id");
  return { ...declaration, objectId };
}

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

/* ------------------------- P3 enforcement ------------------------- */

export interface AuthzSubject {
  subjectType: string;
  subjectId: string;
}

/**
 * Map an edge identity to its FGA subject. The dashboard key and the
 * legacy owner path are the ("identity","operator") pseudo-subject the P2
 * bootstrap seeds; session users are ("user", userId); MCP JWTs act as
 * their token id (jti) so actor_for tuples bound at issuance are the
 * authority.
 */
export function subjectForIdentity(identity: AuthzIdentity): AuthzSubject {
  switch (identity.kind) {
    case "jwt":
      return { subjectType: "token", subjectId: identity.tokenId ?? identity.userId };
    case "session":
      return { subjectType: "user", subjectId: identity.userId };
    case "operator":
    case "api_key":
    default:
      return { subjectType: "identity", subjectId: "operator" };
  }
}

export type TupleCheckFn = (
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
) => Promise<boolean>;

export type TupleAddFn = (
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
) => Promise<void>;

export interface EnforceOpts {
  correlationId: string;
  env?: AspectEnv | null;
  /** Worker env for the IdentityAgent stub when tupleCheck is not injected. */
  identityEnv?: unknown;
  /** Injectable tuple check — the unit-test seam (no DO needed). */
  tupleCheck?: TupleCheckFn;
  /** Injectable tuple writer — the unit-test seam. */
  tupleAdd?: TupleAddFn;
}

/** Per-isolate: the operator bootstrap tuple is seeded at most once. */
let operatorBootstrapAttempted = false;

/**
 * Lazy operator bootstrap (design §5.3/§6: "the operator's first login
 * mints tenant:operator and the seed tuples"). The dashboard key never
 * goes through an OAuth login, so the first FGA check for the operator
 * seeds the bootstrap tuple idempotently (INSERT OR IGNORE) instead of
 * denying the owner's own usage. Backstop only — the check below still
 * decides, deny-by-default.
 */
async function ensureOperatorBootstrap(
  check: TupleCheckFn | undefined,
  add: TupleAddFn | undefined,
): Promise<void> {
  if (operatorBootstrapAttempted) return;
  operatorBootstrapAttempted = true;
  if (!check || !add) return;
  try {
    // Through the same store the check below reads — the injected seam in
    // tests, the IdentityAgent DO in production.
    if (!(await check("identity", "operator", "owner", "tenant", "operator"))) {
      await add("identity", "operator", "owner", "tenant", "operator");
    }
  } catch {
    /* backstop; the tuple check below still decides */
  }
}

async function defaultTupleCheck(identityEnv: unknown): Promise<TupleCheckFn> {
  const { identityStub } = await import("./agent-stubs");
  const stub = await identityStub(identityEnv);
  return (subjectType, subjectId, relation, objectType, objectId) =>
    stub.check(subjectType, subjectId, relation, objectType, objectId) as Promise<boolean>;
}

async function defaultTupleAdd(identityEnv: unknown): Promise<NonNullable<EnforceOpts["tupleAdd"]>> {
  const { identityStub } = await import("./agent-stubs");
  const stub = await identityStub(identityEnv);
  return (subjectType, subjectId, relation, objectType, objectId) =>
    stub.addTuple(subjectType, subjectId, relation, objectType, objectId) as Promise<void>;
}

/**
 * Enforce one declared check against the IdentityAgent tuple store
 * (design §2.4/§5.4), deny-by-default. Both allows AND denies are emitted
 * through the P2 accounting store via emitAuthzDecision — every decision
 * accounted.
 *
 * Enforcement lives at the Hono route boundary, the index.ts A2A branch
 * layer, and the MCP dispatch seam — wherever the decision can be made on
 * values that actually cross the wire. It is intentionally NOT a Proxy
 * around RPC stubs (self-heal #301: the withCallableAspect Proxy broke
 * native DO RPC dispatch and 500'd every call).
 *
 * A tuple-store outage fails closed (deny), never open.
 */
export async function enforceAuthz(
  identity: AuthzIdentity,
  declaration: AuthzDeclaration,
  opts: EnforceOpts,
): Promise<AuthzCheck> {
  const object = `${declaration.objectType}:${declaration.objectId}`;
  const subject = subjectForIdentity(identity);
  let allow = false;
  try {
    const check = opts.tupleCheck ?? (await defaultTupleCheck(opts.identityEnv));
    let add: TupleAddFn | undefined;
    try {
      add = opts.tupleAdd ?? (await defaultTupleAdd(opts.identityEnv));
    } catch {
      add = undefined; // no seed path; the check below still decides
    }
    if (identity.kind === "operator" || identity.kind === "api_key") {
      await ensureOperatorBootstrap(check, add);
    }
    allow = await check(
      subject.subjectType,
      subject.subjectId,
      declaration.relation,
      declaration.objectType,
      declaration.objectId,
    );
  } catch {
    allow = false;
  }
  const result: AuthzCheck = {
    allow,
    decision: { relation: declaration.relation, object, allow },
  };
  emitAuthzDecision(identity, declaration, result, {
    correlationId: opts.correlationId,
    env: opts.env ?? null,
  });
  return result;
}

/**
 * Object-level enforcement with tenant-owner backfill. Checks
 * (subject, relation, object); when the object tuple is absent but the
 * caller owns the tenant, the object tuple is seeded (idempotent) and the
 * check allows — tenant ownership implies rights on that tenant's objects.
 * This is what lets pre-P3 objects (created before their tuples existed)
 * keep working for their owner without a data migration, and what seeds
 * the approver tuple the trade-approval workflow later verifies.
 *
 * Both the object decision and the backfill are emitted as accounting
 * events; a denied caller gets the deny event and no seed.
 */
export async function enforceObjectAuthz(
  identity: AuthzIdentity,
  tenantId: string,
  declaration: AuthzDeclaration,
  opts: EnforceOpts,
): Promise<AuthzCheck> {
  const direct = await enforceAuthz(identity, declaration, opts);
  if (direct.allow) return direct;
  // Backfill path: the tenant owner may adopt the object.
  const ownerDecl: AuthzDeclaration = {
    objectType: "tenant",
    objectId: tenantId,
    relation: "owner",
  };
  const ownerCheck = await enforceAuthz(identity, ownerDecl, opts);
  if (!ownerCheck.allow) return direct;
  const subject = subjectForIdentity(identity);
  try {
    const add = opts.tupleAdd ?? (await defaultTupleAdd(opts.identityEnv));
    await add(
      subject.subjectType,
      subject.subjectId,
      declaration.relation,
      declaration.objectType,
      declaration.objectId,
    );
  } catch {
    return direct;
  }
  const backfilled: AuthzCheck = {
    allow: true,
    decision: {
      relation: declaration.relation,
      object: `${declaration.objectType}:${declaration.objectId}`,
      allow: true,
    },
  };
  emitAuthzDecision(identity, declaration, backfilled, {
    correlationId: opts.correlationId,
    env: opts.env ?? null,
  });
  return backfilled;
}
