/**
 * Self-provisioning for tenant instances (issue #315).
 *
 * The dispatch seam (tenant-dispatch.ts) seeds the `(user, owner, tenant)`
 * FGA tuple on first in-process dispatch — but a tenant instance woken via
 * the /agents/* WebSocket path (routeAgentRequest → wake, no dispatch)
 * never passes that seam. The SDK-idiomatic close is lifecycle: each
 * tenantized agent self-provisions in `onStart`, which the runtime calls
 * on wake and on restart alike.
 *
 * Idempotent by construction (the tuple write is INSERT OR IGNORE), a
 * no-op for the operator tenant and when the cutover kill switch is off,
 * and fail-safe: a seed failure never blocks startup — the FGA layer
 * still denies what the missing tuple should deny, and the dispatch seam
 * retries on the next dispatch (the same backstop semantics as
 * ensureTenantProvisioned).
 *
 * Top level is SDK-free (tenant-dispatch only imports `agents` dynamically
 * inside functions), so this module stays importable from Vitest.
 */

import { ensureTenantProvisioned } from "./tenant-dispatch";
import { cutoverEnabled, isOperatorTenant, tenantOfInstance, type CutoverEnv } from "./tenancy";

/** Test seam for the identity tuple store (mirrors tenant-dispatch). */
export interface ProvisionIdentityDeps {
  check: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ) => Promise<boolean>;
  addTuple: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ) => Promise<void>;
}

/** The only surface of an agent this helper needs: env + instance name. */
export interface ProvisionableAgentLike {
  env: unknown;
  ctx?: { id?: { name?: string } };
}

/**
 * Seed this instance's tenant tuple if (and only if) it is a user tenant.
 * Call from the tenant agents' `onStart`:
 *
 *   async onStart(): Promise<void> {
 *     await selfProvisionOwnTenant({ env: this.env, ctx: this.ctx });
 *   }
 *
 * Never throws past the ensureTenantProvisioned backstop — startup is not
 * gated on the seed.
 */
export async function selfProvisionOwnTenant(
  agent: ProvisionableAgentLike,
  deps?: { identity?: ProvisionIdentityDeps },
): Promise<void> {
  const name = agent.ctx?.id?.name;
  if (!name) return;
  const { base, tenantId } = tenantOfInstance(name);
  if (isOperatorTenant(tenantId)) return;
  // A tenant-suffixed name can only exist when the surface is cut over; if
  // the kill switch is off (or the base is a singleton), the runtime wakes
  // the singleton — never provision into a tenant that shouldn't exist.
  if (!cutoverEnabled(base, agent.env as CutoverEnv | null)) return;
  // ensureTenantProvisioned carries the same guards again downstream.
  await ensureTenantProvisioned(agent.env, base, tenantId, name, deps);
}
