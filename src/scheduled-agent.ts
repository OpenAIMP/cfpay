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
import type { Connection } from "agents";
import { z } from "zod";
import { defaultModelId } from "./models";
import { normalizeCron } from "./cron-next";
import { oneShotFromDelay, parseOneShotWhen } from "./schedule-once";
import type { Env } from "./types";
import { mintCorrelationId, withTracePart } from "./aspect-logging";
import {
  checkDispatchEnvelope,
  ownTenantId,
  resolveTenantInstance,
  type CutoverEnv,
} from "./tenancy";
import { selfProvisionOwnTenant } from "./tenant-provision";
import { stampTenantOnConnection } from "./tenant-connection";
import { emitLoopOutcome } from "./loop-accounting";

export const MAX_GOAL_CHARS = 500;
const SCHEDULE_CALLBACK = "runScheduledGoal";

interface ScheduledGoalRow {
  id: string;
  goal: string;
  cron: string;
  kind: string;
  runAt: number | null;
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
  /** "cron" recurs on the cron expression; "once" fires a single time at runAt. */
  kind: "cron" | "once";
  cron: string;
  /** For kind "once": the epoch-ms fire time. Null for recurring goals. */
  runAt: number | null;
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
    kind: row.kind === "once" ? "once" : "cron",
    cron: row.cron,
    runAt: row.runAt ?? null,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    runs: row.runs,
    lastJobId: row.lastJobId,
    lastStatus: row.lastStatus,
  };
}

// WS1 aspects (issue #252, design §2.3): every in-process A2A dispatch
// carries the private trace part so the receiving executor emits under the
// same correlationId. P3: the trace carries this instance's own tenant
// (parsed from its instance name).
function a2aTraceFor(tenantId: string) {
  return {
    correlationId: mintCorrelationId(),
    tenantId,
    userId: tenantId,
  };
}

export class ScheduledAgent extends Think<Env> {
  /**
   * Issue #315: a tenant instance can wake without any in-process dispatch
   * (the /agents/* WebSocket path), so it seeds its own FGA tuple here.
   * Idempotent; operator no-op; failures never block startup (the dispatch
   * seam retries and the FGA layer denies by default).
   */
  async onStart(): Promise<void> {
    await selfProvisionOwnTenant({ env: this.env, ctx: this.ctx });
  }

  /**
   * Issue #316: bind the resolved tenant/user to this socket's connection
   * state (SDK connection.setState, functional updater — existing
   * connection state is preserved, never clobbered). Defense-in-depth
   * BEHIND the /agents/* edge 401/403: the edge still guards the door;
   * this stamps identity on the connection itself so WS-path handling can
   * attribute per message. First stamp wins; operator singletons stay
   * unstamped; stamping never throws and never blocks connect.
   */
  async onConnect(
    connection: Connection,
    context: { request: Request },
  ): Promise<void> {
    await stampTenantOnConnection({ env: this.env, ctx: this.ctx }, connection);
    await super.onConnect?.(connection, context);
  }
  override getModel() {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the scheduling agent for this deployment.",
      "You keep the owner's standing goals and their cron schedules; when one fires you hand the goal to the OrchestratorAgent - you never do the goal's work yourself.",
      "Use scheduledList to report what is scheduled, scheduledCreate to add a recurring goal (goal text + 5-field cron, @daily style aliases allowed), scheduledOnce to add a one-shot goal (goal text + an ISO time or delaySeconds), scheduledTrigger to run an existing goal immediately, scheduledDelete to remove one.",
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
         kind TEXT NOT NULL DEFAULT 'cron',
         run_at INTEGER,
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
    this.ensureColumn("kind", "TEXT NOT NULL DEFAULT 'cron'");
    this.ensureColumn("run_at", "INTEGER");
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
        `SELECT id, goal, cron, kind, run_at AS runAt, schedule_id AS scheduleId, enabled, created_at AS createdAt,
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
    const when: string | Date =
      row.kind === "once" ? new Date(row.runAt ?? row.nextRunAt ?? Date.now()) : row.cron;
    const sched = await this.schedule(when, SCHEDULE_CALLBACK, { goalId: row.id });
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
      if (row.enabled === 1 && row.scheduleId && row.kind !== "once") {
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

  /**
   * Create a ONE-SHOT goal (issue #232): fires exactly once, at an
   * ISO time (`at`) or after `delaySeconds`, then disables itself
   * and keeps its run record. Armed as a native Date schedule.
   */
  @callable()
  async scheduledOnce(
    goal: string,
    at?: string,
    delaySeconds?: number,
  ): Promise<{ ok: boolean; goal?: ScheduledGoal; error?: string }> {
    const text = (goal ?? "").trim();
    if (!text) return { ok: false, error: "goal_required" };
    if (text.length > MAX_GOAL_CHARS) return { ok: false, error: "goal_too_long" };
    const now = Date.now();
    const parsed =
      typeof delaySeconds === "number" && delaySeconds > 0
        ? oneShotFromDelay(delaySeconds, now)
        : parseOneShotWhen(at ?? "", now);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const id = `sched-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    this.db().exec(
      `INSERT INTO scheduled_goals (id, goal, cron, kind, run_at, enabled, created_at, next_run_at)
       VALUES (?, ?, '', 'once', ?, 1, ?, ?)`,
      id,
      text,
      parsed.at,
      now,
      parsed.at,
    );
    try {
      await this.armSchedule(this.row(id)!);
    } catch {
      this.db().exec(`DELETE FROM scheduled_goals WHERE id = ?`, id);
      return { ok: false, error: "schedule_failed" };
    }
    return { ok: true, goal: toGoal(this.row(id)!) };
  }

