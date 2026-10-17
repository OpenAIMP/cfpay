// Multi-agent orchestration: the planning core (issue #180).
//
// Pure and SDK-free so vitest covers it. The OrchestratorAgent
// (src/orchestrator-agent.ts) owns the Durable Object, the model
// calls, and the dispatch; everything decidable - which operations
// may be planned, whether a plan is valid, which steps can run in
// parallel, how step results merge - lives here and is tested.
//
// The catalog below is the single source of truth for plannable
// operations. It mirrors each agent's A2A dispatch switch; the
// planner prompt is generated FROM it, so the model can only ever
// propose steps that exist. Two deliberate exclusions, both because
// a plan cannot author their inputs or semantics:
//   - email.sendWithAttachments (attachment bytes can't be planned)
//   - webhook.receive (inbound-event simulation, not coordination)
//   - chat.clear (destructive; orchestration never wipes state)
// (slack.post was briefly excluded while the Slack agent refused
// it over A2A; the owner enabled posting over A2A in issue #188,
// so it is plannable like the other operations.)
// Every other operation keeps its own agent's gates: payment.process
// still refuses without a verified claim, trade proposals still
// require dashboard approval. Orchestration adds no bypass.

export interface CatalogEntry {
  agent: string;
  /** Durable Object binding name on the Worker Env. */
  binding: string;
  /** Instance name, matching src/index.ts's A2A routing. */
  instance: string;
  operations: string[];
  blurb: string;
}

export const OPERATION_CATALOG: CatalogEntry[] = [
  { agent: "host", binding: "CfmailAgent", instance: "agent", operations: ["chat.summary", "chat.facts", "chat.send"], blurb: "The main agent: mailbox facts, summaries, and its own chat." },
  { agent: "email", binding: "EMAIL_AGENT", instance: "email", operations: ["email.summary", "email.totals", "email.list", "email.quota", "email.send"], blurb: "Email records and sending (the agent's quota and self-send rules apply)." },
  { agent: "payments", binding: "PAYMENTS_AGENT", instance: "payments", operations: ["ledger.summary", "payments.list", "payments.totals", "payment.process", "checkout.create", "checkout.status", "checkout.fulfil"], blurb: "The payments ledger and x402 checkouts. payment.process refuses without a verified claim or card reference." },
  { agent: "webhooks", binding: "WEBHOOK_AGENT", instance: "webhooks", operations: ["webhook.summary", "webhook.totals", "webhook.list"], blurb: "Inbound webhook event records." },
  { agent: "slack", binding: "SLACK_AGENT", instance: "slack", operations: ["slack.summary", "slack.totals", "slack.status", "slack.list", "slack.post"], blurb: "Slack channel records, status, and posting (slack.post: channel argument posts via the bot, otherwise via the incoming webhook)." },
  { agent: "qa", binding: "QA_AGENT", instance: "qa", operations: ["qa.summary", "qa.check", "qa.dashboard", "qa.ux_audit", "qa.investigate", "qa.browser_profile"], blurb: "Browser QA: checks, dashboard verification, UX audits, investigations. Browser steps are slow (minutes)." },
  { agent: "chat", binding: "CHAT_AGENT", instance: "chat", operations: ["chat.summary", "chat.totals", "chat.transcript", "chat.emailTranscript"], blurb: "Conversation history records and transcripts." },
  { agent: "voice", binding: "VOICE_AGENT", instance: "desk", operations: ["voice.snapshot", "voice.ask"], blurb: "The voice channel: voice.ask runs the desk pipeline and returns the speakable answer." },
  { agent: "search", binding: "SEARCH_AGENT", instance: "search", operations: ["search.summary", "search.query", "search.ask"], blurb: "Knowledge-base retrieval over the owner's AI Search index." },
];

export function catalogAgent(agent: string): CatalogEntry | undefined {
  return OPERATION_CATALOG.find((e) => e.agent === agent);
}

export interface PlanStep {
  id: string;
  agent: string;
  operation: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
}

