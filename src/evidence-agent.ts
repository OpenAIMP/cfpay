/**
 * Host-side glue for the #245 test-harness evidence lanes (cfpay).
 *
 * SDK-free: everything takes explicit (sql, env) arguments — the host
 * agent's wrappers are 2-line delegations, and unit tests pass a fake
 * SqlStorage plus a stub fetch. Provider resolution goes through the
 * plugin registry (BACKTEST_PROVIDER / FORWARD_TEST_PROVIDER env keys,
 * tastytrade / alpaca-paper defaults), so swapping a venue never touches
 * this code.
 *
 * Follow-up arming is the CALLER's job: advanceEvidence returns
 * { rearmed, goalText } and the host arms `scheduled.once` with the goal
 * text (the ScheduledAgent goal-text contract in lanes.ts). Advancing is
 * idempotent — a duplicate follow-up re-reads terminal lanes and no-ops.
 */

import { EvidenceStore } from "./evidence-store";
import {
  BACKTEST_PROVIDER_FALLBACK,
  FORWARD_TEST_PROVIDER_FALLBACK,
  registry,
  registerDefaultProviders,
  resolveProvider,
} from "./test-harness/providers";
import type {
  BacktestLeg,
  BacktestProvider,
  BacktestRequest,
  BacktestWindow,
  ForwardLeg,
  ForwardOrder,
  ForwardTestProvider,
  ProviderEnv,
} from "./test-harness/providers";
import {
  evidenceGoalText,
  pollBacktestLane,
  submitBacktestLane,
  submitForwardLane,
  advanceForwardLane,
  EVIDENCE_FOLLOWUP_DELAY_SECONDS,
} from "./test-harness/lanes";
import {
  makeClientTestId,
  newEvidenceRecord,
  summarizeEvidence,
} from "./test-harness/evidence";
import type { EvidenceRecord } from "./test-harness/evidence";

registerDefaultProviders(registry);

export interface EvidenceStartSpec {
  recommendationId: string;
  strategy: string;
  underlying: string;
  symbol: string;
  legs: BacktestLeg[];
  windows: BacktestWindow[];
  profitTargetPct: number;
  stopLossPct?: number;
  /** Verifier-approved size; the forward mirror reuses this identically. */
  sizerSpec: unknown;
  forwardLegs: ForwardLeg[];
  /** Signed: positive = debit, negative = credit. */
  limitPrice: number;
  timeInForce: "day" | "gtc";
  testBudget: number;
  exitProfitTargetPct?: number;
  exitStopLossPct?: number;
  exitDteThreshold?: number;
  backtestProviderId?: string;
  forwardProviderId?: string;
}

function backtestProviderFor(env: ProviderEnv): BacktestProvider {
  const p = resolveProvider(
    registry,
    env,
    "backtest",
    "BACKTEST_PROVIDER",
    BACKTEST_PROVIDER_FALLBACK,
  );
  return p as BacktestProvider;
}

function forwardProviderFor(env: ProviderEnv): ForwardTestProvider {
  const p = resolveProvider(
    registry,
    env,
    "forward",
    "FORWARD_TEST_PROVIDER",
    FORWARD_TEST_PROVIDER_FALLBACK,
  );
  return p as ForwardTestProvider;
}

function buildBacktestRequest(spec: EvidenceStartSpec): BacktestRequest {
  return {
    recommendationId: spec.recommendationId,
    strategy: spec.strategy,
    symbol: spec.symbol,
    legs: spec.legs,
    windows: spec.windows,
    profitTargetPct: spec.profitTargetPct,
    stopLossPct: spec.stopLossPct,
  };
}

function buildForwardOrder(spec: EvidenceStartSpec): ForwardOrder {
  return {
    clientTestId: makeClientTestId(spec.recommendationId, spec.strategy),
    symbol: spec.symbol,
    strategy: spec.strategy,
    recommendationId: spec.recommendationId,
    orderClass: "mleg",
    legs: spec.forwardLegs,
    limitPrice: spec.limitPrice,
    timeInForce: spec.timeInForce,
    testBudget: spec.testBudget,
  };
}

