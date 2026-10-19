/**
 * Test-harness provider plugin contracts (cfpay #245).
 *
 * Two lanes, parallel: tastytrade backtest ("did this make money
 * historically?") + Alpaca paper forward-test ("does it work live,
 * starting now?"). Platforms are plugins swappable behind these stable
 * interfaces (#248 decision: swappable plugins behind stable interfaces).
 *
 * SDK-free: no cloudflare:/agents imports, no env access inside the pure
 * functions — providers take their config as `ProviderEnv` (duck-typed so
 * tests never need the Worker's real Env). Importable from unit tests, same
 * idiom as src/crypto-hmac.ts / src/slack-verify.ts.
 *
 * Worker-safety: `BacktestProvider.submitBacktest` returns a
 * `BacktestHandle` IMMEDIATELY; status is polled separately via
 * `getBacktestStatus`. There is no blocking run loop inside one Worker
 * invocation — amuse's 5s×600s poll becomes submit + durable wake-ups in
 * the evidence workflow (findings §5).
 */

import { createTastytradeBacktestProvider } from "./tastytrade-backtest";
// NOTE: sibling workers landed both provider modules under
// src/test-harness/ (not src/); imports point at the real locations.
import { createAlpacaPaperProvider } from "./alpaca-paper";

export type LaneKind = "backtest" | "forward";

export interface ProviderCapabilities {
  multiLeg: boolean;
  maxLegs: number;
  assetClasses: ("equity-option" | "equity")[];
  /** Forward providers must always be true: this harness never places a live order. */
  paperOnly: boolean;
  /** Honest limits, surfaced on dossiers — e.g. "paper fills: NBBO sim, no depth check". */
  honestLimits: string[];
}

/**
 * Duck-typed environment for providers. A plain record (not the Worker
 * Env) so unit tests and non-Worker consumers can pass config directly.
 */
export interface ProviderEnv {
  [k: string]: string | undefined;
}

export interface TestProvider {
  readonly providerId: string;
  readonly kind: LaneKind;
  capabilities(): ProviderCapabilities;
  /** false → the lane records `skipped-not-configured`; never synthetic data. */
  isConfigured(cfg: ProviderEnv): boolean;
  /** Secret/config names this provider reads, e.g. ["TASTYTRADE_CLIENT_SECRET","TASTYTRADE_REFRESH_TOKEN"]. */
  requiredEnv(): string[];
}

// ---------------------------------------------------------------------------
// Backtest lane
// ---------------------------------------------------------------------------

export interface BacktestLeg {
  side: "put" | "call";
  direction: "short" | "long";
  strikeSelection: "delta";
  delta: number;
  daysUntilExpiration: number;
  quantity: number;
}

export interface BacktestWindow {
  /** ISO date, e.g. "2023-01-01". */
  start: string;
  /** ISO date, e.g. "2026-01-01". */
  end: string;
}

export interface BacktestRequest {
  recommendationId: string;
  strategy: string;
  symbol: string;
  legs: BacktestLeg[];
  windows: BacktestWindow[];
  profitTargetPct: number;
  stopLossPct?: number;
}

export interface BacktestWindowResult {
  start: string;
  end: string;
  tradeCount: number;
  winRate: number;
  predictedWinRate?: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor?: number;
  maxDrawdown?: number;
  sharpeRatio?: number;
  /** Server notices, often explaining 0 trades — surfaced, never dropped. */
  notices: string[];
}

/**
 * Submit returns a handle IMMEDIATELY (Worker-safe); status polled
 * separately. Never a blocking loop inside one invocation.
 */
export interface BacktestHandle {
  runId: string;
  providerId: string;
}

