/**
 * Tenant-isolation suite (issue #252 P3, design §7.2).
 *
 * Matrix: surfaces × attack shapes —
 *  1. guessed ids (401/403/404-without-leak),
 *  2. cross-tenant correlation replay,
 *  3. stale singleton fallback (a tenant must never fall back to a
 *     shared singleton),
 *  4. shared-cache identity (a cached validity never confers identity),
 *  5. secret isolation (instance separation),
 *  6. budget isolation (budgets live in the per-tenant host instance),
 *  7. FGA negatives (viewer can't approve; actor_for scoping; revoked
 *     sessions inert),
 * plus the P3 machinery: tenancy resolution, unconditional per-tenant
 * resolution, first-use provisioning + migration_fallback, and the A2A
 * edge identity.
 *
 * Pure modules only — no Durable Objects. Tuple-store interactions go
 * through the injected seams (enforceAuthz tupleCheck/tupleAdd,
 * ensureTenantProvisioned deps.identity, resolveA2AIdentity
 * deps.sessionBackend).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  OPERATOR_TENANT_ID,
  TENANT_SINGLETON_BASES,
  checkDispatchEnvelope,
  instanceFor,
  isOperatorTenant,
  ownTenantId,
  resolveTenant,
  resolveTenantInstance,
  tenantFromAuthDecision,
  tenantOfInstance,
} from "../src/tenancy";
import * as tenancy from "../src/tenancy";
import {
  emitAuthzDecision,
  enforceAuthz,
  enforceObjectAuthz,
  findHttpDeclaration,
  findOperationDeclaration,
  instantiateDeclaration,
  subjectForIdentity,
  type AuthzIdentity,
} from "../src/aspect-authz";
import {
  accountingEvent,
  extractTracePart,
  replaceTracePart,
  setAspectEventSink,
  setOutcomeLedgerSink,
  withTracePart,
  type AspectEvent,
  type AspectTrace,
} from "../src/aspect-logging";
import { ensureTenantProvisioned } from "../src/tenant-dispatch";
import { resolveA2AIdentity } from "../src/a2a-identity";
import { a2aOperationFromBody, qaOperationAccess } from "../src/a2a-ops";

const UID_A = "usr_aaaa1111";
const UID_B = "usr_bbbb2222";

let captured: AspectEvent[];
let ledger: AspectEvent[];
beforeEach(() => {
  captured = [];
  ledger = [];
  setAspectEventSink((e) => captured.push(e));
  setOutcomeLedgerSink((e) => ledger.push(e));
});
afterEach(() => {
  setAspectEventSink(null);
  setOutcomeLedgerSink(null);
});

/** In-memory tuple store for the injected enforceAuthz seams. */
function fakeTuples(initial: Array<[string, string, string, string, string]> = []) {
  const set = new Set(initial.map((t) => t.join("|")));
  return {
    check: async (st: string, si: string, r: string, ot: string, oi: string) =>
      set.has([st, si, r, ot, oi].join("|")),
    addTuple: async (st: string, si: string, r: string, ot: string, oi: string) => {
      set.add([st, si, r, ot, oi].join("|"));
    },
    has: (st: string, si: string, r: string, ot: string, oi: string) =>
      set.has([st, si, r, ot, oi].join("|")),
  };
}

const operatorIdentity: AuthzIdentity = {
  kind: "operator",
  tenantId: OPERATOR_TENANT_ID,
  userId: OPERATOR_TENANT_ID,
  role: "operator",
};
const userAIdentity: AuthzIdentity = {
  kind: "session",
  tenantId: UID_A,
  userId: UID_A,
  role: "owner",
};

function traceFor(tenantId: string): AspectTrace {
  return { correlationId: "corr-1", tenantId, userId: tenantId };
}