function exitRuleText(spec: EvidenceStartSpec): string {
  const tp = spec.exitProfitTargetPct ?? 50;
  const sl = spec.exitStopLossPct ?? 200;
  const dte = spec.exitDteThreshold ?? 7;
  return (
    `take-profit at ${tp}% credit capture; stop-loss at ${sl}% adverse; ` +
    `exit at DTE <= ${dte}`
  );
}

/**
 * Create the evidence record (both lanes pending) and persist the full
 * lane specs so follow-up steps can re-poll without caller state.
 */
export function startEvidenceRun(
  sql: SqlStorage,
  spec: EvidenceStartSpec,
): EvidenceRecord {
  const store = new EvidenceStore(sql);
  const record = newEvidenceRecord({
    recommendationId: spec.recommendationId,
    strategy: spec.strategy,
    underlying: spec.underlying,
    sizerSpec: spec.sizerSpec,
  });
  record.backtestRequest = buildBacktestRequest(spec);
  record.forwardOrderSpec = buildForwardOrder(spec);
  record.forward.exitRule = exitRuleText(spec);
  store.save(record);
  return record;
}

export function getEvidenceRecord(
  sql: SqlStorage,
  recommendationId: string,
): EvidenceRecord | null {
  return new EvidenceStore(sql).get(recommendationId);
}

function loadOrThrow(sql: SqlStorage, recommendationId: string): EvidenceRecord {
  const record = getEvidenceRecord(sql, recommendationId);
  if (!record) {
    throw new Error(
      `evidence run not found for recommendation ${recommendationId}`,
    );
  }
  return record;
}

/**
 * Submit the backtest lane. Idempotent: only submits when the lane is
 * pending — a retry after submit reuses the stored handles via
 * advanceEvidence, never double-submits.
 */
