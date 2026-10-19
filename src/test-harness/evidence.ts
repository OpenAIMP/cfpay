/**
 * Evidence record for one recommendation's test lanes (cfpay #245).
 *
 * One record per recommendation: the backtest dossier and the forward
 * paper-test outcome land here, and the TradeWorkflow writes the live
 * outcome back into the same record — one attributable chain for the
 * outcome ledger (#242).
 *
 * SDK-free: no cloudflare:/agents imports, no env access. The host agent
 * owns persistence (HuntStore pattern); this module owns the pure record
 * shape + the honest dossier text.
 */

import type {
  BacktestRequest,
  BacktestWindowResult,
  ForwardOrder,
  VenueOrderStatus,
} from "./providers";

export type LaneState =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "skipped-not-configured";

export interface LaneResult<T> {
  state: LaneState;
  provider: string;
  error?: string;
  result?: T;
  ranAt?: string;
}

export interface ForwardOutcome {
  realizedPnl: number;
  holdingDays: number;
  maxAdverseMove?: number;
  closeReason: string;
}

export interface EvidenceRecord {
  recommendationId: string;
  strategy: string;
  underlying: string;
  issuedAt: string;
  /** Verifier-approved size; the forward mirror reuses this identically. */
  sizerSpec: unknown;
  backtest: LaneResult<BacktestWindowResult[]> & {
    windows?: BacktestWindowResult[];
  };
  forward: LaneResult<VenueOrderStatus[]> & {
    venueOrderIds: string[];
    enteredAt?: string;
    exitRule?: string;
    outcome?: ForwardOutcome;
  };
  live?: { proposalId?: string; outcome?: unknown };
  /** Durable workflow instance owning this run, once started. */
  workflowId?: string;
  /** The full backtest request, persisted so follow-up steps can re-poll. */
  backtestRequest?: BacktestRequest;
  /** The forward order as submitted (clientTestId assigned at submit). */
  forwardOrderSpec?: ForwardOrder;
  /** Backtest run ids returned at submit, for status polling. */
  backtestHandles?: string[];
  /** Final honest dossier text (summarizeEvidence), written at finalize. */
  dossierText?: string;
}

/**
 * New record: issuedAt = now (ISO), both lanes pending. Providers are
 * named at submission time by the lane runner, not here.
 */
export function newEvidenceRecord(rec: {
  recommendationId: string;
  strategy: string;
  underlying: string;
  sizerSpec: unknown;
}): EvidenceRecord {
  return {
    recommendationId: rec.recommendationId,
    strategy: rec.strategy,
    underlying: rec.underlying,
    issuedAt: new Date().toISOString(),
    sizerSpec: rec.sizerSpec,
    backtest: { state: "pending", provider: "" },
    forward: { state: "pending", provider: "", venueOrderIds: [] },
  };
}

const NOT_CONFIGURED_TEXT = "not configured — evidence unavailable";

function describeLane(
  name: string,
  lane: LaneResult<unknown>,
): string {
  switch (lane.state) {
    case "skipped-not-configured":
      return `${name}: ${NOT_CONFIGURED_TEXT}.`;
    case "pending":
      return `${name}: pending.`;
    case "running":
      return `${name}: running.`;
    case "failed":
      return `${name}: failed${lane.error ? ` — ${lane.error}` : ""}.`;
    case "complete":
      return ""; // caller fills in lane-specific detail
  }
}

/**
 * Honest one-paragraph dossier text. A lane that is skipped-not-configured
 * renders "not configured — evidence unavailable", never numbers. When the
 * forward provider is alpaca-paper, the text carries the paper-fill
 * optimism caveat (fills simulated at NBBO, unlimited-depth assumption —
 * evidence is systematically optimistic on fill quality).
 */
