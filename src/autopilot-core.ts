/**
 * AutopilotAgent core: objective validation and text helpers (issue #242 P1).
 *
 * Pure and SDK-free so vitest covers it. The agent (src/autopilot-agent.ts)
 * owns the Durable Object, the SQL, and the cross-agent dispatch; everything
 * decidable about an objective - what is valid, what it normalizes to -
 * lives here and is tested.
 *
 * The exact goal text the agent arms on ScheduledAgent for its cadence is
 * AUTOPILOT_CYCLE_GOAL_TEXT: a firing hands it to the OrchestratorAgent,
 * which plans autopilot.runCycle from its catalog (the same composition
 * every scheduled goal uses).
 */

import { normalizeCron } from "./cron-next";

export const AUTOPILOT_GOAL_MAX_CHARS = 500;
export const AUTOPILOT_BUDGET_MAX = 100_000_000;
export const AUTOPILOT_SYMBOLS_MAX = 20;
export const DEFAULT_CADENCE_CRON = "0 14 * * 1-5";
export const AUTOPILOT_CYCLE_GOAL_TEXT =
  "Run the AutopilotAgent discovery cycle (autopilot.runCycle).";

export interface AutopilotObjectiveInput {
  goal?: unknown;
  budget?: unknown;
  cadenceCron?: unknown;
  symbols?: unknown;
  notifyEmail?: unknown;
}

export interface AutopilotObjective {
  goal: string;
  budget: number;
  cadenceCron: string;
  symbols: string[];
  notifyEmail: string | null;
}

export type ObjectiveError =
  | "goal_required"
  | "goal_too_long"
  | "budget_required"
  | "budget_invalid"
  | "invalid_cron"
  | "symbols_invalid"
  | "email_invalid";

export function validateObjective(
  input: AutopilotObjectiveInput,
): { ok: true; objective: AutopilotObjective } | { ok: false; error: ObjectiveError } {
  const goal = String(input.goal ?? "").trim();
  if (!goal) return { ok: false, error: "goal_required" };
  if (goal.length > AUTOPILOT_GOAL_MAX_CHARS) return { ok: false, error: "goal_too_long" };

  const budget = typeof input.budget === "number" ? input.budget : Number.NaN;
  if (!Number.isFinite(budget)) return { ok: false, error: "budget_required" };
  if (budget <= 0 || budget > AUTOPILOT_BUDGET_MAX) return { ok: false, error: "budget_invalid" };

  const rawCron =
    typeof input.cadenceCron === "string" && input.cadenceCron.trim()
      ? input.cadenceCron.trim()
      : DEFAULT_CADENCE_CRON;
  const cadenceCron = normalizeCron(rawCron);
  if (!cadenceCron) return { ok: false, error: "invalid_cron" };

  let symbols: string[] = [];
  if (input.symbols !== undefined && input.symbols !== null) {
    if (!Array.isArray(input.symbols) || input.symbols.length > AUTOPILOT_SYMBOLS_MAX) {
      return { ok: false, error: "symbols_invalid" };
    }
    symbols = [];
    for (const s of input.symbols) {
      const t = String(s ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return { ok: false, error: "symbols_invalid" };
      symbols.push(t);
    }
  }

  let notifyEmail: string | null = null;
  if (
    input.notifyEmail !== undefined &&
    input.notifyEmail !== null &&
    String(input.notifyEmail).trim() !== ""
  ) {
    const email = String(input.notifyEmail).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "email_invalid" };
    notifyEmail = email;
  }

  return { ok: true, objective: { goal, budget, cadenceCron, symbols, notifyEmail } };
}

/** One-line human summary of an objective for the desk card. */
export function objectiveSummaryText(o: {
  goal: string;
  budget: number;
  cadenceCron: string;
  symbols: string[];
  notifyEmail: string | null;
  enabled: boolean;
}): string {
  const bits = [
    o.enabled ? "armed" : "unarmed",
    `budget $${o.budget.toLocaleString("en-US")}`,
    `cron ${o.cadenceCron}`,
  ];
  if (o.symbols.length) bits.push(`symbols ${o.symbols.join(",")}`);
  if (o.notifyEmail) bits.push(`email -> ${o.notifyEmail}`);
  return `${o.goal} [${bits.join("; ")}]`;
}

/** One-line human summary of a finished cycle for the desk card. */
export function cycleSummaryText(c: {
  id: string;
  status: string;
  huntId: string | null;
  startedAt: number;
  finishedAt: number | null;
}): string {
  const when = new Date(c.startedAt).toISOString();
  if (c.status === "failed") return `${c.id} FAILED ${when}`;
  return `${c.id} ${c.status} ${when}${c.huntId ? ` hunt ${c.huntId}` : ""}`;
}
