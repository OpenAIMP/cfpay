import { describe, expect, it } from "vitest";
import {
  budgetDayKey,
  budgetRefusal,
  budgetSnapshot,
  envDerivedPolicy,
  freshBudgetState,
  loadBudgetState,
  makeBudgetRequest,
  recordBudgetSpend,
  saveBudgetPolicy,
  transitionBudgetState,
  validateOutboundPayment,
  type BudgetPolicy,
  type BudgetSql,
  type OutboundPaymentRequest,
} from "../src/budget-guard";

const DAY = "2026-10-17";
const policy = (overrides: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  dailyCap: 10_000_000,
  perCallCap: 1_000_000,
  enforceAllowlist: false,
  allowlist: [],
  strictAllowlist: true,
  agentCaps: { research: 2_000_000 },
  agentPerCallCaps: { research: 500_000 },
  ...overrides,
});
const req = (overrides: Partial<OutboundPaymentRequest> = {}): OutboundPaymentRequest => ({
  id: "attempt-1",
  agentId: "host",
  serviceId: "api.example.com",
  recipient: "0xRecipient",
  amount: 100_000,
  timestamp: "2026-10-17T12:00:00.000Z",
  dayKey: DAY,
  ...overrides,
});

describe("budget guard validator (issue #211)", () => {
  it("allows a payment inside every cap", () => {
    const r = validateOutboundPayment(req(), policy(), freshBudgetState(DAY));
    expect(r.allowed).toBe(true);
    expect(r.remainingDaily).toBe(9_900_000);
  });

  it("refuses over the per-call cap, honoring the agent override", () => {
    expect(validateOutboundPayment(req({ amount: 1_000_001 }), policy(), freshBudgetState(DAY)).code).toBe(
      "PER_CALL_CAP_EXCEEDED",
    );
    expect(
      validateOutboundPayment(req({ agentId: "research", amount: 600_000 }), policy(), freshBudgetState(DAY)).code,
    ).toBe("PER_CALL_CAP_EXCEEDED");
    expect(
      validateOutboundPayment(req({ agentId: "research", amount: 500_000 }), policy(), freshBudgetState(DAY)).allowed,
    ).toBe(true);
  });

  it("refuses when the daily cap would break, and says EXHAUSTED at zero", () => {
    const state = { ...freshBudgetState(DAY), totalSpent: 9_950_000 };
    expect(validateOutboundPayment(req(), policy(), state).code).toBe("DAILY_CAP_EXCEEDED");
    const drained = { ...freshBudgetState(DAY), totalSpent: 10_000_000 };
    expect(validateOutboundPayment(req(), policy(), drained).code).toBe("DAILY_BUDGET_EXHAUSTED");
  });

  it("refuses when the agent's own daily cap would break", () => {
    const state = {
      ...freshBudgetState(DAY),
      totalSpent: 1_960_000,
      spentByAgent: { research: 1_960_000 },
    };
    const r = validateOutboundPayment(req({ agentId: "research", amount: 100_000 }), policy(), state);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("AGENT_DAILY_CAP_EXCEEDED");
  });

  it("enforces the allowlist strictly, and denies an enforced-but-empty list", () => {
    const p = policy({ enforceAllowlist: true, allowlist: ["0xRecipient"] });
    expect(validateOutboundPayment(req(), p, freshBudgetState(DAY)).allowed).toBe(true);
    expect(validateOutboundPayment(req({ recipient: "0xOther" }), p, freshBudgetState(DAY)).code).toBe(
      "SERVICE_NOT_ALLOWED",
    );
    const empty = policy({ enforceAllowlist: true, allowlist: [] });
    expect(validateOutboundPayment(req(), empty, freshBudgetState(DAY)).allowed).toBe(false);
  });

  it("rejects invalid amounts, day mismatches and broken policies", () => {
    expect(validateOutboundPayment(req({ amount: 0 }), policy(), freshBudgetState(DAY)).code).toBe("INVALID_AMOUNT");
    expect(validateOutboundPayment(req({ amount: 1.5 }), policy(), freshBudgetState(DAY)).code).toBe("INVALID_AMOUNT");
    expect(validateOutboundPayment(req(), policy(), freshBudgetState("2026-10-18")).code).toBe("INVALID_AMOUNT");
    expect(validateOutboundPayment(req(), policy({ dailyCap: -1 }), freshBudgetState(DAY)).code).toBe(
      "POLICY_NOT_CONFIGURED",
    );
  });

  it("treats a replayed attempt id as allowed without double-counting", () => {
    const state = transitionBudgetState(policy(), freshBudgetState(DAY), req());
    expect(state.totalSpent).toBe(100_000);
    expect(state.callCount).toBe(1);
    const replay = validateOutboundPayment(req(), policy(), state);
    expect(replay.allowed).toBe(true);
    expect(replay.reason).toContain("idempotent");
    const again = transitionBudgetState(policy(), state, req());
    expect(again.totalSpent).toBe(100_000);
    expect(again.callCount).toBe(1);
  });

  it("budgetRefusal renders the named code", () => {
    expect(budgetRefusal(policy(), freshBudgetState(DAY), req())).toBeNull();
    expect(budgetRefusal(policy(), freshBudgetState(DAY), req({ amount: 2_000_000 }))).toContain(
      "budget PER_CALL_CAP_EXCEEDED",
    );
  });
});

