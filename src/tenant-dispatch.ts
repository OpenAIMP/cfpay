/**
 * Tenant-aware A2A dispatch (issue #252 P3, design §4).
 *
 * The single seam for Worker-initiated in-process A2A calls: resolve the
 * cutover-aware instance name, assert the cross-tenant envelope rule,
 * provision the tenant on first use, then dispatch. Every index.ts A2A
 * branch, the MCP dispatcher, and the autopilot/scheduled in-process
 * dispatchers go through here (or its raw-stub sibling below).
 *
 * Provisioning (design §5.3): the instance is created on first tenant use
 * (getAgentByName creates lazily) and the `(user, owner, tenant:<uid>)`
 * tuple is seeded in the IdentityAgent alongside — create → seed → ready.
 * A seed failure leaves the tuple missing (the next dispatch retries:
 * orphans are reclaimable) and never reports ready (never half-visible).
 * The provisioning is a backstop: OAuth logins already seed the tuple.
 *
 * The honest form of the §6 dual-read window: TENANT_CUTOVER on = tenant
 * instances for users; off = singletons. When a cutover-enabled surface
 * provisions a tenant with no prior record, a `migration_fallback`
 * accounting event is emitted at this seam. No data moves and the
 * operator's singleton data is never copied (the operator → singleton
 * identity mapping is kept).
 *
 * RPC safety (self-heal #301): stubs are raw — never wrapped in a Proxy.
 */

import {
  accountingEvent,
  emitAspectEvent,
  mintCorrelationId,
  withTracePart,
  type AspectTrace,
} from "./aspect-logging";
import {
  checkDispatchEnvelope,
  OPERATOR_TENANT_ID,
  resolveTenantInstance,
  type ResolvedTenant,
} from "./tenancy";
import { identityStub } from "./agent-stubs";

/** Thrown when a dispatch envelope violates the cross-tenant rule. */
export class CrossTenantDispatchError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CrossTenantDispatchError";
  }
}

/** Per-isolate record of tenant/base pairs whose provisioning completed. */
const provisionedTenants = new Set<string>();

/**
 * First-use provisioning for a tenant on one surface. Idempotent;
 * safe to call on every dispatch (the per-isolate cache makes repeat
 * calls free, and the tuple write is INSERT OR IGNORE).
 *
 * `deps.identity` is the test seam: { check, addTuple } without a DO.
 */
export async function ensureTenantProvisioned(
  env: unknown,
  base: string,
  tenantId: string,
  instanceName?: string,
  deps?: {
    identity?: {
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
    };
  },
): Promise<void> {
  if (!tenantId || tenantId === OPERATOR_TENANT_ID) return;
  const name = instanceName ?? resolveTenantInstance(base, tenantId, env as { TENANT_CUTOVER?: string });
  if (name === base) return; // cutover off or singleton base: nothing to provision
  const key = `${base}:${tenantId}`;
  if (provisionedTenants.has(key)) return;
  try {
    let check: (st: string, si: string, r: string, ot: string, oi: string) => Promise<boolean>;
    let addTuple: (st: string, si: string, r: string, ot: string, oi: string) => Promise<void>;
    if (deps?.identity) {
      check = deps.identity.check;
      addTuple = deps.identity.addTuple;
    } else {
      const stub = await identityStub(env);
      check = (st, si, r, ot, oi) => stub.check(st, si, r, ot, oi) as Promise<boolean>;
      addTuple = (st, si, r, ot, oi) => stub.addTuple(st, si, r, ot, oi) as Promise<void>;
    }
    const has = await check("user", tenantId, "owner", "tenant", tenantId);
    if (!has) {
      await addTuple("user", tenantId, "owner", "tenant", tenantId);
      emitAspectEvent(
        accountingEvent("migration_fallback", {
          tenantId,
          userId: tenantId,
          correlationId: mintCorrelationId(),
          agent: base,
          detail: { base, instance: name, reason: "first-use-provisioning" },
        }),
        env as { LOG_ASPECTS?: string; LOG_LEVEL?: string },
      );
    }
    provisionedTenants.add(key);
  } catch (err) {
    // Backstop, not gate: log and continue — the FGA layer still denies
    // anything the missing tuple should deny, and the next dispatch
    // retries the seed.
    console.error(
      `tenant provisioning failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface TenantDispatchOpts {
  env: unknown;
  /** Durable Object binding name, e.g. "SCHEDULED_AGENT". */
  binding: string;
  /** Instance base name, e.g. "scheduler". */
  base: string;
  tenant: ResolvedTenant;
  /** The dispatch trace; its tenantId must match the target instance. */
  trace: AspectTrace;
  origin: string;
  body: unknown;
}

/**
 * Dispatch one A2A message to a tenant's instance. Resolves the
 * cutover-aware instance name, enforces the cross-tenant envelope rule,
 * provisions on first use, and calls handleA2A on the raw stub.
 */
export async function dispatchToTenantInstance(opts: TenantDispatchOpts): Promise<unknown> {
  const instanceName = resolveTenantInstance(
    opts.base,
    opts.tenant.tenantId,
    opts.env as { TENANT_CUTOVER?: string },
  );
  const gate = checkDispatchEnvelope(opts.trace, instanceName);
  if (!gate.ok) throw new CrossTenantDispatchError(gate.reason ?? "cross-tenant dispatch rejected");
  await ensureTenantProvisioned(opts.env, opts.base, opts.tenant.tenantId, instanceName);
  const { getAgentByName } = await import("agents");
  const ns = (opts.env as Record<string, unknown>)[opts.binding] as
    | { idFromName(name: string): unknown }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function") {
    throw new Error(`${opts.binding} binding is not configured.`);
  }
  const stub = (await getAgentByName(ns as any, instanceName)) as unknown as {
    handleA2A: (body: unknown, origin: string) => Promise<unknown>;
  };
  return stub.handleA2A(withTracePart(opts.body, opts.trace), opts.origin);
}

/**
 * Raw (RPC-capable, never Proxy-wrapped) stub for a tenant's instance, for
 * the api.ts get*Agent helpers. Same resolution + provisioning as the A2A
 * path; no envelope assert (RPC callables are authorised at the route).
 */
export async function tenantAgentStub(
  env: unknown,
  binding: string,
  base: string,
  tenantId: string,
): Promise<{ stub: unknown; instanceName: string }> {
  const instanceName = resolveTenantInstance(
    base,
    tenantId,
    env as { TENANT_CUTOVER?: string },
  );
  await ensureTenantProvisioned(env, base, tenantId, instanceName);
  const { getAgentByName } = await import("agents");
  const ns = (env as Record<string, unknown>)[binding];
  if (!ns) throw new Error(`${binding} binding is not configured.`);
  const stub = await getAgentByName(ns as any, instanceName);
  return { stub, instanceName };
}