/** The planner prompt: goal + the catalog, generated from the catalog itself. With a memory brief (issue #192), past outcomes ride along. */
export function plannerPrompt(goal: string, brief?: string): string {
  const lines = OPERATION_CATALOG.map(
    (e) => `- ${e.agent}: ${e.operations.join(", ")} - ${e.blurb}`,
  );
  return [
    "You plan work for a multi-agent system. Break the goal into steps, each executed by ONE agent operation from this catalog:",
    ...lines,
    "",
    "Rules:",
    "- Reply with ONLY a JSON array of steps, no prose.",
    '- Each step: {"id": "s1", "agent": "qa", "operation": "qa.summary", "args": {}, "dependsOn": []}.',
    "- args carries the operation's inputs (e.g. a url for qa.check, a query for search.ask, to/subject/body for email.send).",
    "- Use dependsOn only when a step truly needs an earlier step's result; independent steps run in parallel.",
    "- At most 8 steps. Prefer the fewest steps that achieve the goal. Read-only summary operations are cheap; browser QA operations are slow.",
    ...(brief ? ["", brief] : []),
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

/** Supervisor bounds (issue #185): revisions per job, and total steps across the original plan plus revisions. */
export const MAX_REVISIONS = 3;
export const MAX_TOTAL_STEPS = 12;

/**
 * Validate raw step objects against the catalog. Dependencies may
 * reference steps in the same set or ids in `externalIds` (steps
 * already executed, for supervisor revisions). Null when unusable.
 */
export function validateSteps(parsed: unknown, externalIds: Set<string>, cap: number): PlanStep[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > cap) return null;
  const steps: PlanStep[] = [];
  const ids = new Set<string>(externalIds);
  for (const item of parsed) {
    const s = item as Partial<PlanStep>;
    if (!s || typeof s.id !== "string" || typeof s.agent !== "string" || typeof s.operation !== "string") return null;
    const entry = catalogAgent(s.agent);
    if (!entry || !entry.operations.includes(s.operation)) return null;
    if (ids.has(s.id)) return null;
    ids.add(s.id);
    steps.push({
      id: s.id,
      agent: s.agent,
      operation: s.operation,
      args: s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {},
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    });
  }
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) if (!ids.has(dep)) return null;
  }
  const done = new Set<string>(externalIds);
  let progress = true;
  while (progress && done.size < ids.size) {
    progress = false;
    for (const s of steps) {
      if (!done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d))) {
        done.add(s.id);
        progress = true;
      }
    }
  }
  return done.size === ids.size ? steps : null;
}

/** Extract and validate a plan from the model's reply. Null when unusable. */
export function parsePlan(raw: string): PlanStep[] | null {
  if (!raw) return null;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  return validateSteps(parsed, new Set(), 8);
}

export type SupervisorVerdict =
  | { action: "continue" }
  | { action: "stop"; reason: string }
  | { action: "revise"; steps: PlanStep[] };

/** The between-waves review prompt (supervise mode, issue #185). */
export function supervisorPrompt(goal: string, outcomesText: string, executedIds: string[]): string {
  const lines = OPERATION_CATALOG.map((e) => `- ${e.agent}: ${e.operations.join(", ")}`);
  return [
    "You supervise a multi-agent job in progress. Review the results so far against the goal and return ONE JSON object:",
    '{"action": "continue"} - the remaining plan is right; keep going.',
    '{"action": "stop", "reason": "..."} - the goal is met, or cannot be met; stop. Remaining steps are recorded as skipped with your reason.',
    '{"action": "revise", "steps": [ ... ]} - replace ALL remaining steps with this new step list (same step shape as planning). New steps may depend on executed step ids: ' + executedIds.join(", ") + ". Never reuse an executed id.",
    "",
    "Available operations:",
    ...lines,
    "",
    `Goal: ${goal}`,
    "",
    "Results so far:",
    outcomesText,
  ].join("\n");
}

/** Parse and validate a supervisor verdict. Null = unreadable (the caller treats it as continue). */
export function parseSupervisorReply(raw: string, executedIds: Set<string>): SupervisorVerdict | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: { action?: string; reason?: string; steps?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed.action === "continue") return { action: "continue" };
  if (parsed.action === "stop") return { action: "stop", reason: String(parsed.reason || "supervisor stopped the job").slice(0, 200) };
  if (parsed.action === "revise") {
    const steps = validateSteps(parsed.steps, executedIds, MAX_TOTAL_STEPS);
    return steps ? { action: "revise", steps } : null;
  }
  return null;
}

/** Group steps into dependency waves; steps in one wave run in parallel. */
export function topoWaves(steps: PlanStep[]): PlanStep[][] {
  const waves: PlanStep[][] = [];
  const placed = new Set<string>();
  let remaining = [...steps];
  while (remaining.length) {
    const wave = remaining.filter((s) => (s.dependsOn ?? []).every((d) => placed.has(d)));
    if (!wave.length) break; // cycle (parsePlan rejects these; defensive)
    waves.push(wave);
    for (const s of wave) placed.add(s.id);
    remaining = remaining.filter((s) => !placed.has(s.id));
  }
  return waves;
}

