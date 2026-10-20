/**
 * AutopilotAgent execution attribution (issue #242 P3.2, #332).
 *
 * Pure and SDK-free so vitest covers it. P2's rebalance proposals
 * (#329) are review records; this module is the chain that closes
 * #242's attribution demand - goal -> proposal -> approval ->
 * execution -> outcome - WITHOUT giving AutopilotAgent an execution
 * path of its own:
 *
 * - Staging (buildStagedOrders): a human submits a persisted
 *   rebalance proposal, and each of its delta lines becomes ONE OR
 *   MORE trade proposals in the EXISTING human-approval trade
 *   workflow (the host's proposeTrade, the PUBLIC_ALLOW_TRADING
 *   path). The staged call is the order intent in the workflow's
 *   documented shape (tool + exact args, shown to the approver
 *   before any decision): the allocated trades carry their exact
 *   legs/contracts/credit from the hunt's verified figures, and a
 *   reduce/close carries the exact held positions from the
 *   proposal's own holdings snapshot. Nothing here decides,
 *   approves, or executes - the trade workflow's human gate is the
 *   only path from a staged proposal to an order, unchanged.
 * - Linkage: the attribution record lives HERE, in AutopilotAgent,
 *   keyed by the trade proposal id proposeTrade returns. The host
 *   record needs no new field: its `question` carries the human-
 *   readable attribution (proposal id + goal + the line's reason),
 *   and the machine link is this store. Approval semantics are
 *   untouched.
 * - Write-back (applyTradeStatus): the host's trade ledger is the
 *   single record of decisions and outcomes; the agent refreshes
 *   its attribution from it at read time (the host's getTradeProposal
 *   callable - the fleet's existing read seam). No push channel is
 *   invented and nothing in the execution path calls back here, so
 *   an attribution failure can never block or alter a trade.
 *
 * Honesty rules, mirroring the rest of the fleet:
 * - A line whose action is "none" stages nothing.
 * - When staging itself fails for one order (the host could not
 *   start its approval workflow), the record says so with the error
 *   and carries no trade id; other orders still stage.
 * - States are reported exactly as the host ledger states them:
 *   awaiting approval, rejected, expired, approved-awaiting
 *   execution, executing, executed, execution failed. Nothing is
 *   inferred beyond the recorded status.
 */

import type { ProposalAction, RebalanceProposal } from "./autopilot-proposals";
import { underlyingOfPosition } from "./autopilot-proposals";

/**
 * The order tool name the staged call records. This is the trade
 * workflow's own documented shape for the field (src/types.ts:
 * the MCP tool that will run on approval, e.g. "place_order"); the
 * approver sees the tool and the exact args in the dashboard before
 * deciding, and the workflow's executor fails closed - recording
 * the failure on the proposal - if the account's MCP surface does
 * not answer it.
 */
export const STAGED_ORDER_TOOL = "place_order";

export type AttributionDecision = "none" | "pending" | "approved" | "rejected" | "expired";
export type AttributionOutcome = "none" | "executing" | "executed" | "failed";

export interface ExecutionAttribution {
  id: string;
  proposalId: string;
  cycleId: string;
  /** The objective goal the parent proposal was built for. */
  goal: string;
  underlying: string;
  /** The proposal line's delta action (never "none": those stage nothing). */
  action: Exclude<ProposalAction, "none">;
  /** The line's reason, carried from the proposal. */
  reason: string;
  /** The staged call, exactly as recorded on the trade proposal. */
  tool: string;
  args: Record<string, unknown>;
  /** Host trade-proposal id; null when staging itself failed. */
  tradeProposalId: string | null;
  /** Why staging failed (the host could not start the workflow), when it did. */
  stageError: string | null;
  decision: AttributionDecision;
  decidedAt: string | null;
  decisionNotes: string | null;
  outcome: AttributionOutcome;
  /** Execution output or failure reason from the host record, truncated. */
  result: string | null;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms the Slack trade-done notification posted, once it has. */
  notifiedAt: number | null;
}

