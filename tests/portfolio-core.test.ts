import { describe, expect, it } from "vitest";
import {
  constructPortfolio,
  resolveConstraints,
  strategyKindOf,
  DEFAULT_PER_STRATEGY_FRACTION,
  DEFAULT_PER_UNDERLYING_FRACTION,
  DEFAULT_TOTAL_OPEN_RISK_FRACTION,
  type PortfolioRejectionReason,
} from "../src/portfolio-core";
import type { SizedTrade } from "../src/opportunity-hunt";

const EXPIRY = "2026-11-20";

/** A hunt-sized put credit spread; totalRisk defaults to $500 (1 contract). */
const sized = (over: Partial<SizedTrade> = {}): SizedTrade => ({
  underlying: "NVDA",
  strategy: "put credit spread",
  legs: [
    { action: "sell", type: "put", strike: 200 },
    { action: "buy", type: "put", strike: 195 },
  ],
  expiry: EXPIRY,
  credit: 1.25,
  probability: 0.8,
  thesis: "t",
  invalidation: "i",
  contracts: 1,
  spot: 218,
  maxLossPerContract: 500,
  maxProfitPerContract: 150,
  totalRisk: 500,
  totalMaxProfit: 150,
  expectedValue: 60,
  evPerRisk: 0.12,
  ...over,
});

/** Same trade at a different size: risk figures kept mutually consistent. */
const atRisk = (risk: number, over: Partial<SizedTrade> = {}): SizedTrade =>
  sized({ maxLossPerContract: risk, totalRisk: risk, totalMaxProfit: risk / 2, expectedValue: risk / 5, ...over });

const reasons = (plan: ReturnType<typeof constructPortfolio>): PortfolioRejectionReason[] =>
  plan.rejections.map((r) => r.reason);

describe("constructPortfolio - happy path", () => {
  it("allocates ranked candidates under all caps and rolls up the plan", () => {
    const plan = constructPortfolio(
      [
        atRisk(2000, { underlying: "SPY", strategy: "put credit spread" }),
        atRisk(1500, { underlying: "AMD", strategy: "call credit spread" }),
      ],
      { budget: 10000 },
    );
    expect(plan.rejections).toEqual([]);
    expect(plan.allocations.map((a) => a.underlying)).toEqual(["SPY", "AMD"]);
    expect(plan.allocations[0].risk).toBe(2000);
    expect(plan.allocations[0].budgetShare).toBe(0.2);
    expect(plan.allocations[1].budgetShare).toBe(0.15);
    expect(plan.totalRisk).toBe(3500);
    expect(plan.totalMaxProfit).toBe(1750);
    expect(plan.unallocated).toBe(6500);
    expect(plan.budget).toBe(10000);
  });

  it("preserves the hunt's ranked order - construction never re-ranks", () => {
    const plan = constructPortfolio(
      [
        atRisk(400, { underlying: "AMD", evPerRisk: 0.01 }),
        atRisk(400, { underlying: "SPY", evPerRisk: 0.99 }),
      ],
      { budget: 10000 },
    );
    expect(plan.allocations.map((a) => a.underlying)).toEqual(["AMD", "SPY"]);
  });
});

