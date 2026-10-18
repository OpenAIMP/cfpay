/**
 * ScheduledAgent - autonomous triggers on the Agents SDK's native
 * scheduler (issues #213, #226).
 *
 * Aligned with the documented pattern
 * (https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/):
 * every goal the owner creates becomes a NATIVE schedule on this
 * agent - `this.schedule(cron, "runScheduledGoal", { goalId })`.
 * The framework persists schedules in the agent's own SQLite and
 * wakes the agent with a Durable Object alarm at each due time;
 * there is no Worker cron trigger and no polling tick. When a
 * schedule fires, the framework invokes runScheduledGoal(payload,
 * schedule) and advances the cron entry to its next occurrence as
 * part of job processing - regardless of how the dispatch ends -
 * so a failing goal can never hot-loop.
 *
 * This agent still owns exactly one problem (the owner's rule):
 * knowing WHICH goals exist and WHEN they fire. The registry table
 * below holds the owner's goal text, the native schedule id, and
 * the run bookkeeping (counts, last orchestrator job). The work
 * itself belongs to the OrchestratorAgent: a firing hands the goal
 * to orchestrator.run over A2A, in plan mode, and records the job
 * id it gets back.
 *
 * NOTHING IS SEEDED. A fresh deployment has an empty schedule -
 * autonomous runs begin only when the owner creates a goal (desk
 * API, A2A, or host chat). Deleting a goal cancels its schedule;
 * disabling cancels too (the SDK has no pause - the row keeps the
 * cron, and enabling re-creates the schedule).
 *
 * Compatibility: rows created by the first design (#219, a Worker
 * cron trigger + tick scan) have no schedule_id. They are
 * reconciled lazily at the read/write entry points: any enabled
 * row without a native schedule gets one, so no goal silently
 * stops firing across the upgrade.
 *
 * Cron expressions are validated before they reach the SDK (which
 * parses with cron-schedule): src/cron-next.ts expands @daily-
 * style aliases and rejects anything malformed or impossible with
 * a named error; an SDK throw maps to the same invalid_cron error.
 */

import { Think } from "@cloudflare/think";
import { callable } from "agents";
import { z } from "zod";
import { defaultModelId } from "./models";
import { normalizeCron } from "./cron-next";
import type { Env } from "./types";

export const MAX_GOAL_CHARS = 500;
const SCHEDULE_CALLBACK = "runScheduledGoal";

interface ScheduledGoalRow {
  id: string;
  goal: string;
  cron: string;
  scheduleId: string | null;
  enabled: number;
  createdAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runs: number;
  lastJobId: string | null;
  lastStatus: string | null;
}

export interface ScheduledGoal {
  id: string;
  goal: string;
  cron: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runs: number;
  lastJobId: string | null;
  lastStatus: string | null;
}

function toGoal(row: ScheduledGoalRow): ScheduledGoal {
  return {
    id: row.id,
    goal: row.goal,
    cron: row.cron,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    runs: row.runs,
    lastJobId: row.lastJobId,
    lastStatus: row.lastStatus,
  };
}