export interface StepOutcome {
  stepId: string;
  agent: string;
  operation: string;
  ok: boolean;
  reply?: string;
  error?: string;
  skipped?: boolean;
}

/** Did a dispatch result count as failure? Agents report failures as data.ok === false or a data.error string. */
export function outcomeFromReply(step: PlanStep, text: string, data: unknown): StepOutcome {
  const d = (data ?? {}) as { ok?: unknown; error?: unknown };
  const failed = !text || d.ok === false || (typeof d.error === "string" && d.error.length > 0);
  return failed
    ? { stepId: step.id, agent: step.agent, operation: step.operation, ok: false, error: (typeof d.error === "string" ? d.error : text || "no reply").slice(0, 300) }
    : { stepId: step.id, agent: step.agent, operation: step.operation, ok: true, reply: text.slice(0, 1200) };
}

/** The deterministic merged report (also the synthesis fallback). */
export function summarizeOutcomes(goal: string, outcomes: StepOutcome[]): string {
  const lines = outcomes.map((o) =>
    o.skipped
      ? `- ${o.stepId} ${o.agent}/${o.operation}: SKIPPED (${o.error || "dependency failed"})`
      : o.ok
        ? `- ${o.stepId} ${o.agent}/${o.operation}: OK - ${o.reply || ""}`
        : `- ${o.stepId} ${o.agent}/${o.operation}: FAILED - ${o.error || "unknown error"}`,
  );
  const ok = outcomes.filter((o) => o.ok).length;
  return [`Goal: ${goal}`, `${ok}/${outcomes.length} steps succeeded.`, ...lines].join("\n");
}

/**
 * Planning memory (issue #192, item 3): the orchestrator used to
 * plan every goal cold. Past jobs and per-operation outcomes persist
 * in the agent's tables; this distills them deterministically - no
 * extra model call - into a short brief for the planner: similar
 * past goals and how they ended, plus operations carrying a recent
 * failure record. Retrieval is token overlap; reliability is
 * counted, not vibes.
 */
export interface MemoryJobRow {
  goal: string;
  status: string;
}
export interface MemoryOpStat {
  operation: string;
  runs: number;
  failures: number;
  lastError?: string;
}

const GOAL_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "from",
  "give", "me", "show", "all", "every", "recent", "state", "status",
  "report", "summarize", "summary", "check",
]);

/** Content tokens of a goal: lowercase words of 3+ chars, minus glue words. */
export function goalTokens(goal: string): Set<string> {
  const out = new Set<string>();
  for (const t of String(goal || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !GOAL_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** An operation is unreliable when at least half of its last runs (2+) failed. */
export function isUnreliableOp(s: MemoryOpStat): boolean {
  return s.runs >= 2 && s.failures > 0 && s.failures / s.runs >= 0.5;
}

/**
 * Build the planner's memory brief. `jobs` arrives newest-first;
 * relevance is shared content tokens (recency breaks ties). Empty
 * string when nothing is relevant - the prompt is then unchanged.
 */
export function memoryBrief(goal: string, jobs: MemoryJobRow[], stats: MemoryOpStat[]): string {
  const lines: string[] = [];
  const tokens = goalTokens(goal);
  if (tokens.size) {
    const scored = jobs
      .map((j) => ({ j, score: [...goalTokens(j.goal)].filter((t) => tokens.has(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const { j } of scored) {
      lines.push(`- A previous goal "${j.goal.slice(0, 90)}" finished ${j.status}.`);
    }
  }
  const unreliable = stats.filter(isUnreliableOp).sort((a, b) => b.failures - a.failures).slice(0, 4);
  for (const s of unreliable) {
    lines.push(
      `- ${s.operation} has failed ${s.failures} of its last ${s.runs} runs${s.lastError ? ` (last error: ${s.lastError.slice(0, 90)})` : ""}. Avoid it unless the goal requires it; if you use it, expect it may fail.`,
    );
  }
  if (!lines.length) return "";
  return ["Memory from previous jobs (real outcomes - plan with them, do not repeat a step that already failed the same way):", ...lines]
    .join("\n")
    .slice(0, 1200);
}