/** A minimal in-memory BudgetSql: pattern-matches the helpers' queries. */
function fakeSql(): BudgetSql & { tables: Map<string, Map<string, string>> } {
  const tables = new Map<string, Map<string, string>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  return {
    tables,
    exec(query: string, ...params: unknown[]) {
      if (query.startsWith("CREATE TABLE")) return { toArray: () => [] };
      if (query.startsWith("SELECT json FROM budget_policy")) {
        const v = table("budget_policy").get("1");
        return { toArray: () => (v ? [{ json: v }] : []) };
      }
      if (query.startsWith("INSERT OR REPLACE INTO budget_policy")) {
        table("budget_policy").set("1", String(params[0]));
        return { toArray: () => [] };
      }
      if (query.startsWith("SELECT json FROM budget_state")) {
        const v = table("budget_state").get(String(params[0]));
        return { toArray: () => (v ? [{ json: v }] : []) };
      }
      if (query.startsWith("INSERT OR REPLACE INTO budget_state")) {
        table("budget_state").set(String(params[0]), String(params[1]));
        return { toArray: () => [] };
      }
      throw new Error(`fakeSql: unhandled query ${query}`);
    },
  };
}

describe("budget guard persistence", () => {
  it("env-derived policy inherits the OUTBOUND_MAX_AMOUNT_ATOMIC ceiling", () => {
    expect(envDerivedPolicy({}).perCallCap).toBe(Number.MAX_SAFE_INTEGER);
    expect(envDerivedPolicy({ OUTBOUND_MAX_AMOUNT_ATOMIC: "2500000" }).perCallCap).toBe(2_500_000);
    expect(envDerivedPolicy({ OUTBOUND_MAX_AMOUNT_ATOMIC: "junk" }).perCallCap).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("snapshot is unconfigured until a policy is saved; spend then accumulates per day", () => {
    const sql = fakeSql();
    const now = new Date("2026-10-17T12:00:00.000Z");
    expect(budgetDayKey(now)).toBe(DAY);
    let snap = budgetSnapshot(sql, {}, now);
    expect(snap.configured).toBe(false);
    expect(snap.today.totalSpent).toBe(0);

    saveBudgetPolicy(sql, policy());
    snap = budgetSnapshot(sql, {}, now);
    expect(snap.configured).toBe(true);

    const state = loadBudgetState(sql, DAY);
    const request = makeBudgetRequest("a-1", "host", "api.example.com", "0xRecipient", "100000", DAY);
    expect(request.amount).toBe(100_000);
    expect(recordBudgetSpend(sql, policy(), state, request)).toBeNull();
    expect(loadBudgetState(sql, DAY).totalSpent).toBe(100_000);

    const over = makeBudgetRequest("a-2", "host", "api.example.com", "0xRecipient", "2000000", DAY);
    expect(recordBudgetSpend(sql, policy(), loadBudgetState(sql, DAY), over)).toContain("PER_CALL_CAP_EXCEEDED");
    expect(loadBudgetState(sql, DAY).totalSpent).toBe(100_000);
  });
});
