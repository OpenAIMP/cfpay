import { describe, expect, it } from "vitest";
import {
  OPERATION_CATALOG,
  outcomeFromReply,
  parsePlan,
  parseSupervisorReply,
  goalTokens,
  isUnreliableOp,
  memoryBrief,
  plannerPrompt,
  summarizeOutcomes,
  supervisorPrompt,
  topoWaves,
  type PlanStep,
} from "../src/orchestrate";

const good = JSON.stringify([
  { id: "s1", agent: "search", operation: "search.ask", args: { query: "approval policy" } },
  { id: "s2", agent: "qa", operation: "qa.summary", dependsOn: [] },
  { id: "s3", agent: "email", operation: "email.send", args: { to: "ops@example.com", subject: "report", body: "done" }, dependsOn: ["s1", "s2"] },
]);

describe("orchestration planning core", () => {
  it("parses a valid plan and defaults args/dependsOn", () => {
    const plan = parsePlan("here is the plan:\n```json\n" + good + "\n```");
    expect(plan).toHaveLength(3);
    expect(plan?.[1].args).toEqual({});
    expect(plan?.[2].dependsOn).toEqual(["s1", "s2"]);
  });

  it("rejects operations outside the catalog", () => {
    expect(parsePlan(JSON.stringify([{ id: "s1", agent: "qa", operation: "qa.destroy" }]))).toBeNull();
    expect(parsePlan(JSON.stringify([{ id: "s1", agent: "nope", operation: "qa.summary" }]))).toBeNull();
    // The deliberate exclusions are not plannable either.
    expect(parsePlan(JSON.stringify([{ id: "s1", agent: "chat", operation: "chat.clear" }]))).toBeNull();
    // slack.post IS plannable since issue #188 enabled it over A2A.
    expect(parsePlan(JSON.stringify([{ id: "s1", agent: "slack", operation: "slack.post", args: { text: "hi" } }]))).not.toBeNull();
    expect(parsePlan(JSON.stringify([{ id: "s1", agent: "webhooks", operation: "webhook.receive" }]))).toBeNull();
  });

  it("rejects cycles, dangling dependencies, and oversized plans", () => {
    const cycle = JSON.stringify([
      { id: "a", agent: "qa", operation: "qa.summary", dependsOn: ["b"] },
      { id: "b", agent: "qa", operation: "qa.summary", dependsOn: ["a"] },
    ]);
    expect(parsePlan(cycle)).toBeNull();
    expect(parsePlan(JSON.stringify([{ id: "a", agent: "qa", operation: "qa.summary", dependsOn: ["zzz"] }]))).toBeNull();
    const big = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: "s" + i, agent: "qa", operation: "qa.summary" })));
    expect(parsePlan(big)).toBeNull();
  });

  it("groups steps into dependency waves for parallel execution", () => {
    const plan = parsePlan(good) as PlanStep[];
    const waves = topoWaves(plan);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([["s1", "s2"], ["s3"]]);
  });

  it("judges outcomes from reply data (ok:false and error strings fail)", () => {
    const step = { id: "s1", agent: "email", operation: "email.send" } as PlanStep;
    expect(outcomeFromReply(step, "Sent.", { ok: true }).ok).toBe(true);
    expect(outcomeFromReply(step, "Refused.", { ok: false, error: "quota" }).error).toBe("quota");
    expect(outcomeFromReply(step, "", undefined).ok).toBe(false);
    expect(outcomeFromReply(step, "Search failed", { error: "not found" }).ok).toBe(false);
  });

  it("the catalog is complete and the prompt is generated from it", () => {
    expect(OPERATION_CATALOG.map((e) => e.agent)).toEqual([
      "host", "email", "payments", "webhooks", "slack", "qa", "chat", "voice",
      "search",
      "scheduled",
    ]);
    const prompt = plannerPrompt("check everything");
    for (const e of OPERATION_CATALOG) expect(prompt).toContain(e.operations[0]);
    expect(prompt).toContain("Goal: check everything");
    expect(summarizeOutcomes("g", [{ stepId: "s1", agent: "qa", operation: "qa.summary", ok: true, reply: "fine" }])).toContain("1/1 steps succeeded");
  });
});

describe("supervisor verdicts (issue #185)", () => {
  const executed = new Set(["s1"]);
  it("parses continue and stop verdicts", () => {
    expect(parseSupervisorReply('{"action":"continue"}', executed)).toEqual({ action: "continue" });
    expect(parseSupervisorReply('{"action":"stop","reason":"goal met"}', executed)).toEqual({ action: "stop", reason: "goal met" });
  });
  it("parses a revision that depends on an executed step", () => {
    const v = parseSupervisorReply(
      JSON.stringify({ action: "revise", steps: [{ id: "s2", agent: "email", operation: "email.send", args: { to: "ops@example.com", subject: "report", body: "done" }, dependsOn: ["s1"] }] }),
      executed,
    );
    expect(v?.action).toBe("revise");
  });
  it("rejects revisions reusing an executed id or leaving the catalog", () => {
    expect(parseSupervisorReply(JSON.stringify({ action: "revise", steps: [{ id: "s1", agent: "qa", operation: "qa.summary" }] }), executed)).toBeNull();
    expect(parseSupervisorReply(JSON.stringify({ action: "revise", steps: [{ id: "s9", agent: "qa", operation: "qa.destroy" }] }), executed)).toBeNull();
    expect(parseSupervisorReply("not json", executed)).toBeNull();
    expect(supervisorPrompt("g", "results", ["s1"])).toContain("s1");
  });
});

describe("planning memory (issue #192)", () => {
  it("tokenizes goals, dropping glue words", () => {
    expect([...goalTokens("Summarize the state of qa, search, and slack")].sort()).toEqual(["search", "slack"]);
    expect(goalTokens("").size).toBe(0);
  });
  it("returns an empty brief with no relevant history", () => {
    expect(memoryBrief("check payments", [], [])).toBe("");
    expect(memoryBrief("check payments", [{ goal: "audit the dashboard ux", status: "done" }], [])).toBe("");
    expect(plannerPrompt("check payments", "")).not.toContain("Memory from previous jobs");
  });
  it("surfaces similar past goals and unreliable operations", () => {
    const brief = memoryBrief(
      "summarize slack and search state",
      [
        { goal: "summarize the state of qa, search, and slack", status: "partial" },
        { goal: "audit the dashboard ux", status: "done" },
      ],
      [
        { operation: "search.ask", runs: 3, failures: 3, lastError: "ai_search_not_found" },
        { operation: "qa.summary", runs: 4, failures: 1 },
      ],
    );
    expect(brief).toContain("Memory from previous jobs");
    expect(brief).toContain("finished partial");
    expect(brief).not.toContain("audit the dashboard ux");
    expect(brief).toContain("search.ask has failed 3 of its last 3 runs");
    expect(brief).toContain("ai_search_not_found");
    expect(brief).not.toContain("qa.summary has failed");
    expect(plannerPrompt("summarize slack and search state", brief)).toContain("Memory from previous jobs");
  });
  it("flags unreliability only on a real record (>=2 runs, >=half failed)", () => {
    expect(isUnreliableOp({ operation: "x", runs: 1, failures: 1 })).toBe(false);
    expect(isUnreliableOp({ operation: "x", runs: 2, failures: 1 })).toBe(true);
    expect(isUnreliableOp({ operation: "x", runs: 5, failures: 2 })).toBe(false);
    expect(isUnreliableOp({ operation: "x", runs: 5, failures: 0 })).toBe(false);
  });
});
