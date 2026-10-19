/**
 * Tenant binding on WebSocket connection state (issue #316, audit ADOPT-SDK #2).
 *
 * The `/agents/*` edge (src/index.ts `onBeforeConnect`) enforces the
 * credential → tenant resolution and the tenant-vs-instance 403 BEFORE a
 * socket ever reaches the Durable Object. This module adds defense-in-depth
 * BEHIND that edge: each tenantized agent stamps the resolved tenant/user
 * onto the connection's own state in `onConnect`, using the SDK's
 * `connection.setState` with the functional updater form (so any existing
 * connection state is preserved, never clobbered).
 *
 * Identity is derived from the instance name — the same seam as #315's
 * onStart self-provisioning (`tenantOfInstance`): the edge guarantees the
 * credential's tenant matches the instance's tenant before the socket is
 * accepted, and tenant = user 1:1 in v1, so userId = tenantId here.
 *
 * Scope is deliberately narrow and honest:
 * - Stamping only. No authz decision events are emitted from here:
 *   `emitAuthzDecision` needs a declaration + check + correlationId, and the
 *   edge already made (and is the event site for) the connection's
 *   allow/deny decision. The stamp is the attribution source future
 *   per-message coverage consumes via `readTenantConnectionStamp`.
 * - Operator singletons are never stamped (nothing to bind; the legacy
 *   path stays byte-identical).
 * - The `cutoverEnabled` guard is the defensive re-check behind the edge
 *   403: a tenant-suffixed instance name should only exist when its base
 *   is cut over; anything else stamps nothing.
 * - First stamp wins: a connection already stamped with a DIFFERENT
 *   tenantId keeps the original — a connection cannot be restamped to a
 *   new tenant.
 * - Stamping never throws and never blocks connect.
 *
 * Top level is SDK-free (only `import type` from "agents", erased at
 * compile), so this module stays importable from Vitest — same convention
 * as src/tenant-provision.ts.
 */

import {
  cutoverEnabled,
  isOperatorTenant,
  tenantOfInstance,
  type CutoverEnv,
} from "./tenancy";

/** Connection-state key carrying the stamp (namespaced to avoid collisions). */
export const TENANT_CONNECTION_STATE_KEY = "tenant";

/** What onConnect records on the connection. Structured-cloneable. */
export interface TenantConnectionStamp {
  tenantId: string;
  /** tenant = user 1:1 in v1; the edge binds credential tenant to instance tenant. */
  userId: string;
  stampedAt: number;
  instanceName: string;
}

/** The only surface of a WebSocket connection this helper needs. */
export interface ConnectionLike {
  setState(state: unknown): unknown;
  state?: unknown;
}

/** The only surface of an agent this helper needs: env + instance name. */
export interface StampableAgentLike {
  env: unknown;
  ctx?: { id?: { name?: string } };
}

/**
 * Derive the stamp for an instance name, or null when nothing should be
 * stamped (operator singleton, cutover off for this base, missing name).
 * Pure — safe to unit test without a DO.
 */
export function stampForInstance(
  instanceName: string | undefined | null,
  env: unknown,
): TenantConnectionStamp | null {
  if (!instanceName) return null;
  const { base, tenantId } = tenantOfInstance(instanceName);
  if (isOperatorTenant(tenantId)) return null;
  if (!cutoverEnabled(base, env as CutoverEnv | null)) return null;
  return {
    tenantId,
    userId: tenantId,
    stampedAt: Date.now(),
    instanceName,
  };
}

/**
 * Read a previously stamped identity off a connection. Returns null when
 * the connection carries no (valid) stamp. The reader future per-message
 * attribution consumes — no DO access required.
 */
export function readTenantConnectionStamp(
  connection: ConnectionLike,
): TenantConnectionStamp | null {
  const s = connection.state;
  if (!s || typeof s !== "object") return null;
  const raw = (s as Record<string, unknown>)[TENANT_CONNECTION_STATE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<TenantConnectionStamp>;
  if (typeof t.tenantId !== "string" || !t.tenantId) return null;
  return {
    tenantId: t.tenantId,
    userId: typeof t.userId === "string" && t.userId ? t.userId : t.tenantId,
    stampedAt: typeof t.stampedAt === "number" ? t.stampedAt : 0,
    instanceName: typeof t.instanceName === "string" ? t.instanceName : "",
  };
}

/**
 * Stamp this instance's tenant identity onto a newly connected socket.
 * Call from the tenant agents' `onConnect`, before/after the super call:
 *
 *   async onConnect(connection: Connection, context: { request: Request }) {
 *     await stampTenantOnConnection({ env: this.env, ctx: this.ctx }, connection);
 *     await super.onConnect?.(connection, context);
 *   }
 *
 * Idempotent (re-stamping the same tenant is a no-op); a connection already
 * stamped with a DIFFERENT tenant keeps its original stamp — it can never
 * be restamped. Never throws: a stamping failure degrades to "unstamped",
 * exactly like the pre-#316 world, and the edge 401/403 still guards the
 * door.
 */
export async function stampTenantOnConnection(
  agent: StampableAgentLike,
  connection: ConnectionLike,
): Promise<TenantConnectionStamp | null> {
  const name = agent.ctx?.id?.name;
  const stamp = stampForInstance(name, agent.env);
  if (!stamp) return null;
  try {
    const existing = readTenantConnectionStamp(connection);
    if (existing) return existing;
    await connection.setState((prev: unknown) => {
      const prevObj =
        prev && typeof prev === "object" ? (prev as Record<string, unknown>) : {};
      return { ...prevObj, [TENANT_CONNECTION_STATE_KEY]: stamp };
    });
    return stamp;
  } catch {
    return null;
  }
}
