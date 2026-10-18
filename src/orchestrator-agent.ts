import { callable } from "agents";
import { Think } from "@cloudflare/think";
import type { Env } from "./types";
import { defaultModelId } from "./models";
import { runRouted, type ModelTask } from "./model-routing";
import {
  catalogAgent,
  outcomeFromReply,
  parsePlan,
  parseSupervisorReply,
  memoryBrief,
  isUnreliableOp,
  plannerPrompt,
  summarizeOutcomes,
  supervisorPrompt,
  topoWaves,
  MAX_REVISIONS,
  MAX_TOTAL_STEPS,
  type MemoryJobRow,
  type MemoryOpStat,
  type PlanStep,
  type StepOutcome,
  type SupervisorVerdict,
} from "./orchestrate";

// OrchestratorAgent (issue #180): multi-agent orchestration for
// cfpay. Its single responsibility is coordinating the other
// agents - it does no domain work itself.
//
// The host agent already dispatches one agent at a time inside its
// own conversation. This agent is the layer above that: given a
// goal it PLANS explicit steps across agents (from the operation
// catalog in src/orchestrate.ts, which is the only thing the
// planner may propose), executes them with parallel fan-out where
// steps are independent, supervises each result (one retry, then
// a named failure - dependents are skipped, never silently
// dropped), and merges everything into one job report. Jobs and
// steps persist in the agent's own SQL, so a job outlives any
// conversation.
//
// Dispatch goes through each agent's own handleA2A - the same
// entry an external A2A caller uses - so every agent's own gates
// apply unchanged: payment.process refuses without a verified
// claim, trades still need dashboard approval, QA stays read-only.
// Orchestration adds no bypass and holds no other agent's secrets.
//
// Why A2A rather than agent-as-a-tool (the host's mechanism): one
// dispatch path per agent (the same code the endpoint tests and
// external callers exercise), gates enforced by the owning agent
// rather than the caller's context, and a request/reply contract
// that fits durable parallel jobs - where a tool call runs the
// child inside the host's chat turn, with its history and
// cancellation. The README's Multi-agent orchestration section
// carries the full rationale.

export interface OrchestratorJob {
  id: string;
  goal: string;
  status: string; // planning | running | done | partial | failed
  mode: string; // plan | supervise (issue #185)
  revisions: number;
  plan: PlanStep[];
  outcomes: StepOutcome[];
  result?: string;
  memoryBrief?: string;
  createdAt: number;
  finishedAt?: number;
}