export interface StagedOrder {
  /** Deterministic key: one staged order per (proposal, line, trade). */
  key: string;
  underlying: string;
  action: Exclude<ProposalAction, "none">;
  reason: string;
  tool: string;
  args: Record<string, unknown>;
  /** The originating context recorded on the trade proposal. */
  question: string;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function legText(legs: { action: string; type: string; strike: number }[]): string {
  return legs.map((l) => `${l.action} ${l.strike}${l.type === "call" ? "C" : "P"}`).join(" / ");
}

/**
 * The staged orders a rebalance proposal produces, deterministically:
 * - open / increase: one order per allocated trade behind the line,
 *   carrying that trade's exact legs, contracts, expiry, and credit.
 * - reduce / close: one order per line, carrying the exact held
 *   positions (symbol + signed quantity) from the proposal's
 *   holdings snapshot and the line's figures.
 * - none: no order.
 * A proposal whose holdings read failed carries no lines at all, so
 * it stages nothing - the empty result IS the honest answer.
 */
export function buildStagedOrders(proposal: RebalanceProposal): StagedOrder[] {
  const orders: StagedOrder[] = [];
  const head = `Autopilot rebalance proposal ${proposal.id} (goal "${proposal.goal}")`;
  for (const line of proposal.lines) {
    if (line.action === "none") continue;
    const action = line.action;
    if (action === "open" || action === "increase") {
      const trades = proposal.plan.allocations.filter(
        (a) => String(a.underlying ?? "").trim().toUpperCase() === line.underlying,
      );
      if (!trades.length) {
        // Defensive: a target line with no allocation behind it can
        // still be staged as a sized intent from the line's figures.
        orders.push({
          key: `${proposal.id}:${line.underlying}:${action}:0`,
          underlying: line.underlying,
          action,
          reason: line.reason,
          tool: STAGED_ORDER_TOOL,
          args: { underlying: line.underlying, action, targetRisk: line.targetRisk },
          question: truncate(`${head}: ${action.toUpperCase()} ${line.underlying} - ${line.reason}`, 600),
        });
        continue;
      }
      trades.forEach((t, i) => {
        orders.push({
          key: `${proposal.id}:${line.underlying}:${action}:${i}`,
          underlying: line.underlying,
          action,
          reason: line.reason,
          tool: STAGED_ORDER_TOOL,
          args: {
            underlying: line.underlying,
            strategy: t.strategy,
            expiry: t.expiry,
            legs: t.legs.map((l) => ({ action: l.action, type: l.type, strike: l.strike })),
            contracts: t.contracts,
            credit: t.credit,
          },
          question: truncate(
            `${head}: ${action.toUpperCase()} ${line.underlying} - ${line.reason} Trade ${i + 1}/${trades.length}: ${t.contracts} contract(s), ${legText(t.legs)}, exp ${t.expiry}, net credit ${t.credit}.`,
            600,
          ),
        });
      });
      continue;
    }
    // reduce / close: the intent runs against what is actually held,
    // exactly as the proposal's holdings snapshot recorded it.
    const positions = proposal.holdings.ok
      ? proposal.holdings.positions
          .filter((p) => underlyingOfPosition(p) === line.underlying)
          .map((p) => ({ symbol: p.symbol, quantity: p.quantity }))
      : [];
    orders.push({
      key: `${proposal.id}:${line.underlying}:${action}:0`,
      underlying: line.underlying,
      action,
      reason: line.reason,
      tool: STAGED_ORDER_TOOL,
      args: {
        underlying: line.underlying,
        action,
        positions,
        currentValue: line.currentValue,
        targetRisk: line.targetRisk,
      },
      question: truncate(`${head}: ${action.toUpperCase()} ${line.underlying} - ${line.reason}`, 600),
    });
  }
  return orders;
}

/** The host trade-ledger view the write-back reads (TradeProposal's shape). */
export interface TradeStatusView {
  status: string;
  decidedAt?: string;
  decisionNotes?: string;
  result?: string;
}

/**
 * Fold one host trade-ledger state into an attribution record.
 * `completed` names a terminal outcome THIS fold newly reached
 * (executed / failed) - the moment the Slack trade-done belongs to.
 * A record with no trade id (staging failed) never changes here.
 */
export function applyTradeStatus(
  rec: ExecutionAttribution,
  trade: TradeStatusView,
  now: number,
): { record: ExecutionAttribution; changed: boolean; completed: "executed" | "failed" | null } {
  if (!rec.tradeProposalId) return { record: rec, changed: false, completed: null };
  const next: ExecutionAttribution = { ...rec };
  switch (trade.status) {
    case "pending":
      next.decision = "pending";
      next.outcome = "none";
      break;
    case "approved":
      next.decision = "approved";
      next.outcome = "none";
      break;
    case "rejected":
      next.decision = "rejected";
      next.outcome = "none";
      break;
    case "expired":
      next.decision = "expired";
      next.outcome = "none";
      break;
    case "executing":
      next.decision = "approved";
      next.outcome = "executing";
      break;
    case "executed":
      next.decision = "approved";
      next.outcome = "executed";
      break;
    case "failed":
      next.outcome = "failed";
      // A failure after a recorded decision keeps that decision; a
      // failure with no decision recorded leaves the decision as-is
      // (the workflow's own record carries the reason in `result`).
      if (trade.decidedAt) next.decision = "approved";
      break;
    default:
      return { record: rec, changed: false, completed: null };
  }
  if (trade.decidedAt) next.decidedAt = trade.decidedAt;
  if (trade.decisionNotes) next.decisionNotes = trade.decisionNotes;
  if (trade.result) next.result = truncate(trade.result, 500);
  const completed =
    (next.outcome === "executed" && rec.outcome !== "executed") ||
    (next.outcome === "failed" && rec.outcome !== "failed")
      ? next.outcome
      : null;
  const changed =
    next.decision !== rec.decision ||
    next.outcome !== rec.outcome ||
    next.decidedAt !== rec.decidedAt ||
    next.decisionNotes !== rec.decisionNotes ||
    next.result !== rec.result;
  if (changed) next.updatedAt = now;
  return { record: next, changed, completed };
}

/** Terminal records never change again; the refresh skips them. */
export function isTerminalAttribution(rec: ExecutionAttribution): boolean {
  if (rec.stageError) return true;
  if (rec.decision === "rejected" || rec.decision === "expired") return true;
  return rec.outcome === "executed" || rec.outcome === "failed";
}

/** One-line state label for an attribution record, in plain words. */
export function executionStateLabel(rec: ExecutionAttribution): string {
  if (rec.stageError) return "staging failed";
  if (rec.outcome === "executed") return "executed";
  if (rec.outcome === "failed") return "execution failed";
  if (rec.outcome === "executing") return "executing";
  if (rec.decision === "rejected") return "rejected";
  if (rec.decision === "expired") return "expired - no decision in the window";
  if (rec.decision === "approved") return "approved - awaiting execution";
  return "awaiting approval";
}

/**
 * The Slack trade-done text for a completed attribution (posted via
 * the agent's existing SlackAgent notify path). Carries the
 * attribution ids the owner test path checks: the rebalance
 * proposal id, the trade proposal id, and the objective goal.
 */
export function tradeDoneText(rec: ExecutionAttribution): string {
  const head =
    `Autopilot trade done: ${rec.action.toUpperCase()} ${rec.underlying} ` +
    `${rec.outcome === "executed" ? "executed" : "FAILED"} via trade proposal ${rec.tradeProposalId ?? "n/a"} ` +
    `(rebalance proposal ${rec.proposalId}, goal "${rec.goal}").`;
  return rec.outcome === "failed" && rec.result ? `${head} ${truncate(rec.result, 200)}` : head;
}

/**
 * The one text rendering of the attribution chain (the
 * autopilot.executions reply): every record with its ids, its
 * state, and the recorded reason/result behind it. An empty chain
 * renders the explicit no-attribution state, never an empty string.
 */
export function renderExecutionsText(records: ExecutionAttribution[]): string {
  if (!records.length) {
    return "No execution attributions yet. Submit a rebalance proposal with autopilot.submitProposal {proposalId} to stage its actions as trade proposals in the existing approval workflow; each staged action's decision and outcome are recorded here.";
  }
  const out: string[] = [`Execution attribution (${records.length} record(s)) - refreshed from the host trade ledger:`];
  for (const r of records) {
    const bits = [
      `- ${r.action.toUpperCase()} ${r.underlying} (proposal ${r.proposalId}, trade ${r.tradeProposalId ?? "not staged"}): ${executionStateLabel(r)}`,
    ];
    if (r.stageError) bits.push(`staging error: ${r.stageError}`);
    if (r.decidedAt) bits.push(`decided ${r.decidedAt}${r.decisionNotes ? ` - ${r.decisionNotes}` : ""}`);
    if (r.result && (r.outcome === "executed" || r.outcome === "failed")) {
      bits.push(truncate(r.result.replace(/\s+/g, " "), 160));
    }
    out.push(bits.join(" | "));
  }
  return out.join("\n");
}

export const EXECUTIONS_MAX_KEPT = 50;

/** SQL-backed attribution store, mirroring ProposalStore's shape. */
export class ExecutionStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_executions (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  save(rec: ExecutionAttribution): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO autopilot_executions (id, proposal_id, created_at, data) VALUES (?, ?, ?, ?)",
      rec.id,
      rec.proposalId,
      rec.createdAt,
      JSON.stringify(rec),
    );
    const ids = [...this.sql.exec("SELECT id FROM autopilot_executions ORDER BY created_at DESC")]
      .map((r) => String(r.id));
    for (const extra of ids.slice(EXECUTIONS_MAX_KEPT)) {
      this.sql.exec("DELETE FROM autopilot_executions WHERE id = ?", extra);
    }
  }

  list(limit = EXECUTIONS_MAX_KEPT): ExecutionAttribution[] {
    const n = typeof limit === "number" && limit > 0 ? Math.floor(limit) : EXECUTIONS_MAX_KEPT;
    const rows = [...this.sql.exec(
      "SELECT data FROM autopilot_executions ORDER BY created_at DESC LIMIT ?",
      n,
    )];
    const out: ExecutionAttribution[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data as string) as ExecutionAttribution);
      } catch {
        // Skip a corrupt row rather than failing the list.
      }
    }
    return out;
  }

  byProposal(proposalId: string): ExecutionAttribution[] {
    const rows = [...this.sql.exec(
      "SELECT data FROM autopilot_executions WHERE proposal_id = ? ORDER BY created_at DESC",
      proposalId,
    )];
    const out: ExecutionAttribution[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data as string) as ExecutionAttribution);
      } catch {
        // Skip a corrupt row rather than failing the read.
      }
    }
    return out;
  }

  count(): number {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS c FROM autopilot_executions")];
    return Number(rows[0]?.c ?? 0);
  }
}