export interface BacktestProvider extends TestProvider {
  readonly kind: "backtest";
  submitBacktest(
    env: ProviderEnv,
    req: BacktestRequest,
    fetchImpl?: typeof fetch,
  ): Promise<BacktestHandle>;
  /**
   * Submit one backtest per window; returns every handle. This is the
   * variant the evidence workflow calls (submitting only the first window
   * would silently drop coverage).
   */
  submitBacktestWindows(
    env: ProviderEnv,
    req: BacktestRequest,
    fetchImpl?: typeof fetch,
  ): Promise<BacktestHandle[]>;
  getBacktestStatus(
    env: ProviderEnv,
    runId: string,
    fetchImpl?: typeof fetch,
  ): Promise<{
    state: "pending" | "running" | "complete" | "failed";
    results?: BacktestWindowResult[];
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Forward lane
// ---------------------------------------------------------------------------

export interface ForwardLeg {
  occSymbol: string;
  ratio: number;
  side: "buy" | "sell";
}

export interface ForwardOrder {
  /** Unique external identifier; idempotency key for the venue. */
  clientTestId: string;
  symbol: string;
  strategy: string;
  recommendationId: string;
  orderClass: "mleg";
  legs: ForwardLeg[];
  /** Signed: positive = debit, negative = credit. */
  limitPrice: number;
  timeInForce: "day" | "gtc";
  testBudget: number;
}

export interface VenueOrderStatus {
  id: string;
  status: string;
  filledQty: number;
  filledAvgPrice?: number;
  legs: { symbol: string; filledQty: number }[];
}

export interface ForwardTestProvider extends TestProvider {
  readonly kind: "forward";
  /** Throws unless the provider is pointed at the paper domain. No live order path exists. */
  assertPaper(env: ProviderEnv): void;
  placeTestOrder(
    env: ProviderEnv,
    o: ForwardOrder,
    fetchImpl?: typeof fetch,
  ): Promise<VenueOrderStatus>;
  getTestOrder(
    env: ProviderEnv,
    id: string,
    fetchImpl?: typeof fetch,
  ): Promise<VenueOrderStatus>;
  listTestOrders(
    env: ProviderEnv,
    status: "open" | "closed" | "all",
    fetchImpl?: typeof fetch,
  ): Promise<VenueOrderStatus[]>;
  cancelTestOrder(
    env: ProviderEnv,
    id: string,
    fetchImpl?: typeof fetch,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ProviderFactory = (fetchImpl?: typeof fetch) => TestProvider;

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>();

  register(factory: ProviderFactory): void {
    this.factories.set(factory().providerId, factory);
  }

  get(providerId: string): TestProvider | undefined {
    const factory = this.factories.get(providerId);
    return factory ? factory() : undefined;
  }

  backtestProviders(): BacktestProvider[] {
    return this.all().filter(
      (p): p is BacktestProvider => p.kind === "backtest",
    );
  }

  forwardProviders(): ForwardTestProvider[] {
    return this.all().filter(
      (p): p is ForwardTestProvider => p.kind === "forward",
    );
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  private all(): TestProvider[] {
    return [...this.factories.values()].map((f) => f());
  }
}

export const registry = new ProviderRegistry();

export function registerDefaultProviders(reg: ProviderRegistry): void {
  reg.register(createTastytradeBacktestProvider);
  reg.register(createAlpacaPaperProvider);
}

export const BACKTEST_PROVIDER_FALLBACK = "tastytrade-backtest";
export const FORWARD_TEST_PROVIDER_FALLBACK = "alpaca-paper";

/**
 * Resolve the provider for a lane from `env[envKey] ?? fallbackId`.
 * Throws a clear Error naming the unknown provider and listing the
 * registered ids (never a silent fallback to a different venue).
 */
export function resolveProvider(
  reg: ProviderRegistry,
  env: ProviderEnv,
  kind: LaneKind,
  envKey: "BACKTEST_PROVIDER" | "FORWARD_TEST_PROVIDER",
  fallbackId: string,
): TestProvider {
  const id = env[envKey] ?? fallbackId;
  const provider = reg.get(id);
  if (!provider) {
    throw new Error(
      `Unknown test-harness provider "${id}" for the ${kind} lane ` +
        `(from ${envKey}); registered: ${reg.ids().join(", ") || "(none)"}`,
    );
  }
  if (provider.kind !== kind) {
    throw new Error(
      `Provider "${id}" is a ${provider.kind} provider but ${envKey} ` +
        `selects the ${kind} lane`,
    );
  }
  return provider;
}
