import { callable } from "agents";
import { Think } from "@cloudflare/think";
import type { Env } from "./types";
import { defaultModelId } from "./models";
import { nextCronRun, normalizeCron } from "./cron-next";

// ScheduledAgent (issue #213; bundle 202 adapted): the fleet's
// clock. Its single responsibility is owning scheduled goals -
// {goal, cron} rows in its own SQL - and, when one falls due,
// handing the goal to the OrchestratorAgent through the
// orchestrator's own A2A handler. It does no domain work itself,
// holds no other agent's secrets, and adds no bypass: a scheduled
// run is an ordinary orchestrator job, with every agent's gates
// applying unchanged.
//
// Time source: the Worker's cron trigger (wrangler triggers.crons,
// every minute, UTC) calls scheduledTick() via the scheduled()
// handler in src/index.ts. Cron math lives in src/cron-next.ts
// (pure, UTC). NOTHING is seeded: no goal exists - and no
// autonomous run can spend anything - until the owner creates one
// through the dashboard API, A2A, or the host's scheduledAgent tool.

export interface ScheduledGoal {
  id: string;
  goal: string;
  cron: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runs: number;
  lastJobId?: string;
  lastStatus?: string;
}

interface ScheduledGoalRow {
  id: string;
  goal: string;
  cron: string;
  enabled: number;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  runs: number;
  last_job_id: string | null;
  last_status: string | null;
}

const MAX_GOALS_PER_TICK = 5;

