/**
 * Goal-oriented autopilot for the Public.com agent (issue #107).
 *
 * The reactive chat loop answers one question with one burst of tool calls.
 * Autopilot wraps it in the pipeline from the design:
 *
 *   Goal → Planner → Task Queue → Executor → Verifier
 *
 * This module holds the run-state types and the pure pieces — the planner /
 * verifier prompt contracts, the defensive JSON parsers for their replies,
 * and the evidence digest the executor, verifier and synthesis steps read.
 * The orchestration itself lives on the host agent (src/agent.ts,
 * runAutopilot), which owns the model calls and the existing tool loop.
 *
 * Everything here is deterministic and unit-testable: a model reply that is
 * not the JSON asked for degrades to a named fallback, never to a throw.
 */

export interface AutopilotStep {
  id: string;
  title: string;
  instruction: string;
  status: "pending" | "running" | "done" | "failed";
  /** The executor's concise finding for this step, once it has run. */
  answer?: string;
}

export interface AutopilotEvidence {
  stepId: string;
  tool: string;
  ok: boolean;
  /** First meaningful line of the tool result, bounded. */
  summary: string;
}

export interface AutopilotVerification {
  complete: boolean;
  /** 0..1 — the verifier's confidence that the evidence answers the goal. */
  confidence: number;
  /** Named gaps when incomplete; the replan step plans directly from these. */
  gaps: string[];
  summary: string;
}

export interface AutopilotRun {
  id: string;
  goal: string;
  status: "planning" | "running" | "verifying" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
  steps: AutopilotStep[];
  evidence: AutopilotEvidence[];
  verification: AutopilotVerification | null;
  answer: string;
  model: string;
  replans: number;
}

/** Bounds — Workers AI neurons are the scarce resource (issue #107). */
export const AUTOPILOT_MAX_STEPS = 6;
export const AUTOPILOT_MAX_FOLLOWUPS = 3;
export const AUTOPILOT_STEP_TOOL_BUDGET = 6;
export const AUTOPILOT_MAX_RUNS_KEPT = 20;

export const AUTOPILOT_PLANNER_SYSTEM = [
  "You are the planner for a financial research agent with Public.com tools.",
  "Decompose the user's goal into concrete data-gathering steps: each step names exactly what to fetch or compare (instruments, expiries, balances, chains).",
  "Prefer few, focused steps. Do not plan prose, formatting or conclusions — only evidence gathering.",
  'Reply with JSON only, no markdown fences: {"steps":[{"title":"short label","instruction":"what to fetch or compare, and for which instruments"}]}',
].join("\n");

export const AUTOPILOT_VERIFIER_SYSTEM = [
  "You are the verifier for a financial research agent. You judge EVIDENCE, not effort.",
  "Given the goal and the evidence gathered, decide whether the evidence is sufficient to answer the goal correctly and specifically.",
  "Be strict: prices, expiries or comparisons the goal asks for must actually appear in the evidence. If a step failed or returned nothing, name it as a gap.",
  'Reply with JSON only, no markdown fences: {"complete":true|false,"confidence":0.0-1.0,"gaps":["what is still missing"],"summary":"one or two sentences"}',
].join("\n");

export const AUTOPILOT_SYNTHESIS_SYSTEM = [
  "You answer the user's goal from verified evidence gathered by a research agent.",
  "Use only facts present in the evidence; never invent a price, symbol, balance or expiry.",
  "Say which instruments were compared and why, name any gap the verifier left open, and note this is not investment advice when recommending anything.",
].join("\n");

/** Extract the first JSON object from a model reply, tolerating fences/prose. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return "step-" + Date.now().toString(36) + "-" + stepCounter;
}

/**
 * Parse a planner reply into steps. Any malformed reply degrades to a single
 * step carrying the goal itself, so a weak planner model costs structure,
 * never the whole run.
 */
export function parsePlan(text: string, goal: string): AutopilotStep[] {
  const fallback: AutopilotStep[] = [
    { id: nextStepId(), title: "Answer the goal", instruction: goal.slice(0, 400), status: "pending" },
  ];
  const obj = extractJsonObject(text);
  if (!obj || !Array.isArray(obj.steps)) return fallback;
  const steps: AutopilotStep[] = [];
  for (const raw of obj.steps) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const instruction = cleanText(rec.instruction ?? rec.task ?? rec.description, 400);
    if (!instruction) continue;
    steps.push({
      id: nextStepId(),
      title: cleanText(rec.title, 120) || instruction.slice(0, 60),
      instruction,
      status: "pending",
    });
    if (steps.length >= AUTOPILOT_MAX_STEPS) break;
  }
  return steps.length > 0 ? steps : fallback;
}

/**
 * Parse a verifier reply. A malformed reply is an INCOMPLETE verdict with a
 * named gap — the safe direction: it can trigger one bounded replan, but it
 * can never certify evidence nobody checked.
 */
export function parseVerification(text: string): AutopilotVerification {
  const obj = extractJsonObject(text);
  if (!obj) {
    return {
      complete: false,
      confidence: 0,
      gaps: ["The verifier did not return a structured verdict."],
      summary: "",
    };
  }
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1) confidence = confidence / 100; // a percent slipped through
  confidence = Math.min(1, Math.max(0, confidence));
  const gaps = Array.isArray(obj.gaps)
    ? obj.gaps.map((g) => cleanText(g, 200)).filter((g) => g.length > 0).slice(0, 5)
    : [];
  return {
    complete: obj.complete === true,
    confidence,
    gaps,
    summary: cleanText(obj.summary, 400),
  };
}

/**
 * The digest every later stage reads: per-step findings plus the tool
 * evidence lines behind them, bounded so a long run cannot grow the
 * verifier/synthesis prompts without limit.
 */
export function buildEvidenceDigest(
  run: { steps: AutopilotStep[]; evidence: AutopilotEvidence[] },
  maxChars = 6000,
): string {
  const lines: string[] = [];
  for (const step of run.steps) {
    if (step.status !== "done" && step.status !== "failed") continue;
    lines.push("## Step: " + step.title + " (" + step.status + ")");
    if (step.answer) lines.push(step.answer.slice(0, 800));
    for (const ev of run.evidence.filter((e) => e.stepId === step.id)) {
      lines.push("- " + ev.tool + (ev.ok ? "" : " (failed)") + ": " + ev.summary.slice(0, 160));
    }
  }
  const digest = lines.join("\n");
  return digest.length > maxChars
    ? digest.slice(0, maxChars) + "\n[... evidence digest shortened]"
    : digest;
}
