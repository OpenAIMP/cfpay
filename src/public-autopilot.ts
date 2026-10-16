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
 * The orchestration (runAutopilotPipeline, below) is driven by the host
 * agent (src/agent.ts, runAutopilot), which injects the model call, the
 * existing tool loop, and persistence.
 *
 * Everything here is deterministic and unit-testable: a model reply that is
 * not the JSON asked for degrades to a named fallback, never to a throw.
 */

import { contextWindowFor, readCompletion } from "./models";
import type { SessionMessage, Sessions } from "agents/sessions";
import type { UsageCost } from "./models";
import type { ToolTrace } from "./types";

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
  "If the goal compares instruments or strategies, open with a 'Verdict: <winner> \u2014 <one-line reason>' line, then a markdown table of the key metrics from the evidence (one column per instrument), then brief prose. A table cell may only contain a figure present in the evidence; write n/a for anything not retrieved.",
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

/** The agent-owned pieces the pipeline orchestrates (injected by the host). */
export interface AutopilotDeps {
  /** One raw Workers AI call; resolves with the provider response envelope. */
  aiRun: (
    modelId: string,
    messages: Array<Record<string, unknown>>,
    maxTokens: number,
  ) => Promise<unknown>;
  /** The reactive tool loop, scoped to one step's question. */
  runStep: (question: string) => Promise<{ answer: string; trace: ToolTrace[] }>;
  /** Persist the run state after every transition. */
  save: (run: AutopilotRun) => Promise<void>;
}

/**
 * One no-tools model call for the planner / verifier / synthesis stages.
 * Same context discipline as the chat loop: budget the output against the
 * model's window, and on the provider's over-length rejection recompute
 * from its own figures and retry once.
 */
async function aiTextCall(
  deps: AutopilotDeps,
  modelId: string,
  system: string,
  user: string,
  maxOut = 1024,
): Promise<string> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const contextWindow = contextWindowFor(modelId);
  let maxTokens = maxOut;
  if (contextWindow) {
    const estimatedInput = Math.ceil(JSON.stringify(messages).length / 3.5);
    maxTokens = Math.max(256, Math.min(maxOut, contextWindow - estimatedInput - 512));
  }
  try {
    const response = await deps.aiRun(modelId, messages, maxTokens);
    return readCompletion(response).text;
  } catch (err) {
    const m = /maximum context length is (\d+) tokens[\s\S]*?at least (\d+) input tokens/.exec(
      String(err),
    );
    if (!m) throw err;
    const retryTokens = Number(m[1]) - Number(m[2]) - 512;
    if (retryTokens < 128) throw err;
    const response = await deps.aiRun(modelId, messages, Math.min(maxOut, retryTokens));
    return readCompletion(response).text;
  }
}

/**
 * The pipeline: Goal → Planner → Task Queue → Executor → Verifier, with at
 * most one replan aimed at the verifier's named gaps, and a synthesis written
 * from the verified evidence. The run is saved after every transition, so the
 * persisted state always shows where a run got to.
 */