  /**
   * Run an existing goal RIGHT NOW (issue #232), without touching
   * its schedule: a recurring goal keeps its next run; a pending
   * one-shot is consumed by the manual run. Returns the job id.
   */
  @callable()
  async scheduledTrigger(
    id: string,
  ): Promise<{ ok: boolean; jobId?: string | null; goal?: ScheduledGoal; error?: string }> {
    const row = this.row(id);
    if (!row) return { ok: false, error: "not_found" };
    if (row.kind === "once" && row.runs > 0) return { ok: false, error: "already_fired" };
    const { jobId, status } = await this.dispatchAndRecord(row);
    if (!jobId) return { ok: false, error: status.replace(/^error: /, "") || "dispatch_failed", goal: toGoal(this.row(id)!) };
    return { ok: true, jobId, goal: toGoal(this.row(id)!) };
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
    } else if (!enabled) {
      this.db().exec(`UPDATE scheduled_goals SET enabled = 0, next_run_at = NULL WHERE id = ?`, id);
    } else if (enabled) {
      // A one-shot that already fired is spent - it cannot re-arm.
      if (row.kind === "once" && row.runs > 0) return { ok: false, error: "already_fired" };
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
    await this.dispatchAndRecord(row);
  }

  /**
   * Dispatch one goal to the orchestrator and record the outcome
   * on its row. Shared by the alarm callback and scheduledTrigger.
   * A one-shot is consumed by its run: disabled, schedule cleared,
   * record kept. Never throws.
   */
  private async dispatchAndRecord(
    row: ScheduledGoalRow,
  ): Promise<{ jobId: string | null; status: string }> {
    const startedAt = Date.now();
    let jobId: string | null = null;
    let status = "dispatched";
    try {
      jobId = await this.dispatchGoal(row.goal);
      if (!jobId) status = "error: orchestrator returned no job id";
    } catch (err) {
      status = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
    if (row.kind === "once") {
      this.db().exec(
        `UPDATE scheduled_goals SET last_run_at = ?, runs = runs + 1, last_job_id = ?, last_status = ?,
                enabled = 0, schedule_id = NULL, next_run_at = NULL WHERE id = ?`,
        startedAt,
        jobId,
        status,
        row.id,
      );
    } else {
      this.db().exec(
        `UPDATE scheduled_goals SET last_run_at = ?, runs = runs + 1, last_job_id = ?, last_status = ? WHERE id = ?`,
        startedAt,
        jobId,
        status,
        row.id,
      );
    }
    // R0.3 (#327): the firing loop's outcome, recorded once the firing's
    // outcome is persisted on the goal row — exactly one event per
    // firing. "dispatched" (the orchestrator accepted the goal and
    // returned a job id) is the success this seam genuinely knows; the
    // job's own outcome is the orchestrator loop's event, not this one.
    const failed = status.startsWith("error");
    emitLoopOutcome(
      {
        agent: "scheduled",
        operation: "scheduled.firing",
        tenantId: ownTenantId(this.ctx.id.name),
        outcome: failed ? "error" : "ok",
        durationMs: Date.now() - startedAt,
        ...(failed
          ? {
              errorCode:
                status === "error: orchestrator returned no job id"
                  ? "NO_JOB_ID"
                  : "DISPATCH_FAILED",
            }
          : {}),
        detail: { goalId: row.id, kind: row.kind, jobId, status },
      },
      this.env,
    );
    return { jobId, status };
  }

  /**
   * Hand one goal to the OrchestratorAgent over A2A; returns the job id.
   *
   * P3 tenancy (issue #252, design §4): the goal is handed to this
   * instance's own tenant orchestrator (`orchestrator:<sameUid>`), and the
   * cross-tenant envelope rule is asserted before the call.
   */
  private async dispatchGoal(goal: string): Promise<string | null> {
    const binding = (this.env as Env & { ORCHESTRATOR_AGENT?: DurableObjectNamespace }).ORCHESTRATOR_AGENT;
    if (!binding) throw new Error("OrchestratorAgent binding is not configured.");
    const tenantId = ownTenantId(this.ctx.id.name);
    const instanceName = resolveTenantInstance("orchestrator", tenantId, this.env as CutoverEnv);
    const trace = a2aTraceFor(tenantId);
    const envelope = checkDispatchEnvelope(trace, instanceName);
    if (!envelope.ok) throw new Error(envelope.reason ?? "cross-tenant dispatch rejected");
    const stub = binding.get(binding.idFromName(instanceName)) as unknown as {
      handleA2A: (body: unknown, origin: string) => Promise<{
        result?: { parts?: { kind: string; data?: { id?: string } }[] };
      }>;
    };
    const body = {
      jsonrpc: "2.0",
      id: `sched-${Date.now()}`,
      method: "message/stream",
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
    const outcome = await stub.handleA2A(withTracePart(body, a2aTraceFor(ownTenantId(this.ctx.id.name))), "https://scheduled-agent.internal");
    const { a2aReplyFromOutcome } = await import("./a2a");
    const { data } = a2aReplyFromOutcome(outcome);
    return (data as { id?: string } | undefined)?.id ?? null;
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

  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, scheduledCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, scheduledCard(origin), {
      card: scheduledCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    }, { agentName: "scheduled", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: scheduled.list/create/once/trigger/setEnabled/delete; no operation = summary. */
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
      const { goals } = await this.scheduledList();
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
        ? {
            text: `Scheduled ${res.goal!.id}: "${res.goal!.goal}" on ${res.goal!.cron}; first run ${res.goal!.nextRunAt ? new Date(res.goal!.nextRunAt).toISOString() : "n/a"}.`,
            data: res.goal,
          }
        : { text: `Could not schedule that: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op === "scheduled.once") {
      const res = await this.scheduledOnce(
        String(args.goal || ""),
        typeof args.at === "string" ? args.at : undefined,
        typeof args.delaySeconds === "number" ? args.delaySeconds : undefined,
      );
      return res.ok
        ? {
            text: `One-shot ${res.goal!.id}: "${res.goal!.goal}" fires once at ${res.goal!.runAt ? new Date(res.goal!.runAt).toISOString() : "n/a"}.`,
            data: res.goal,
          }
        : { text: `Could not schedule that: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op === "scheduled.trigger") {
      const res = await this.scheduledTrigger(String(args.id || ""));
      return res.ok
        ? { text: `Triggered ${String(args.id || "")} now; orchestrator job ${res.jobId}.`, data: { ok: true, jobId: res.jobId, goal: res.goal } }
        : { text: `Could not trigger that goal: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op === "scheduled.setEnabled") {
      const res = await this.scheduledSetEnabled(String(args.id || ""), args.enabled === true);
      return res.ok
        ? { text: `Goal ${String(args.id || "")} is now ${args.enabled === true ? "enabled" : "disabled"}.`, data: res.goal }
        : { text: `Could not change that goal: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op === "scheduled.delete") {
      const res = await this.scheduledDelete(String(args.id || ""));
      return res.ok
        ? { text: `Deleted scheduled goal ${String(args.id || "")}.`, data: { ok: true } }
        : { text: `Could not delete that goal: ${res.error}.`, data: { ok: false, error: res.error } };
    }
    if (op && op !== "scheduled.summary") {
      return { text: `Unknown operation: ${op}`, data: { ok: false, error: "unknown_operation" } };
    }
    const snapshot = await this.a2aSnapshot();
    return {
      text: `Scheduler status. ${snapshot.goals} goal(s), ${snapshot.enabled} enabled, ${snapshot.runs} run(s) so far${snapshot.nextDue ? `; next due ${snapshot.nextDue}` : ""}. Nothing runs until a goal is created.`,
      data: snapshot,
    };
  }
}

export const scheduledAgentToolSchema = z.object({
  operation: z
    .enum(["scheduled.summary", "scheduled.list", "scheduled.create", "scheduled.once", "scheduled.trigger", "scheduled.setEnabled", "scheduled.delete"])
    .describe("Which ScheduledAgent operation to run."),
  goal: z
    .string()
    .optional()
    .describe("For scheduled.create: the standing goal text (what the OrchestratorAgent should achieve each run)."),
  cron: z
    .string()
    .optional()
    .describe("For scheduled.create: a 5-field cron expression (UTC) or an alias like @daily."),
  at: z
    .string()
    .optional()
    .describe("For scheduled.once: an ISO-8601 fire time, or a relative offset like +2m / +1h / +3d."),
  delaySeconds: z
    .number()
    .optional()
    .describe("For scheduled.once: fire this many seconds from now (alternative to at)."),
  enabled: z
    .boolean()
    .optional()
    .describe("For scheduled.setEnabled: true arms the goal's schedule, false cancels it (the row and cron are kept)."),
  id: z.string().optional().describe("For scheduled.delete / scheduled.trigger / scheduled.setEnabled: the scheduled goal id."),
});
