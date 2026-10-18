import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_GOAL_MAX_CHARS,
  AUTOPILOT_CYCLE_GOAL_TEXT,
  DEFAULT_CADENCE_CRON,
  validateObjective,
  objectiveSummaryText,
  cycleSummaryText,
} from "../src/autopilot-core";

describe("autopilot-core objective validation", () => {
  it("accepts a valid objective and applies defaults", () => {
    const res = validateObjective({ goal: "Grow the portfolio", budget: 10000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.objective.goal).toBe("Grow the portfolio");
    expect(res.objective.budget).toBe(10000);
    expect(res.objective.cadenceCron).toBe(DEFAULT_CADENCE_CRON);
    expect(res.objective.symbols).toEqual([]);
    expect(res.objective.notifyEmail).toBeNull();
  });

  it("normalizes cron aliases and symbols, accepts an email", () => {
    const res = validateObjective({
      goal: "Steady premium income",
      budget: 25000,
      cadenceCron: "@daily",
      symbols: ["spy", " QQQ "],
      notifyEmail: " owner@example.com ",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.objective.cadenceCron).not.toBe("@daily");
    expect(res.objective.cadenceCron.length).toBeGreaterThan(0);
    expect(res.objective.symbols).toEqual(["SPY", "QQQ"]);
    expect(res.objective.notifyEmail).toBe("owner@example.com");
  });

  it("rejects a missing or overlong goal", () => {
    expect(validateObjective({ goal: "   ", budget: 1 })).toMatchObject({
      ok: false,
      error: "goal_required",
    });
    expect(
      validateObjective({ goal: "x".repeat(AUTOPILOT_GOAL_MAX_CHARS + 1), budget: 1 }),
    ).toMatchObject({ ok: false, error: "goal_too_long" });
  });

  it("rejects a missing, zero, negative, or absurd budget", () => {
    expect(validateObjective({ goal: "g" })).toMatchObject({
      ok: false,
      error: "budget_required",
    });
    expect(validateObjective({ goal: "g", budget: 0 })).toMatchObject({
      ok: false,
      error: "budget_invalid",
    });
    expect(validateObjective({ goal: "g", budget: -50 })).toMatchObject({
      ok: false,
      error: "budget_invalid",
    });
    expect(validateObjective({ goal: "g", budget: 100_000_001 })).toMatchObject({
      ok: false,
      error: "budget_invalid",
    });
    expect(validateObjective({ goal: "g", budget: "10000" })).toMatchObject({
      ok: false,
      error: "budget_required",
    });
  });

  it("rejects an invalid cron", () => {
    expect(validateObjective({ goal: "g", budget: 1, cadenceCron: "not a cron" })).toMatchObject({
      ok: false,
      error: "invalid_cron",
    });
  });

  it("rejects bad symbols", () => {
    expect(validateObjective({ goal: "g", budget: 1, symbols: "SPY" })).toMatchObject({
      ok: false,
      error: "symbols_invalid",
    });
    expect(
      validateObjective({ goal: "g", budget: 1, symbols: Array(21).fill("SPY") }),
    ).toMatchObject({ ok: false, error: "symbols_invalid" });
    expect(validateObjective({ goal: "g", budget: 1, symbols: ["$PY"] })).toMatchObject({
      ok: false,
      error: "symbols_invalid",
    });
  });

  it("rejects a malformed email but allows an empty one", () => {
    expect(validateObjective({ goal: "g", budget: 1, notifyEmail: "not-an-email" })).toMatchObject({
      ok: false,
      error: "email_invalid",
    });
    const res = validateObjective({ goal: "g", budget: 1, notifyEmail: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.objective.notifyEmail).toBeNull();
  });

  it("the cadence goal text is the exact string the scheduler will fire", () => {
    expect(AUTOPILOT_CYCLE_GOAL_TEXT).toBe(
      "Run the AutopilotAgent discovery cycle (autopilot.runCycle).",
    );
  });

  it("summary helpers render compact text", () => {
    expect(
      objectiveSummaryText({
        goal: "Income",
        budget: 10000,
        cadenceCron: DEFAULT_CADENCE_CRON,
        symbols: ["SPY"],
        notifyEmail: null,
        enabled: true,
      }),
    ).toContain("Income [armed;");
    expect(
      cycleSummaryText({ id: "cycle-1", status: "completed", huntId: "h1", startedAt: 0, finishedAt: 1 }),
    ).toContain("cycle-1 completed");
  });
});
