/**
 * Tenancy resolution (issue #252, design §4).
 *
 * Convention: instance name = `<base>:<userId>` (e.g. `scheduler:usr_9f3a…`).
 * All twelve `idFromName` call sites and the get*Agent helpers resolve
 * through here; the API-key identity maps to the operator tenant, so the
 * owner keeps using the product exactly as today.
 *
 * P3 (this slice): per-tenant resolution is live.
 * - `resolveTenant(credential)`: the one SDK-free resolver. API key /
 *   dashboard key → operator tenant; app_session → user → tenant
 *   (tenant = user 1:1); MCP JWT → tenant_id claim (bound to sub by the
 *   JWT verification itself); oauth-legacy cookie → operator tenant
 *   (legacy owner path); anonymous → operator tenant.
 * - `tenantOfInstance(instanceName)`: parse `<base>:<uid>` back out, so an
 *   agent can learn its own tenant from its instance name.
 * - Per-tenant resolution is unconditional (the staged-rollout flag was
 *   removed by issue #346 once its staging condition — two consecutive
 *   green deploys post-P3 — was verified met). The operator → singleton
 *   identity mapping is kept (instanceFor returns the base for the
 *   operator tenant), so the owner's own usage changes zero and NO data
 *   moves — the operator's singleton data is never copied.
 * - `checkDispatchEnvelope`: the cross-tenant rule — an in-process dispatch
 *   envelope's trace tenantId must equal the target instance's tenant; the
 *   only cross-tenant dispatch allowed is to operator singletons (qa,
 *   platform services). qa read-only for user tenants is enforced at the
 *   /a2a/qa branch, not here.
 *
 * SDK-free.
 */

export const OPERATOR_TENANT_ID = "operator";

/** P1: the only tenant is the operator. P3 resolves from the credential. */
export function tenantIdFor(): string {
  return OPERATOR_TENANT_ID;
}

/** P1: the only user is the operator. P2 resolves from the session/JWT. */
export function userIdFor(): string {
  return OPERATOR_TENANT_ID;
}

/**
 * Resolve the Durable Object instance name for a tenant. The identity
 * function on the operator tenant; `<base>:<tenantId>` for user tenants.
 */
export function instanceFor(base: string, tenantId: string = OPERATOR_TENANT_ID): string {
  if (!tenantId || tenantId === OPERATOR_TENANT_ID) return base;
  return `${base}:${tenantId}`;
}

/**
 * Bases that never get per-tenant instances.
 * QAAgent tests production for the operator — it is platform ops, not user
 * data (design §4). Agent cards / fleet index / error catalog are not DO
 * dispatches at all and stay global by construction.
 */
export const TENANT_SINGLETON_BASES: ReadonlySet<string> = new Set(["qa"]);

/** The credential shapes the edge can resolve to a tenant. */
export type TenantCredential =
  | { kind: "operator-key" }
  | { kind: "session"; userId: string; tenantId: string }
  | { kind: "mcp-jwt"; sub: string; tenantId: string }
  | { kind: "oauth-legacy" }
  | { kind: "anonymous" };

export interface ResolvedTenant {
  tenantId: string;
  userId: string;
  /** The AuthzIdentity kind this tenant maps to. */
  identityKind: "operator" | "session" | "jwt";
}

/**
 * The one SDK-free tenancy resolver. Pure: the caller extracts the
 * credential facts (session validation, JWT verification happen outside).
 */