describe("constructPortfolio - each cap bites", () => {
  it("per-underlying cap: second NVDA trade over 25% is rejected, and passes when the cap is lifted", () => {
    const candidates = [
      atRisk(2000, { underlying: "NVDA" }),
      atRisk(1000, { underlying: "NVDA", expiry: "2026-12-18" }),
    ];
    const capped = constructPortfolio(candidates, { budget: 10000 });
    expect(capped.allocations).toHaveLength(1);
    expect(reasons(capped)).toEqual(["per_underlying_cap"]);

    const lifted = constructPortfolio(candidates, { budget: 10000 }, { perUnderlyingFraction: 1 });
    expect(lifted.allocations).toHaveLength(2);
    expect(lifted.rejections).toEqual([]);
  });

  it("per-strategy cap: the same kind across underlyings is capped at 40%, case/space-insensitively", () => {
    const candidates = [
      atRisk(2500, { underlying: "NVDA", strategy: "put credit spread" }),
      atRisk(2000, { underlying: "AMD", strategy: "Put  Credit   Spread" }),
    ];
    const capped = constructPortfolio(candidates, { budget: 10000 });
    expect(capped.allocations).toHaveLength(1);
    expect(reasons(capped)).toEqual(["per_strategy_cap"]);
    expect(capped.allocations[0].strategyKind).toBe("put credit spread");

    const lifted = constructPortfolio(candidates, { budget: 10000 }, { perStrategyFraction: 1 });
    expect(lifted.allocations).toHaveLength(2);
  });

  it("total open-risk cap: the portfolio stops at 80% of budget even when per-name caps allow more", () => {
    const candidates = [
      atRisk(5000, { underlying: "NVDA", strategy: "put credit spread" }),
      atRisk(4000, { underlying: "SPY", strategy: "call credit spread" }),
    ];
    const constraints = { perUnderlyingFraction: 1, perStrategyFraction: 1 };
    const capped = constructPortfolio(candidates, { budget: 10000 }, constraints);
    expect(capped.allocations).toHaveLength(1);
    expect(reasons(capped)).toEqual(["total_risk_cap"]);

    const lifted = constructPortfolio(candidates, { budget: 10000 }, { ...constraints, totalOpenRiskFraction: 0.95 });
    expect(lifted.allocations).toHaveLength(2);
  });

  it("budget exhausted: with the policy cap lifted past the budget, the raw budget still binds", () => {
    const candidates = [
      atRisk(7000, { underlying: "NVDA", strategy: "put credit spread" }),
      atRisk(4000, { underlying: "SPY", strategy: "call credit spread" }),
    ];
    const constraints = { perUnderlyingFraction: 2, perStrategyFraction: 2, totalOpenRiskFraction: 2 };
    const capped = constructPortfolio(candidates, { budget: 10000 }, constraints);
    expect(capped.allocations).toHaveLength(1);
    expect(reasons(capped)).toEqual(["budget_exhausted"]);

    const funded = constructPortfolio(candidates, { budget: 20000 }, constraints);
    expect(funded.allocations).toHaveLength(2);
  });
});

describe("constructPortfolio - identity and scope rejections", () => {
  it("duplicate exposure: the identical trade twice is allocated once", () => {
    const dup = atRisk(500);
    const plan = constructPortfolio([dup, { ...dup }, atRisk(500, { legs: [
      { action: "sell", type: "put", strike: 200 },
      { action: "buy", type: "put", strike: 190 },
    ] })], { budget: 10000 });
    expect(plan.allocations).toHaveLength(2); // original + the different-width near-duplicate
    expect(reasons(plan)).toEqual(["duplicate_exposure"]);
  });

  it("a duplicate of a REJECTED candidate is judged on its own merits, not as a duplicate", () => {
    const tooBig = atRisk(3000, { underlying: "NVDA" }); // over the 25% per-underlying cap
    const plan = constructPortfolio([tooBig, { ...tooBig }], { budget: 10000 });
    expect(plan.allocations).toEqual([]);
    expect(reasons(plan)).toEqual(["per_underlying_cap", "per_underlying_cap"]);
  });

  it("outside objective symbols: scope is enforced case-insensitively, empty scope is unconstrained", () => {
    const scoped = constructPortfolio(
      [atRisk(500, { underlying: "NVDA" }), atRisk(500, { underlying: "SPY" })],
      { budget: 10000, symbols: ["spy"] },
    );
    expect(scoped.allocations.map((a) => a.underlying)).toEqual(["SPY"]);
    expect(reasons(scoped)).toEqual(["outside_objective_symbols"]);

    const open = constructPortfolio([atRisk(500, { underlying: "NVDA" })], { budget: 10000, symbols: [] });
    expect(open.allocations).toHaveLength(1);
  });
});

describe("constructPortfolio - defined-risk only", () => {
  it("undefined risk: a naked short call is rejected even when it claims a risk figure", () => {
    const naked = sized({
      legs: [{ action: "sell", type: "call", strike: 200 }],
      credit: 2,
      totalRisk: 5000,
      maxLossPerContract: 5000,
    });
    const plan = constructPortfolio([naked], { budget: 10000 });
    expect(plan.allocations).toEqual([]);
    expect(reasons(plan)).toEqual(["undefined_risk"]);
  });

  it("undefined risk: missing or non-positive sizing figures are rejected, never sized here", () => {
    const plan = constructPortfolio(
      [
        atRisk(500, { underlying: "SPY", totalRisk: 0 }),
        atRisk(500, { underlying: "AMD", contracts: 0 }),
        atRisk(500, { underlying: "QQQ", maxLossPerContract: 0 }),
      ],
      { budget: 10000 },
    );
    expect(plan.allocations).toEqual([]);
    expect(reasons(plan)).toEqual(["undefined_risk", "undefined_risk", "undefined_risk"]);
  });
});

