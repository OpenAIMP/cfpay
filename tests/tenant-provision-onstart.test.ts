/**
 * Self-provisioning on tenant wake (issue #315).
 *
 * The dispatch seam seeds the (user, owner, tenant) tuple on first
 * in-process dispatch — but a tenant instance woken via /agents/*
 * WebSocket (routeAgentRequest → wake, no dispatch) never passes that
 * seam. Each tenantized agent self-provisions in onStart; this file pins
 * that the helper the onStart methods call does the right thing for every
 * entry path, stays idempotent, and leaves the operator behavior
 * byte-identical.
 *
 * Pure-agent-likes only — no Durable Objects. The tuple store goes through
 * the injected identity seam (mirroring ensureTenantProvisioned's deps).
 */
import { describe, expect, it } from "vitest";
import { selfProvisionOwnTenant } from "../src/tenant-provision";

function fakeIdentity() {
  const tuples = new Set<string>();
  const calls: string[] = [];
  const key = (st: string, si: string, r: string, ot: string, oi: string) =>
    `${st}:${si}:${r}:${ot}:${oi}`;
  return {
    calls,
    has: (k: string) => tuples.has(k),
    check: async (st: string, si: string, r: string, ot: string, oi: string) => {
      calls.push(`check:${key(st, si, r, ot, oi)}`);
      return tuples.has(key(st, si, r, ot, oi));
    },
    addTuple: async (st: string, si: string, r: string, ot: string, oi: string) => {
      calls.push(`add:${key(st, si, r, ot, oi)}`);
      tuples.add(key(st, si, r, ot, oi));
    },
  };
}

/** What a WS-woken tenant instance looks like to onStart: a wake, no dispatch. */
const woken = (name: string, env: unknown = {}) => ({
  env,
  ctx: { id: { name } },
});

describe("selfProvisionOwnTenant (issue #315)", () => {
  it("seeds the (user, owner, tenant) tuple on a WS wake with no dispatch", async () => {
    const identity = fakeIdentity();
    await selfProvisionOwnTenant(woken("chat:usr_onstart_1"), { identity });
    expect(identity.has("user:usr_onstart_1:owner:tenant:usr_onstart_1")).toBe(true);
    expect(identity.calls).toContain(
      "check:user:usr_onstart_1:owner:tenant:usr_onstart_1",
    );
    expect(identity.calls).toContain("add:user:usr_onstart_1:owner:tenant:usr_onstart_1");
  });

  it("is idempotent across repeated starts (no duplicate writes)", async () => {
    const identity = fakeIdentity();
    const agent = woken("email:usr_onstart_2");
    await selfProvisionOwnTenant(agent, { identity });
    await selfProvisionOwnTenant(agent, { identity });
    const adds = identity.calls.filter((c) => c.startsWith("add:"));
    expect(adds).toHaveLength(1);
  });

  it("is a no-op for the operator singleton (no identity calls at all)", async () => {
    const identity = fakeIdentity();
    await selfProvisionOwnTenant(woken("payments"), { identity });
    await selfProvisionOwnTenant(woken("agent"), { identity });
    expect(identity.calls).toEqual([]);
  });

  it("provisions regardless of env contents (no cutover kill switch remains, issue #346)", async () => {
    // Converted from the old kill-switch-off case: env used to be able to
    // suppress provisioning via the staged-rollout flag; that flag is gone,
    // so an arbitrary env object is inert and the wake provisions.
    const identity = fakeIdentity();
    await selfProvisionOwnTenant(woken("chat:usr_onstart_4", { SOME_LEGACY_FLAG: "none" }), {
      identity,
    });
    expect(identity.has("user:usr_onstart_4:owner:tenant:usr_onstart_4")).toBe(true);
  });

  it("covers every tenantized surface base", async () => {
    const identity = fakeIdentity();
    const bases = [
      "agent",
      "autopilot",
      "chat",
      "email",
      "orchestrator",
      "payments",
      "scheduler",
      "search",
      "slack",
      "webhooks",
      "desk",
    ];
    for (const base of bases) {
      await selfProvisionOwnTenant(woken(`${base}:usr_onstart_5`), { identity });
      expect(identity.has(`user:usr_onstart_5:owner:tenant:usr_onstart_5`)).toBe(true);
    }
    // The singleton qa base never provisions, even with a user suffix.
    await selfProvisionOwnTenant(woken("qa:usr_onstart_5"), { identity });
    expect(identity.calls.filter((c) => c.includes("qa:"))).toEqual([]);
  });

  it("a failing seed never blocks startup (the dispatch seam retries)", async () => {
    const agent = woken("search:usr_onstart_6");
    await expect(
      selfProvisionOwnTenant(agent, {
        identity: {
          check: async () => {
            throw new Error("identity store down");
          },
          addTuple: async () => {
            throw new Error("identity store down");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("missing instance name is a no-op (defensive)", async () => {
    const identity = fakeIdentity();
    await selfProvisionOwnTenant({ env: {} }, { identity });
    expect(identity.calls).toEqual([]);
  });
});
