/**
 * Tests for src/test-harness/tastytrade-backtest.ts (cfpay #245, worker 2).
 *
 * Stub-fetch only — no live network. Pins the amuse port contract:
 * OAuth refresh request shape + proactive-refresh margin + rotation,
 * buildBacktestPayload byte-shape, strategy legs, status mapping, trial
 * normalization (totals.profitLoss fallback chain, 0-trade validity),
 * NOT_CONFIGURED honesty, and the secrets-never-in-errors discipline.
 */
import { describe, expect, it } from "vitest";
import {
  TASTYTRADE_AUTH_HOST,
  TASTYTRADE_BACKTEST_HOST,
  TASTYTRADE_PROVIDER_ID,
  buildBacktestPayload,
  createTastytradeBacktestProvider,
  getBacktestStatus,
  isTastytradeConfigured,
  mapBacktestState,
  needsRefresh,
  refreshAccessToken,
  standardWindows,
  strategyLegs,
  submitBacktest,
  submitBacktestWindows,
  summarizeTrials,
  tastytradeRequiredEnv,
  trialPnl,
} from "../../src/test-harness/tastytrade-backtest";

// ---------------------------------------------------------------------------
// Stub fetch plumbing
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>;

function makeStubFetch(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const req = { url: String(url), init };
    requests.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("no json body");
    },
    text: async () => text,
  } as unknown as Response;
}

function header(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k] ?? null;
  }
  return null;
}

// Obviously-fake fixture values (never secret-shaped).
const FAKE_CLIENT = "cs-test-client-value";
const FAKE_REFRESH = "rt-test-refresh-value";
const FAKE_ACCESS = "at-test-access-value";
const ENV = {
  TASTYTRADE_CLIENT_SECRET: FAKE_CLIENT,
  TASTYTRADE_REFRESH_TOKEN: FAKE_REFRESH,
};

function tokenResponse(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ access_token: FAKE_ACCESS, expires_in: 900, ...extra });
}