describe("tenancy resolution (P3)", () => {
  it("API key / dashboard key → operator tenant", () => {
    expect(resolveTenant({ kind: "operator-key" })).toEqual({
      tenantId: "operator",
      userId: "operator",
      identityKind: "operator",
    });
  });

  it("app_session → user → tenant (tenant = user 1:1)", () => {
    expect(resolveTenant({ kind: "session", userId: UID_A, tenantId: UID_A })).toEqual({
      tenantId: UID_A,
      userId: UID_A,
      identityKind: "session",
    });
  });

  it("MCP JWT → tenant_id claim bound to sub", () => {
    const r = resolveTenant({ kind: "mcp-jwt", sub: UID_A, tenantId: UID_A });
    expect(r.tenantId).toBe(UID_A);
    expect(r.userId).toBe(UID_A);
    expect(r.identityKind).toBe("jwt");
  });

  it("MCP JWT without tenant_id falls back to the operator tenant (P1/P2 behavior)", () => {
    expect(resolveTenant({ kind: "mcp-jwt", sub: "operator", tenantId: "" }).tenantId).toBe(
      "operator",
    );
  });

  it("oauth-legacy cookie → operator tenant (legacy owner path)", () => {
    expect(resolveTenant({ kind: "oauth-legacy" }).tenantId).toBe("operator");
  });

  it("anonymous → operator tenant", () => {
    expect(resolveTenant({ kind: "anonymous" }).tenantId).toBe("operator");
  });

  it("tenantFromAuthDecision maps the require-auth kinds", () => {
    expect(
      tenantFromAuthDecision({ kind: "session", userId: UID_A, tenantId: UID_A }).tenantId,
    ).toBe(UID_A);
    expect(
      tenantFromAuthDecision({ kind: "operator", userId: "operator", tenantId: "operator" })
        .tenantId,
    ).toBe("operator");
    expect(
      tenantFromAuthDecision({ kind: "oauth-legacy", userId: "legacy:x", tenantId: "operator" })
        .tenantId,
    ).toBe("operator");
  });

  it("tenantOfInstance parses <base>:<uid>; no colon → operator singleton", () => {
    expect(tenantOfInstance("scheduler:usr_abc123")).toEqual({
      base: "scheduler",
      tenantId: "usr_abc123",
    });
    expect(tenantOfInstance("agent")).toEqual({ base: "agent", tenantId: "operator" });
    expect(tenantOfInstance("qa")).toEqual({ base: "qa", tenantId: "operator" });
    expect(tenantOfInstance("desk:usr_abc123")).toEqual({
      base: "desk",
      tenantId: "usr_abc123",
    });
  });

  it("instanceFor is the identity on the operator tenant", () => {
    expect(instanceFor("scheduler", "operator")).toBe("scheduler");
    expect(instanceFor("scheduler", "")).toBe("scheduler");
    expect(instanceFor("scheduler", UID_A)).toBe(`scheduler:${UID_A}`);
  });

  it("ownTenantId reads the instance name, falling back to operator", () => {
    expect(ownTenantId("autopilot:usr_abc123")).toBe("usr_abc123");
    expect(ownTenantId("scheduler")).toBe("operator");
    expect(ownTenantId(undefined)).toBe("operator");
    expect(ownTenantId("")).toBe("operator");
  });

  it("isOperatorTenant", () => {
    expect(isOperatorTenant("operator")).toBe(true);
    expect(isOperatorTenant("")).toBe(true);
    expect(isOperatorTenant(UID_A)).toBe(false);
  });
});

describe("per-tenant resolution is unconditional (issue #346)", () => {
  // The staged-rollout flag that gated P3's per-tenant resolution was
  // removed once its staging condition (two consecutive green deploys
  // post-P3) was verified met. These pins replace the old flag-semantics
  // suite: there is no env input left to consult, so the behavior that
  // production ran with the flag at "all" is now the only behavior.
  it("the staged-rollout flag helper no longer exists", () => {
    expect((tenancy as Record<string, unknown>).cutoverEnabled).toBeUndefined();
  });

  it("every cut-over base resolves per-tenant, for every tenant", () => {
    for (const base of ["scheduler", "autopilot", "agent", "slack", "chat"]) {
      expect(resolveTenantInstance(base, UID_A)).toBe(`${base}:${UID_A}`);
      expect(resolveTenantInstance(base, UID_B)).toBe(`${base}:${UID_B}`);
    }
  });

  it("operator keeps the singleton (identity mapping, no data moves)", () => {
    expect(resolveTenantInstance("scheduler", "operator")).toBe("scheduler");
    expect(resolveTenantInstance("agent", "operator")).toBe("agent");
    expect(resolveTenantInstance("agent", "")).toBe("agent");
  });

  it("qa is never per-tenant (permanent singleton base, not rollout staging)", () => {
    expect(TENANT_SINGLETON_BASES.has("qa")).toBe(true);
    expect(resolveTenantInstance("qa", UID_A)).toBe("qa");
    expect(resolveTenantInstance("qa", UID_B)).toBe("qa");
  });

  it("a guessed tenant id resolves only to its own instance name", () => {
    // Tenant A cannot make resolution return tenant B's instance.
    expect(resolveTenantInstance("agent", UID_A)).not.toBe(`agent:${UID_B}`);
    expect(resolveTenantInstance("agent", UID_A)).toBe(`agent:${UID_A}`);
  });
});

