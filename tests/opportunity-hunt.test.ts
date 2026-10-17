import { describe, expect, it } from "vitest";
import {
  buildHuntGoal,
  extractSpot,
  parseCandidates,
  sizePlan,
  structureRisk,
  verifyCandidate,
  type HuntCandidate,
} from "../src/opportunity-hunt";

const NOW = new Date("2026-10-17T12:00:00Z");
const FUTURE = "2026-11-20";

const putSpread = (over: Partial<HuntCandidate> = {}): HuntCandidate => ({
  underlying: "NVDA",
  strategy: "put credit spread",
  legs: [
    { action: "sell", type: "put", strike: 200 },
    { action: "buy", type: "put", strike: 195 },
  ],
  expiry: FUTURE,
  credit: 1.25,
  probability: 0.8,
  thesis: "t",
  invalidation: "i",
  ...over,
});

describe("structureRisk", () => {
  it("prices a put credit spread as (width - credit) x 100", () => {
    expect(structureRisk(putSpread())).toEqual({ maxLoss: 375, maxProfit: 125 });
  });
  it("prices a cash-secured put as (strike - credit) x 100", () => {
    const csp = putSpread({ legs: [{ action: "sell", type: "put", strike: 200 }], credit: 3 });
    expect(structureRisk(csp)).toEqual({ maxLoss: 19700, maxProfit: 300 });
  });
  it("prices a debit spread's max loss as the debit", () => {
    expect(structureRisk(putSpread({ credit: -1.5 }))).toEqual({ maxLoss: 150, maxProfit: 350 });
  });
  it("refuses a naked short call and a wrong-way hedge", () => {
    expect(structureRisk(putSpread({ legs: [{ action: "sell", type: "call", strike: 200 }] }))).toBeNull();
    const wrongWay = putSpread({
      legs: [
        { action: "sell", type: "put", strike: 195 },
        { action: "buy", type: "put", strike: 200 },
      ],
    });
    expect(structureRisk(wrongWay)).toBeNull();
  });
});

describe("verifyCandidate", () => {
  it("accepts an out-of-the-money put spread against the live spot", () => {
    expect(verifyCandidate(putSpread(), 218, NOW)).toBeNull();
  });
  it("rejects the NVDA trap: a short put strike above spot", () => {
    const deep = putSpread({
      legs: [
        { action: "sell", type: "put", strike: 240 },
        { action: "buy", type: "put", strike: 235 },
      ],
    });
    expect(verifyCandidate(deep, 218, NOW)).toMatch(/in the money/);
  });
  it("rejects expired, spotless, and undefined-risk candidates", () => {
    expect(verifyCandidate(putSpread({ expiry: "2026-10-01" }), 218, NOW)).toMatch(/past/);
    expect(verifyCandidate(putSpread(), undefined, NOW)).toMatch(/no live spot/);
    expect(
      verifyCandidate(putSpread({ legs: [{ action: "sell", type: "call", strike: 200 }] }), 218, NOW),
    ).toMatch(/defined-risk/);
  });
});

describe("sizePlan", () => {
  it("sizes under the per-trade cap and reports the rollup", () => {
    // Budget $50,000, 2% per-trade cap = $1,000; spread risks $375/contract.
    const plan = sizePlan([putSpread()], { NVDA: 218 }, { budget: 50000 }, NOW);
    expect(plan.trades).toHaveLength(1);
    expect(plan.trades[0].contracts).toBe(2); // floor(1000 / 375)
    expect(plan.trades[0].totalRisk).toBe(750);
    expect(plan.totalRisk).toBe(750);
    expect(plan.unallocated).toBe(49250);
  });
  it("honors the per-underlying cap across trades", () => {
    const cheap = putSpread({ credit: 4.9 }); // risks $10/contract
    const plan = sizePlan([cheap, cheap], { NVDA: 218 }, { budget: 10000, maxRiskPct: 100 }, NOW);
    // Per-underlying cap is 25% of $10,000 = $2,500 total across both.
    expect(plan.totalRisk).toBeLessThanOrEqual(2500);
  });
  it("never sizes a negative-EV or unverifiable candidate", () => {
    const bad = putSpread({ probability: 0.1 });
    const plan = sizePlan([bad, putSpread({ underlying: "ZZZ" })], { NVDA: 218 }, { budget: 50000 }, NOW);
    expect(plan.trades).toHaveLength(0);
    expect(plan.unsized[0].reason).toMatch(/negative expected value/);
    expect(plan.rejected[0].reason).toMatch(/no live spot/);
  });
});

describe("parseCandidates", () => {
  it("pulls the fenced json block out of a prose answer", () => {
    const text = `Scanned the chains...\n\n\`\`\`json\n${JSON.stringify([putSpread()])}\n\`\`\``;
    const out = parseCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0].underlying).toBe("NVDA");
    expect(out[0].legs[0]).toEqual({ action: "sell", type: "put", strike: 200 });
  });
  it("returns [] when there is no usable block", () => {
    expect(parseCandidates("no candidates today")).toEqual([]);
    expect(parseCandidates("```json\n[{\"bogus\":1}]\n```")).toEqual([]);
  });
});

describe("extractSpot", () => {
  it("reads object rows and table shapes", () => {
    expect(extractSpot({ quotes: [{ symbol: "NVDA", last: "218.44" }] }, "NVDA")).toBe(218.44);
    expect(
      extractSpot({ columns: ["Symbol", "Last"], rows: [["AMD", 162.1], ["NVDA", 218.4]] }, "NVDA"),
    ).toBe(218.4);
    expect(extractSpot({ quotes: [{ symbol: "AMD", last: 1 }] }, "NVDA")).toBeUndefined();
  });
});

describe("buildHuntGoal", () => {
  it("states the budget as a planning constraint and forbids orders", () => {
    const goal = buildHuntGoal({ budget: 25000, symbols: ["NVDA"] });
    expect(goal).toContain("$25000");
    expect(goal).toContain("do NOT place or propose any orders");
    expect(goal).toContain("NVDA");
  });
});
