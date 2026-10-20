/**
 * AutopilotAgent rebalance proposals (issue #242 P2.2, #329).
 *
 * Pure and SDK-free so vitest covers it. Given one construction plan
 * (src/portfolio-core.ts) and one holdings snapshot (the host's
 * desk.portfolio read, parsed by src/public-data.ts extractPositions),
 * build the persisted rebalance proposal: per underlying, target vs
 * current and the delta action a human reviewer is being asked to
 * consider - each with its reason and the figures behind it.
 *
 * A proposal is a RECORD FOR HUMAN REVIEW. Nothing in this module (or
 * in the agent step that persists its output) places an order, calls
 * the trade workflow, or moves money. Execution, if it ever happens,
 * is a later phase (#332) through the existing human-approved trade
 * workflow only.
 *
 * Honesty rules, mirroring the rest of the fleet:
 * - Target figures are max-risk dollars from deterministic
 *   construction; current figures are quantities / market values
 *   exactly as the broker read reported them. The two are compared as
 *   shares of the objective budget - an exposure proxy for review,
 *   stated on the proposal itself, never dressed up as like-for-like
 *   risk.
 * - When the holdings read failed, the proposal still records the
 *   target plan (with the failure named) and proposes NO delta lines:
 *   a diff against holdings nobody read would be fabrication.
 * - When a held underlying carries no market value, no sized delta is
 *   proposed for it; the line says why.
 */

import type { PortfolioPlan } from "./portfolio-core";
import type { PortfolioPosition } from "./public-data";

/** What the holdings seam reported for one cycle, success or failure. */
export type HoldingsSnapshot =
  | {
      ok: true;
      positions: PortfolioPosition[];
      /** ISO timestamp from the read, when it carried one. */
      fetchedAt: string | null;
      /** Sum of reported market values; null when none were reported. */
      totalValue: number | null;
    }
  | { ok: false; error: string };

export type ProposalAction = "open" | "increase" | "reduce" | "close" | "none";

export interface ProposalLine {
  underlying: string;
  action: ProposalAction;
  /** Human-readable reason with the figures behind the action. */
  reason: string;
  /** Target max-risk dollars for this underlying (0 = not in target). */
  targetRisk: number;
  /** targetRisk / budget, 4dp. */
  targetShare: number;
  /** Allocated trades behind the target for this underlying. */
  targetTrades: number;
  /** Summed signed quantity currently held (0 = not held). */
  currentQuantity: number;
  /** Summed reported market value; null when the read reported none. */
  currentValue: number | null;
  /** currentValue / budget, 4dp; null when currentValue is null. */
  currentShare: number | null;
}

export interface RebalanceProposal {
  id: string;
  cycleId: string;
  /** Epoch ms the proposal was built (supplied by the caller). */
  createdAt: number;
  goal: string;
  budget: number;
  /** The construction plan, rejections included, exactly as built. */
  plan: PortfolioPlan;
  holdings: HoldingsSnapshot;
  lines: ProposalLine[];
  notes: string[];
}

/**
 * Relative band around the target share inside which a held,
 * in-target underlying counts as aligned: current share within
 * ±10% of the target share proposes no change.
 */