export async function runAutopilotPipeline(
  deps: AutopilotDeps,
  goal: string,
  toolNames: string[],
  modelId: string,
): Promise<{
  answer: string;
  trace: ToolTrace[];
  model: string;
  cost: UsageCost | null;
  autopilot: AutopilotRun;
}> {
  const run: AutopilotRun = {
    id: crypto.randomUUID(),
    goal,
    status: "planning",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    evidence: [],
    verification: null,
    answer: "",
    model: modelId,
    replans: 0,
  };
  const trace: ToolTrace[] = [];
  const save = async () => {
    run.updatedAt = new Date().toISOString();
    await deps.save(run);
  };
  await save();
  try {
    // PLANNER — one no-tools call; a malformed plan degrades to one step.
    const planText = await aiTextCall(
      deps,
      modelId,
      AUTOPILOT_PLANNER_SYSTEM,
      "Goal: " + goal + "\n\nAvailable tools: " + toolNames.join(", "),
      1024,
    );
    run.steps = parsePlan(planText, goal);
    run.status = "running";
    await save();

    // TASK QUEUE + EXECUTOR, then VERIFIER — with at most one replan.
    for (let round = 0; round < 2; round++) {
      for (const step of run.steps.filter((s) => s.status === "pending")) {
        step.status = "running";
        await save();
        const stepQuestion =
          "Goal: " + goal +
          "\n\nYour assigned step: " + step.instruction +
          "\n\nEvidence gathered so far:\n" + (buildEvidenceDigest(run) || "(none yet)") +
          "\n\nComplete this step only, gathering the data it names. Answer concisely with the facts you found.";
        try {
          const res = await deps.runStep(stepQuestion);
          step.answer = res.answer;
          step.status = "done";
          trace.push(...res.trace);
          for (const t of res.trace) {
            run.evidence.push({
              stepId: step.id,
              tool: t.name,
              ok: t.ok,
              summary: String(t.summary || t.result || "").slice(0, 200),
            });
          }
        } catch (err) {
          step.status = "failed";
          step.answer = "Step failed: " + String(err);
        }
        await save();
      }

      // VERIFIER — judges the evidence against the goal, never the effort.
      run.status = "verifying";
      await save();
      const verifyText = await aiTextCall(
        deps,
        modelId,
        AUTOPILOT_VERIFIER_SYSTEM,
        "Goal: " + goal + "\n\nEvidence:\n" + buildEvidenceDigest(run, 8000),
        768,
      ).catch(() => "");
      run.verification = parseVerification(verifyText);
      await save();
      if (run.verification.complete || round === 1) break;

      // REPLAN — at most AUTOPILOT_MAX_FOLLOWUPS steps aimed at the gaps.
      run.replans = 1;
      const gaps = run.verification.gaps.join("; ") || run.verification.summary;
      const followText = await aiTextCall(
        deps,
        modelId,
        AUTOPILOT_PLANNER_SYSTEM,
        "Goal: " + goal +
          "\n\nA first research pass left these gaps: " + gaps +
          "\n\nPlan at most " + AUTOPILOT_MAX_FOLLOWUPS + " follow-up steps that close exactly those gaps.",
        768,
      ).catch(() => "");
      const followUps = parsePlan(followText, goal)
        .filter((s) => s.instruction !== goal.slice(0, 400))
        .slice(0, AUTOPILOT_MAX_FOLLOWUPS);
      if (followUps.length === 0) break;
      run.steps.push(...followUps);
      run.status = "running";
      await save();
    }

    // SYNTHESIS — the answer is written from the verified evidence only.
    const synthesis = await aiTextCall(
      deps,
      modelId,
      AUTOPILOT_SYNTHESIS_SYSTEM,
      "Goal: " + goal +
        "\n\nVerified evidence:\n" + buildEvidenceDigest(run, 9000) +
        "\n\nVerifier summary: " + (run.verification?.summary || "(none)") +
        "\n\nWrite the final answer to the goal.",
      1600,
    ).catch(() => "");
    run.answer =
      synthesis.trim() ||
      run.steps
        .filter((s) => s.answer)
        .map((s) => s.title + ": " + s.answer)
        .join("\n\n");
    run.status = "done";
  } catch (err) {
    run.status = "failed";
    run.answer = "Autopilot failed: " + String(err);
  }
  await save();
  return { answer: run.answer, trace, model: modelId, cost: null, autopilot: run };
}

/* ------------------------- per-run persistence ------------------------- */

/**
 * Autopilot runs, one SQLite row per run in the host Durable Object
 * (issue #110) — the same table pattern as the A2A task store in
 * src/a2a.ts. Runs used to live inside the agent state blob, so every
 * pipeline save rewrote the host's ENTIRE state (stored emails, payments,
 * webhook payloads, ...) through setState — and a run saves ~13–26
 * times. Here a save writes only the run's own row.
 */
