/**
 * Unit tests for the Public.com autopilot contracts (issue #107):
 * src/public-autopilot.ts holds the planner/verifier JSON contracts and the
 * evidence digest. The parsers are the trust boundary of the whole pipeline —
 * a model that answers in prose instead of JSON must degrade the run's
 * structure, never corrupt it, and a malformed verifier reply must read as
 * INCOMPLETE, never as a pass.
 */
import { describe, it, expect } from "vitest";
import {
  AUTOPILOT_MAX_STEPS,
  buildEvidenceDigest,
  parsePlan,
  parseVerification,
  type AutopilotRun,
} from "../src/public-autopilot";

describe("parsePlan", () => {
  it("parses a well-formed planner reply", () => {
    const steps = parsePlan(
      '{"steps":[{"title":"Quotes","instruction":"Get quotes for NVDA, AMD, AVGO"},{"title":"Chains","instruction":"Pull the NVDA option chain for the nearest expiry"}]}',
      "compare semis",
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe("Quotes");
    expect(steps[0].status).toBe("pending");
    expect(steps[0].id).not.toBe(steps[1].id);
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const steps = parsePlan(
      'Here is the plan:\n```json\n{"steps":[{"title":"Balances","instruction":"Fetch account balances"}]}\n```',
      "what can I afford",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].instruction).toContain("balances");
  });

  it("caps the plan at AUTOPILOT_MAX_STEPS", () => {
    const many = JSON.stringify({
      steps: Array.from({ length: 12 }, (_, i) => ({ title: "S" + i, instruction: "do " + i })),
    });
    expect(parsePlan(many, "goal")).toHaveLength(AUTOPILOT_MAX_STEPS);
  });

  it("falls back to a single goal step on garbage", () => {
    const steps = parsePlan("the model rambled without any json", "buy the dip research");
    expect(steps).toHaveLength(1);
    expect(steps[0].instruction).toBe("buy the dip research");
  });

  it("drops steps without instructions and falls back when none survive", () => {
    expect(parsePlan('{"steps":[{"title":"empty"}]}', "the goal")).toHaveLength(1);
    expect(parsePlan('{"steps":[{"title":"empty"}]}', "the goal")[0].instruction).toBe("the goal");
  });
});

describe("parseVerification", () => {
  it("parses a complete verdict", () => {
    const v = parseVerification('{"complete":true,"confidence":0.85,"gaps":[],"summary":"All three chains present."}');
    expect(v.complete).toBe(true);
    expect(v.confidence).toBe(0.85);
    expect(v.gaps).toEqual([]);
  });

  it("parses an incomplete verdict with named gaps", () => {
    const v = parseVerification('{"complete":false,"confidence":0.4,"gaps":["No AVGO chain"],"summary":"Missing one leg."}');
    expect(v.complete).toBe(false);
    expect(v.gaps).toEqual(["No AVGO chain"]);
  });

  it("treats a percent confidence as a fraction", () => {
    expect(parseVerification('{"complete":true,"confidence":73}').confidence).toBe(0.73);
  });

  it("clamps out-of-range confidence", () => {
    expect(parseVerification('{"complete":true,"confidence":-2}').confidence).toBe(0);
  });

  it("reads garbage as INCOMPLETE with a named gap — never as a pass", () => {
    const v = parseVerification("looks good to me!");
    expect(v.complete).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.gaps[0]).toMatch(/structured verdict/);
  });
});

describe("buildEvidenceDigest", () => {
  const run = {
    steps: [
      { id: "s1", title: "Quotes", instruction: "quotes", status: "done" as const, answer: "NVDA 190.5" },
      { id: "s2", title: "Chains", instruction: "chains", status: "pending" as const },
      { id: "s3", title: "Balance", instruction: "balance", status: "failed" as const, answer: "Step failed: boom" },
    ],
    evidence: [
      { stepId: "s1", tool: "get_quotes", ok: true, summary: "{...}" },
      { stepId: "s3", tool: "get_accounts", ok: false, summary: "error" },
    ],
  } as unknown as AutopilotRun;

  it("includes only finished steps, with their evidence lines", () => {
    const digest = buildEvidenceDigest(run);
    expect(digest).toContain("Quotes");
    expect(digest).toContain("NVDA 190.5");
    expect(digest).toContain("get_quotes");
    expect(digest).toContain("(failed)");
    expect(digest).not.toContain("Chains");
  });

  it("bounds the digest length", () => {
    const big = {
      steps: [
        { id: "s1", title: "Big", instruction: "x", status: "done" as const, answer: "y".repeat(5000) },
      ],
      evidence: [],
    } as unknown as AutopilotRun;
    expect(buildEvidenceDigest(big, 1000).length).toBeLessThanOrEqual(1100);
  });
});
