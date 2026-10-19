/**
 * tastytrade backtest provider — cfpay #245, backtest lane.
 *
 * TypeScript port of OpenAIMP/amuse `src/tastytrade_backtest.py` (same
 * contract: OAuth2 refresh-grant auth, `backtester.vast.tastyworks.com`
 * submit/status/logs, delta-based strategy legs, `summarize_results`
 * trial normalization). SDK-free: `fetch` is injected (defaults to
 * `globalThis.fetch`); no cloudflare:/agents imports.
 *
 * Differences from amuse (deliberate):
 * - Every request sends `User-Agent: cfpay-test-harness/1.0` (#244 audit:
 *   mandatory; amuse did not send it).
 * - No module-level session state: each call mints its own short-lived
 *   access token via `refreshAccessToken` and discards it, so secrets never
 *   live in module state beyond the call. Callers that hold a session
 *   across steps use the exported `needsRefresh(expiresAt, now)` check to
 *   refresh PROACTIVELY (60s margin) — never a 401 retry, because a POST
 *   that may have placed an order must not be replayed (amuse rationale).
 *   A server-rotated refresh token is adopted into the returned session;
 *   persisting it durably is a host/workflow concern (findings §5 risk 3).
 * - `BacktestRequest.profitTargetPct` / `stopLossPct` are PERCENTAGES
 *   (50 = 50%); amuse's `build_backtest` took fractions and multiplied by
 *   100 — the ×100 step is folded into this interface contract.
 * - `exit_dte` is NOT emitted: amuse accepted it but never put it in the
 *   payload. Exit-by-DTE is a forward-lane concern, not a backtester
 *   payload concern.
 * - amuse's blocking poll loop is split Worker-safe: `submitBacktest`
 *   returns a handle immediately; `getBacktestStatus` is polled by the
 *   evidence workflow's durable wake-ups (findings §5 risk 2).
 *
 * Multi-window decision (documented for the interface owner — no
 * interface change needed): `submitBacktest` submits ALL windows and
 * returns the FIRST handle (`{ runId, providerId }`);
 * `submitBacktestWindows` returns the full handle list and is the variant
 * the workflow calls.
 *
 * NOT_CONFIGURED honesty: `isTastytradeConfigured` false →
 * `submitBacktest`/`getBacktestStatus` throw
 * `tastytrade-backtest: NOT_CONFIGURED — ...`. The workflow maps that to
 * the `skipped-not-configured` lane state; this provider fails loudly and
 * never fabricates numbers.
 */

import type {
  BacktestHandle,
  BacktestLeg,
  BacktestProvider,
  BacktestRequest,
  BacktestWindow,
  BacktestWindowResult,
  ProviderCapabilities,
  ProviderEnv,
} from "./providers";

export const TASTYTRADE_AUTH_HOST = "https://api.tastyworks.com";
export const TASTYTRADE_BACKTEST_HOST = "https://backtester.vast.tastyworks.com";
export const TASTYTRADE_PROVIDER_ID = "tastytrade-backtest";

/** Mandatory product/version header per the #244 audit (amuse missed this). */
const USER_AGENT = "cfpay-test-harness/1.0";

/** Proactive refresh margin: renew this many seconds before expiry. */
export const TASTYTRADE_REFRESH_MARGIN_SECS = 60;

/** `expires_in` fallback when the token response omits it (amuse: 900). */
const DEFAULT_EXPIRES_IN_SECS = 900;

const NOT_CONFIGURED_MESSAGE =
  "tastytrade-backtest: NOT_CONFIGURED — set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function tastytradeRequiredEnv(): string[] {
  return ["TASTYTRADE_CLIENT_SECRET", "TASTYTRADE_REFRESH_TOKEN"];
}

export function isTastytradeConfigured(env: ProviderEnv): boolean {
  return (
    Boolean(env.TASTYTRADE_CLIENT_SECRET) &&
    Boolean(env.TASTYTRADE_REFRESH_TOKEN)
  );
}