export class ScheduledAgent extends Think<Env> {
  override getModel() {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the scheduling agent for this deployment.",
      "You keep the owner's standing goals and their cron schedules; when one fires you hand the goal to the OrchestratorAgent - you never do the goal's work yourself.",
      "Use scheduledList to report what is scheduled, scheduledCreate to add a goal (goal text + 5-field cron, @daily style aliases allowed), scheduledDelete to remove one.",
      "If no goals exist, say so plainly: nothing runs autonomously until the owner creates one.",
    ].join(" ");
  }

  override getTools() {
    return {};
  }

  private db() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS scheduled_goals (
         id TEXT PRIMARY KEY,
         goal TEXT NOT NULL,
         cron TEXT NOT NULL,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at INTEGER NOT NULL,
         next_run_at INTEGER,
         last_run_at INTEGER,
         runs INTEGER NOT NULL DEFAULT 0,
         last_job_id TEXT,
         last_status TEXT
       )`,
    );
    this.ensureColumn("schedule_id", "TEXT");
    return this.ctx.storage.sql;
  }

  private ensureColumn(name: string, decl: string): void {
    const cols = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(scheduled_goals)`)
      .toArray();
    if (!cols.some((c) => c.name === name)) {
      this.ctx.storage.sql.exec(`ALTER TABLE scheduled_goals ADD COLUMN ${name} ${decl}`);
    }
  }

  private rows(): ScheduledGoalRow[] {
    return this.db()
      .exec(
        `SELECT id, goal, cron, schedule_id AS scheduleId, enabled, created_at AS createdAt,
                next_run_at AS nextRunAt, last_run_at AS lastRunAt, runs,
                last_job_id AS lastJobId, last_status AS lastStatus
         FROM scheduled_goals ORDER BY created_at ASC`,
      )
      .toArray() as unknown as ScheduledGoalRow[];
  }

  private row(id: string): ScheduledGoalRow | undefined {
    return this.rows().find((r) => r.id === id);
  }

  /** Create the native schedule for a row and persist its id + next run. */
  private async armSchedule(row: ScheduledGoalRow): Promise<void> {
    const sched = await this.schedule(row.cron, SCHEDULE_CALLBACK, { goalId: row.id });
    this.db().exec(
      `UPDATE scheduled_goals SET schedule_id = ?, next_run_at = ? WHERE id = ?`,
      sched.id,
      sched.time * 1000,
      row.id,
    );
  }

  /**
   * Reconcile rows that predate the native scheduler (or lost
   * their schedule): every enabled row gets a live schedule.
   */
  private async ensureNativeSchedules(): Promise<void> {
    for (const row of this.rows()) {
      if (row.enabled === 1 && !row.scheduleId) {
        try {
          await this.armSchedule(row);
        } catch {
          /* surfaced as a missing nextRunAt; the row itself is intact */
        }
      }
    }
  }

  @callable()
  async scheduledList(): Promise<{ goals: ScheduledGoal[] }> {
    await this.ensureNativeSchedules();
    const goals: ScheduledGoal[] = [];
    for (const row of this.rows()) {
      if (row.enabled === 1 && row.scheduleId) {
        // The native Schedule record is the source of truth for
        // the next run; refresh the cached value from it.
        const live = await this.getScheduleById(row.scheduleId).catch(() => undefined);
        if (live && live.time * 1000 !== row.nextRunAt) {
          this.db().exec(`UPDATE scheduled_goals SET next_run_at = ? WHERE id = ?`, live.time * 1000, row.id);
          row.nextRunAt = live.time * 1000;
        }
      }
      goals.push(toGoal(row));
    }
    return { goals };
  }

  @callable()
  async scheduledCreate(
    goal: string,
    cron: string,
  ): Promise<{ ok: boolean; goal?: ScheduledGoal; error?: string }> {
    const text = (goal ?? "").trim();
    if (!text) return { ok: false, error: "goal_required" };
    if (text.length > MAX_GOAL_CHARS) return { ok: false, error: "goal_too_long" };
    const normalized = normalizeCron(cron ?? "");
    if (!normalized) return { ok: false, error: "invalid_cron" };
    const id = `sched-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const createdAt = Date.now();
    this.db().exec(
      `INSERT INTO scheduled_goals (id, goal, cron, enabled, created_at) VALUES (?, ?, ?, 1, ?)`,
      id,
      text,
      normalized,
      createdAt,
    );
    const row = this.row(id)!;
    try {
      await this.armSchedule(row);
    } catch {
      // Syntactically valid, but the SDK could not compute a next
      // run for it (an impossible calendar date, e.g. Feb 30).
      this.db().exec(`DELETE FROM scheduled_goals WHERE id = ?`, id);
      return { ok: false, error: "cron_never_fires" };
    }
    return { ok: true, goal: toGoal(this.row(id)!) };
  }

  @callable()
  async scheduledDelete(id: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.row(id);
    if (!row) return { ok: false, error: "not_found" };
    if (row.scheduleId) {
      await this.cancelSchedule(row.scheduleId).catch(() => false);
    }
    this.db().exec(`DELETE FROM scheduled_goals WHERE id = ?`, id);
    return { ok: true };
  }

  @callable()
  async scheduledSetEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; goal?: ScheduledGoal; error?: string }> {
    const row = this.row(id);
    if (!row) return { ok: false, error: "not_found" };
    if (!enabled && row.scheduleId) {
      await this.cancelSchedule(row.scheduleId).catch(() => false);
      this.db().exec(
        `UPDATE scheduled_goals SET enabled = 0, schedule_id = NULL, next_run_at = NULL WHERE id = ?`,
        id,
      );
    } else if (enabled) {
      this.db().exec(`UPDATE scheduled_goals SET enabled = 1 WHERE id = ?`, id);
      await this.armSchedule(this.row(id)!);
    }
    return { ok: true, goal: toGoal(this.row(id)!) };
  }

  /**
   * The scheduled callback the framework invokes at each due time
   * (payload + the Schedule record). NOT a @callable - it runs on
   * the Durable Object alarm, inside the agent. It never throws:
   * dispatch outcomes are recorded on the goal row, and the
   * framework advances the cron entry regardless.
   */
  async runScheduledGoal(
    payload: { goalId: string },
    schedule?: { id: string },
  ): Promise<void> {
    const goalId = payload?.goalId;
    if (!goalId) return;
    const row = this.row(goalId);
    if (!row) {
      // Orphaned schedule (its row is gone): cancel ourselves so
      // the alarm stops firing for a goal that no longer exists.
      if (schedule?.id) await this.cancelSchedule(schedule.id).catch(() => false);
      return;
    }
    if (row.enabled !== 1) return;
    const startedAt = Date.now();
    let jobId: string | null = null;
    let status = "dispatched";
    try {
      jobId = await this.dispatchGoal(row.goal);
      if (!jobId) status = "error: orchestrator returned no job id";
    } catch (err) {
      status = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
    this.db().exec(
      `UPDATE scheduled_goals SET last_run_at = ?, runs = runs + 1, last_job_id = ?, last_status = ? WHERE id = ?`,
      startedAt,
      jobId,
      status,
      goalId,
    );
  }

  /** Hand one goal to the OrchestratorAgent over A2A; returns the job id. */
  private async dispatchGoal(goal: string): Promise<string | null> {
    const binding = (this.env as Env & { ORCHESTRATOR_AGENT?: DurableObjectNamespace }).ORCHESTRATOR_AGENT;
    if (!binding) throw new Error("OrchestratorAgent binding is not configured.");
    const stub = binding.get(binding.idFromName("orchestrator")) as unknown as {
      handleA2A: (body: unknown, origin: string) => Promise<{
        result?: { parts?: { kind: string; data?: { id?: string } }[] };
      }>;
    };
    const body = {
      jsonrpc: "2.0",
      id: `sched-${Date.now()}`,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [
            { kind: "text", text: goal },
            { kind: "data", data: { operation: "orchestrator.run", goal, mode: "plan" } },
          ],
          messageId: `sched-${Date.now()}`,
          kind: "message",
        },
      },
    };
    const outcome = await stub.handleA2A(body, "https://scheduled-agent.internal");
    const dataPart = outcome.result?.parts?.find((p) => p.kind === "data");
    return dataPart?.data?.id ?? null;
  }

  async a2aSnapshot(): Promise<Record<string, unknown>> {
    const goals = this.rows().map(toGoal);
    const enabled = goals.filter((g) => g.enabled);
    const next = enabled
      .map((g) => g.nextRunAt)
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b)[0];
    return {
      goals: goals.length,
      enabled: enabled.length,
      nextDue: next ? new Date(next).toISOString() : null,
      runs: goals.reduce((sum, g) => sum + g.runs, 0),
      scheduler: "agents-sdk (native schedules + DO alarms)",
    };
  }
}

export const scheduledAgentToolSchema = z.object({
  operation: z
    .enum(["scheduled.summary", "scheduled.list", "scheduled.create", "scheduled.delete"])
    .describe("Which ScheduledAgent operation to run."),
  goal: z
    .string()
    .optional()
    .describe("For scheduled.create: the standing goal text (what the OrchestratorAgent should achieve each run)."),
  cron: z
    .string()
    .optional()
    .describe("For scheduled.create: a 5-field cron expression (UTC) or an alias like @daily."),
  id: z.string().optional().describe("For scheduled.delete: the scheduled goal id."),
});
