import { callable } from "agents";
import { Think } from "@cloudflare/think";
import type { Env } from "./types";
import { defaultModelId } from "./models";
import {
  catalogAgent,
  outcomeFromReply,
  parsePlan,
  plannerPrompt,
  summarizeOutcomes,
  topoWaves,
  type PlanStep,
  type StepOutcome,
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
  plan: PlanStep[];
  outcomes: StepOutcome[];
  result?: string;
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
  }

  private origin(): string {
    return this.env.SELF_ORIGIN ?? "https://pay.openaimp.com";
  }

  /** One model call returning plain text (Workers AI chat shape). */
  private async modelText(prompt: string): Promise<string> {
    const res = (await this.env.AI.run(this.getModel() as never, {
      messages: [{ role: "user", content: prompt }],
    } as never)) as { response?: string; choices?: { message?: { content?: string } }[] } | string;
    if (typeof res === "string") return res;
    return res?.response ?? res?.choices?.[0]?.message?.content ?? "";
  }

  /** Plan a goal into catalog steps. One correction retry, then a named failure. */
  private async plan(goal: string): Promise<PlanStep[]> {
    const first = parsePlan(await this.modelText(plannerPrompt(goal)));
    if (first) return first;
    const second = parsePlan(
      await this.modelText(plannerPrompt(goal) + "\nYour previous reply was not a valid plan. Reply with ONLY the JSON array."),
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

  /** Create, plan, and execute a job end to end. Long-running when QA steps are involved. */
  @callable()
  async orchestrateRun(goal: string): Promise<OrchestratorJob> {
    this.ensureTables();
    const g = String(goal || "").trim();
    const id = `job-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = Date.now();
    if (!g) {
      return { id, goal: g, status: "failed", plan: [], outcomes: [], result: "orchestrate.run needs a goal.", createdAt };
    }
    this.db().exec(
      `INSERT INTO orchestrate_jobs (id, goal, status, plan_json, created_at) VALUES (?, ?, 'planning', '[]', ?)`,
      id, g, createdAt,
    );
    let plan: PlanStep[];
    try {
      plan = await this.plan(g);
    } catch (err) {
      const result = String(err);
      this.db().exec(`UPDATE orchestrate_jobs SET status = 'failed', result = ?, finished_at = ? WHERE id = ?`, result, Date.now(), id);
      return { id, goal: g, status: "failed", plan: [], outcomes: [], result, createdAt, finishedAt: Date.now() };
    }
    this.db().exec(`UPDATE orchestrate_jobs SET status = 'running', plan_json = ? WHERE id = ?`, JSON.stringify(plan), id);

    const outcomes: StepOutcome[] = [];
    const byId = new Map<string, StepOutcome>();
    for (const wave of topoWaves(plan)) {
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
          this.recordStep(id, step, "skipped", skipped, 0);
        } else {
          runnable.push(step);
        }
      }
      const results = await Promise.all(runnable.map((s) => this.runStep(id, s)));
      for (const r of results) {
        byId.set(r.stepId, r);
        outcomes.push(r);
      }
    }

    const okCount = outcomes.filter((o) => o.ok).length;
    const status = okCount === outcomes.length ? "done" : okCount > 0 ? "partial" : "failed";
    let result = summarizeOutcomes(g, outcomes);
    try {
      const synthesis = await this.modelText(
        [
          "Write the final report for this completed multi-agent job: brief, factual, no invented details. Lead with whether the goal was achieved, then the key findings per step.",
          "",
          summarizeOutcomes(g, outcomes),
        ].join("\n"),
      );
      if (synthesis.trim().length > 40) result = synthesis.trim();
    } catch {
      // The deterministic summary stands.
    }
    const finishedAt = Date.now();
    this.db().exec(`UPDATE orchestrate_jobs SET status = ?, result = ?, finished_at = ? WHERE id = ?`, status, result, finishedAt, id);
    return { id, goal: g, status, plan, outcomes, result, createdAt, finishedAt };
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
      outcomes: [],
      result: (r.result as string) ?? undefined,
      createdAt: Number(r.created_at),
      finishedAt: r.finished_at ? Number(r.finished_at) : undefined,
    };
  }

  /** Configuration/state snapshot for A2A callers: counts only. */
  async a2aSnapshot(): Promise<{ agent: string; jobs: number; lastStatus?: string }> {
    this.ensureTables();
    const rows = this.db().exec(`SELECT COUNT(*) AS n FROM orchestrate_jobs`).toArray() as { n: number }[];
    const last = this.db().exec(`SELECT status FROM orchestrate_jobs ORDER BY created_at DESC LIMIT 1`).toArray() as { status: string }[];
    return { agent: "orchestrator", jobs: Number(rows[0]?.n ?? 0), lastStatus: last[0]?.status };
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
      const job = await this.orchestrateRun(String(args.goal || ""));
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
      text: `Orchestrator status. ${snapshot.jobs} job(s) run${snapshot.lastStatus ? `, most recent ${snapshot.lastStatus}` : ""}. Give me a goal (orchestrator.run) and I will plan it across the agents, run the steps, and merge the results.`,
      data: snapshot,
    };
  }
}