function formParams(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

describe("tastytrade constants and config", () => {
  it("exports the pinned hosts and provider id", () => {
    expect(TASTYTRADE_AUTH_HOST).toBe("https://api.tastyworks.com");
    expect(TASTYTRADE_BACKTEST_HOST).toBe("https://backtester.vast.tastyworks.com");
    expect(TASTYTRADE_PROVIDER_ID).toBe("tastytrade-backtest");
  });

  it("tastytradeRequiredEnv names both OAuth secrets", () => {
    expect(tastytradeRequiredEnv()).toEqual([
      "TASTYTRADE_CLIENT_SECRET",
      "TASTYTRADE_REFRESH_TOKEN",
    ]);
  });

  it("isTastytradeConfigured requires both values non-empty", () => {
    expect(isTastytradeConfigured({})).toBe(false);
    expect(isTastytradeConfigured({ TASTYTRADE_CLIENT_SECRET: "x" })).toBe(false);
    expect(isTastytradeConfigured({ TASTYTRADE_REFRESH_TOKEN: "y" })).toBe(false);
    expect(
      isTastytradeConfigured({ TASTYTRADE_CLIENT_SECRET: "", TASTYTRADE_REFRESH_TOKEN: "" }),
    ).toBe(false);
    expect(isTastytradeConfigured(ENV)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("POSTs the form-encoded refresh grant with the mandatory User-Agent", async () => {
    const { fetchImpl, requests } = makeStubFetch(() => tokenResponse());
    const session = await refreshAccessToken(ENV, fetchImpl);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://api.tastyworks.com/oauth/token");
    expect(req.init?.method).toBe("POST");
    expect(header(req.init, "User-Agent")).toBe("cfpay-test-harness/1.0");
    expect(header(req.init, "Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const params = formParams(req.init);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe(FAKE_REFRESH);
    expect(params.get("client_secret")).toBe(FAKE_CLIENT);

    expect(session.accessToken).toBe(FAKE_ACCESS);
    const now = Date.now() / 1000;
    expect(session.expiresAt).toBeGreaterThan(now + 890);
    expect(session.expiresAt).toBeLessThanOrEqual(now + 900);
    expect(session.refreshToken).toBe(FAKE_REFRESH);
  });

  it("adopts a server-rotated refresh token", async () => {
    const { fetchImpl } = makeStubFetch(() =>
      tokenResponse({ refresh_token: "rt-rotated-new-value" }),
    );
    const session = await refreshAccessToken(ENV, fetchImpl);
    expect(session.refreshToken).toBe("rt-rotated-new-value");
  });

  it("defaults expires_in to 900 when the response omits it", async () => {
    const { fetchImpl } = makeStubFetch(() =>
      jsonResponse({ access_token: FAKE_ACCESS }),
    );
    const session = await refreshAccessToken(ENV, fetchImpl);
    const now = Date.now() / 1000;
    expect(session.expiresAt).toBeGreaterThan(now + 890);
    expect(session.expiresAt).toBeLessThanOrEqual(now + 900);
  });

  it("raises tastytrade auth failed with truncated body, never secrets", async () => {
    const tail = "TAILMARKER";
    const serverBody = "x".repeat(300) + tail + "y".repeat(100);
    const { fetchImpl } = makeStubFetch(() => errorResponse(401, serverBody));
    const err = await refreshAccessToken(ENV, fetchImpl).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("tastytrade auth failed: HTTP 401");
    expect(err.message).toContain("x".repeat(300));
    expect(err.message).not.toContain(tail); // body truncated at 300 chars
    expect(err.message).not.toContain(FAKE_CLIENT);
    expect(err.message).not.toContain(FAKE_REFRESH);
  });

  it("rejects when env is missing", async () => {
    const { fetchImpl, requests } = makeStubFetch(() => tokenResponse());
    await expect(refreshAccessToken({}, fetchImpl)).rejects.toThrow(
      /TASTYTRADE_CLIENT_SECRET/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("needsRefresh (proactive, never a 401 retry)", () => {
  it("applies the 60s margin", () => {
    // expiresAt=1000, margin boundary at now=940
    expect(needsRefresh(1000, 939)).toBe(false);
    expect(needsRefresh(1000, 940)).toBe(true);
    expect(needsRefresh(1000, 2000)).toBe(true);
    expect(needsRefresh(1000, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Payload builder byte-shape (amuse build_backtest port)
// ---------------------------------------------------------------------------

function singleLegRequest() {
  return {
    recommendationId: "rec-1",
    strategy: "bull_put",
    symbol: "SPY",
    legs: [
      {
        side: "put" as const,
        direction: "short" as const,
        strikeSelection: "delta" as const,
        delta: 16,
        daysUntilExpiration: 45,
        quantity: 1,
      },
    ],
    windows: [{ start: "2022-01-01", end: "2026-10-01" }],
    profitTargetPct: 50,
    stopLossPct: 200,
  };
}

describe("buildBacktestPayload", () => {
  it("matches the §1 example byte-for-byte", () => {
    const payload = buildBacktestPayload(singleLegRequest());
    expect(JSON.stringify(payload)).toBe(
      '{"symbol":"SPY","startDate":"2022-01-01","endDate":"2026-10-01",' +
        '"legs":[{"type":"equity-option","side":"put","direction":"short",' +
        '"quantity":1,"strikeSelection":"delta","delta":16,' +
        '"daysUntilExpiration":45}],' +
        '"entryConditions":{"frequency":"every day"},' +
        '"exitConditions":{"takeProfitPercentage":50,"stopLossPercentage":200}}',
    );
  });

  it("omits stopLossPercentage when not provided", () => {
    const req = { ...singleLegRequest(), stopLossPct: undefined };
    const payload = buildBacktestPayload(req) as Record<string, unknown>;
    expect(payload["exitConditions"]).toEqual({ takeProfitPercentage: 50 });
  });

  it("builds the payload for the requested window index", () => {
    const req = {
      ...singleLegRequest(),
      windows: [
        { start: "2024-01-01", end: "2025-01-01" },
        { start: "2025-01-01", end: "2026-01-01" },
      ],
    };
    const payload = buildBacktestPayload(req, 1) as Record<string, unknown>;
    expect(payload["startDate"]).toBe("2025-01-01");
    expect(payload["endDate"]).toBe("2026-01-01");
  });

  it("throws on an out-of-range window index", () => {
    expect(() => buildBacktestPayload(singleLegRequest(), 3)).toThrow(
      /window index 3 out of range/,
    );
  });
});

// ---------------------------------------------------------------------------
// Strategies + windows
// ---------------------------------------------------------------------------

describe("strategyLegs", () => {
  it("bull_put = 16d short put + 10d long put at 45 DTE", () => {
    expect(strategyLegs("bull_put")).toEqual([
      {
        side: "put",
        direction: "short",
        strikeSelection: "delta",
        delta: 16,
        daysUntilExpiration: 45,
        quantity: 1,
      },
      {
        side: "put",
        direction: "long",
        strikeSelection: "delta",
        delta: 10,
        daysUntilExpiration: 45,
        quantity: 1,
      },
    ]);
  });

  it("bear_call mirrors bull_put on the call side", () => {
    expect(strategyLegs("bear_call")).toEqual([
      {
        side: "call",
        direction: "short",
        strikeSelection: "delta",
        delta: 16,
        daysUntilExpiration: 45,
        quantity: 1,
      },
      {
        side: "call",
        direction: "long",
        strikeSelection: "delta",
        delta: 10,
        daysUntilExpiration: 45,
        quantity: 1,
      },
    ]);
  });

  it("iron_condor = bull_put + bear_call (4 legs)", () => {
    const legs = strategyLegs("iron_condor");
    expect(legs).toHaveLength(4);
    expect(legs.map((l) => `${l.side}/${l.direction}/${l.delta}`)).toEqual([
      "put/short/16",
      "put/long/10",
      "call/short/16",
      "call/long/10",
    ]);
  });

  it("single_put = one 16d short put", () => {
    expect(strategyLegs("single_put")).toHaveLength(1);
    expect(strategyLegs("single_put")[0]).toMatchObject({
      side: "put",
      direction: "short",
      delta: 16,
    });
  });

  it("throws on an unknown strategy", () => {
    expect(() =>
      strategyLegs("butterfly" as unknown as "bull_put"),
    ).toThrow(/unknown strategy 'butterfly'/);
  });
});

describe("standardWindows", () => {
  it("returns trailing 1y, trailing 3y, and full windows with ISO dates", () => {
    const windows = standardWindows();
    expect(windows).toHaveLength(3);
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    for (const w of windows) {
      expect(w.start).toMatch(iso);
      expect(w.end).toMatch(iso);
      expect(w.start < w.end).toBe(true);
    }
    expect(windows[2]!.start).toBe("2022-01-01");
    // trailing 1y window is shorter than trailing 3y
    expect(windows[0]!.start > windows[1]!.start).toBe(true);
    // all windows end today
    const today = new Date().toISOString().slice(0, 10);
    expect(windows[0]!.end).toBe(today);
  });
});

// ---------------------------------------------------------------------------
// Status mapping + trial normalization
// ---------------------------------------------------------------------------

describe("mapBacktestState", () => {
  it("maps terminal states", () => {
    for (const s of ["completed", "complete", "done", "finished", "COMPLETED"]) {
      expect(mapBacktestState(s)).toBe("complete");
    }
  });
  it("maps failure states", () => {
    for (const s of ["failed", "error", "cancelled"]) {
      expect(mapBacktestState(s)).toBe("failed");
    }
  });
  it("maps pending and in-progress states", () => {
    expect(mapBacktestState("pending")).toBe("pending");
    expect(mapBacktestState("")).toBe("pending");
    expect(mapBacktestState("running")).toBe("running");
    expect(mapBacktestState("in_progress")).toBe("running");
  });
});

describe("trialPnl", () => {
  it("follows the totals.profitLoss fallback chain", () => {
    expect(trialPnl({ totals: { profitLoss: 123.5 } })).toBe(123.5);
    expect(trialPnl({ profitLoss: 42 })).toBe(42);
    expect(trialPnl({ pnl: -7 })).toBe(-7);
    // totals.profitLoss wins over trial-level keys
    expect(trialPnl({ totals: { profitLoss: 10 }, profitLoss: 99, pnl: 98 })).toBe(10);
  });
  it("returns 0 for missing or non-numeric values", () => {
    expect(trialPnl({})).toBe(0);
    expect(trialPnl(null)).toBe(0);
    expect(trialPnl({ totals: { profitLoss: "n/a" } })).toBe(0);
  });
});

describe("summarizeTrials", () => {
  it("computes counts, win rate, and averages", () => {
    const r = summarizeTrials(
      [
        { totals: { profitLoss: 100 } },
        { totals: { profitLoss: -40 } },
        { profitLoss: 25 },
        { pnl: -10 },
        {},
      ],
      "2024-01-01",
      "2025-01-01",
      ["n1"],
    );
    expect(r.tradeCount).toBe(5);
    expect(r.winRate).toBeCloseTo(0.4, 10);
    expect(r.netPnl).toBeCloseTo(75, 10);
    expect(r.avgWin).toBeCloseTo(62.5, 10);
    expect(r.avgLoss).toBeCloseTo(-50 / 3, 10);
    expect(r.notices).toEqual(["n1"]);
    expect(r.profitFactor).toBeUndefined();
  });

  it("merges server statistics when present", () => {
    const r = summarizeTrials([], "2024-01-01", "2025-01-01", [], {
      profitFactor: 1.8,
      maxDrawdown: -120,
      sharpeRatio: 1.1,
    });
    expect(r.profitFactor).toBe(1.8);
    expect(r.maxDrawdown).toBe(-120);
    expect(r.sharpeRatio).toBe(1.1);
  });

  it("treats 0-trade results as valid", () => {
    const r = summarizeTrials([], "2024-01-01", "2025-01-01", [
      "No trades matched the entry conditions",
    ]);
    expect(r.tradeCount).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.netPnl).toBe(0);
    expect(r.avgWin).toBe(0);
    expect(r.avgLoss).toBe(0);
    expect(r.notices).toEqual(["No trades matched the entry conditions"]);
  });
});

// ---------------------------------------------------------------------------
// getBacktestStatus (stubbed status + logs)
// ---------------------------------------------------------------------------

function statusRouter(statusBody: unknown, trials: unknown[]) {
  return makeStubFetch((req) => {
    if (req.url.endsWith("/oauth/token")) return tokenResponse();
    if (req.url.includes("/backtests/bt-1/logs")) {
      return jsonResponse({ snapshots: [], trials });
    }
    if (req.url.includes("/backtests/bt-1")) {
      return jsonResponse(statusBody);
    }
    throw new Error(`unexpected request: ${req.url}`);
  });
}

describe("getBacktestStatus", () => {
  it("on complete: fetches logs, normalizes trials, sends Bearer + User-Agent", async () => {
    const { fetchImpl, requests } = statusRouter(
      {
        id: "bt-1",
        status: "completed",
        symbol: "SPY",
        startDate: "2024-01-01",
        endDate: "2025-01-01",
        notices: ["Partial coverage for QQQ"],
        statistics: { profitFactor: 1.8, maxDrawdown: -120, sharpeRatio: 1.1 },
      },
      [
        { totals: { profitLoss: 100 } },
        { totals: { profitLoss: -40 } },
        { profitLoss: 25 },
      ],
    );
    const status = await getBacktestStatus(ENV, "bt-1", fetchImpl);

    expect(status.state).toBe("complete");
    expect(status.runId).toBe("bt-1");
    expect(status.error).toBeUndefined();
    expect(status.results).toHaveLength(1);
    const w = status.results[0]!;
    expect(w.start).toBe("2024-01-01");
    expect(w.end).toBe("2025-01-01");
    expect(w.tradeCount).toBe(3);
    expect(w.winRate).toBeCloseTo(2 / 3, 10);
    expect(w.netPnl).toBeCloseTo(85, 10);
    expect(w.profitFactor).toBe(1.8);
    expect(w.maxDrawdown).toBe(-120);
    expect(w.sharpeRatio).toBe(1.1);
    expect(w.notices).toEqual(["Partial coverage for QQQ"]);

    // request shapes: token POST, status GET, logs GET — all with headers
    expect(requests).toHaveLength(3);
    const getStatus = requests[1]!;
    expect(getStatus.url).toBe("https://backtester.vast.tastyworks.com/backtests/bt-1");
    expect(getStatus.init?.method).toBe("GET");
    const getLogs = requests[2]!;
    expect(getLogs.url).toBe(
      "https://backtester.vast.tastyworks.com/backtests/bt-1/logs",
    );
    for (const r of requests.slice(1)) {
      expect(header(r.init, "User-Agent")).toBe("cfpay-test-harness/1.0");
      expect(header(r.init, "Authorization")).toBe(`Bearer ${FAKE_ACCESS}`);
    }
  });

  it("maps running and pending without touching logs", async () => {
    for (const raw of ["running", "pending"]) {
      const { fetchImpl, requests } = statusRouter({ id: "bt-1", status: raw }, []);
      const status = await getBacktestStatus(ENV, "bt-1", fetchImpl);
      expect(status.state).toBe(raw);
      expect(status.results).toEqual([]);
      expect(requests).toHaveLength(2); // token + status only
    }
  });

  it("maps failed with an error naming the run", async () => {
    const { fetchImpl } = statusRouter({ id: "bt-1", status: "failed" }, []);
    const status = await getBacktestStatus(ENV, "bt-1", fetchImpl);
    expect(status.state).toBe("failed");
    expect(status.results).toEqual([]);
    expect(status.error).toContain("bt-1");
  });

  it("keeps a 0-trade complete result valid with notices surfaced", async () => {
    const { fetchImpl } = statusRouter(
      {
        id: "bt-1",
        status: "complete",
        startDate: "2024-01-01",
        endDate: "2025-01-01",
        notices: ["No trades matched the entry conditions"],
      },
      [],
    );
    const status = await getBacktestStatus(ENV, "bt-1", fetchImpl);
    expect(status.state).toBe("complete");
    const w = status.results[0]!;
    expect(w.tradeCount).toBe(0);
    expect(w.winRate).toBe(0);
    expect(w.notices).toEqual(["No trades matched the entry conditions"]);
  });

  it("records a notice (not a throw) when logs are unavailable", async () => {
    const stub = makeStubFetch((req) => {
      if (req.url.endsWith("/oauth/token")) return tokenResponse();
      if (req.url.includes("/logs")) return errorResponse(500, "log store down");
      return jsonResponse({ id: "bt-1", status: "complete" });
    });
    const status = await getBacktestStatus(ENV, "bt-1", stub.fetchImpl);
    expect(status.state).toBe("complete");
    expect(
      status.notices.some((n) => n.includes("trial logs unavailable")),
    ).toBe(true);
    expect(status.results[0]!.tradeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

describe("submitBacktestWindows", () => {
  it("POSTs one payload per window and returns every handle", async () => {
    const { fetchImpl, requests } = makeStubFetch((req) => {
      if (req.url.endsWith("/oauth/token")) return tokenResponse();
      if (req.url.endsWith("/backtests") && req.init?.method === "POST") {
        const payload = JSON.parse(String(req.init.body)) as Record<string, unknown>;
        return jsonResponse({ backtestId: `bt-${payload["startDate"]}` });
      }
      throw new Error(`unexpected request: ${req.url}`);
    });
    const req = {
      ...singleLegRequest(),
      windows: [
        { start: "2024-01-01", end: "2025-01-01" },
        { start: "2025-01-01", end: "2026-01-01" },
      ],
    };
    const handles = await submitBacktestWindows(ENV, req, fetchImpl);

    expect(handles).toHaveLength(2);
    expect(handles[0]).toEqual({
      runId: "bt-2024-01-01",
      providerId: "tastytrade-backtest",
    });
    expect(handles[1]).toEqual({
      runId: "bt-2025-01-01",
      providerId: "tastytrade-backtest",
    });

    const posts = requests.filter((r) => r.url.endsWith("/backtests"));
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(header(p.init, "User-Agent")).toBe("cfpay-test-harness/1.0");
      expect(header(p.init, "Content-Type")).toBe("application/json");
      expect(header(p.init, "Authorization")).toBe(`Bearer ${FAKE_ACCESS}`);
    }
    const firstPayload = JSON.parse(String(posts[0]!.init?.body));
    expect(firstPayload["startDate"]).toBe("2024-01-01");
  });

  it("accepts the id fallback when backtestId is absent", async () => {
    const { fetchImpl } = makeStubFetch((req) => {
      if (req.url.endsWith("/oauth/token")) return tokenResponse();
      return jsonResponse({ id: "abc-123" });
    });
    const handles = await submitBacktestWindows(ENV, singleLegRequest(), fetchImpl);
    expect(handles[0]!.runId).toBe("abc-123");
  });
});

describe("submitBacktest", () => {
  it("submits all windows and returns the first handle", async () => {
    const { fetchImpl } = makeStubFetch((req) => {
      if (req.url.endsWith("/oauth/token")) return tokenResponse();
      const payload = JSON.parse(String(req.init?.body)) as Record<string, unknown>;
      return jsonResponse({ backtestId: `bt-${payload["startDate"]}` });
    });
    const req = {
      ...singleLegRequest(),
      windows: [
        { start: "2024-01-01", end: "2025-01-01" },
        { start: "2025-01-01", end: "2026-01-01" },
      ],
    };
    const handle = await submitBacktest(ENV, req, fetchImpl);
    expect(handle).toEqual({
      runId: "bt-2024-01-01",
      providerId: "tastytrade-backtest",
    });
  });
});

// ---------------------------------------------------------------------------
// Provider factory + NOT_CONFIGURED honesty
// ---------------------------------------------------------------------------

describe("createTastytradeBacktestProvider", () => {
  it("exposes the interface identity and capabilities", () => {
    const provider = createTastytradeBacktestProvider();
    expect(provider.providerId).toBe("tastytrade-backtest");
    expect(provider.kind).toBe("backtest");
    expect(provider.capabilities()).toEqual({
      multiLeg: true,
      maxLegs: 4,
      assetClasses: ["equity-option"],
      paperOnly: false,
      honestLimits: [
        "backtest fills are historical simulations, not live executions",
        "paper: n/a — historical",
      ],
    });
    expect(provider.requiredEnv()).toEqual([
      "TASTYTRADE_CLIENT_SECRET",
      "TASTYTRADE_REFRESH_TOKEN",
    ]);
    expect(provider.isConfigured(ENV)).toBe(true);
    expect(provider.isConfigured({})).toBe(false);
  });

  it("fails loudly with NOT_CONFIGURED when env is missing", async () => {
    const stub = makeStubFetch(() => tokenResponse());
    const provider = createTastytradeBacktestProvider(stub.fetchImpl);
    await expect(
      provider.submitBacktest({}, singleLegRequest(), stub.fetchImpl),
    ).rejects.toThrow(
      "tastytrade-backtest: NOT_CONFIGURED — set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN",
    );
    await expect(
      provider.getBacktestStatus({}, "bt-1", stub.fetchImpl),
    ).rejects.toThrow(/NOT_CONFIGURED/);
    // nothing was sent: loud failure happens before any HTTP
    expect(stub.requests).toHaveLength(0);
  });

  it("delegates to the standalone functions when configured", async () => {
    const stub = makeStubFetch((req) => {
      if (req.url.endsWith("/oauth/token")) return tokenResponse();
      return jsonResponse({ backtestId: "bt-9" });
    });
    const provider = createTastytradeBacktestProvider(stub.fetchImpl);
    const handle = await provider.submitBacktest(ENV, singleLegRequest());
    expect(handle).toEqual({ runId: "bt-9", providerId: "tastytrade-backtest" });
  });
});
