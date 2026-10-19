/**
 * Tenancy resolution (issue #252, design §4).
 *
 * Convention: instance name = `<base>:<userId>` (e.g. `scheduler:usr_9f3a…`).
 * All twelve `idFromName` call sites and the get*Agent helpers resolve
 * through here; the API-key identity maps to the operator tenant, so the
 * owner keeps using the product exactly as today.
 *
 * P1 (this slice): the skeleton — the operator tenant only. Per-tenant
 * resolution arrives with the P3 cutover; the call sites are already
 * routed through instanceFor so the cutover is a change here, not in 12
 * places.
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
 * Resolve the Durable Object instance name for a tenant. Today this is the
 * identity function on the operator tenant; after the P3 cutover it returns
 * `<base>:<tenantId>` for user tenants.
 */
export function instanceFor(base: string, tenantId: string = OPERATOR_TENANT_ID): string {
  if (!tenantId || tenantId === OPERATOR_TENANT_ID) return base;
  return `${base}:${tenantId}`;
}