export async function submitBacktestFor(
  sql: SqlStorage,
  env: ProviderEnv,
  recommendationId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<EvidenceRecord> {
  const store = new EvidenceStore(sql);
  const record = loadOrThrow(sql, recommendationId);
  if (record.backtest.state !== "pending") return record;
  const provider = backtestProviderFor(env);
  const req = record.backtestRequest;
  if (!req) throw new Error("evidence record has no backtest request");
  try {
    const outcome = await submitBacktestLane(provider, env, req, fetchImpl);
    record.backtest = {
      state: outcome.state,
      provider: provider.providerId,
      error: outcome.error,
      ranAt: outcome.ranAt,
    };
    if (outcome.runIds) record.backtestHandles = outcome.runIds;
  } catch (err) {
    record.backtest = {
      state: "failed",
      provider: provider.providerId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  store.save(record);
  return record;
}

/**
 * Place the forward paper order. Idempotent: only submits when the lane is
 * pending; the provider itself dedupes on clientTestId, so a step retry
 * cannot double-submit at the venue either.
 */
export async function submitForwardFor(
  sql: SqlStorage,
  env: ProviderEnv,
  recommendationId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<EvidenceRecord> {
  const store = new EvidenceStore(sql);
  const record = loadOrThrow(sql, recommendationId);
  if (record.forward.state !== "pending") return record;
  const provider = forwardProviderFor(env);
  const order = record.forwardOrderSpec;
  if (!order) throw new Error("evidence record has no forward order spec");
  try {
    const outcome = await submitForwardLane(provider, env, order, fetchImpl);
    record.forward = {
      ...record.forward,
      state: outcome.state,
      provider: provider.providerId,
      error: outcome.error,
      ranAt: outcome.ranAt,
      venueOrderIds:
        outcome.venueOrderId != null ? [outcome.venueOrderId] : [],
      enteredAt: outcome.state === "running" ? new Date().toISOString() : undefined,
    };
  } catch (err) {
    record.forward = {
      ...record.forward,
      state: "failed",
      provider: provider.providerId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  store.save(record);
  return record;
}

export interface AdvanceResult {
  record: EvidenceRecord;
  /** True when a lane is still open — the caller arms scheduled.once. */
  rearmed: boolean;
  goalText?: string;
  followUpDelaySeconds?: number;
}

function laneTerminal(
  state: string,
): boolean {
  return (
    state === "complete" || state === "failed" || state === "skipped-not-configured"
  );
}

/**
 * Advance one evidence run: poll open backtest handles, re-read the paper
 * order and evaluate the exit, finalize when both lanes are terminal.
 * Fully idempotent — safe to invoke from duplicate follow-ups.
 */
export async function advanceEvidence(
  sql: SqlStorage,
  env: ProviderEnv,
  recommendationId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AdvanceResult> {
  const store = new EvidenceStore(sql);
  const record = loadOrThrow(sql, recommendationId);

  // Backtest lane: poll open handles.
  if (record.backtest.state === "running" && record.backtestHandles?.length) {
    const provider = backtestProviderFor(env);
    try {
      const outcome = await pollBacktestLane(
        provider,
        env,
        record.backtestHandles,
        fetchImpl,
      );
      record.backtest = {
        state: outcome.state,
        provider: provider.providerId,
        error: outcome.error,
        result: outcome.result,
        windows: outcome.result,
        ranAt: outcome.ranAt ?? record.backtest.ranAt,
      };
    } catch (err) {
      record.backtest = {
        ...record.backtest,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Forward lane: re-read the order, evaluate the exit.
  if (
    record.forward.state === "running" &&
    record.forward.venueOrderIds.length > 0
  ) {
    const provider = forwardProviderFor(env);
    const orderId = record.forward.venueOrderIds[0] as string;
    const spec = record.forwardOrderSpec;
    try {
      const entryCredit =
        spec && spec.limitPrice < 0 ? -spec.limitPrice : NaN;
      const enteredAt = record.forward.enteredAt
        ? Date.parse(record.forward.enteredAt)
        : NaN;
      const dte = 45; // structural DTE of the mirrored spread (45-DTE entry)
      const advance = await advanceForwardLane(
        provider,
        env,
        orderId,
        {
          entryCredit,
          dte,
          profitTargetPct: 50,
          stopLossPct: 200,
          dteExitThreshold: 7,
        },
        fetchImpl,
      );
      if (advance.signal !== "hold") {
        await provider
          .cancelTestOrder(env, orderId, fetchImpl)
          .catch(() => undefined);
        const closeCost =
          typeof advance.status.filledAvgPrice === "number"
            ? advance.status.filledAvgPrice
            : NaN;
        record.forward = {
          ...record.forward,
          state: "complete",
          result: [advance.status],
          outcome: {
            realizedPnl: Number.isFinite(entryCredit) && Number.isFinite(closeCost)
              ? entryCredit - (closeCost as number)
              : 0,
            holdingDays: Number.isFinite(enteredAt)
              ? Math.max(0, (Date.now() - (enteredAt as number)) / 86400000)
              : 0,
            closeReason: advance.signal,
          },
        };
      } else {
        record.forward = {
          ...record.forward,
          result: [advance.status],
        };
      }
    } catch (err) {
      record.forward = {
        ...record.forward,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  store.save(record);

  const done =
    laneTerminal(record.backtest.state) && laneTerminal(record.forward.state);
  if (done) {
    record.dossierText = summarizeEvidence(record);
    store.save(record);
    return { record, rearmed: false };
  }
  return {
    record,
    rearmed: true,
    goalText: evidenceGoalText(recommendationId),
    followUpDelaySeconds: EVIDENCE_FOLLOWUP_DELAY_SECONDS,
  };
}