function assertConfigured(env: ProviderEnv): void {
  if (!isTastytradeConfigured(env)) throw new Error(NOT_CONFIGURED_MESSAGE);
}

// ---------------------------------------------------------------------------
// OAuth session (proactive refresh, rotation adoption)
// ---------------------------------------------------------------------------

export interface TastytradeSession {
  accessToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  refreshToken: string;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Proactive-refresh check (amuse `get_access_token` semantics, testable):
 * true when `now` is within the refresh margin of (or past) expiry.
 * Callers refresh BEFORE expiry — never a 401 retry.
 */
export function needsRefresh(expiresAt: number, now: number = nowSecs()): boolean {
  return now >= expiresAt - TASTYTRADE_REFRESH_MARGIN_SECS;
}

async function readTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Exchange the refresh grant for a short-lived access token.
 * POST {AUTH_HOST}/oauth/token, x-www-form-urlencoded
 * {grant_type: "refresh_token", refresh_token, client_secret}.
 * Adopts a server-rotated refresh_token. Failures raise
 * `tastytrade auth failed: HTTP {code}` with the server body truncated to
 * 300 chars — never including secrets.
 */
export async function refreshAccessToken(
  env: ProviderEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TastytradeSession> {
  const grantValue = env.TASTYTRADE_REFRESH_TOKEN;
  if (!env.TASTYTRADE_CLIENT_SECRET || !grantValue) {
    throw new Error(
      "tastytrade auth failed: TASTYTRADE_CLIENT_SECRET and " +
        "TASTYTRADE_REFRESH_TOKEN must both be set",
    );
  }
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", grantValue);
  form.set("client_secret", env.TASTYTRADE_CLIENT_SECRET);

  let res: Response;
  try {
    res = await fetchImpl(`${TASTYTRADE_AUTH_HOST}/oauth/token`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    throw new Error(
      `tastytrade auth failed: network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    const bodyText = await readTextSafe(res);
    const suffix = bodyText ? `: ${bodyText.slice(0, 300)}` : "";
    throw new Error(`tastytrade auth failed: HTTP ${res.status}${suffix}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const access = data["access_token"];
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("tastytrade auth failed: token response missing access_token");
  }
  const expiresInRaw = Number(data["expires_in"]);
  const expiresIn =
    Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? Math.floor(expiresInRaw)
      : DEFAULT_EXPIRES_IN_SECS;
  const rotated = data["refresh_token"];
  return {
    accessToken: access,
    expiresAt: nowSecs() + expiresIn,
    refreshToken:
      typeof rotated === "string" && rotated.length > 0 ? rotated : grantValue,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (every request carries the mandatory User-Agent)
// ---------------------------------------------------------------------------

function apiHeaders(access: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Authorization": `Bearer ${access}`,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function apiError(verb: string, path: string, status: number, bodyText: string): Error {
  const suffix = bodyText ? `: ${bodyText.slice(0, 300)}` : "";
  return new Error(`tastytrade API ${verb} ${path} failed: HTTP ${status}${suffix}`);
}

async function apiGet(
  host: string,
  path: string,
  access: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${host}${path}`, {
    method: "GET",
    headers: apiHeaders(access, false),
  });
  if (!res.ok) throw apiError("GET", path, res.status, await readTextSafe(res));
  return (await res.json()) as Record<string, unknown>;
}

async function apiPost(
  host: string,
  path: string,
  access: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: apiHeaders(access, true),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw apiError("POST", path, res.status, await readTextSafe(res));
  const text = await readTextSafe(res);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Payload builder (port of amuse build_backtest)
// ---------------------------------------------------------------------------

function toApiLeg(leg: BacktestLeg): Record<string, unknown> {
  return {
    type: "equity-option",
    side: leg.side,
    direction: leg.direction,
    quantity: leg.quantity,
    strikeSelection: "delta",
    delta: leg.delta,
    daysUntilExpiration: leg.daysUntilExpiration,
  };
}

/**
 * Build the POST /backtests payload for one window (default: the first).
 * Shape matches amuse `build_backtest` exactly; key order is pinned by test.
 *
 * NOTE: exit_dte is NOT emitted — amuse accepted it but never put it in the
 * payload. Exit-by-DTE is a forward-lane concern.
 */
export function buildBacktestPayload(req: BacktestRequest, windowIndex = 0): unknown {
  const window = req.windows[windowIndex];
  if (!window) {
    throw new Error(
      `tastytrade buildBacktestPayload: window index ${windowIndex} out of range`,
    );
  }
  const exitConditions: Record<string, number> = {
    takeProfitPercentage: Math.round(req.profitTargetPct),
  };
  if (req.stopLossPct !== undefined && req.stopLossPct !== null) {
    exitConditions["stopLossPercentage"] = Math.round(req.stopLossPct);
  }
  return {
    symbol: req.symbol,
    startDate: window.start,
    endDate: window.end,
    legs: req.legs.map(toApiLeg),
    entryConditions: { frequency: "every day" },
    exitConditions,
  };
}

// ---------------------------------------------------------------------------
// Submit (one backtest per window)
// ---------------------------------------------------------------------------

function handleFromResponse(data: Record<string, unknown>): string {
  const id = data["backtestId"] ?? data["id"];
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error(
      `tastytrade submitBacktest: no backtest ID in response: ${JSON.stringify(
        data,
      ).slice(0, 300)}`,
    );
  }
  return String(id);
}

/**
 * Submit one backtest per window; returns every handle. This is the
 * variant the evidence workflow calls.
 */
export async function submitBacktestWindows(
  env: ProviderEnv,
  req: BacktestRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BacktestHandle[]> {
  const session = await refreshAccessToken(env, fetchImpl);
  const handles: BacktestHandle[] = [];
  for (let i = 0; i < req.windows.length; i++) {
    const payload = buildBacktestPayload(req, i);
    const data = await apiPost(
      TASTYTRADE_BACKTEST_HOST,
      "/backtests",
      session.accessToken,
      payload,
      fetchImpl,
    );
    handles.push({
      runId: handleFromResponse(data),
      providerId: TASTYTRADE_PROVIDER_ID,
    });
  }
  return handles;
}

/**
 * Interface-shaped submit: submits ALL windows, returns the FIRST handle.
 * (Submitting only the first window would silently drop coverage.)
 */
export async function submitBacktest(
  env: ProviderEnv,
  req: BacktestRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BacktestHandle> {
  const handles = await submitBacktestWindows(env, req, fetchImpl);
  const first = handles[0];
  if (!first) throw new Error("tastytrade submitBacktest: no windows in request");
  return first;
}

// ---------------------------------------------------------------------------
// Status + trial normalization (port of amuse summarize_results)
// ---------------------------------------------------------------------------

export type TastytradeRunState = "pending" | "running" | "complete" | "failed";

export interface TastytradeBacktestStatus {
  runId: string;
  state: TastytradeRunState;
  results: BacktestWindowResult[];
  notices: string[];
  error?: string;
}

const COMPLETE_STATES = new Set(["completed", "complete", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "error", "cancelled"]);
const PENDING_STATES = new Set(["pending", "queued", "submitted", "created", ""]);

/** Map the raw backtester status string to the lane state. */
export function mapBacktestState(raw: string): TastytradeRunState {
  const s = raw.toLowerCase();
  if (COMPLETE_STATES.has(s)) return "complete";
  if (FAILED_STATES.has(s)) return "failed";
  if (PENDING_STATES.has(s)) return "pending";
  return "running";
}

/**
 * Per-trial P&L (amuse `_pnl` fallback chain): `totals.profitLoss` first,
 * then trial-level `profitLoss`, then `pnl`; non-numeric → 0.
 */
export function trialPnl(trial: unknown): number {
  if (typeof trial !== "object" || trial === null) return 0;
  const t = trial as Record<string, unknown>;
  let raw: unknown;
  const totals = t["totals"];
  if (typeof totals === "object" && totals !== null) {
    raw = (totals as Record<string, unknown>)["profitLoss"];
  }
  if (raw === undefined || raw === null) raw = t["profitLoss"];
  if (raw === undefined || raw === null) raw = t["pnl"];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function finiteNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Port of amuse `summarize_results`: trade counts, win rate, P&L, plus
 * server-computed statistics when present. 0-trade results are VALID
 * (tradeCount 0; notices explain why).
 */
export function summarizeTrials(
  trials: unknown[],
  start: string,
  end: string,
  notices: string[],
  statistics?: unknown,
): BacktestWindowResult {
  const pnls = trials.map(trialPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const tradeCount = pnls.length;
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const result: BacktestWindowResult = {
    start,
    end,
    tradeCount,
    winRate: tradeCount > 0 ? wins.length / tradeCount : 0,
    netPnl: sum(pnls),
    avgWin: wins.length > 0 ? sum(wins) / wins.length : 0,
    avgLoss: losses.length > 0 ? sum(losses) / losses.length : 0,
    notices: [...notices],
  };
  const stats =
    typeof statistics === "object" && statistics !== null
      ? (statistics as Record<string, unknown>)
      : {};
  const profitFactor = finiteNumber(stats["profitFactor"]);
  const maxDrawdown = finiteNumber(stats["maxDrawdown"]);
  const sharpeRatio = finiteNumber(stats["sharpeRatio"]);
  if (profitFactor !== undefined) result.profitFactor = profitFactor;
  if (maxDrawdown !== undefined) result.maxDrawdown = maxDrawdown;
  if (sharpeRatio !== undefined) result.sharpeRatio = sharpeRatio;
  return result;
}

function statisticsOf(body: Record<string, unknown>): unknown {
  if (body["statistics"] !== undefined) return body["statistics"];
  const results = body["results"];
  if (typeof results === "object" && results !== null) {
    return (results as Record<string, unknown>)["statistics"];
  }
  return undefined;
}

/**
 * GET /backtests/{id}; on terminal-complete also GET /backtests/{id}/logs
 * (trials live in logs, not in the status response) and normalize.
 * Returns `{ state, results, notices, error? }` — assignable to the
 * `BacktestProvider.getBacktestStatus` contract.
 */
export async function getBacktestStatus(
  env: ProviderEnv,
  runId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TastytradeBacktestStatus> {
  const session = await refreshAccessToken(env, fetchImpl);
  const encoded = encodeURIComponent(runId);
  const body = await apiGet(
    TASTYTRADE_BACKTEST_HOST,
    `/backtests/${encoded}`,
    session.accessToken,
    fetchImpl,
  );
  const rawState = typeof body["status"] === "string" ? body["status"] : "";
  const state = mapBacktestState(rawState);
  const notices = Array.isArray(body["notices"])
    ? body["notices"].map((n) => String(n))
    : [];
  if (state === "failed") {
    return {
      runId,
      state,
      results: [],
      notices,
      error: `tastytrade backtest ${runId} ${rawState || "failed"}`,
    };
  }
  if (state !== "complete") {
    return { runId, state, results: [], notices };
  }
  let trials: unknown[] = [];
  try {
    const logs = await apiGet(
      TASTYTRADE_BACKTEST_HOST,
      `/backtests/${encoded}/logs`,
      session.accessToken,
      fetchImpl,
    );
    trials = Array.isArray(logs["trials"]) ? (logs["trials"] as unknown[]) : [];
  } catch (err) {
    notices.push(
      `trial logs unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const start = typeof body["startDate"] === "string" ? body["startDate"] : "";
  const end = typeof body["endDate"] === "string" ? body["endDate"] : "";
  const window = summarizeTrials(trials, start, end, notices, statisticsOf(body));
  return { runId, state, results: [window], notices: [...notices] };
}

// ---------------------------------------------------------------------------
// Strategies (port of amuse _strategy_legs) + standard windows
// ---------------------------------------------------------------------------

export type TastytradeStrategy = "bull_put" | "bear_call" | "iron_condor" | "single_put";

const ENTRY_DTE = 45;
const SHORT_DELTA = 16;
const LONG_DELTA = 10;

function optionLeg(
  side: "put" | "call",
  direction: "short" | "long",
  delta: number,
): BacktestLeg {
  return {
    side,
    direction,
    strikeSelection: "delta",
    delta,
    daysUntilExpiration: ENTRY_DTE,
    quantity: 1,
  };
}

/**
 * Strategy → legs. bull_put = 16Δ short put + 10Δ long put (45 DTE);
 * bear_call mirrored; iron_condor = both; single_put = 16Δ short put
 * (diagnostic). All quantity 1 — sizing happens outside the backtester.
 */
export function strategyLegs(strategy: TastytradeStrategy): BacktestLeg[] {
  switch (strategy) {
    case "single_put":
      return [optionLeg("put", "short", SHORT_DELTA)];
    case "bull_put":
      return [
        optionLeg("put", "short", SHORT_DELTA),
        optionLeg("put", "long", LONG_DELTA),
      ];
    case "bear_call":
      return [
        optionLeg("call", "short", SHORT_DELTA),
        optionLeg("call", "long", LONG_DELTA),
      ];
    case "iron_condor":
      return [
        optionLeg("put", "short", SHORT_DELTA),
        optionLeg("put", "long", LONG_DELTA),
        optionLeg("call", "short", SHORT_DELTA),
        optionLeg("call", "long", LONG_DELTA),
      ];
    default:
      throw new Error(`tastytrade strategyLegs: unknown strategy '${String(strategy)}'`);
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Standard harness windows: trailing 1y, trailing 3y, full
 * (2022-01-01 → today). ISO dates, always reported on dossiers.
 */
export function standardWindows(): BacktestWindow[] {
  const today = new Date();
  const end = isoDay(today);
  const trailing = (years: number): string => {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return isoDay(d);
  };
  return [
    { start: trailing(1), end },
    { start: trailing(3), end },
    { start: "2022-01-01", end },
  ];
}

// ---------------------------------------------------------------------------
// Provider factory (implements ../providers BacktestProvider)
// ---------------------------------------------------------------------------

function providerCapabilities(): ProviderCapabilities {
  return {
    multiLeg: true,
    maxLegs: 4,
    assetClasses: ["equity-option"],
    paperOnly: false,
    honestLimits: [
      "backtest fills are historical simulations, not live executions",
      "paper: n/a — historical",
    ],
  };
}

export function createTastytradeBacktestProvider(
  fetchImpl: typeof fetch = globalThis.fetch,
): BacktestProvider {
  return {
    providerId: TASTYTRADE_PROVIDER_ID,
    kind: "backtest",
    capabilities() {
      return providerCapabilities();
    },
    requiredEnv() {
      return tastytradeRequiredEnv();
    },
    isConfigured(env: ProviderEnv) {
      return isTastytradeConfigured(env);
    },
    async submitBacktest(
      env: ProviderEnv,
      req: BacktestRequest,
      impl: typeof fetch = fetchImpl,
    ): Promise<BacktestHandle> {
      assertConfigured(env);
      return submitBacktest(env, req, impl);
    },
    async submitBacktestWindows(
      env: ProviderEnv,
      req: BacktestRequest,
      impl: typeof fetch = fetchImpl,
    ): Promise<BacktestHandle[]> {
      assertConfigured(env);
      return submitBacktestWindows(env, req, impl);
    },
    async getBacktestStatus(
      env: ProviderEnv,
      runId: string,
      impl: typeof fetch = fetchImpl,
    ) {
      assertConfigured(env);
      return getBacktestStatus(env, runId, impl);
    },
  };
}