export const REBALANCE_TOLERANCE = 0.1;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const money = (n: number) => `$${round2(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (share: number) => `${round2(share * 100)}%`;

/**
 * The underlying a position belongs to. Option rows may carry an
 * OCC-style code (NVDA251121C00200000); their underlying is the
 * leading symbol. Plain tickers pass through uppercased.
 */
export function underlyingOfPosition(p: PortfolioPosition): string {
  const symbol = String(p.symbol ?? "").trim().toUpperCase();
  const occ = symbol.match(/^([A-Z][A-Z0-9.]{0,5})\d{6}[CP]\d{8}$/);
  if (occ) return occ[1];
  return symbol;
}

interface TargetAgg {
  risk: number;
  trades: number;
}
interface CurrentAgg {
  quantity: number;
  value: number | null;
  valuedPositions: number;
  positions: number;
}

export function buildRebalanceProposal(input: {
  id: string;
  cycleId: string;
  createdAt: number;
  goal: string;
  budget: number;
  plan: PortfolioPlan;
  holdings: HoldingsSnapshot;
  tolerance?: number;
}): RebalanceProposal {
  const { plan, holdings } = input;
  const budget = input.budget > 0 && Number.isFinite(input.budget) ? input.budget : 0;
  const tolerance =
    typeof input.tolerance === "number" && Number.isFinite(input.tolerance) && input.tolerance >= 0
      ? input.tolerance
      : REBALANCE_TOLERANCE;
  const notes: string[] = [
    "Review record only: this proposal executes nothing. Any execution is a later phase through the human-approved trade workflow.",
    "Target figures are max-risk dollars from deterministic construction; current figures are quantities and market values as reported by the broker read (desk.portfolio). Shares compare each side against the objective budget - an exposure proxy for human review, not a like-for-like risk measure.",
  ];

  const target = new Map<string, TargetAgg>();
  for (const a of plan.allocations) {
    const u = String(a.underlying ?? "").trim().toUpperCase();
    if (!u) continue;
    const agg = target.get(u) ?? { risk: 0, trades: 0 };
    agg.risk = round2(agg.risk + a.risk);
    agg.trades += 1;
    target.set(u, agg);
  }

  const lines: ProposalLine[] = [];
  const head = {
    id: input.id,
    cycleId: input.cycleId,
    createdAt: input.createdAt,
    goal: input.goal,
    budget,
    plan,
    holdings,
    notes,
  };
  if (!holdings.ok) {
    notes.push(
      `Holdings read failed (${holdings.error}); the target allocation is recorded WITHOUT a diff. No delta actions are proposed against holdings nobody read.`,
    );
    return { ...head, lines };
  }

  const current = new Map<string, CurrentAgg>();
  for (const p of holdings.positions) {
    const u = underlyingOfPosition(p);
    if (!u) continue;
    const agg = current.get(u) ?? { quantity: 0, value: null, valuedPositions: 0, positions: 0 };
    agg.quantity = round4(agg.quantity + p.quantity);
    agg.positions += 1;
    if (p.marketValue !== null && Number.isFinite(p.marketValue)) {
      agg.value = round2((agg.value ?? 0) + p.marketValue);
      agg.valuedPositions += 1;
    }
    current.set(u, agg);
  }
  const unvalued = [...current.values()].some((a) => a.valuedPositions < a.positions);
  if (unvalued) {
    notes.push(
      "Some held positions carry no market value from the read path; underlyings whose value is unknown get no sized delta (see their lines).",
    );
  }

  const underlyings = [...new Set([...target.keys(), ...current.keys()])].sort();
  for (const u of underlyings) {
    const t = target.get(u);
    const c = current.get(u);
    const targetRisk = t?.risk ?? 0;
    const targetShare = budget > 0 ? round4(targetRisk / budget) : 0;
    const base = {
      underlying: u,
      targetRisk,
      targetShare,
      targetTrades: t?.trades ?? 0,
      currentQuantity: c?.quantity ?? 0,
      currentValue: c?.value ?? null,
      currentShare: c?.value != null && budget > 0 ? round4(c.value / budget) : null,
    };
    if (t && !c) {
      lines.push({
        ...base,
        action: "open",
        reason: `Target allocates ${money(targetRisk)} of risk (${pct(targetShare)} of the ${money(budget)} budget) across ${t.trades} trade(s); no current holding in ${u}.`,
      });
      continue;
    }
    if (!t && c) {
      lines.push({
        ...base,
        action: "close",
        reason:
          c.value != null
            ? `${u} is held (quantity ${c.quantity}, reported value ${money(c.value)}) but the target allocation carries no ${u} risk; a full exit is recorded for review.`
            : `${u} is held (quantity ${c.quantity}; the read reported no market value) but the target allocation carries no ${u} risk; a full exit is recorded for review.`,
      });
      continue;
    }
    if (t && c) {
      if (c.value == null || base.currentShare == null) {
        lines.push({
          ...base,
          action: "none",
          reason: `${u} is held (quantity ${c.quantity}) and in the target allocation (${money(targetRisk)} of risk), but the holdings read reported no market value for it, so no sized delta is proposed.`,
        });
        continue;
      }
      const cur = base.currentShare;
      if (cur > targetShare * (1 + tolerance)) {
        lines.push({
          ...base,
          action: "reduce",
          reason: `Current ${u} exposure ${money(c.value)} (${pct(cur)} of budget) is above the target risk share ${pct(targetShare)} (${money(targetRisk)}) by more than the ±${pct(tolerance)} band; a reduction is recorded for review.`,
        });
      } else if (cur < targetShare * (1 - tolerance)) {
        lines.push({
          ...base,
          action: "increase",
          reason: `Current ${u} exposure ${money(c.value)} (${pct(cur)} of budget) is below the target risk share ${pct(targetShare)} (${money(targetRisk)}) by more than the ±${pct(tolerance)} band; an increase is recorded for review.`,
        });
      } else {
        lines.push({
          ...base,
          action: "none",
          reason: `Current ${u} exposure ${money(c.value)} (${pct(cur)} of budget) is within the ±${pct(tolerance)} band of the target risk share ${pct(targetShare)}; no change proposed.`,
        });
      }
    }
  }

  return { ...head, lines };
}

/**
 * The one text rendering of a rebalance proposal (issue #242 P2.3,
 * #330). Every surface that shows a proposal as text - the
 * autopilot.summary / autopilot.proposals A2A replies and the desk
 * snapshot email - renders through this function, so the wording a
 * reviewer reads can never drift between surfaces. The dashboard
 * renders the same structured record as HTML in public-data.js.
 *
 * Honesty rules: a null proposal renders the explicit no-proposal
 * state (never an empty string a surface could mistake for "nothing
 * to say"); a holdings-read failure is named on the rendering with
 * zero delta actions; the comparison basis (max-risk dollars vs
 * reported market values, shares of the objective budget) is stated
 * on the face of the output via the proposal's own notes.
 */
export function renderProposalText(proposal: RebalanceProposal | null | undefined): string {
  if (!proposal) {
    return "No rebalance proposals yet. A proposal is built by autopilot.runCycle from the hunt's construction plan and the current holdings read (desk.portfolio).";
  }
  const when = new Date(proposal.createdAt).toISOString();
  const out: string[] = [
    `Rebalance proposal ${proposal.id} (cycle ${proposal.cycleId}, ${when}) - review record only; nothing has been executed.`,
    `Goal: "${proposal.goal}" - budget ${money(proposal.budget)}.`,
  ];
  if (proposal.holdings.ok) {
    const h = proposal.holdings;
    out.push(
      `Holdings basis: read OK${h.fetchedAt ? ` at ${h.fetchedAt}` : ""} - ${h.positions.length} position(s)` +
        (h.totalValue != null ? `, total reported value ${money(h.totalValue)}.` : ", no reported total value."),
    );
  } else {
    out.push(
      `Holdings basis: READ FAILED (${proposal.holdings.error}) - the target allocation below is recorded with NO delta actions; a diff against holdings nobody read would be fabrication.`,
    );
  }
  const plan = proposal.plan;
  out.push(
    `Target allocation: ${money(plan.totalRisk)} total max risk across ${plan.allocations.length} allocated trade(s); ${money(plan.unallocated)} of the budget unallocated.`,
  );
  out.push("Delta lines:");
  if (proposal.lines.length) {
    for (const l of proposal.lines) out.push(`- ${l.action.toUpperCase()} ${l.underlying}: ${l.reason}`);
  } else {
    out.push("- none (no holdings diff was computed for this proposal).");
  }
  if (plan.rejections.length) {
    out.push(`Construction rejections (${plan.rejections.length}):`);
    for (const r of plan.rejections) {
      out.push(`- ${r.underlying} (${r.strategy}, exp ${r.expiry}) [${r.reason}]: ${r.detail}`);
    }
  } else {
    out.push("Construction rejections: none.");
  }
  if (proposal.notes.length) {
    out.push("Notes:");
    for (const n of proposal.notes) out.push(`- ${n}`);
  }
  return out.join("\n");
}

export const PROPOSALS_MAX_KEPT = 20;

/** SQL-backed proposal store, mirroring HuntStore's shape. */
export class ProposalStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_proposals (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        cycle_id TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  save(proposal: RebalanceProposal): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO autopilot_proposals (id, created_at, cycle_id, data) VALUES (?, ?, ?, ?)",
      proposal.id,
      proposal.createdAt,
      proposal.cycleId,
      JSON.stringify(proposal),
    );
    const ids = [...this.sql.exec("SELECT id FROM autopilot_proposals ORDER BY created_at DESC")]
      .map((r) => String(r.id));
    for (const extra of ids.slice(PROPOSALS_MAX_KEPT)) {
      this.sql.exec("DELETE FROM autopilot_proposals WHERE id = ?", extra);
    }
  }

  list(limit = PROPOSALS_MAX_KEPT): RebalanceProposal[] {
    const n = typeof limit === "number" && limit > 0 ? Math.floor(limit) : PROPOSALS_MAX_KEPT;
    const rows = [...this.sql.exec(
      "SELECT data FROM autopilot_proposals ORDER BY created_at DESC LIMIT ?",
      n,
    )];
    const out: RebalanceProposal[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data as string) as RebalanceProposal);
      } catch {
        // Skip a corrupt row rather than failing the list.
      }
    }
    return out;
  }

  latest(): RebalanceProposal | null {
    return this.list(1)[0] ?? null;
  }

  count(): number {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS c FROM autopilot_proposals")];
    return Number(rows[0]?.c ?? 0);
  }
}
