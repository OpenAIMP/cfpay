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
  AUTOPILOT_PLANNER_SYSTEM,
  AUTOPILOT_VERIFIER_SYSTEM,
  buildEvidenceDigest,
  parsePlan,
  parseVerification,
  runAutopilotPipeline,
  type AutopilotDeps,
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

describe("runAutopilotPipeline", () => {
  const PLAN =
    '{"steps":[{"title":"Quotes","instruction":"Quote NVDA and AMD"},{"title":"Chains","instruction":"Pull the NVDA chain"}]}';
  const FOLLOWUP = '{"steps":[{"title":"AVGO chain","instruction":"Pull the AVGO chain"}]}';

  function fakeDeps(verdicts: string[], runStepImpl?: AutopilotDeps["runStep"]) {
    const saved: AutopilotRun[] = [];
    const stepQuestions: string[] = [];
    let verdictIdx = 0;
    const deps: AutopilotDeps = {
      aiRun: async (_modelId, messages) => {
        const system = String(messages[0].content);
        const user = String(messages[1].content);
        if (system === AUTOPILOT_PLANNER_SYSTEM) {
          return { response: user.includes("left these gaps") ? FOLLOWUP : PLAN };
        }
        if (system === AUTOPILOT_VERIFIER_SYSTEM) {
          return { response: verdicts[Math.min(verdictIdx++, verdicts.length - 1)] };
        }
        return { response: "The final answer." };
      },
      runStep:
        runStepImpl ??
        (async (question) => {
          stepQuestions.push(question);
          return {
            answer: "finding for: " + question.slice(0, 30),
            trace: [{ name: "get_quotes", args: {}, ok: true, result: "{}", summary: "ok" } as any],
          };
        }),
      save: async (run) => {
        saved.push(JSON.parse(JSON.stringify(run)));
      },
    };
    return { deps, saved, stepQuestions };
  }

  it("runs plan -> steps -> verify -> synthesis and persists the run", async () => {
    const { deps, saved, stepQuestions } = fakeDeps(['{"complete":true,"confidence":0.9,"gaps":[],"summary":"covered"}']);
    const out = await runAutopilotPipeline(deps, "compare NVDA and AMD", ["get_quotes"], "@cf/test");
    expect(out.answer).toBe("The final answer.");
    expect(out.autopilot.status).toBe("done");
    expect(out.autopilot.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(out.autopilot.evidence).toHaveLength(2);
    expect(out.autopilot.verification?.complete).toBe(true);
    expect(out.autopilot.replans).toBe(0);
    expect(stepQuestions).toHaveLength(2);
    expect(saved.length).toBeGreaterThan(3);
    expect(saved[saved.length - 1].status).toBe("done");
  });

  it("replans once from the verifier's gaps, then completes", async () => {
    const { deps, stepQuestions } = fakeDeps([
      '{"complete":false,"confidence":0.4,"gaps":["No AVGO chain"],"summary":"one leg missing"}',
      '{"complete":true,"confidence":0.8,"gaps":[],"summary":"covered now"}',
    ]);
    const out = await runAutopilotPipeline(deps, "compare three semis", ["get_quotes"], "@cf/test");
    expect(out.autopilot.replans).toBe(1);
    expect(out.autopilot.steps).toHaveLength(3);
    expect(stepQuestions).toHaveLength(3);
    expect(out.autopilot.verification?.complete).toBe(true);
  });

  it("marks a throwing step failed and still finishes the run", async () => {
    const { deps } = fakeDeps(
      ['{"complete":false,"confidence":0.2,"gaps":["step failed"],"summary":"partial"}'],
      async () => {
        throw new Error("tool backend down");
      },
    );
    const out = await runAutopilotPipeline(deps, "goal", ["get_quotes"], "@cf/test");
    expect(out.autopilot.steps.every((s) => s.status === "failed")).toBe(true);
    expect(out.autopilot.status).toBe("done");
    expect(out.answer.length).toBeGreaterThan(0);
  });

  it("survives a garbage planner reply with the single fallback step", async () => {
    const { deps, stepQuestions } = fakeDeps(['{"complete":true,"confidence":1,"gaps":[],"summary":"ok"}']);
    deps.aiRun = async (_m, messages) =>
      String(messages[0].content) === AUTOPILOT_PLANNER_SYSTEM
        ? { response: "no json here" }
        : String(messages[0].content) === AUTOPILOT_VERIFIER_SYSTEM
          ? { response: '{"complete":true,"confidence":1,"gaps":[],"summary":"ok"}' }
          : { response: "answer" };
    const out = await runAutopilotPipeline(deps, "the goal itself", ["get_quotes"], "@cf/test");
    expect(out.autopilot.steps).toHaveLength(1);
    expect(stepQuestions).toHaveLength(1);
    expect(out.autopilot.status).toBe("done");
  });
});
