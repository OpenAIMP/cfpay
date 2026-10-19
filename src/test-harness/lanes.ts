/**
 * Lane orchestration for the #245 test harness (pure, SDK-free).
 *
 * Two lanes, parallel and failure-isolated: the backtest lane submits to
 * the backtest provider and polls to a terminal state; the forward lane
 * places a paper mleg order and advances it toward an exit. A lane that
 * throws records {state:"failed"} — it never stalls the other lane
 * (runTestLanes), and the durable workflow calls the submit/poll pieces in
 * separate steps (Worker-safe: no blocking loops, no busy polling in one
 * invocation).
 *
 * Exit evaluation adapts amuse exits.py::evaluate semantics:
 * take-profit on credit capture, stop-loss on adverse multiple, exit by DTE.
 */

import type {
  BacktestProvider,
  BacktestRequest,
  BacktestWindowResult,
  ForwardOrder,
  ForwardTestProvider,
  ProviderEnv,
  VenueOrderStatus,
} from "./providers";
import type { LaneResult } from "./evidence";

export interface BacktestLaneOutcome extends LaneResult<BacktestWindowResult[]> {
  runIds?: string[];
}

export interface ForwardLaneOutcome extends LaneResult<VenueOrderStatus[]> {
  venueOrderId?: string;
}

export interface LaneFailure {
  state: "failed";
  provider: string;
  error: string;
}