export class AutopilotRunStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  save(run: AutopilotRun): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO autopilot_runs (id, created_at, data) VALUES (?, ?, ?)",
      run.id,
      run.createdAt,
      JSON.stringify(run),
    );
    this.sql.exec(
      "DELETE FROM autopilot_runs WHERE id NOT IN (SELECT id FROM autopilot_runs ORDER BY created_at DESC LIMIT ?)",
      AUTOPILOT_MAX_RUNS_KEPT,
    );
  }

  list(): AutopilotRun[] {
    const rows = [...this.sql.exec(
      "SELECT data FROM autopilot_runs ORDER BY created_at DESC LIMIT ?",
      AUTOPILOT_MAX_RUNS_KEPT,
    )];
    const runs: AutopilotRun[] = [];
    for (const row of rows) {
      try {
        runs.push(JSON.parse(row.data as string) as AutopilotRun);
      } catch {
        // Skip a corrupt row rather than failing the whole list.
      }
    }
    return runs;
  }
}

/**
 * The run list the API serves: per-run table rows merged with any runs
 * still held in the legacy agent-state field (written before issue #110).
 * Table rows win on id; the result is newest-first and capped. Pure, so
 * the merge semantics are unit-testable without a Durable Object.
 */
export function mergeAutopilotRuns(
  stored: AutopilotRun[],
  legacy: AutopilotRun[],
): AutopilotRun[] {
  const byId = new Map<string, AutopilotRun>();
  for (const run of legacy) byId.set(run.id, run);
  for (const run of stored) byId.set(run.id, run);
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, AUTOPILOT_MAX_RUNS_KEPT);
}

/** The Sessions namespace one run's transcript lives under. */
export function autopilotSessionId(runId: string): string {
  return "autopilot-" + runId;
}

/**
 * Mirror a run into the Sessions store (agents/sessions — the capability
 * Think itself runs on) as a readable transcript: the goal as the user turn,
 * then each finished step's finding, the verifier's verdict, and the final
 * answer. Message ids are stable per run part and appendMessage is
 * idempotent on id, so the pipeline's save-on-every-transition hook can call
 * this on every save without duplicating rows. The verdict and the answer
 * go through an append-or-update: a replan replaces the verdict, and an
 * insert-or-ignore append alone would leave the superseded round-0 verdict
 * in the transcript forever (issue #110). Recording is observability,
 * never a run dependency: failures are logged, never thrown.
 */
export async function recordRunToSession(sessions: Sessions, run: AutopilotRun): Promise<void> {
  try {
    const session = sessions.session(autopilotSessionId(run.id));
    const parts = (text: string): SessionMessage["parts"] => [{ type: "text", text }];
    const upsert = async (message: SessionMessage): Promise<void> => {
      const res = await session.appendMessage(message);
      if (!res.inserted) await session.updateMessage(message);
    };
    await session.appendMessage({ id: "goal", role: "user", parts: parts("Goal: " + run.goal) });
    for (const step of run.steps) {
      if (!step.answer) continue;
      await session.appendMessage({
        id: "step-" + step.id,
        role: "assistant",
        parts: parts(step.title + "\n" + step.answer),
      });
    }
    if (run.verification) {
      const v = run.verification;
      await upsert({
        id: "verdict",
        role: "assistant",
        parts: parts(
          "Verifier: " + (v.complete ? "complete" : "incomplete") +
            " — confidence " + v.confidence + ". " + v.summary +
            (v.gaps.length ? " Gaps: " + v.gaps.join("; ") : ""),
        ),
      });
    }
    if (run.answer) {
      await upsert({ id: "answer", role: "assistant", parts: parts(run.answer) });
    }
  } catch (err) {
    console.error("autopilot session recording failed:", err);
  }
}

/** Read a run's Sessions transcript back as flat text messages. */
export async function readRunSession(
  sessions: Sessions,
  runId: string,
): Promise<Array<{ id: string; role: string; text: string }>> {
  const history = await sessions.session(autopilotSessionId(runId)).getHistory();
  return history.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.parts
      .map((part) => (part.type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
      .join(""),
  }));
}
