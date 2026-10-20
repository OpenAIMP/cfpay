/**
 * AutopilotAgent - the portfolio-objective owner (issue #242 P1).
 *
 * Given a goal and a budget, this agent works the discovery loop on a
 * cadence: it arms a ScheduledAgent goal that fires `autopilot.runCycle`
 * through the OrchestratorAgent's catalog; each cycle runs a defined-risk
 * opportunity hunt on the host (`desk.hunt`), notifies through SlackAgent,
 * and emails the recommendations report through EmailAgent when the
 * objective carries a notify address.
 *
 * P2.2 (#329): each successful cycle also runs portfolio construction
 * (src/portfolio-core.ts) over the hunt's sized trades, reads current
 * holdings back from the host (`desk.portfolio` - the host keeps the
 * Public token; this agent gains no credentials), and persists a
 * rebalance proposal (src/autopilot-proposals.ts): target vs current
 * with a reasoned delta action per underlying. A proposal is a review
 * record - it executes nothing.
 *
 * This agent places no orders and sends no mail on its own: hunts are
 * report-only pipelines on the host, notifications are best-effort
 * (failures are recorded on the cycle row, never fatal), and any order
 * still needs the human-approved trade workflow. It owns one problem -
 * the standing portfolio objective - and nothing else (the owner's rule).
 *
 * Cross-agent dispatch follows the fleet contract (PR #237): the
 * JSON-RPC body uses message/stream and replies are read ONLY via
 * a2aReplyFromOutcome, never by reaching into the envelope directly.
 */

import { Think } from "@cloudflare/think";
import { callable } from "agents";
import type { Connection } from "agents";
import { defaultModelId } from "./models";
import {
  validateObjective,
  AUTOPILOT_CYCLE_GOAL_TEXT,
  type AutopilotObjectiveInput,
  type AutopilotObjective,
} from "./autopilot-core";
import { constructPortfolio } from "./portfolio-core";
import {
  buildFundingRecords,
  renderFundingPositionText,
  type FundingMovement,
  type FundingPosition,
  type FundingRecord,
} from "./funding-core";
import {
  buildRebalanceProposal,
  ProposalStore,
  renderProposalText,
  type HoldingsSnapshot,
  type RebalanceProposal,
} from "./autopilot-proposals";
import type { HuntPlan } from "./opportunity-hunt";
import type { PortfolioPosition } from "./public-data";
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

interface ObjectiveRow {
  id: string;
  goal: string;
  budget: number;
  cadenceCron: string;
  symbolsJson: string;
  notifyEmail: string | null;
  enabled: number;
  scheduleGoalId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ObjectiveView extends AutopilotObjective {
  set: true;
  enabled: boolean;
  scheduleGoalId: string | null;
  updatedAt: number;
}

interface CycleRow {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  huntId: string | null;
  summary: string | null;
  error: string | null;
  notifications: string | null;
}

export interface CycleView {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  huntId: string | null;
  summary: string | null;
  error: string | null;
  notifications: Record<string, string>;
}

function parseNotifications(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// WS1 aspects (issue #252, design §2.3): every in-process A2A dispatch
// carries the private trace part so the receiving executor emits under the
// same correlationId. P3: the trace carries this instance's own tenant
// (parsed from its instance name), so the cross-tenant envelope rule
// holds for autopilot → scheduler/email/slack/host dispatches.
function a2aTraceFor(tenantId: string) {
  return {
    correlationId: mintCorrelationId(),
    tenantId,
    userId: tenantId,
  };
}

export class AutopilotAgent extends Think<Env> {
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
      "You are the AutopilotAgent: the owner of the standing portfolio objective.",
      "An owner gives you a goal and a budget (autopilotObjectiveSet), you arm a discovery cadence on the ScheduledAgent, and each cycle you run a defined-risk opportunity hunt on the host and report it.",
      "You place no orders, you move no money, and you do not decide trades - proposals go through the human-approved trade workflow. Your reports are evidence, not instructions.",
      "If no objective is set, say so plainly: nothing runs until the owner sets one.",
    ].join(" ");
  }

  override getTools() {
    return {};
  }

