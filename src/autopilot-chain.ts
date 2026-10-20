/**
 * AutopilotAgent end-to-end chain summary (issue #242 P3.3, #333).
 *
 * Pure and SDK-free so vitest covers it. ONE read that joins the whole
 * P3 chain for the tenant's objective:
 *
 *   objective -> cycles -> funding position -> latest rebalance proposal
 *   -> execution attribution (proposal -> trade proposal -> human
 *   decision -> outcome)
 *
 * The join is by id: cycles link through the proposal's cycleId, and
 * executions are joined to the proposal by proposal id. Stages that
 * have no data render an honest empty state - the summary never
 * invents an execution, a funding position, or a proposal.
 *
 * Tenancy: this module takes no tenant argument. The caller (the
 * per-tenant AutopilotAgent instance) supplies only this tenant's
 * stores and a tenant-filtered funding position - contamination is
 * structurally impossible, not merely filtered. Execution records
 * arrive from ExecutionStore.byProposal(latest proposal id) and are
 * re-joined here by id as a second seam.
 *
 * Funding: PaymentsAgent's funding ledger is the single book
 * (#331); the caller passes the ledger's own aggregation
 * (fundingPosition), never a projection, so the two can never
 * disagree. An unavailable read is passed through as
 * available:false and rendered as such.
 *
 * Executions are the last recorded state: the host trade-ledger
 * refresh happens through autopilot.executions (#332), not here,
 * so this read never double-fires the trade-done notify path.
 */

import type { FundingPosition } from "./funding-core";
import { renderFundingPositionText } from "./funding-core";
import type { RebalanceProposal } from "./autopilot-proposals";
import { renderProposalText } from "./autopilot-proposals";
import { executionStateLabel, type ExecutionAttribution } from "./autopilot-execution";

/** The objective, as the AutopilotAgent instance recorded it. */
export interface ChainObjective {
  goal: string;
  budget: number;
  cadenceCron: string;
  enabled: boolean;
  scheduleGoalId: string | null;
}

/** A discovery cycle, as recorded in autopilot_cycles. */
export interface ChainCycle {
  id: string;
  startedAt: number;
  status: string;
  huntId: string | null;
  error: string | null;
}

export type ChainFunding =
  | { available: true; position: FundingPosition }
  | { available: false; error: string };

export interface ChainSummaryInput {
  objective: ChainObjective | null;
  cyclesTotal: number;
  cyclesCompleted: number;
  lastCycle: ChainCycle | null;
  funding: ChainFunding;
  proposal: RebalanceProposal | null;
  /**
   * Attribution records for the tenant's latest proposal. The builder
   * re-joins these by proposal id - records from any other proposal
   * are dropped, never rendered.
   */
  executions: ExecutionAttribution[];
}

export interface ChainSummary {
  objective: ChainObjective | null;
  cyclesTotal: number;
  cyclesCompleted: number;
  lastCycle: ChainCycle | null;
  funding: ChainFunding;
  proposal: RebalanceProposal | null;
  /** Only executions joined to `proposal` by id. */
  executions: ExecutionAttribution[];
}

const money = (n: number): string =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Join the tenant's objective, cycles, funding, latest proposal, and
 * execution attribution into one chain view. The execution join is by
 * proposal id: a record that does not belong to the latest proposal
 * is not part of this chain and is dropped.
 */
export function buildChainSummary(input: ChainSummaryInput): ChainSummary {
  const proposal = input.proposal;
  const executions = proposal
    ? (input.executions ?? []).filter((e) => e.proposalId === proposal.id)
    : [];
  return {
    objective: input.objective,
    cyclesTotal: input.cyclesTotal,
    cyclesCompleted: input.cyclesCompleted,
    lastCycle: input.lastCycle,
    funding: input.funding,
    proposal,
    executions,
  };
}

/**
 * The one text rendering of the attribution chain (the
 * autopilot.chain reply): every stage with its ids, and an honest
 * empty state wherever a stage has no data. Never an empty string.
 */
export function renderChainText(chain: ChainSummary): string {
  const out: string[] = ["Autopilot attribution chain - goal to outcome in one read:"];
  const obj = chain.objective;
  if (!obj) {
    out.push('Objective: none set - nothing runs until one is created (autopilot.objective.set).');
  } else {
    out.push(
      `Objective: "${obj.goal}" (${money(obj.budget)}, ${obj.cadenceCron}) - ` +
        (obj.enabled ? `armed (schedule ${obj.scheduleGoalId ?? "unknown"}).` : "UNARMED (schedule failed)."),
    );
  }
  if (chain.cyclesTotal > 0) {
    const last = chain.lastCycle;
    out.push(
      `Cycles: ${chain.cyclesTotal} total, ${chain.cyclesCompleted} completed.` +
        (last
          ? ` Last cycle ${last.id} [${last.status}]${last.huntId ? ` (hunt ${last.huntId})` : ""}${last.error ? ` - error: ${last.error.slice(0, 120)}` : ""}.`
          : ""),
    );
  } else {
    out.push("Cycles: none run yet.");
  }
  if (chain.funding.available) {
    const p = chain.funding.position;
    out.push(
      p.recorded
        ? `Funding: ${renderFundingPositionText(p)}`
        : "Funding: no funding movements recorded yet (explicit zero state - sync with autopilot.fundingSync).",
    );
  } else {
    out.push(`Funding position unavailable: ${chain.funding.error}`);
  }
  out.push(renderProposalText(chain.proposal));
  if (!chain.proposal) {
    out.push("Executions: no proposal - nothing has been staged.");
  } else if (!chain.executions.length) {
    out.push(
      `Executions: none staged from proposal ${chain.proposal.id} yet. Stage its delta actions with autopilot.submitProposal {proposalId}; the approval workflow's decisions and outcomes are recorded here.`,
    );
  } else {
    out.push(
      `Executions for proposal ${chain.proposal.id} (last recorded state - refresh from the host ledger with autopilot.executions):`,
    );
    for (const r of chain.executions) {
      out.push(
        `- ${r.action.toUpperCase()} ${r.underlying} (trade ${r.tradeProposalId ?? "not staged"}): ${executionStateLabel(r)}`,
      );
    }
  }
  return out.join("\n");
}