describe("constructPortfolio - completeness and determinism", () => {
  it("every input candidate appears exactly once across allocations + rejections", () => {
    const candidates = [
      atRisk(500, { underlying: "SPY" }),
      atRisk(500, { underlying: "AMD", strategy: "call credit spread" }),
      atRisk(500, { underlying: "TSLA" }), // outside scope
      sized({ underlying: "AMD", legs: [{ action: "sell", type: "call", strike: 200 }], credit: 2 }), // undefined risk
      atRisk(500, { underlying: "SPY" }), // duplicate of the first
    ];
    const plan = constructPortfolio(candidates, { budget: 10000, symbols: ["SPY", "AMD"] });
    expect(plan.allocations.length + plan.rejections.length).toBe(candidates.length);
    expect(plan.allocations).toHaveLength(2);
    expect(reasons(plan)).toEqual(["outside_objective_symbols", "undefined_risk", "duplicate_exposure"]);
  });

  it("same inputs produce a byte-identical plan", () => {
    const candidates = [
      atRisk(2000, { underlying: "NVDA" }),
      atRisk(1000, { underlying: "NVDA", expiry: "2026-12-18" }),
      atRisk(900, { underlying: "SPY", strategy: "call credit spread" }),
    ];
    const a = constructPortfolio(JSON.parse(JSON.stringify(candidates)), { budget: 10000, symbols: ["NVDA", "SPY"] });
    const b = constructPortfolio(JSON.parse(JSON.stringify(candidates)), { budget: 10000, symbols: ["NVDA", "SPY"] });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("constructPortfolio - degenerate inputs", () => {
  it("no candidates: an empty plan with the whole budget unallocated", () => {
    const plan = constructPortfolio([], { budget: 10000 });
    expect(plan.allocations).toEqual([]);
    expect(plan.rejections).toEqual([]);
    expect(plan.totalRisk).toBe(0);
    expect(plan.unallocated).toBe(10000);
  });

  it("zero or invalid budget: measurable candidates are budget_exhausted, nothing allocates", () => {
    const plan = constructPortfolio([atRisk(500)], { budget: 0 });
    expect(plan.budget).toBe(0);
    expect(plan.allocations).toEqual([]);
    expect(reasons(plan)).toEqual(["budget_exhausted"]);
  });

  it("zero headroom: a trade that exactly fills the caps leaves no room for the next", () => {
    const constraints = { perUnderlyingFraction: 1, perStrategyFraction: 1, totalOpenRiskFraction: 1 };
    const plan = constructPortfolio(
      [atRisk(1000, { underlying: "SPY" }), atRisk(100, { underlying: "AMD", strategy: "call credit spread" })],
      { budget: 1000 },
      constraints,
    );
    expect(plan.allocations).toHaveLength(1);
    expect(plan.unallocated).toBe(0);
    expect(reasons(plan)).toEqual(["total_risk_cap"]);
  });

  it("all duplicates: one allocation, the rest duplicate_exposure", () => {
    const trade = atRisk(500);
    const plan = constructPortfolio([trade, { ...trade }, { ...trade }], { budget: 10000 });
    expect(plan.allocations).toHaveLength(1);
    expect(reasons(plan)).toEqual(["duplicate_exposure", "duplicate_exposure"]);
  });
});

describe("resolveConstraints", () => {
  it("applies the documented defaults and falls back on invalid values", () => {
    expect(resolveConstraints()).toEqual({
      perUnderlyingFraction: DEFAULT_PER_UNDERLYING_FRACTION,
      perStrategyFraction: DEFAULT_PER_STRATEGY_FRACTION,
      totalOpenRiskFraction: DEFAULT_TOTAL_OPEN_RISK_FRACTION,
    });
    expect(resolveConstraints({ perUnderlyingFraction: 0, perStrategyFraction: Number.NaN, totalOpenRiskFraction: -1 }))
      .toEqual(resolveConstraints());
    const plan = constructPortfolio([atRisk(500)], { budget: 10000 }, { perUnderlyingFraction: 0 });
    expect(plan.constraints.perUnderlyingFraction).toBe(DEFAULT_PER_UNDERLYING_FRACTION);
  });

  it("strategyKindOf normalizes case and whitespace, empty becomes unspecified", () => {
    expect(strategyKindOf("  Put   Credit Spread ")).toBe("put credit spread");
    expect(strategyKindOf("")).toBe("unspecified");
    expect(strategyKindOf(undefined)).toBe("unspecified");
  });
});