export class ScheduledAgent extends Think<Env> {
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the scheduling capability agent for this Worker.",
      "Your one job is owning scheduled goals: store {goal, cron} rows, and when one falls due, hand the goal to the orchestrator through its A2A handler.",
      "You never execute a goal's work yourself, never invent a schedule that was not given to you, and a goal that errors is recorded by name and moved to its next slot - never retried in a hot loop.",
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
      `CREATE TABLE IF NOT EXISTS scheduled_goals (
         id TEXT PRIMARY KEY, goal TEXT NOT NULL, cron TEXT NOT NULL,
         enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
         last_run_at TEXT, next_run_at TEXT,
         runs INTEGER NOT NULL DEFAULT 0, last_job_id TEXT, last_status TEXT
       )`,
    );
  }

  private shape(row: ScheduledGoalRow): ScheduledGoal {
    return {
      id: row.id,
      goal: row.goal,
      cron: row.cron,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      runs: row.runs,
      lastJobId: row.last_job_id ?? undefined,
      lastStatus: row.last_status ?? undefined,
    };
  }

  private origin(): string {
    return this.env.SELF_ORIGIN ?? "https://pay.openaimp.com";
  }

  @callable()
  async scheduledList(): Promise<ScheduledGoal[]> {
    this.ensureTables();
    const rows = this.db()
      .exec(`SELECT * FROM scheduled_goals ORDER BY created_at ASC`)
      .toArray() as unknown as ScheduledGoalRow[];
    return rows.map((r) => this.shape(r));
  }

  @callable()
  async scheduledCreate(
    goal: string,
    cron: string,
  ): Promise<{ ok: boolean; goal?: ScheduledGoal; error?: string }> {
    this.ensureTables();
    const text = String(goal ?? "").trim();
    if (!text) return { ok: false, error: "goal_required" };
    if (text.length > 500) return { ok: false, error: "goal_too_long" };
    const normalized = normalizeCron(String(cron ?? ""));
    if (!normalized) return { ok: false, error: "invalid_cron" };
    const now = new Date();
    const next = nextCronRun(normalized, now);
    if (!next) return { ok: false, error: "cron_never_fires" };
    const row: ScheduledGoalRow = {
      id: `sched-${crypto.randomUUID().slice(0, 8)}`,
      goal: text,
      cron: normalized,
      enabled: 1,
      created_at: now.toISOString(),
      last_run_at: null,
      next_run_at: next.toISOString(),
      runs: 0,
      last_job_id: null,
      last_status: null,
    };
    this.db().exec(
      `INSERT INTO scheduled_goals (id, goal, cron, enabled, created_at, last_run_at, next_run_at, runs, last_job_id, last_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.goal, row.cron, row.enabled, row.created_at, row.last_run_at, row.next_run_at, row.runs, row.last_job_id, row.last_status,
    );
    return { ok: true, goal: this.shape(row) };
  }

  @callable()
  async scheduledDelete(id: string): Promise<{ ok: boolean }> {
    this.ensureTables();
    this.db().exec(`DELETE FROM scheduled_goals WHERE id = ?`, String(id ?? ""));
    return { ok: true };
  }

  @callable()
  async scheduledSetEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    this.ensureTables();
    const rows = this.db()
      .exec(`SELECT * FROM scheduled_goals WHERE id = ?`, String(id ?? ""))
      .toArray() as unknown as ScheduledGoalRow[];
    if (!rows.length) return { ok: false, error: "not_found" };
    // Re-enabling re-arms from now, so a long-disabled goal does not
    // fire a backlog of missed runs.
    const next = enabled ? nextCronRun(rows[0].cron, new Date()) : null;
    this.db().exec(
      `UPDATE scheduled_goals SET enabled = ?, next_run_at = ? WHERE id = ?`,
      enabled ? 1 : 0, next ? next.toISOString() : rows[0].next_run_at, rows[0].id,
    );
    return { ok: true };
  }

  /**
   * The heartbeat (called from the Worker's scheduled handler every
   * minute): dispatch every due goal to the orchestrator, cap the
   * fan-out per tick, and ALWAYS advance a fired goal to its next
   * slot - a failing goal must not refire every minute.
   */
  @callable()
  async scheduledTick(): Promise<{ ran: string[]; failed: string[] }> {
    this.ensureTables();
    const now = new Date();
    const nowIso = now.toISOString();
    const due = (this.db()
      .exec(`SELECT * FROM scheduled_goals WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`, nowIso, MAX_GOALS_PER_TICK)
      .toArray() as unknown as ScheduledGoalRow[]);
    const ran: string[] = [];
    const failed: string[] = [];
    for (const row of due) {
      const next = nextCronRun(row.cron, now);
      try {
        const jobId = await this.dispatchGoal(row.goal);
        this.db().exec(
          `UPDATE scheduled_goals SET last_run_at = ?, next_run_at = ?, runs = runs + 1, last_job_id = ?, last_status = ? WHERE id = ?`,
          nowIso, next ? next.toISOString() : null, jobId, "dispatched", row.id,
        );
        ran.push(row.id);
      } catch (err) {
        this.db().exec(
          `UPDATE scheduled_goals SET last_run_at = ?, next_run_at = ?, runs = runs + 1, last_status = ? WHERE id = ?`,
          nowIso, next ? next.toISOString() : null, `error: ${String(err).slice(0, 160)}`, row.id,
        );
        failed.push(row.id);
      }
    }
    return { ran, failed };
  }

  /** Hand one goal to the orchestrator through its A2A handler; returns the job id when reported. */
  private async dispatchGoal(goal: string): Promise<string | undefined> {
    const ns = this.env.ORCHESTRATOR_AGENT;
    const stub = ns.get(ns.idFromName("orchestrator")) as unknown as {
      handleA2A: (b: unknown, o: string) => Promise<{ result?: { parts?: { kind: string; text?: string; data?: { id?: string } }[] } }>;
    };
    const body = {
      jsonrpc: "2.0",
      id: `sched-${Date.now()}`,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: `sched-${crypto.randomUUID()}`,
          parts: [{ kind: "data", data: { operation: "orchestrator.run", goal, mode: "plan" } }],
        },
      },
    };
    const outcome = await stub.handleA2A(body, this.origin());
    const data = outcome?.result?.parts?.find((p) => p.kind === "data")?.data;
    return data?.id ? String(data.id) : undefined;
  }

  /** Configuration/state snapshot for A2A callers. */
  async a2aSnapshot(): Promise<{ agent: string; goals: number; enabled: number; totalRuns: number; nextDue?: string }> {
    this.ensureTables();
    const goals = await this.scheduledList();
    const enabled = goals.filter((g) => g.enabled);
    const nextDue = enabled
      .map((g) => g.nextRunAt)
      .filter((t): t is string => Boolean(t))
      .sort()[0];
    return {
      agent: "scheduled",
      goals: goals.length,
      enabled: enabled.length,
      totalRuns: goals.reduce((sum, g) => sum + g.runs, 0),
      nextDue,
    };
  }

  /** A2A entry point, mirroring the other capability agents. */
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, scheduledCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, scheduledCard(origin), {
      card: scheduledCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: scheduled.list/create/delete; no operation = summary. */
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
    if (op === "scheduled.list") {
      const goals = await this.scheduledList();
      return {
        text: goals.length
          ? goals.map((g) => `${g.id} [${g.enabled ? "on" : "off"}] ${g.cron} - ${g.goal}`).join("\n")
          : "No scheduled goals. Create one with scheduled.create {goal, cron}.",
        data: goals,
      };
    }
    if (op === "scheduled.create") {
      const res = await this.scheduledCreate(String(args.goal || ""), String(args.cron || ""));
      return res.ok
        ? { text: `Scheduled ${res.goal!.id}: "${res.goal!.goal}" on ${res.goal!.cron}; first run ${res.goal!.nextRunAt}.`, data: res.goal }
        : { text: `Could not schedule that: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op === "scheduled.delete") {
      await this.scheduledDelete(String(args.id || ""));
      return { text: `Deleted scheduled goal ${String(args.id || "")}.`, data: { ok: true } };
    }
    if (op && op !== "scheduled.summary") {
      return { text: `Unknown operation: ${op}`, data: { ok: false, error: "unknown_operation" } };
    }
    const snapshot = await this.a2aSnapshot();
    return {
      text: `Scheduler status. ${snapshot.goals} goal(s), ${snapshot.enabled} enabled, ${snapshot.totalRuns} run(s) so far${snapshot.nextDue ? `; next due ${snapshot.nextDue}` : ""}. Nothing runs until a goal is created.`,
      data: snapshot,
    };
  }
}