function laneFailure(provider: string, err: unknown): LaneFailure {
  return {
    state: "failed",
    provider,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Run both lanes "in parallel" (Promise.all) with per-lane isolation: a
 * lane that throws resolves to {state:"failed"} instead of rejecting the
 * combination. This is the unit under the lane-isolation test.
 */
export async function runTestLanes<B, F>(
  backtestProviderId: string,
  runBacktest: () => Promise<B>,
  forwardProviderId: string,
  runForward: () => Promise<F>,
): Promise<{ backtest: B | LaneFailure; forward: F | LaneFailure }> {
  const [backtest, forward] = await Promise.all([
    runBacktest().catch(
      (err): B | LaneFailure => laneFailure(backtestProviderId, err),
    ),
    runForward().catch(
      (err): F | LaneFailure => laneFailure(forwardProviderId, err),
    ),
  ]);
  return { backtest, forward };
}

// ---------------------------------------------------------------------------
// Backtest lane: submit (returns handles immediately) + poll (one status pass)
// ---------------------------------------------------------------------------

/**
 * Submit one backtest per window. Returns state "running" with the run ids;
 * the workflow persists them on the evidence record and polls later via
 * pollBacktestLane. NOT_CONFIGURED → "skipped-not-configured", never
 * synthetic data.
 */
export async function submitBacktestLane(
  provider: BacktestProvider,
  env: ProviderEnv,
  req: BacktestRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BacktestLaneOutcome> {
  if (!provider.isConfigured(env)) {
    return {
      state: "skipped-not-configured",
      provider: provider.providerId,
    };
  }
  const handles = await provider.submitBacktestWindows(env, req, fetchImpl);
  return {
    state: "running",
    provider: provider.providerId,
    runIds: handles.map((h) => h.runId),
    ranAt: new Date().toISOString(),
  };
}

/**
 * One status pass over the submitted run ids. All complete → complete with
 * merged window results; any failed → failed with the provider error; else
 * still running (the workflow re-arms a follow-up).
 */
export async function pollBacktestLane(
  provider: BacktestProvider,
  env: ProviderEnv,
  runIds: string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BacktestLaneOutcome> {
  if (!provider.isConfigured(env)) {
    return {
      state: "skipped-not-configured",
      provider: provider.providerId,
    };
  }
  const results: BacktestWindowResult[] = [];
  const errors: string[] = [];
  let anyRunning = false;
  for (const runId of runIds) {
    const status = await provider.getBacktestStatus(env, runId, fetchImpl);
    if (status.state === "complete" && status.results) {
      results.push(...status.results);
    } else if (status.state === "failed") {
      errors.push(status.error ?? `backtest ${runId} failed`);
    } else {
      anyRunning = true;
    }
  }
  if (errors.length > 0) {
    return {
      state: "failed",
      provider: provider.providerId,
      error: errors.join("; "),
      runIds,
    };
  }
  if (anyRunning) {
    return { state: "running", provider: provider.providerId, runIds };
  }
  return {
    state: "complete",
    provider: provider.providerId,
    result: results,
    runIds,
    ranAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Forward lane: place (idempotent) + advance toward an exit
// ---------------------------------------------------------------------------

export const EVIDENCE_FOLLOWUP_DELAY_SECONDS = 6 * 3600;

/**
 * Place the forward-test mleg order. Idempotent: the provider returns the
 * existing venue order when clientTestId is already present, so step
 * retries cannot double-submit. NOT_CONFIGURED → "skipped-not-configured".
 * The paper guard throws for any non-paper base URL BEFORE any network
 * call — there is no live order path in this code.
 */
export async function submitForwardLane(
  provider: ForwardTestProvider,
  env: ProviderEnv,
  order: ForwardOrder,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ForwardLaneOutcome> {
  if (!provider.isConfigured(env)) {
    return {
      state: "skipped-not-configured",
      provider: provider.providerId,
    };
  }
  provider.assertPaper(env);
  const status = await provider.placeTestOrder(env, order, fetchImpl);
  return {
    state: "running",
    provider: provider.providerId,
    result: [status],
    venueOrderId: status.id,
    ranAt: new Date().toISOString(),
  };
}

export type ExitSignal = "take_profit" | "stop_loss" | "dte_exit" | "hold";

export interface ExitEvaluationInput {
  /** Credit received at entry (positive number). */
  entryCredit: number;
  /** Current cost to close the position (positive number). */
  closeCost: number;
  /** Days to expiry of the short leg. */
  dte: number;
  /** Capture fraction of credit that triggers take-profit (default 0.5). */
  profitTargetPct?: number;
  /** Adverse multiple of credit that triggers the stop (default 2.0). */
  stopLossPct?: number;
  /** DTE at or below which the position is exited (default 7). */
  dteExitThreshold?: number;
}

/**
 * Pure exit evaluation (amuse exits.py::evaluate semantics): profit is
 * measured as credit captured = (entryCredit - closeCost) / entryCredit.
 */
export function evaluateForwardExit(input: ExitEvaluationInput): ExitSignal {
  const profitTarget = (input.profitTargetPct ?? 50) / 100;
  const stopMultiple = (input.stopLossPct ?? 200) / 100;
  const dteThreshold = input.dteExitThreshold ?? 7;
  if (input.entryCredit <= 0) return "hold";
  const captured = (input.entryCredit - input.closeCost) / input.entryCredit;
  if (captured >= profitTarget) return "take_profit";
  if (captured <= -stopMultiple) return "stop_loss";
  if (input.dte <= dteThreshold) return "dte_exit";
  return "hold";
}

export interface ForwardAdvanceResult {
  signal: ExitSignal;
  status: VenueOrderStatus;
  /** Present when a mark was unavailable — the lane holds honestly. */
  note?: string;
}

/**
 * Re-read the venue order and evaluate the exit. Never throws for a
 * missing mark: without a close cost the lane holds and says why.
 */
export async function advanceForwardLane(
  provider: ForwardTestProvider,
  env: ProviderEnv,
  orderId: string,
  exitCfg: Omit<ExitEvaluationInput, "entryCredit" | "closeCost" | "dte"> & {
    entryCredit: number;
    dte: number;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ForwardAdvanceResult> {
  const status = await provider.getTestOrder(env, orderId, fetchImpl);
  const closeCost =
    typeof status.filledAvgPrice === "number" &&
    Number.isFinite(status.filledAvgPrice)
      ? status.filledAvgPrice
      : NaN;
  if (!Number.isFinite(closeCost)) {
    return {
      signal: "hold",
      status,
      note: "no close mark available from the venue — holding",
    };
  }
  return {
    signal: evaluateForwardExit({ ...exitCfg, closeCost }),
    status,
  };
}

// ---------------------------------------------------------------------------
// Provenance labels + the ScheduledAgent goal-text contract
// ---------------------------------------------------------------------------

/**
 * Honest-limit labels for a provider, surfaced on dossiers and reports.
 * The paper caveat is the #244 audit's: fills are simulated at NBBO with
 * no depth check, random partials, no fees/latency/dividends — evidence is
 * systematically optimistic on fill quality and is never live performance.
 */
export function laneProvenance(providerId: string): string[] {
  if (providerId === "alpaca-paper") {
    return [
      "venue: Alpaca paper (simulated)",
      "fills simulated at NBBO (buy at ask / sell at bid); quantity not checked against NBBO depth",
      "~10% random partial fills; market impact, latency, queue position, fees, dividends ignored",
      "forward-test performance is never live performance",
    ];
  }
  if (providerId === "tastytrade-backtest") {
    return [
      "venue: tastytrade backtester (historical)",
      "backtest fills are historical simulations, not live executions",
      "windows and dates are reported on the dossier; predicted vs realized win rates are paired",
    ];
  }
  return [`venue: ${providerId}`];
}

/**
 * The exact ScheduledAgent goal text that advances an open evidence run.
 * Contract (no new scheduler): the operator — or the workflow via
 * `scheduled.once` — creates a goal with this text; when it fires,
 * ScheduledAgent hands it to the orchestrator, which routes it to the
 * host's evidenceAdvance callable (desk pattern). The text is the stable
 * identity: the workflow checks for an existing goal with this text before
 * arming a duplicate.
 */
export function evidenceGoalText(recommendationId: string): string {
  return `Advance the evidence run for recommendation ${recommendationId} (evidence.advance).`;
}

/** Deterministic one-shot goal identity for workflow-initiated follow-ups. */
export function evidenceFollowUpGoalId(recommendationId: string): string {
  return `evidence-followup:${recommendationId}`;
}