describe("cross-tenant envelope rule", () => {
  it("same-tenant dispatch is allowed", () => {
    expect(checkDispatchEnvelope(traceFor(UID_A), `scheduler:${UID_A}`).ok).toBe(true);
  });

  it("tenant A's trace to tenant B's instance is rejected (bite-proven)", () => {
    const r = checkDispatchEnvelope(traceFor(UID_A), `scheduler:${UID_B}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(UID_A);
    expect(r.reason).toContain(UID_B);
  });

  it("operator trace to a user instance is rejected", () => {
    expect(checkDispatchEnvelope(traceFor("operator"), `agent:${UID_A}`).ok).toBe(false);
  });

  it("cross-tenant dispatch to operator singletons is allowed (qa read-only is separate)", () => {
    expect(checkDispatchEnvelope(traceFor(UID_A), "qa").ok).toBe(true);
    expect(checkDispatchEnvelope(traceFor(UID_A), "agent").ok).toBe(true);
  });

  it("a missing trace is treated as the operator identity (today's in-process default)", () => {
    expect(checkDispatchEnvelope(null, "scheduler").ok).toBe(true);
    expect(checkDispatchEnvelope(undefined, `scheduler:${UID_A}`).ok).toBe(false);
    expect(checkDispatchEnvelope({} as AspectTrace, `scheduler:${UID_A}`).ok).toBe(false);
  });

  it("replaceTracePart strips a forged trace part before appending the true one", () => {
    const forged = {
      jsonrpc: "2.0",
      params: {
        message: {
          parts: [
            { kind: "data", data: { _trace: traceFor(UID_B) } },
            { kind: "text", text: "scheduled.list" },
          ],
        },
      },
    };
    const replaced = replaceTracePart(forged, traceFor(UID_A)) as {
      params: { message: { parts: unknown[] } };
    };
    const { trace, parts } = extractTracePart(replaced.params.message.parts);
    expect(trace?.tenantId).toBe(UID_A);
    // The forged part is gone; the text part survives.
    expect(parts).toHaveLength(1);
  });

  it("withTracePart bodies keep working for fresh in-process dispatches", () => {
    const body = {
      params: { message: { parts: [{ kind: "text", text: "scheduled.list" }] } },
    };
    const withTrace = withTracePart(body, traceFor(UID_A)) as {
      params: { message: { parts: unknown[] } };
    };
    const { trace } = extractTracePart(withTrace.params.message.parts);
    expect(trace?.tenantId).toBe(UID_A);
  });
});

describe("FGA check points (design §2.4/§5.4)", () => {
  it("declarations are tenant-parameterized via {tenant}", () => {
    const decl = findHttpDeclaration("POST", "/api/dashboard/scheduled-goals")!;
    expect(decl.objectId).toBe("{tenant}");
    expect(instantiateDeclaration(decl, { tenantId: UID_A })).toEqual({
      objectType: "tenant",
      objectId: UID_A,
      relation: "owner",
    });
    const trade = instantiateDeclaration(
      findHttpDeclaration("POST", "/api/public/trades/:id/decision")!,
      { tenantId: UID_A, id: "prop-1" },
    );
    expect(trade).toEqual({
      objectType: "trade_proposal",
      objectId: "prop-1",
      relation: "approver",
    });
    expect(
      instantiateDeclaration(findOperationDeclaration("slack.post")!, { tenantId: UID_B }),
    ).toEqual({ objectType: "tenant", objectId: UID_B, relation: "owner" });
  });

  it("subjectForIdentity maps edge identities to FGA subjects", () => {
    expect(subjectForIdentity(operatorIdentity)).toEqual({
      subjectType: "identity",
      subjectId: "operator",
    });
    expect(subjectForIdentity(userAIdentity)).toEqual({
      subjectType: "user",
      subjectId: UID_A,
    });
    expect(
      subjectForIdentity({
        kind: "jwt",
        tenantId: UID_A,
        userId: "sub-1",
        role: "viewer",
        tokenId: "jti-1",
      }),
    ).toEqual({ subjectType: "token", subjectId: "jti-1" });
  });

  it("trade decision: the tenant owner is allowed, and the allow is accounted", async () => {
    const tuples = fakeTuples([["user", UID_A, "owner", "tenant", UID_A]]);
    const check = await enforceObjectAuthz(
      userAIdentity,
      UID_A,
      { objectType: "trade_proposal", objectId: "prop-1", relation: "approver" },
      {
        correlationId: "c1",
        tupleCheck: tuples.check,
        tupleAdd: tuples.addTuple,
      },
    );
    expect(check.allow).toBe(true);
    // Backfill seeded the approver tuple for the owner.
    expect(tuples.has("user", UID_A, "approver", "trade_proposal", "prop-1")).toBe(true);
    // Every decision accounted: object deny → owner allow → backfill allow.
    const ops = ledger.map((e) => e.operation);
    expect(ops).toContain("authz.allow");
    expect(ledger.filter((e) => e.operation === "authz.deny")).toHaveLength(1);
  });

  it("trade decision: the operator (dashboard key) approves via the owner bootstrap", async () => {
    // The operator's pre-P3 proposals carry no tuples; the generic
    // owner-backfill path adopts them: (identity,operator,owner,
    // tenant:operator) bootstraps, then the approver tuple seeds.
    const tuples = fakeTuples();
    const check = await enforceObjectAuthz(
      operatorIdentity,
      OPERATOR_TENANT_ID,
      { objectType: "trade_proposal", objectId: "prop-op", relation: "approver" },
      { correlationId: "c11", tupleCheck: tuples.check, tupleAdd: tuples.addTuple },
    );
    expect(check.allow).toBe(true);
    expect(tuples.has("identity", "operator", "owner", "tenant", "operator")).toBe(true);
    expect(tuples.has("identity", "operator", "approver", "trade_proposal", "prop-op")).toBe(true);
  });

  it("trade decision: another tenant's user is denied without leak", async () => {
    const tuples = fakeTuples([
      ["user", UID_A, "owner", "tenant", UID_A],
      ["user", UID_B, "owner", "tenant", UID_B],
    ]);
    const userB: AuthzIdentity = { kind: "session", tenantId: UID_B, userId: UID_B, role: "owner" };
    const check = await enforceObjectAuthz(
      userB,
      UID_A,
      { objectType: "trade_proposal", objectId: "prop-1", relation: "approver" },
      { correlationId: "c2", tupleCheck: tuples.check, tupleAdd: tuples.add },
    );
    expect(check.allow).toBe(false);
    // No tuple was seeded for the denied caller.
    expect(tuples.has("user", UID_B, "approver", "trade_proposal", "prop-1")).toBe(false);
    expect(ledger.some((e) => e.operation === "authz.deny")).toBe(true);
  });

  it("FGA negative: a viewer (no owner tuple) cannot approve", async () => {
    const tuples = fakeTuples();
    const viewer: AuthzIdentity = {
      kind: "session",
      tenantId: UID_A,
      userId: "usr_viewer9",
      role: "viewer",
    };
    const check = await enforceObjectAuthz(
      viewer,
      UID_A,
      { objectType: "trade_proposal", objectId: "prop-9", relation: "approver" },
      { correlationId: "c3", tupleCheck: tuples.check, tupleAdd: tuples.add },
    );
    expect(check.allow).toBe(false);
    expect(check.decision).toEqual({
      relation: "approver",
      object: "trade_proposal:prop-9",
      allow: false,
    });
  });

  it("FGA negative: actor_for token scoped to objective X cannot touch Y", async () => {
    const tuples = fakeTuples([["token", "jti-x", "actor_for", "objective", UID_A]]);
    const tokenX: AuthzIdentity = {
      kind: "jwt",
      tenantId: UID_A,
      userId: "jti-x",
      role: "viewer",
      tokenId: "jti-x",
    };
    const allowX = await enforceAuthz(
      tokenX,
      { objectType: "objective", objectId: UID_A, relation: "actor_for" },
      { correlationId: "c4", tupleCheck: tuples.check },
    );
    expect(allowX.allow).toBe(true);
    const denyY = await enforceAuthz(
      tokenX,
      { objectType: "objective", objectId: UID_B, relation: "actor_for" },
      { correlationId: "c5", tupleCheck: tuples.check },
    );
    expect(denyY.allow).toBe(false);
    expect(denyY.decision.object).toBe(`objective:${UID_B}`);
  });

  it("FGA negative: a token from another tenant cannot write here", async () => {
    const tuples = fakeTuples([["token", "jti-b", "actor_for", "tenant", UID_B]]);
    const tokenB: AuthzIdentity = {
      kind: "jwt",
      tenantId: UID_B,
      userId: "jti-b",
      role: "viewer",
      tokenId: "jti-b",
    };
    const check = await enforceAuthz(
      tokenB,
      { objectType: "tenant", objectId: UID_A, relation: "actor_for" },
      { correlationId: "c6", tupleCheck: tuples.check },
    );
    expect(check.allow).toBe(false);
  });

  it("deny-by-default: a tuple-store outage denies, never allows", async () => {
    const check = await enforceAuthz(
      userAIdentity,
      { objectType: "tenant", objectId: UID_A, relation: "owner" },
      {
        correlationId: "c7",
        tupleCheck: async () => {
          throw new Error("store down");
        },
      },
    );
    expect(check.allow).toBe(false);
    expect(ledger.some((e) => e.operation === "authz.deny")).toBe(true);
  });

  it("every decision — allow and deny — is emitted to the accounting sink", async () => {
    const tuples = fakeTuples([["identity", "operator", "owner", "tenant", "operator"]]);
    await enforceAuthz(
      operatorIdentity,
      { objectType: "tenant", objectId: "operator", relation: "owner" },
      { correlationId: "c8", tupleCheck: tuples.check },
    );
    await enforceAuthz(
      userAIdentity,
      { objectType: "tenant", objectId: "operator", relation: "owner" },
      { correlationId: "c9", tupleCheck: tuples.check },
    );
    expect(ledger.map((e) => e.operation)).toEqual(["authz.allow", "authz.deny"]);
    expect(ledger[0].authDecision).toEqual({
      relation: "owner",
      object: "tenant:operator",
      allow: true,
    });
    expect(ledger[1].outcome).toBe("denied");
  });

  it("scheduled-goal delete honors a pre-seeded object tuple", async () => {
    const tuples = fakeTuples([
      ["user", UID_A, "owner", "tenant", UID_A],
      ["user", UID_A, "owner", "scheduled_goal", "sched-1"],
    ]);
    const check = await enforceObjectAuthz(
      userAIdentity,
      UID_A,
      { objectType: "scheduled_goal", objectId: "sched-1", relation: "owner" },
      { correlationId: "c10", tupleCheck: tuples.check, tupleAdd: tuples.add },
    );
    expect(check.allow).toBe(true);
    // Direct hit: no backfill needed, single allow event.
    expect(ledger.map((e) => e.operation)).toEqual(["authz.allow"]);
  });
});

describe("first-use provisioning + migration_fallback", () => {
  // NOTE: ensureTenantProvisioned caches per isolate+test-process; use
  // distinct tenant ids per test so the cache does not cross tests.
  it("seeds (user, owner, tenant) and emits migration_fallback on first use", async () => {
    const tuples = fakeTuples();
    const tenant = "usr_prov1";
    await ensureTenantProvisioned({}, "scheduler", tenant, `scheduler:${tenant}`, {
      identity: tuples,
    });
    expect(tuples.has("user", tenant, "owner", "tenant", tenant)).toBe(true);
    const fallback = ledger.find((e) => e.operation === "migration_fallback");
    expect(fallback).toBeDefined();
    expect(fallback?.tenantId).toBe(tenant);
    expect(fallback?.detail).toMatchObject({ reason: "first-use-provisioning" });
  });

  it("no event when the tenant already has its tuple (not first use)", async () => {
    const tenant = "usr_prov2";
    const tuples = fakeTuples([["user", tenant, "owner", "tenant", tenant]]);
    await ensureTenantProvisioned({}, "scheduler", tenant, `scheduler:${tenant}`, {
      identity: tuples,
    });
    expect(ledger.some((e) => e.operation === "migration_fallback")).toBe(false);
  });

  it("operator tenant, singleton-named instances, and singleton bases provision nothing", async () => {
    const tuples = fakeTuples();
    await ensureTenantProvisioned({}, "scheduler", "operator", "scheduler", {
      identity: tuples,
    });
    // Converted from the old flag-off case (issue #346): with the staged
    // flag gone, an explicitly singleton instance name is what provisions
    // nothing — resolution itself no longer has an "off" mode.
    await ensureTenantProvisioned({}, "scheduler", "usr_prov3", "scheduler", {
      identity: tuples,
    });
    await ensureTenantProvisioned({}, "qa", "usr_prov4", "qa", { identity: tuples });
    expect(ledger).toHaveLength(0);
  });

  it("a seed failure is logged and retried later — never half-visible", async () => {
    const tenant = "usr_prov5";
    let calls = 0;
    const flaky = {
      check: async () => false,
      addTuple: async () => {
        calls++;
        if (calls === 1) throw new Error("identity store down");
      },
    };
    await ensureTenantProvisioned({}, "scheduler", tenant, `scheduler:${tenant}`, {
      identity: flaky,
    });
    // First attempt failed: nothing cached as ready, no fallback event.
    expect(ledger.some((e) => e.operation === "migration_fallback")).toBe(false);
    // Retry succeeds and emits.
    await ensureTenantProvisioned({}, "scheduler", tenant, `scheduler:${tenant}`, {
      identity: flaky,
    });
    expect(calls).toBe(2);
    expect(ledger.some((e) => e.operation === "migration_fallback")).toBe(true);
  });
});

describe("A2A edge identity", () => {
  const env = { DASHBOARD_API_KEY: "test-key-123", MCP_JWT_SECRET: "" };

  function req(headers: Record<string, string> = {}, cookie = ""): Request {
    const h = new Headers(headers);
    if (cookie) h.set("Cookie", cookie);
    return new Request("https://x.test/a2a/scheduled", { method: "POST", headers: h });
  }

  it("dashboard key → operator tenant", async () => {
    const id = await resolveA2AIdentity(
      req({ Authorization: "Bearer test-key-123" }),
      env as never,
    );
    expect(id?.tenantId).toBe("operator");
    expect(id?.source).toBe("operator-key");
  });

  it("X-API-Key also → operator tenant", async () => {
    const id = await resolveA2AIdentity(req({ "X-API-Key": "test-key-123" }), env as never);
    expect(id?.tenantId).toBe("operator");
  });

  it("app_session cookie → that user's tenant", async () => {
    const backend = {
      validateSession: async (token: string) =>
        token === "sess-valid"
          ? { session: {}, user: { id: UID_A, primaryEmail: null } }
          : null,
      revokeSession: async () => {},
      loginComplete: async () => {
        throw new Error("unused");
      },
    };
    const id = await resolveA2AIdentity(req({}, "app_session=sess-valid"), env as never, {
      sessionBackend: backend as never,
    });
    expect(id?.tenantId).toBe(UID_A);
    expect(id?.userId).toBe(UID_A);
    expect(id?.source).toBe("session");
  });

  it("revoked session → unauthenticated (tuples never consulted)", async () => {
    const backend = {
      validateSession: async () => null,
      revokeSession: async () => {},
      loginComplete: async () => {
        throw new Error("unused");
      },
    };
    const id = await resolveA2AIdentity(req({}, "app_session=sess-revoked"), env as never, {
      sessionBackend: backend as never,
    });
    expect(id).toBeNull();
  });

  it("no credential → null (401 behavior unchanged)", async () => {
    expect(await resolveA2AIdentity(req(), env as never)).toBeNull();
  });

  it("wrong key → null", async () => {
    expect(
      await resolveA2AIdentity(req({ Authorization: "Bearer wrong" }), env as never),
    ).toBeNull();
  });
});

describe("qa read-only gate inputs", () => {
  it("a2aOperationFromBody reads the data part first, then text", () => {
    const body = {
      params: {
        message: {
          parts: [
            { kind: "text", text: "qa.summary" },
            { kind: "data", data: { operation: "qa.check", url: "https://x" } },
          ],
        },
      },
    };
    expect(a2aOperationFromBody(body)).toBe("qa.check");
    expect(
      a2aOperationFromBody({ params: { message: { parts: [{ kind: "text", text: "qa.summary" }] } } }),
    ).toBe("qa.summary");
    expect(a2aOperationFromBody({})).toBeNull();
  });

  it("qaOperationAccess: only qa.summary is read-class", () => {
    expect(qaOperationAccess("qa.summary")).toBe("read");
    expect(qaOperationAccess("qa.check")).toBe("action");
    expect(qaOperationAccess("qa.ux_audit")).toBe("action");
    expect(qaOperationAccess("qa.nope")).toBeNull();
    expect(qaOperationAccess(null)).toBeNull();
  });
});

describe("shared-cache identity", () => {
  it("resolveTenant is pure: no shared state can confer another tenant's identity", () => {
    const a = resolveTenant({ kind: "session", userId: UID_A, tenantId: UID_A });
    const b = resolveTenant({ kind: "session", userId: UID_B, tenantId: UID_B });
    expect(a.tenantId).toBe(UID_A);
    expect(b.tenantId).toBe(UID_B);
    // Re-resolving A after B still yields A — nothing cached crosses.
    expect(resolveTenant({ kind: "session", userId: UID_A, tenantId: UID_A }).tenantId).toBe(
      UID_A,
    );
  });

  it("a JWT's tenant comes only from its own claims", () => {
    const t1 = resolveTenant({ kind: "mcp-jwt", sub: "s1", tenantId: UID_A });
    const t2 = resolveTenant({ kind: "mcp-jwt", sub: "s2", tenantId: UID_B });
    expect(t1.tenantId).toBe(UID_A);
    expect(t2.tenantId).toBe(UID_B);
  });
});

describe("secret + budget isolation via instance separation", () => {
  it("two tenants never share a host instance (budgets, tokens, hunts live there)", () => {
    const a = resolveTenantInstance("agent", UID_A);
    const b = resolveTenantInstance("agent", UID_B);
    expect(a).not.toBe(b);
    expect(new Set([a, b]).size).toBe(2);
  });

  it("per-tenant instances for every stateful surface", () => {
    for (const base of [
      "agent",
      "email",
      "payments",
      "webhooks",
      "slack",
      "chat",
      "desk",
      "search",
      "orchestrator",
      "scheduler",
      "autopilot",
    ]) {
      expect(resolveTenantInstance(base, UID_A)).toBe(`${base}:${UID_A}`);
    }
  });

  it("qa, cards-adjacent globals, and the operator stay singleton", () => {
    expect(resolveTenantInstance("qa", UID_A)).toBe("qa");
    expect(resolveTenantInstance("agent", "operator")).toBe("agent");
  });
});

describe("accounting taxonomy", () => {
  it("migration_fallback is a first-class accounting event", () => {
    const e = accountingEvent("migration_fallback", {
      tenantId: UID_A,
      userId: UID_A,
      correlationId: "c",
      agent: "scheduler",
    });
    expect(e.operation).toBe("migration_fallback");
    expect(e.outcome).toBe("ok");
  });

  it("emitAuthzDecision emits both allows and denies", () => {
    emitAuthzDecision(
      operatorIdentity,
      { objectType: "tenant", objectId: "operator", relation: "owner" },
      { allow: true, decision: { relation: "owner", object: "tenant:operator", allow: true } },
      { correlationId: "e1" },
    );
    emitAuthzDecision(
      userAIdentity,
      { objectType: "tenant", objectId: "operator", relation: "owner" },
      { allow: false, decision: { relation: "owner", object: "tenant:operator", allow: false } },
      { correlationId: "e2" },
    );
    expect(captured.map((e) => e.operation)).toEqual(["authz.allow", "authz.deny"]);
  });
});