export class OrchestratorAgent extends Think<Env> {
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the orchestration capability agent for this Worker.",
      "Your one job is coordinating the other agents: plan a goal into steps from the operation catalog, dispatch each step through the owning agent's A2A handler, supervise the results, and merge them into one report.",
      "You never do another agent's work yourself, never invent an operation that is not in the catalog, and never hide a failed step - failures are retried once and then reported by name.",
    ].join(" ");
  }

  override getTools(): Record<string, never> {
    return {};
  }

  private db() {
    return this.ctx.storage.sql;
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db().exec(`PRAGMA table_info(${table})`).toArray() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db().exec(ddl);
  }

  private ensureTables(): void {
    this.db().exec(
      `CREATE TABLE IF NOT EXISTS orchestrate_jobs (
         id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
         plan_json TEXT NOT NULL DEFAULT '[]', result TEXT,
         created_at INTEGER NOT NULL, finished_at INTEGER
       )`,
    );
    this.db().exec(
      `CREATE TABLE IF NOT EXISTS orchestrate_steps (
         job_id TEXT NOT NULL, step_id TEXT NOT NULL, agent TEXT NOT NULL,
         operation TEXT NOT NULL, status TEXT NOT NULL, reply TEXT, error TEXT,
         attempts INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (job_id, step_id)
       )`,
    );
    this.ensureColumn("orchestrate_jobs", "mode", `ALTER TABLE orchestrate_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan'`);
    this.ensureColumn("orchestrate_jobs", "revisions", `ALTER TABLE orchestrate_jobs ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0`);
    this.ensureColumn("orchestrate_jobs", "memory_brief", `ALTER TABLE orchestrate_jobs ADD COLUMN memory_brief TEXT NOT NULL DEFAULT ''`);
    this.db().exec(
      `CREATE TABLE IF NOT EXISTS orchestrate_op_stats (
         operation TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0,
         failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
         last_at INTEGER NOT NULL DEFAULT 0
       )`,
    );
  }

  private origin(): string {
    return this.env.SELF_ORIGIN ?? "https://pay.openaimp.com";
  }

  /** One model call returning plain text (Workers AI chat shape). */
  private async rawModelText(modelId: string, prompt: string): Promise<string> {
    const res = (await this.env.AI.run(modelId as never, {
      messages: [{ role: "user", content: prompt }],
    } as never)) as { response?: string; choices?: { message?: { content?: string } }[] } | string;
    if (typeof res === "string") return res;
    return res?.response ?? res?.choices?.[0]?.message?.content ?? "";
  }

  /**
   * A routed model call (issue #212): per-task chain with one retry
   * and fallback on transient provider errors (3043 class). The
   * account-level quota (4006) is terminal inside the router and
   * surfaces immediately.
   */
  private async modelText(prompt: string, task: ModelTask = "plan"): Promise<string> {
    const { result } = await runRouted(task, (modelId) => this.rawModelText(modelId, prompt));
    return result;
  }

  /**
   * Read-before-planning (issue #192, item 3): distill past jobs and
   * per-operation outcomes into the planner's memory brief. Jobs
   * arrive newest-first; relevance scoring lives in orchestrate.ts.
   */
  private readMemoryBrief(goal: string): string {
    const jobs = this.db()
      .exec(`SELECT goal, status FROM orchestrate_jobs WHERE status IN ('done', 'partial', 'failed') ORDER BY created_at DESC LIMIT 30`)
      .toArray() as unknown as MemoryJobRow[];
    const stats = this.db()
      .exec(`SELECT operation, runs, failures, last_error AS lastError FROM orchestrate_op_stats`)
      .toArray() as unknown as MemoryOpStat[];
    return memoryBrief(goal, jobs, stats);
  }

  /**
   * Write-outcomes-back (issue #192, item 3): fold one job's executed
   * steps into the per-operation reliability counters the next plan
   * reads. Skipped steps never ran, so they are not counted.
   */
  private recordOpStats(outcomes: StepOutcome[]): void {
    for (const o of outcomes) {
      if (o.skipped) continue;
      this.db().exec(
        `INSERT INTO orchestrate_op_stats (operation, runs, failures, last_error, last_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(operation) DO UPDATE SET
           runs = runs + 1,
           failures = failures + excluded.failures,
           last_error = COALESCE(excluded.last_error, last_error),
           last_at = excluded.last_at`,
        o.operation, o.ok ? 0 : 1, o.ok ? null : String(o.error ?? "failed").slice(0, 200), Date.now(),
      );
    }
  }

  /** Plan a goal into catalog steps (with its memory brief). One correction retry, then a named failure. */
  private async plan(goal: string, brief?: string): Promise<PlanStep[]> {
    const first = parsePlan(await this.modelText(plannerPrompt(goal, brief)));
    if (first) return first;
    const second = parsePlan(
      await this.modelText(plannerPrompt(goal, brief) + "\nYour previous reply was not a valid plan. Reply with ONLY the JSON array."),
    );
    if (second) return second;
    throw new Error("planning_failed: the model did not produce a valid plan from the operation catalog");
  }

  /** Dispatch one step through the owning agent's A2A handler. */
  private async dispatchStep(step: PlanStep): Promise<StepOutcome> {
    const entry = catalogAgent(step.agent);
    if (!entry) {
      return { stepId: step.id, agent: step.agent, operation: step.operation, ok: false, error: `unknown agent ${step.agent}` };
    }
    const body = {
      jsonrpc: "2.0",
      id: `orch-${step.id}`,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: `orch-${step.id}-${Date.now()}`,
          parts: [{ kind: "data", data: { operation: step.operation, ...(step.args ?? {}) } }],
        },
      },
    };
    try {
      const ns = (this.env as unknown as Record<string, DurableObjectNamespace>)[entry.binding];
      const stub = ns.get(ns.idFromName(entry.instance)) as unknown as {
        handleA2A: (b: unknown, o: string) => Promise<{ result?: { parts?: { kind: string; text?: string; data?: unknown }[] } }>;
      };
      const outcome = await stub.handleA2A(body, this.origin());
      const parts = outcome?.result?.parts ?? [];
      const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join(" ").trim();
      const data = parts.find((p) => p.kind === "data")?.data;
      return outcomeFromReply(step, text, data);
    } catch (err) {
      return { stepId: step.id, agent: step.agent, operation: step.operation, ok: false, error: String(err).slice(0, 300) };
    }
  }

  private recordStep(jobId: string, step: PlanStep, status: string, outcome?: StepOutcome, attempts = 0): void {
    this.db().exec(
      `INSERT OR REPLACE INTO orchestrate_steps (job_id, step_id, agent, operation, status, reply, error, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId, step.id, step.agent, step.operation, status,
      outcome?.reply ?? null, outcome?.error ?? null, attempts,
    );
  }

  /** Run one step with supervision: one retry on failure. */
  private async runStep(jobId: string, step: PlanStep): Promise<StepOutcome> {
    let outcome = await this.dispatchStep(step);
    let attempts = 1;
    if (!outcome.ok) {
      outcome = await this.dispatchStep(step);
      attempts = 2;
    }
    this.recordStep(jobId, step, outcome.ok ? "ok" : "failed", outcome, attempts);
    return outcome;
  }

  /** One supervisor review (supervise mode): the model sees the results so far and may revise what remains. Unreadable verdicts count as continue. */
  private async supervise(goal: string, outcomes: StepOutcome[], executedIds: Set<string>): Promise<SupervisorVerdict> {
    try {
      const raw = await this.modelText(supervisorPrompt(goal, summarizeOutcomes(goal, outcomes), [...executedIds]), "supervise");
      return parseSupervisorReply(raw, executedIds) ?? { action: "continue" };
    } catch {
      return { action: "continue" };
    }
  }

  /** Execute one dependency wave: blocked steps are skipped by name, the rest run in parallel. */
  private async executeWave(jobId: string, wave: PlanStep[], byId: Map<string, StepOutcome>, outcomes: StepOutcome[]): Promise<void> {
    const runnable: PlanStep[] = [];
    for (const step of wave) {
      const blockedBy = (step.dependsOn ?? []).find((d) => byId.get(d) && !byId.get(d)!.ok);
      if (blockedBy) {
        const skipped: StepOutcome = {
          stepId: step.id, agent: step.agent, operation: step.operation,
          ok: false, skipped: true, error: `dependency ${blockedBy} failed`,
        };
        byId.set(step.id, skipped);
        outcomes.push(skipped);
        this.recordStep(jobId, step, "skipped", skipped, 0);
      } else {
        runnable.push(step);
      }
    }
    const results = await Promise.all(runnable.map((s) => this.runStep(jobId, s)));
    for (const r of results) {
      byId.set(r.stepId, r);
      outcomes.push(r);
    }
  }

  /**
   * Create, plan, and execute a job end to end. Long-running when QA
   * steps are involved.
   *
   * Two modes (issue #185), sharing the planner, the catalog
   * validation, the dispatcher, and persistence:
   * - "plan" (default): the validated plan executes as computed.
   * - "supervise": after each wave the model reviews the results
   *   and may continue, stop (remaining steps recorded as skipped
   *   with its reason), or revise the remaining steps - bounded by
   *   MAX_REVISIONS reviews and MAX_TOTAL_STEPS total steps.
   */
  @callable()
  async orchestrateRun(goal: string, mode: string = "plan"): Promise<OrchestratorJob> {
    this.ensureTables();
    const g = String(goal || "").trim();
    const m = mode === "supervise" ? "supervise" : "plan";
    const id = `job-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = Date.now();
    if (!g) {
      return { id, goal: g, status: "failed", mode: m, revisions: 0, plan: [], outcomes: [], result: "orchestrate.run needs a goal.", createdAt };
    }
    const brief = this.readMemoryBrief(g);
    this.db().exec(
      `INSERT INTO orchestrate_jobs (id, goal, status, plan_json, mode, memory_brief, created_at) VALUES (?, ?, 'planning', '[]', ?, ?, ?)`,
      id, g, m, brief, createdAt,
    );
    let plan: PlanStep[];
    try {
      plan = await this.plan(g, brief);
    } catch (err) {
      const result = String(err);
      this.db().exec(`UPDATE orchestrate_jobs SET status = 'failed', result = ?, finished_at = ? WHERE id = ?`, result, Date.now(), id);
      return { id, goal: g, status: "failed", mode: m, revisions: 0, plan: [], outcomes: [], result, createdAt, finishedAt: Date.now() };
    }
    this.db().exec(`UPDATE orchestrate_jobs SET status = 'running', plan_json = ? WHERE id = ?`, JSON.stringify(plan), id);

    const outcomes: StepOutcome[] = [];
    const byId = new Map<string, StepOutcome>();
    let remaining = [...plan];
    let revisions = 0;
    for (;;) {
      if (remaining.length) {
        const wave = topoWaves(remaining)[0] ?? [];
        await this.executeWave(id, wave, byId, outcomes);
        const decided = new Set(outcomes.map((o) => o.stepId));
        remaining = remaining.filter((s) => !decided.has(s.id));
        if (m === "plan") {
          if (remaining.length) continue;
          break;
        }
      } else if (m === "plan") {
        break;
      }
      // Supervise mode: review before deciding there is nothing left to change.
      if (revisions >= MAX_REVISIONS) break;
      const executedIds = new Set(outcomes.map((o) => o.stepId));
      const verdict = await this.supervise(g, outcomes, executedIds);
      revisions += 1;
      if (verdict.action === "continue") {
        if (!remaining.length) break;
        continue;
      }
      if (verdict.action === "stop") {
        for (const step of remaining) {
          const skipped: StepOutcome = {
            stepId: step.id, agent: step.agent, operation: step.operation,
            ok: false, skipped: true, error: `supervisor stopped: ${verdict.reason}`,
          };
          byId.set(step.id, skipped);
          outcomes.push(skipped);
          this.recordStep(id, step, "skipped", skipped, 0);
        }
        remaining = [];
        break;
      }
      // revise: replace everything not yet decided, within the total-step bound.
      const decidedSteps = plan.filter((s) => byId.has(s.id));
      if (decidedSteps.length + verdict.steps.length > MAX_TOTAL_STEPS) {
        if (!remaining.length) break;
        continue;
      }
      plan = [...decidedSteps, ...verdict.steps];
      remaining = [...verdict.steps];
      this.db().exec(
        `UPDATE orchestrate_jobs SET plan_json = ?, revisions = ? WHERE id = ?`,
        JSON.stringify(plan), revisions, id,
      );
      if (!remaining.length) break;
    }

    const okCount = outcomes.filter((o) => o.ok).length;
    const status = outcomes.length > 0 && okCount === outcomes.length ? "done" : okCount > 0 ? "partial" : "failed";
    let result = summarizeOutcomes(g, outcomes);
    try {
      const synthesis = await this.modelText(
        [
          "Write the final report for this completed multi-agent job: brief, factual, no invented details. Lead with whether the goal was achieved, then the key findings per step.",
          "",
          summarizeOutcomes(g, outcomes),
        ].join("\n"),
        "synthesize",
      );
      if (synthesis.trim().length > 40) result = synthesis.trim();
    } catch {
      // The deterministic summary stands.
    }
    const finishedAt = Date.now();
    this.db().exec(`UPDATE orchestrate_jobs SET status = ?, result = ?, revisions = ?, finished_at = ? WHERE id = ?`, status, result, revisions, finishedAt, id);
    this.recordOpStats(outcomes);
    return { id, goal: g, status, mode: m, revisions, plan, outcomes, result, memoryBrief: brief || undefined, createdAt, finishedAt };
  }

  /** Recent jobs, newest first (plans included, outcomes summarized in the job rows). */
  @callable()
  async orchestrateJobs(limit = 20): Promise<OrchestratorJob[]> {
    this.ensureTables();
    const rows = this.db()
      .exec(`SELECT * FROM orchestrate_jobs ORDER BY created_at DESC LIMIT ?`, Math.min(Math.max(limit, 1), 50))
      .toArray() as Record<string, unknown>[];
    return rows.map((r) => this.jobFromRow(r));
  }

  /** One job with its recorded step outcomes. */
  @callable()
  async orchestrateJob(id: string): Promise<OrchestratorJob | null> {
    this.ensureTables();
    const rows = this.db().exec(`SELECT * FROM orchestrate_jobs WHERE id = ?`, id).toArray() as Record<string, unknown>[];
    if (!rows.length) return null;
    const job = this.jobFromRow(rows[0]);
    const steps = this.db().exec(`SELECT * FROM orchestrate_steps WHERE job_id = ?`, id).toArray() as Record<string, unknown>[];
    job.outcomes = steps.map((s) => ({
      stepId: String(s.step_id),
      agent: String(s.agent),
      operation: String(s.operation),
      ok: s.status === "ok",
      reply: (s.reply as string) ?? undefined,
      error: (s.error as string) ?? undefined,
      skipped: s.status === "skipped",
    }));
    return job;
  }

  private jobFromRow(r: Record<string, unknown>): OrchestratorJob {
    return {
      id: String(r.id),
      goal: String(r.goal),
      status: String(r.status),
      plan: JSON.parse(String(r.plan_json || "[]")) as PlanStep[],
      mode: String(r.mode ?? "plan"),
      revisions: Number(r.revisions ?? 0),
      outcomes: [],
      result: (r.result as string) ?? undefined,
      memoryBrief: (r.memory_brief as string) || undefined,
      createdAt: Number(r.created_at),
      finishedAt: r.finished_at ? Number(r.finished_at) : undefined,
    };
  }

  /** Configuration/state snapshot for A2A callers: counts plus the planning-memory state. */
  async a2aSnapshot(): Promise<{ agent: string; jobs: number; lastStatus?: string; opsTracked: number; unreliableOps: string[] }> {
    this.ensureTables();
    const rows = this.db().exec(`SELECT COUNT(*) AS n FROM orchestrate_jobs`).toArray() as { n: number }[];
    const last = this.db().exec(`SELECT status FROM orchestrate_jobs ORDER BY created_at DESC LIMIT 1`).toArray() as { status: string }[];
    const stats = this.db()
      .exec(`SELECT operation, runs, failures FROM orchestrate_op_stats`)
      .toArray() as unknown as MemoryOpStat[];
    return {
      agent: "orchestrator",
      jobs: Number(rows[0]?.n ?? 0),
      lastStatus: last[0]?.status,
      opsTracked: stats.length,
      unreliableOps: stats.filter((s) => isUnreliableOp(s)).map((s) => s.operation),
    };
  }

  /** A2A entry point, mirroring the other capability agents. */
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, orchestratorCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, orchestratorCard(origin), {
      card: orchestratorCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: orchestrator.run / orchestrator.jobs; no operation = summary. */
  async handleA2AMessage(
    message: any,
    _context: { taskId: string; contextId: string },
  ): Promise<{ text: string; data?: unknown }> {
    const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
    const dataPart = parts.find(
      (x) => x && x.kind === "data" && x.data && typeof x.data === "object",
    );
    const op = dataPart ? String((dataPart.data as any).operation || "") : "";
    const args = (dataPart?.data as any) ?? {};
    if (op === "orchestrator.run") {
      const job = await this.orchestrateRun(String(args.goal || ""), String(args.mode || "plan"));
      return {
        text: `Job ${job.id} ${job.status}: ${job.outcomes.filter((o) => o.ok).length}/${job.outcomes.length} steps ok.\n${job.result ?? ""}`.slice(0, 1500),
        data: job,
      };
    }
    if (op === "orchestrator.jobs") {
      const jobs = await this.orchestrateJobs(10);
      return {
        text: jobs.length
          ? jobs.map((j) => `${j.id} [${j.status}] ${j.goal}`).join("\n")
          : "No orchestration jobs yet.",
        data: jobs,
      };
    }
    if (op && op !== "orchestrator.summary") {
      return { text: `Unknown operation: ${op}`, data: { ok: false, error: "unknown_operation" } };
    }
    const snapshot = await this.a2aSnapshot();
    return {
      text: `Orchestrator status. ${snapshot.jobs} job(s) run${snapshot.lastStatus ? `, most recent ${snapshot.lastStatus}` : ""}. Planning memory: ${snapshot.opsTracked} operation(s) tracked${snapshot.unreliableOps.length ? `, unreliable: ${snapshot.unreliableOps.join(", ")}` : ""}. Give me a goal (orchestrator.run) and I will plan it across the agents, run the steps, and merge the results.`,
      data: snapshot,
    };
  }
}