export function summarizeEvidence(e: EvidenceRecord): string {
  const parts: string[] = [
    `${e.strategy} on ${e.underlying} (recommendation ${e.recommendationId}, issued ${e.issuedAt}).`,
  ];

  const backtestLine = describeLane("Backtest", e.backtest);
  if (backtestLine) {
    parts.push(backtestLine);
  } else {
    const windows = e.backtest.windows ?? e.backtest.result ?? [];
    const trades = windows.reduce((n, w) => n + w.tradeCount, 0);
    const pnl = windows.reduce((n, w) => n + w.netPnl, 0);
    const winRates = windows
      .filter((w) => w.tradeCount > 0)
      .map((w) => w.winRate);
    const winRate =
      winRates.length > 0
        ? winRates.reduce((a, b) => a + b, 0) / winRates.length
        : NaN;
    const drift = windows
      .filter(
        (w) =>
          w.tradeCount > 0 &&
          typeof w.predictedWinRate === "number" &&
          Math.abs(w.predictedWinRate - w.winRate) * 100 > 10,
      )
      .map((w) => `${w.start}→${w.end}`);
    let line = `Backtest (${e.backtest.provider}): ${trades} trades across ${windows.length} window(s)`;
    line += Number.isNaN(winRate)
      ? ", no realized win rate"
      : `, ${(winRate * 100).toFixed(1)}% average realized win rate`;
    line += `, net P&L ${pnl.toFixed(2)}.`;
    if (drift.length > 0) {
      line += ` Caution: modeled win rate overestimates realized in window(s) ${drift.join(", ")}.`;
    }
    const notices = windows.flatMap((w) => w.notices);
    if (notices.length > 0) {
      line += ` Notices: ${notices.join(" ")}`;
    }
    parts.push(line);
  }

  const forwardLine = describeLane("Forward test", e.forward);
  if (forwardLine) {
    parts.push(forwardLine);
  } else {
    const outcome = e.forward.outcome;
    let line = `Forward test (${e.forward.provider})`;
    line += e.forward.enteredAt ? `, entered ${e.forward.enteredAt}` : "";
    line += e.forward.exitRule ? `, exit rule: ${e.forward.exitRule}` : "";
    line += ".";
    if (outcome) {
      line += ` Outcome: realized P&L ${outcome.realizedPnl.toFixed(2)} over ${outcome.holdingDays} day(s)`;
      if (typeof outcome.maxAdverseMove === "number") {
        line += `, max adverse move ${outcome.maxAdverseMove.toFixed(2)}`;
      }
      line += `, closed: ${outcome.closeReason}.`;
    } else {
      line += ` Orders: ${e.forward.venueOrderIds.join(", ") || "none yet"}.`;
    }
    if (e.forward.provider === "alpaca-paper") {
      line +=
        " Caveat: Alpaca paper fills are simulated at NBBO (buy at ask, sell at bid) with no depth check, random partial fills, and no fees, latency, queue position, or dividends — fill quality is systematically optimistic; forward-test performance is never live performance.";
    }
    parts.push(line);
  }

  if (e.live?.proposalId) {
    parts.push(
      `Live: proposal ${e.live.proposalId}${e.live.outcome !== undefined ? " has a recorded outcome" : " outcome pending"}.`,
    );
  }

  return parts.join(" ");
}

/**
 * Deterministic FNV-1a 32-bit hex (SDK-free, implemented inline).
 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Deterministic external identifier for a recommendation, safe as an
 * Alpaca client_order_id (≤ 48 chars). Format: `tt-<recId>-<shortHash>`,
 * where shortHash is the FNV-1a hex of recommendationId+strategy. The
 * order step checks listTestOrders for this id before submitting, so
 * step retries cannot duplicate orders.
 */
export function makeClientTestId(
  recommendationId: string,
  strategy: string,
): string {
  const shortHash = fnv1aHex(`${recommendationId}|${strategy}`);
  const safe = recommendationId.replace(/[^A-Za-z0-9._-]/g, "-");
  // "tt-" (3) + "-" (1) + shortHash (8) = 12 fixed chars; ≤ 48 total.
  const trimmed = safe.slice(0, 36);
  return `tt-${trimmed}-${shortHash}`;
}