export function resolveTenant(credential: TenantCredential): ResolvedTenant {
  switch (credential.kind) {
    case "operator-key":
      return { tenantId: OPERATOR_TENANT_ID, userId: OPERATOR_TENANT_ID, identityKind: "operator" };
    case "session":
      return {
        tenantId: credential.tenantId || credential.userId,
        userId: credential.userId,
        identityKind: "session",
      };
    case "mcp-jwt":
      // tenant_id claim, bound to sub by the JWT verification itself.
      // A token without tenant_id predates P2 issuance and resolves to the
      // operator tenant (P1/P2 behavior); issuance always sets the claim.
      return {
        tenantId: credential.tenantId || OPERATOR_TENANT_ID,
        userId: credential.sub,
        identityKind: "jwt",
      };
    case "oauth-legacy":
      // Legacy owner path: the deprecated gh_access_token cookie branch.
      return { tenantId: OPERATOR_TENANT_ID, userId: OPERATOR_TENANT_ID, identityKind: "operator" };
    case "anonymous":
      return { tenantId: OPERATOR_TENANT_ID, userId: OPERATOR_TENANT_ID, identityKind: "operator" };
  }
}

/** Map a require-auth AuthDecision onto a tenant credential. */
export function tenantFromAuthDecision(d: {
  kind: string;
  userId: string;
  tenantId: string;
}): ResolvedTenant {
  switch (d.kind) {
    case "session":
      return resolveTenant({ kind: "session", userId: d.userId, tenantId: d.tenantId });
    case "oauth-legacy":
      return resolveTenant({ kind: "oauth-legacy" });
    case "operator":
    default:
      return resolveTenant({ kind: "operator-key" });
  }
}

/**
 * Parse `<base>:<uid>` back into base + tenant, so an agent can learn its
 * own tenant from its instance name (e.g. autopilot arming
 * `scheduler:<sameUid>`). No colon → the operator singleton.
 */
export function tenantOfInstance(instanceName: string): { base: string; tenantId: string } {
  const idx = instanceName.indexOf(":");
  if (idx < 0) return { base: instanceName, tenantId: OPERATOR_TENANT_ID };
  return {
    base: instanceName.slice(0, idx),
    tenantId: instanceName.slice(idx + 1) || OPERATOR_TENANT_ID,
  };
}

/**
 * The instance name for a tenant — unconditional since issue #346 removed
 * the staged-rollout flag. Singleton bases (TENANT_SINGLETON_BASES) always
 * resolve to the base; every other base resolves per-tenant. Because the
 * operator → singleton identity mapping is kept, the operator's own usage
 * resolves exactly as today and no data ever moves.
 */
export function resolveTenantInstance(base: string, tenantId: string): string {
  if (TENANT_SINGLETON_BASES.has(base)) return base;
  return instanceFor(base, tenantId);
}

export function isOperatorTenant(tenantId: string): boolean {
  return !tenantId || tenantId === OPERATOR_TENANT_ID;
}

/**
 * Cross-tenant dispatch rule (design §4, P3): an in-process dispatch
 * envelope's trace tenantId must equal the target instance's tenant. The
 * only cross-tenant dispatch allowed is to operator singletons (qa,
 * platform services). A missing trace is treated as the operator identity
 * (today's in-process default — e.g. the host's internal scheduler
 * dispatch, which targets the operator singleton).
 */
export function checkDispatchEnvelope(
  trace: { tenantId?: string } | null | undefined,
  instanceName: string,
): { ok: boolean; reason?: string } {
  const target = tenantOfInstance(instanceName);
  const traceTenant = trace?.tenantId || OPERATOR_TENANT_ID;
  if (traceTenant === target.tenantId) return { ok: true };
  if (target.tenantId === OPERATOR_TENANT_ID) return { ok: true };
  return {
    ok: false,
    reason:
      `cross-tenant dispatch rejected: trace tenant "${traceTenant}" ` +
      `!= target tenant "${target.tenantId}" (${instanceName})`,
  };
}

/**
 * The tenant of the Durable Object instance running this code, from its
 * own instance name (e.g. `this.ctx.id.name`). Falls back to the operator
 * tenant when the name is unavailable (today's behavior).
 */
export function ownTenantId(instanceName?: string | null): string {
  if (typeof instanceName === "string" && instanceName) {
    return tenantOfInstance(instanceName).tenantId;
  }
  return OPERATOR_TENANT_ID;
}