  private db() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS autopilot_objective (
         id TEXT PRIMARY KEY,
         goal TEXT NOT NULL,
         budget REAL NOT NULL,
         cadence_cron TEXT NOT NULL,
         symbols_json TEXT NOT NULL DEFAULT '[]',
         notify_email TEXT,
         enabled INTEGER NOT NULL DEFAULT 1,
         schedule_goal_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS autopilot_cycles (
         id TEXT PRIMARY KEY,
         started_at INTEGER NOT NULL,
         finished_at INTEGER,
         status TEXT NOT NULL,
         hunt_id TEXT,
         summary TEXT,
         error TEXT,
         notifications TEXT
       )`,
    );
    return this.ctx.storage.sql;
  }

  private proposalStore(): ProposalStore {
    return new ProposalStore(this.ctx.storage.sql);
  }

  private objectiveRow(): ObjectiveRow | undefined {
    const rows = this.db()
      .exec(
        `SELECT id, goal, budget, cadence_cron AS cadenceCron, symbols_json AS symbolsJson,
                notify_email AS notifyEmail, enabled, schedule_goal_id AS scheduleGoalId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM autopilot_objective WHERE id = '1'`,
      )
      .toArray() as unknown as ObjectiveRow[];
    return rows[0];
  }

  private toObjectiveView(row: ObjectiveRow): ObjectiveView {
    let symbols: string[] = [];
    try {
      const v = JSON.parse(row.symbolsJson) as unknown;
      if (Array.isArray(v)) symbols = v.map((s) => String(s));
    } catch {
      /* keep empty */
    }
    return {
      set: true,
      goal: row.goal,
      budget: row.budget,
      cadenceCron: row.cadenceCron,
      symbols,
      notifyEmail: row.notifyEmail,
      enabled: row.enabled === 1,
      scheduleGoalId: row.scheduleGoalId,
      updatedAt: row.updatedAt,
    };
  }

  private toCycleView(row: CycleRow): CycleView {
    return {
      id: row.id,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      huntId: row.huntId,
      summary: row.summary,
      error: row.error,
      notifications: parseNotifications(row.notifications),
    };
  }

  /**
   * Dispatch an A2A operation to another agent's stub in-process,
   * over message/stream, reading the reply via the fleet contract.
   *
   * P3 tenancy (issue #252, design §4): the target instance is resolved
   * for this instance's own tenant (`scheduler:<sameUid>` for the
   * objective arming, `slack:<uid>`, `email:<uid>`, `agent:<uid>`), and
   * the cross-tenant envelope rule is asserted before the call.
   */
  private async dispatchToAgent(
    binding: "SCHEDULED_AGENT" | "CfmailAgent" | "SLACK_AGENT" | "EMAIL_AGENT" | "PAYMENTS_AGENT",
    instance: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; data?: unknown }> {
    const ns = (this.env as unknown as Record<string, DurableObjectNamespace | undefined>)[binding];
    if (!ns) throw new Error(`${binding} binding is not configured.`);
    const tenantId = ownTenantId(this.ctx.id.name);
    const instanceName = resolveTenantInstance(instance, tenantId, this.env as CutoverEnv);
    const trace = a2aTraceFor(tenantId);
    const envelope = checkDispatchEnvelope(trace, instanceName);
    if (!envelope.ok) throw new Error(envelope.reason ?? "cross-tenant dispatch rejected");
    const stub = ns.get(ns.idFromName(instanceName)) as unknown as {
      handleA2A: (body: unknown, origin: string) => Promise<unknown>;
    };
    const msgId = `autopilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      jsonrpc: "2.0",
      id: msgId,
      method: "message/stream",
      params: {
        message: {
          role: "user",
          parts: [
            { kind: "text", text: operation },
            { kind: "data", data: { operation, ...args } },
          ],
          messageId: msgId,
          kind: "message",
        },
      },
    };
    const outcome = await stub.handleA2A(withTracePart(body, a2aTraceFor(ownTenantId(this.ctx.id.name))), "https://autopilot-agent.internal");
    const { a2aReplyFromOutcome } = await import("./a2a");
    return a2aReplyFromOutcome(outcome);
  }

  private async bestEffortNotify(text: string): Promise<string> {
    try {
      const { data } = await this.dispatchToAgent("SLACK_AGENT", "slack", "slack.notify", { text });
      return (data as { ok?: boolean; error?: string } | undefined)?.ok === false
        ? `error: ${(data as { error?: string }).error ?? "unknown"}`
        : "ok";
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
    }
  }

  private async bestEffortEmail(
    to: string,
    subject: string,
    body: string,
  ): Promise<string> {
    try {
      const { data } = await this.dispatchToAgent("EMAIL_AGENT", "email", "email.send", {
        to,
        subject,
        body,
      });
      return (data as { ok?: boolean; error?: string } | undefined)?.ok === false
        ? `error: ${(data as { error?: string }).error ?? "unknown"}`
        : "ok";
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
    }
  }

  @callable()
  async autopilotObjectiveGet(): Promise<{ set: false } | ObjectiveView> {
    const row = this.objectiveRow();
    return row ? this.toObjectiveView(row) : { set: false };
  }

  /**
   * Set the standing objective and arm its cadence on the
   * ScheduledAgent. Deleting the old scheduled goal and creating the
   * new one are owner-level operations the orchestrator may not
   * plan - this agent owns that goal, so it may. If arming fails,
   * the objective is stored unarmed (enabled=0) and the reply says
   * so plainly: this method never claims an armed schedule it has
   * not read back.
   */
  @callable()
  async autopilotObjectiveSet(
    input: AutopilotObjectiveInput,
  ): Promise<
    | { ok: true; objective: ObjectiveView; scheduleGoalId: string }
    | { ok: false; error: string; scheduleError?: string; objective?: ObjectiveView }
  > {
    const validated = validateObjective(input ?? {});
    if (!validated.ok) return { ok: false, error: validated.error };
    const o = validated.objective;
    const now = Date.now();
    const prev = this.objectiveRow();
    if (prev?.scheduleGoalId) {
      try {
        await this.dispatchToAgent("SCHEDULED_AGENT", "scheduler", "scheduled.delete", {
          id: prev.scheduleGoalId,
        });
      } catch {
        /* best effort: the old goal may already be gone */
      }
    }
    this.db().exec(
      `INSERT OR REPLACE INTO autopilot_objective
         (id, goal, budget, cadence_cron, symbols_json, notify_email, enabled, schedule_goal_id, created_at, updated_at)
       VALUES ('1', ?, ?, ?, ?, ?, 0, NULL, COALESCE((SELECT created_at FROM autopilot_objective WHERE id = '1'), ?), ?)`,
      o.goal,
      o.budget,
      o.cadenceCron,
      JSON.stringify(o.symbols),
      o.notifyEmail,
      now,
      now,
    );
    try {
      const { data } = await this.dispatchToAgent("SCHEDULED_AGENT", "scheduler", "scheduled.create", {
        goal: AUTOPILOT_CYCLE_GOAL_TEXT,
        cron: o.cadenceCron,
      });
      const goalId = (data as { id?: string } | undefined)?.id ?? null;
      if (!goalId) throw new Error("scheduled.create returned no goal id");
      this.db().exec(
        `UPDATE autopilot_objective SET enabled = 1, schedule_goal_id = ?, updated_at = ? WHERE id = '1'`,
        goalId,
        Date.now(),
      );
      return { ok: true, objective: this.toObjectiveView(this.objectiveRow()!), scheduleGoalId: goalId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: "schedule_failed",
        scheduleError: msg.slice(0, 300),
        objective: this.toObjectiveView(this.objectiveRow()!),
      };
    }
  }

  @callable()
  async autopilotObjectiveClear(): Promise<{ ok: boolean; error?: string }> {
    const prev = this.objectiveRow();
    if (prev?.scheduleGoalId) {
      try {
        await this.dispatchToAgent("SCHEDULED_AGENT", "scheduler", "scheduled.delete", {
          id: prev.scheduleGoalId,
        });
      } catch {
        /* best effort */
      }
    }
    this.db().exec(`DELETE FROM autopilot_objective WHERE id = '1'`);
    return { ok: true };
  }

  @callable()
  async autopilotCycles(limit?: number): Promise<{ cycles: CycleView[] }> {
    const n = typeof limit === "number" && limit > 0 && limit <= 100 ? Math.floor(limit) : 10;
    const rows = this.db()
      .exec(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
                hunt_id AS huntId, summary, error, notifications
         FROM autopilot_cycles ORDER BY started_at DESC LIMIT ?`,
        n,
      )
      .toArray() as unknown as CycleRow[];
    return { cycles: rows.map((r) => this.toCycleView(r)) };
  }

  @callable()
  async autopilotProposals(limit?: number): Promise<{ proposals: RebalanceProposal[] }> {
    return { proposals: this.proposalStore().list(limit) };
  }

  /**
   * The recorded funding position for this instance's objective
   * (issue #242 P3.1, #331): read from PaymentsAgent's funding
   * ledger at read time — the totals are the ledger's own
   * aggregation of its stored records, never a projection this
   * agent maintains, so the two can never disagree. A payments
   * read failure answers available:false rather than inventing a
   * position.
   */
  @callable()
  async autopilotFunding(limit?: number): Promise<
    | { available: true; position: FundingPosition; records: FundingRecord[] }
    | { available: false; error: string }
  > {
    const tenantId = ownTenantId(this.ctx.id.name);
    const n = typeof limit === "number" && limit > 0 && limit <= 200 ? Math.floor(limit) : 20;
    try {
      const totals = await this.dispatchToAgent("PAYMENTS_AGENT", "payments", "funding.totals", {
        tenantId,
      });
      const list = await this.dispatchToAgent("PAYMENTS_AGENT", "payments", "funding.list", {
        limit: n,
      });
      const position = totals.data as FundingPosition | undefined;
      const records = (list.data as { records?: FundingRecord[] } | undefined)?.records ?? [];
      if (!position || typeof position.net !== "number") {
        return { available: false, error: "payments funding read returned no position" };
      }
      return { available: true, position, records };
    } catch (err) {
      return {
        available: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  /**
   * Sync brokerage funding movements into the payments ledger
   * (issue #242 P3.1, #331): read the account's movements from the
   * host's Public read surface (desk.funding — the host keeps the
   * token), stamp them with this objective's attribution, and
   * record them through PaymentsAgent (funding.record). Recording
   * only: this initiates no transfer and moves no money, and
   * re-syncing is idempotent (the ledger dedupes on the movement's
   * source reference). When the read surface cannot observe funding
   * movements, the result says so and nothing is recorded.
   */
  @callable()
  async autopilotFundingSync(): Promise<{
    ok: boolean;
    observable?: boolean;
    recorded?: number;
    skipped?: number;
    note?: string;
    error?: string;
    funding?: unknown;
  }> {
    const obj = this.objectiveRow();
    if (!obj) return { ok: false, error: "no_objective" };
    const tenantId = ownTenantId(this.ctx.id.name);
    let readData:
      | {
          ok?: boolean;
          observable?: boolean;
          movements?: FundingMovement[];
          error?: string;
          code?: string;
        }
      | undefined;
    try {
      const { data } = await this.dispatchToAgent("CfmailAgent", "agent", "desk.funding", {});
      readData = data as typeof readData;
    } catch (err) {
      return {
        ok: false,
        error: "funding_read_failed",
        note: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
    if (!readData || readData.ok === false) {
      return { ok: false, error: String(readData?.error ?? "funding_read_failed") };
    }
    if (readData.observable === false) {
      return {
        ok: true,
        observable: false,
        recorded: 0,
        skipped: 0,
        note: "Funding movements are not observable through this account's Public read surface; nothing was recorded and no movement is claimed.",
        funding: await this.autopilotFunding(),
      };
    }
    const records = buildFundingRecords(
      Array.isArray(readData.movements) ? readData.movements : [],
      { tenantId, objectiveId: obj.id, goal: obj.goal },
      new Date().toISOString(),
    );
    try {
      const { data } = await this.dispatchToAgent("PAYMENTS_AGENT", "payments", "funding.record", {
        records,
      });
      const rec = data as { ok?: boolean; recorded?: number; skipped?: number } | undefined;
      if (!rec || rec.ok === false) return { ok: false, error: "funding_record_failed" };
      return {
        ok: true,
        observable: true,
        recorded: rec.recorded ?? 0,
        skipped: rec.skipped ?? 0,
        funding: await this.autopilotFunding(),
      };
    } catch (err) {
      return {
        ok: false,
        error: "funding_record_failed",
        note: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  @callable()
  async autopilotSummary(): Promise<Record<string, unknown>> {
    const obj = this.objectiveRow();
    const cycles = this.db()
      .exec(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
                hunt_id AS huntId, summary, error, notifications
         FROM autopilot_cycles ORDER BY started_at DESC LIMIT 1`,
      )
      .toArray() as unknown as CycleRow[];
    const totals = this.db()
      .exec(
        `SELECT COUNT(*) AS c, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS ok
         FROM autopilot_cycles`,
      )
      .toArray() as unknown as { c: number; ok: number | null }[];
    const store = this.proposalStore();
    // P3.1 (#331): the funding position is read from PaymentsAgent's
    // ledger at summary time; an unavailable read is reported as
    // such, never replaced with invented figures.
    const fundingView = await this.autopilotFunding();
    return {
      objectiveSet: !!obj,
      objective: obj ? this.toObjectiveView(obj) : null,
      cycles: totals[0]?.c ?? 0,
      cyclesCompleted: totals[0]?.ok ?? 0,
      lastCycle: cycles[0] ? this.toCycleView(cycles[0]) : null,
      proposals: store.count(),
      lastProposal: store.latest(),
      funding: fundingView.available
        ? {
            available: true,
            recorded: fundingView.position.recorded,
            count: fundingView.position.count,
            totalDeposits: fundingView.position.totalDeposits,
            totalWithdrawals: fundingView.position.totalWithdrawals,
            net: fundingView.position.net,
            lastMovementAt: fundingView.position.lastMovementAt,
          }
        : { available: false, error: fundingView.error },
    };
  }

  /**
   * The discovery cycle: the standing work the scheduler fires via
   * the orchestrator (autopilot.runCycle is in the catalog). Runs a
   * defined-risk hunt on the host, notifies via Slack, emails the
   * report when the objective carries an address. Notifications are
   * best-effort and recorded; they never fail the cycle.
   */
  @callable()
  async autopilotRunCycle(): Promise<{
    ok: boolean;
    cycleId?: string;
    huntId?: string | null;
    proposalId?: string | null;
    status?: string;
    summary?: string;
    error?: string;
  }> {
    const startedAt = Date.now();
    const obj = this.objectiveRow();
    if (!obj) {
      // R0.3 (#327): a cycle attempt with no objective is a skipped
      // cycle — a genuine, known outcome, recorded as one.
      emitLoopOutcome(
        {
          agent: "autopilot",
          operation: "autopilot.cycle",
          tenantId: ownTenantId(this.ctx.id.name),
          outcome: "skipped",
          durationMs: Date.now() - startedAt,
          detail: { status: "no_objective" },
        },
        this.env,
      );
      return { ok: false, error: "no_objective" };
    }
    const cycleId = `cycle-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    this.db().exec(
      `INSERT INTO autopilot_cycles (id, started_at, finished_at, status, hunt_id, summary, error, notifications)
       VALUES (?, ?, NULL, 'running', NULL, NULL, NULL, ?)`,
      cycleId,
      startedAt,
      JSON.stringify({}),
    );
    const notifications: Record<string, string> = {};
    notifications.slackStart = await this.bestEffortNotify(`Autopilot research started: ${obj.goal}`);

    let huntId: string | null = null;
    let huntData: unknown;
    let summary = "";
    let error: string | null = null;
    const symbols: string[] = JSON.parse(obj.symbolsJson ?? "[]");
    try {
      const { text, data } = await this.dispatchToAgent("CfmailAgent", "agent", "desk.hunt", {
        budget: obj.budget,
        ...(symbols.length ? { symbols } : {}),
      });
      huntData = data;
      summary = (text || "Hunt completed.").slice(0, 4000);
      huntId = (data as { huntId?: string } | undefined)?.huntId ?? null;
      const okFlag = (data as { ok?: boolean } | undefined)?.ok;
      if (okFlag === false) {
        error = String((data as { error?: string }).error ?? "hunt failed");
      }
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }

    // P2.2 (#329): construction + rebalance proposal. Construction
    // (P2.1) runs over the hunt's sized trades; holdings come from the
    // host's desk.portfolio read. The persisted proposal is a review
    // record - this step places no orders and touches no trade path.
    // A failed holdings read still persists the plan (with the failure
    // named and no delta lines); a failed proposal step is recorded on
    // the cycle like a notification, never fatal to the cycle.
    let proposalId: string | null = null;
    if (!error) {
      try {
        const plan = (huntData as { plan?: HuntPlan } | undefined)?.plan;
        if (plan && Array.isArray(plan.trades)) {
          const built = constructPortfolio(plan.trades, { budget: obj.budget, symbols });
          let holdings: HoldingsSnapshot;
          try {
            const { data: hData } = await this.dispatchToAgent("CfmailAgent", "agent", "desk.portfolio", {});
            const hd = hData as
              | {
                  ok?: boolean;
                  positions?: PortfolioPosition[];
                  fetchedAt?: string;
                  totalValue?: number | null;
                  error?: string;
                }
              | undefined;
            holdings =
              hd?.ok && Array.isArray(hd.positions)
                ? {
                    ok: true,
                    positions: hd.positions,
                    fetchedAt: hd.fetchedAt ?? null,
                    totalValue: hd.totalValue ?? null,
                  }
                : { ok: false, error: String(hd?.error ?? "holdings read failed") };
          } catch (err) {
            holdings = {
              ok: false,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
            };
          }
          const proposal = buildRebalanceProposal({
            id: `proposal-${cycleId}`,
            cycleId,
            createdAt: Date.now(),
            goal: obj.goal,
            budget: obj.budget,
            plan: built,
            holdings,
          });
          this.proposalStore().save(proposal);
          proposalId = proposal.id;
          notifications.proposal = proposalId;
        } else {
          notifications.proposal = "skipped: hunt returned no plan";
        }
      } catch (err) {
        notifications.proposal = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      }
    }

    notifications.slackReady = await this.bestEffortNotify(
      huntId
        ? `Autopilot recommendation ready: hunt ${huntId} - ${summary.slice(0, 120)}`
        : `Autopilot cycle failed: ${error ?? "unknown error"}`,
    );
    if (obj.notifyEmail) {
      notifications.email = await this.bestEffortEmail(
        obj.notifyEmail,
        "Autopilot recommendations ready",
        `Hunt ${huntId ?? "n/a"} for "${obj.goal}" (budget $${obj.budget.toLocaleString("en-US")}).\n\n${summary}`,
      );
    }

    const status = error ? "failed" : "completed";
    const finishedAt = Date.now();
    this.db().exec(
      `UPDATE autopilot_cycles SET finished_at = ?, status = ?, hunt_id = ?, summary = ?, error = ?, notifications = ? WHERE id = ?`,
      finishedAt,
      status,
      huntId,
      summary || null,
      error,
      JSON.stringify(notifications),
      cycleId,
    );
    // R0.3 (#327): the cycle loop's outcome, recorded once its terminal
    // status is persisted — exactly one event per cycle.
    emitLoopOutcome(
      {
        agent: "autopilot",
        operation: "autopilot.cycle",
        tenantId: ownTenantId(this.ctx.id.name),
        outcome: error ? "error" : "ok",
        durationMs: finishedAt - startedAt,
        ...(error ? { errorCode: "HUNT_FAILED" } : {}),
        detail: { cycleId, status, huntId, proposalId },
      },
      this.env,
    );
    return error
      ? { ok: false, error, cycleId, huntId, proposalId, status, summary }
      : { ok: true, cycleId, huntId, proposalId, status, summary };
  }

  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, autopilotCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, autopilotCard(origin), {
      card: autopilotCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    }, { agentName: "autopilot", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: autopilot.summary/objective.get/objective.set/objective.clear/cycles/runCycle/proposals/funding/fundingSync; no operation = summary. */
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
    if (op === "autopilot.summary") {
      const s = await this.autopilotSummary();
      const obj = s.objective as ObjectiveView | null;
      const head = obj
        ? `Autopilot: objective ${obj.enabled ? "armed" : "UNARMED (schedule failed)"} - "${obj.goal}" ($${Number(obj.budget).toLocaleString("en-US")}, ${obj.cadenceCron}). ${Number(s.cycles)} cycle(s), ${Number(s.cyclesCompleted)} completed.`
        : `Autopilot: no objective set. Set one with autopilot.objective.set {goal, budget}.`;
      return {
        text: `${head}\n\n${renderProposalText(s.lastProposal as RebalanceProposal | null)}`,
        data: s,
      };
    }
    if (op === "autopilot.objective.get") {
      const o = await this.autopilotObjectiveGet();
      return "set" in o && o.set
        ? { text: `Objective: "${o.goal}" ($${Number(o.budget).toLocaleString("en-US")}, ${o.cadenceCron}, ${o.enabled ? "armed" : "unarmed"}).`, data: o }
        : { text: "No autopilot objective set.", data: o };
    }
    if (op === "autopilot.objective.set") {
      const res = await this.autopilotObjectiveSet({
        goal: args.goal,
        budget: args.budget,
        cadenceCron: args.cadenceCron ?? args.cadence_cron,
        symbols: args.symbols,
        notifyEmail: args.notifyEmail ?? args.notify_email,
      });
      return res.ok
        ? {
            text: `Objective set and armed: "${res.objective.goal}" on ${res.objective.cadenceCron} (schedule ${res.scheduleGoalId}).`,
            data: res,
          }
        : {
            text: res.error === "schedule_failed"
              ? `Objective stored but NOT armed: ${res.scheduleError}. Re-run autopilot.objective.set to retry arming.`
              : `Could not set the objective: ${res.error}.`,
            data: res,
          };
    }
    if (op === "autopilot.objective.clear") {
      await this.autopilotObjectiveClear();
      return { text: "Autopilot objective cleared and its schedule removed.", data: { ok: true } };
    }
    if (op === "autopilot.cycles") {
      const { cycles } = await this.autopilotCycles(
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return {
        text: cycles.length
          ? cycles
              .map(
                (c) =>
                  `${c.id} [${c.status}] ${new Date(c.startedAt).toISOString()}${c.huntId ? ` hunt ${c.huntId}` : ""}${c.error ? ` error: ${c.error.slice(0, 120)}` : ""}`,
              )
              .join("\n")
          : "No autopilot cycles yet.",
        data: cycles,
      };
    }
    if (op === "autopilot.runCycle") {
      const res = await this.autopilotRunCycle();
      return res.ok
        ? {
            text: `Cycle ${res.cycleId} completed${res.huntId ? ` (hunt ${res.huntId})` : ""}${res.proposalId ? `; rebalance proposal ${res.proposalId} recorded for review` : ""}: ${res.summary}`,
            data: res,
          }
        : {
            text: res.error === "no_objective"
              ? "No autopilot objective set; set one with autopilot.objective.set first."
              : `Cycle ${res.cycleId ?? ""} failed: ${res.error}`,
            data: res,
          };
    }
    if (op === "autopilot.proposals") {
      const { proposals } = await this.autopilotProposals(
        typeof args.limit === "number" ? args.limit : undefined,
      );
      // The latest proposal renders through the one shared renderer
      // (issue #242 P2.3): the same text the summary reply and the
      // desk snapshot carry, rejections and basis notes included.
      return {
        text: renderProposalText(proposals[0] ?? null),
        data: { ok: true, proposals },
      };
    }
    if (op === "autopilot.funding") {
      const view = await this.autopilotFunding(
        typeof args.limit === "number" ? args.limit : undefined,
      );
      if (!view.available) {
        return {
          text: `Funding position unavailable: ${view.error}`,
          data: { ok: false, ...view },
        };
      }
      const lines = view.records
        .slice(0, 10)
        .map(
          (r) =>
            `${r.ts} ${r.direction} $${r.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${r.sourceRef})`,
        );
      return {
        text: [renderFundingPositionText(view.position), ...lines].join("\n"),
        data: { ok: true, ...view },
      };
    }
    if (op === "autopilot.fundingSync") {
      const res = await this.autopilotFundingSync();
      const view = res.funding as
        | { available: true; position: FundingPosition }
        | { available: false; error: string }
        | undefined;
      return {
        text: !res.ok
          ? res.error === "no_objective"
            ? "No autopilot objective set; funding movements are attributed to an objective, so set one with autopilot.objective.set first."
            : `Funding sync failed: ${res.error}${res.note ? ` (${res.note})` : ""}`
          : res.observable === false
            ? `Funding sync: ${res.note}`
            : `Funding sync: recorded ${res.recorded ?? 0} new movement(s), ${res.skipped ?? 0} skipped (already recorded or invalid). ${view?.available ? renderFundingPositionText(view.position) : ""}`,
        data: res,
      };
    }
    if (op && op !== "autopilot.summary") {
      return { text: `Unknown operation: ${op}`, data: { ok: false, error: "unknown_operation" } };
    }
    const s = await this.autopilotSummary();
    const obj = s.objective as ObjectiveView | null;
    const head = obj
      ? `Autopilot status. Objective ${obj.enabled ? "armed" : "UNARMED"}: "${obj.goal}" ($${Number(obj.budget).toLocaleString("en-US")}, ${obj.cadenceCron}). ${Number(s.cycles)} cycle(s) so far.`
      : "Autopilot status. No objective set - nothing runs until one is created.";
    return {
      text: `${head}\n\n${renderProposalText(s.lastProposal as RebalanceProposal | null)}`,
      data: s,
    };
  }
}
