/**
 * Tests for src/test-harness/lanes.ts and src/evidence-store.ts.
 *
 * All HTTP is stubbed — no live network. Covers: plugin swap through the
 * registry, lane isolation (one lane throws, the other completes), the
 * paper-only guard (no network call on a live URL), NOT_CONFIGURED
 * honesty (no fetch when unconfigured), exit evaluation, the goal-text
 * contract, and the evidence store round trip.
 */
import { describe, it, expect } from "vitest";
import {
  runTestLanes,
  submitBacktestLane,
  submitForwardLane,
  advanceForwardLane,
  evaluateForwardExit,
  evidenceGoalText,
  evidenceFollowUpGoalId,
  laneProvenance,
  EVIDENCE_FOLLOWUP_DELAY_SECONDS,
} from "../../src/test-harness/lanes";
import {
  ProviderRegistry,
  resolveProvider,
  registerDefaultProviders,
  BACKTEST_PROVIDER_FALLBACK,
  FORWARD_TEST_PROVIDER_FALLBACK,
} from "../../src/test-harness/providers";
import type {
  BacktestProvider,
  ForwardTestProvider,
  ForwardOrder,
  ProviderEnv,
  VenueOrderStatus,
} from "../../src/test-harness/providers";
import { createAlpacaPaperProvider } from "../../src/test-harness/alpaca-paper";
import { createTastytradeBacktestProvider } from "../../src/test-harness/tastytrade-backtest";
import { EvidenceStore, EVIDENCE_MAX_KEPT } from "../../src/evidence-store";
import { newEvidenceRecord } from "../../src/test-harness/evidence";

const ALPACA_ENV: ProviderEnv = {
  ALPACA_API_KEY_ID: "test-key",
  ALPACA_API_SECRET_KEY: "test-secret",
};

function forwardOrder(): ForwardOrder {
  return {
    clientTestId: "test-ord-lanes-1",
    symbol: "SPY",
    strategy: "bull_put",
    recommendationId: "rec-lanes-1",
    orderClass: "mleg",
    legs: [
      { occSymbol: "SPY  260116P00580000", ratio: 1, side: "sell" },
      { occSymbol: "SPY  260116P00570000", ratio: 1, side: "buy" },
    ],
    limitPrice: -1.25,
    timeInForce: "day",
    testBudget: 10000,
  };
}

interface Call {
  method: string;
  url: string;
}

function stubFetch(calls: Call[], routes: Record<string, unknown>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const key = `${method} ${url}`;
    const body = routes[key] ?? routes["*"];
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function stubBacktestProvider(id: string): BacktestProvider {
  return {
    providerId: id,
    kind: "backtest",
    capabilities: () => ({
      multiLeg: false,
      maxLegs: 1,
      assetClasses: ["equity"],
      paperOnly: false,
      honestLimits: [],
    }),
    isConfigured: () => true,
    requiredEnv: () => [],
    submitBacktest: async () => ({ runId: "stub-run-1", providerId: id }),
    submitBacktestWindows: async () => [{ runId: "stub-run-1", providerId: id }],
    getBacktestStatus: async () => ({ state: "complete", results: [] }),
  };
}

// ---------------------------------------------------------------------------
// Plugin swap through the registry
// ---------------------------------------------------------------------------

describe("provider registry swap", () => {
  it("resolves a stub plugin selected by env, not the default", () => {
    const reg = new ProviderRegistry();
    registerDefaultProviders(reg);
    reg.register(() => stubBacktestProvider("stub-backtest"));
    const env: ProviderEnv = { BACKTEST_PROVIDER: "stub-backtest" };
    const p = resolveProvider(
      reg,
      env,
      "backtest",
      "BACKTEST_PROVIDER",
      BACKTEST_PROVIDER_FALLBACK,
    );
    expect(p.providerId).toBe("stub-backtest");
  });

  it("falls back to tastytrade / alpaca-paper when env is unset", () => {
    const reg = new ProviderRegistry();
    registerDefaultProviders(reg);
    expect(
      resolveProvider(reg, {}, "backtest", "BACKTEST_PROVIDER", BACKTEST_PROVIDER_FALLBACK)
        .providerId,
    ).toBe("tastytrade-backtest");
    expect(
      resolveProvider(
        reg,
        {},
        "forward",
        "FORWARD_TEST_PROVIDER",
        FORWARD_TEST_PROVIDER_FALLBACK,
      ).providerId,
    ).toBe("alpaca-paper");
  });

  it("throws a clear error for an unknown provider id", () => {
    const reg = new ProviderRegistry();
    registerDefaultProviders(reg);
    expect(() =>
      resolveProvider(
        reg,
        { BACKTEST_PROVIDER: "nope" },
        "backtest",
        "BACKTEST_PROVIDER",
        BACKTEST_PROVIDER_FALLBACK,
      ),
    ).toThrow(/Unknown test-harness provider "nope"/);
  });

  it("refuses a provider of the wrong lane kind", () => {
    const reg = new ProviderRegistry();
    registerDefaultProviders(reg);
    expect(() =>
      resolveProvider(
        reg,
        { BACKTEST_PROVIDER: "alpaca-paper" },
        "backtest",
        "BACKTEST_PROVIDER",
        BACKTEST_PROVIDER_FALLBACK,
      ),
    ).toThrow(/is a forward provider/);
  });
});

// ---------------------------------------------------------------------------
// Lane isolation: one lane throws, the other completes
// ---------------------------------------------------------------------------

describe("runTestLanes isolation", () => {
  it("a throwing backtest lane does not fail the forward lane", async () => {
    const { backtest, forward } = await runTestLanes(
      "tastytrade-backtest",
      async () => {
        throw new Error("backtester exploded");
      },
      "alpaca-paper",
      async () => ({ ok: true }),
    );
    expect(backtest).toMatchObject({
      state: "failed",
      provider: "tastytrade-backtest",
      error: "backtester exploded",
    });
    expect(forward).toEqual({ ok: true });
  });

  it("a throwing forward lane does not fail the backtest lane", async () => {
    const { backtest, forward } = await runTestLanes(
      "tastytrade-backtest",
      async () => ({ windows: 3 }),
      "alpaca-paper",
      async () => {
        throw new Error("paper venue exploded");
      },
    );
    expect(backtest).toEqual({ windows: 3 });
    expect(forward).toMatchObject({
      state: "failed",
      provider: "alpaca-paper",
      error: "paper venue exploded",
    });
  });
});

// ---------------------------------------------------------------------------
// Paper-only guard: no network call on a live URL
// ---------------------------------------------------------------------------

describe("paper-only guard", () => {
  it("submitForwardLane refuses a live base URL before any network call", async () => {
    const calls: Call[] = [];
    const provider = createAlpacaPaperProvider(stubFetch(calls, {}));
    const env: ProviderEnv = {
      ...ALPACA_ENV,
      ALPACA_BASE_URL: "https://api.alpaca.markets",
    };
    await expect(
      submitForwardLane(provider, env, forwardOrder(), stubFetch(calls, {})),
    ).rejects.toThrow(/refusing non-paper base URL/);
    expect(calls).toHaveLength(0);
  });

  it("submitForwardLane places on the paper domain", async () => {
    const calls: Call[] = [];
    const orderBody = {
      id: "paper-ord-9",
      status: "accepted",
      filled_qty: "0",
      legs: [],
    };
    const fetchImpl = stubFetch(calls, {
      "GET https://paper-api.alpaca.markets/v2/orders?status=all&limit=200": [],
      "POST https://paper-api.alpaca.markets/v2/orders": orderBody,
    });
    const provider = createAlpacaPaperProvider(fetchImpl);
    const outcome = await submitForwardLane(provider, ALPACA_ENV, forwardOrder(), fetchImpl);
    expect(outcome.state).toBe("running");
    expect(outcome.venueOrderId).toBe("paper-ord-9");
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NOT_CONFIGURED honesty: no fetch, no fabricated data
// ---------------------------------------------------------------------------

describe("NOT_CONFIGURED honesty", () => {
  it("backtest lane skips without configured secrets and makes no calls", async () => {
    const calls: Call[] = [];
    const fetchImpl = stubFetch(calls, {});
    const provider = createTastytradeBacktestProvider(fetchImpl);
    const outcome = await submitBacktestLane(
      provider,
      {},
      {
        recommendationId: "r",
        strategy: "bull_put",
        symbol: "SPY",
        legs: [],
        windows: [{ start: "2023-01-01", end: "2024-01-01" }],
        profitTargetPct: 50,
      },
      fetchImpl,
    );
    expect(outcome.state).toBe("skipped-not-configured");
    expect(calls).toHaveLength(0);
  });

  it("forward lane skips without configured keys and makes no calls", async () => {
    const calls: Call[] = [];
    const fetchImpl = stubFetch(calls, {});
    const provider = createAlpacaPaperProvider(fetchImpl);
    const outcome = await submitForwardLane(
      provider,
      {},
      forwardOrder(),
      fetchImpl,
    );
    expect(outcome.state).toBe("skipped-not-configured");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Exit evaluation
// ---------------------------------------------------------------------------

describe("evaluateForwardExit", () => {
  it("takes profit at the credit-capture target", () => {
    expect(
      evaluateForwardExit({ entryCredit: 2.0, closeCost: 0.9, dte: 30 }),
    ).toBe("take_profit"); // captured 55% >= 50%
  });

  it("stops at the adverse multiple", () => {
    expect(
      evaluateForwardExit({ entryCredit: 2.0, closeCost: 6.5, dte: 30 }),
    ).toBe("stop_loss"); // captured -225% <= -200%
  });

  it("exits by DTE at or below the threshold", () => {
    expect(
      evaluateForwardExit({ entryCredit: 2.0, closeCost: 1.9, dte: 5 }),
    ).toBe("dte_exit");
  });

  it("holds otherwise", () => {
    expect(
      evaluateForwardExit({ entryCredit: 2.0, closeCost: 1.5, dte: 30 }),
    ).toBe("hold");
  });

  it("holds when entry credit is not positive (honest, not fabricated)", () => {
    expect(
      evaluateForwardExit({ entryCredit: 0, closeCost: 0.1, dte: 30 }),
    ).toBe("hold");
  });
});

describe("advanceForwardLane", () => {
  function stubForward(status: VenueOrderStatus): ForwardTestProvider {
    return {
      providerId: "stub-forward",
      kind: "forward",
      capabilities: () => ({
        multiLeg: true,
        maxLegs: 4,
        assetClasses: ["equity-option"],
        paperOnly: true,
        honestLimits: [],
      }),
      isConfigured: () => true,
      requiredEnv: () => [],
      assertPaper: () => undefined,
      placeTestOrder: async () => status,
      getTestOrder: async () => status,
      listTestOrders: async () => [status],
      cancelTestOrder: async () => undefined,
    };
  }

  it("signals take_profit when the venue mark hits the target", async () => {
    const provider = stubForward({
      id: "o1",
      status: "filled",
      filledQty: 1,
      filledAvgPrice: 0.8,
      legs: [],
    });
    const res = await advanceForwardLane(provider, {}, "o1", {
      entryCredit: 2.0,
      dte: 30,
    });
    expect(res.signal).toBe("take_profit");
    expect(res.status.id).toBe("o1");
  });

  it("holds honestly when the venue gives no close mark", async () => {
    const provider = stubForward({
      id: "o2",
      status: "accepted",
      filledQty: 0,
      legs: [],
    });
    const res = await advanceForwardLane(provider, {}, "o2", {
      entryCredit: 2.0,
      dte: 30,
    });
    expect(res.signal).toBe("hold");
    expect(res.note).toMatch(/no close mark/);
  });
});

// ---------------------------------------------------------------------------
// Goal-text contract + provenance + store
// ---------------------------------------------------------------------------

describe("goal-text contract", () => {
  it("emits the exact scheduled-goal text", () => {
    expect(evidenceGoalText("rec-42")).toBe(
      "Advance the evidence run for recommendation rec-42 (evidence.advance).",
    );
  });

  it("follow-up delay is a named constant", () => {
    expect(EVIDENCE_FOLLOWUP_DELAY_SECONDS).toBe(6 * 3600);
  });

  it("follow-up goal id is deterministic", () => {
    expect(evidenceFollowUpGoalId("rec-42")).toBe("evidence-followup:rec-42");
  });
});

describe("laneProvenance", () => {
  it("labels alpaca-paper evidence as simulated/optimistic", () => {
    const labels = laneProvenance("alpaca-paper");
    expect(labels.join(" ")).toMatch(/simulated/i);
    expect(labels.join(" ")).toMatch(/never live performance/);
  });

  it("labels tastytrade evidence as historical", () => {
    expect(laneProvenance("tastytrade-backtest").join(" ")).toMatch(
      /historical/,
    );
  });
});

describe("EvidenceStore", () => {
  function fakeSql() {
    const rows = new Map<string, { created_at: string; data: string }>();
    return {
      rows,
      exec(sql: string, ...bind: unknown[]) {
        if (sql.includes("CREATE TABLE")) return [];
        if (sql.includes("INSERT OR REPLACE")) {
          rows.set(String(bind[0]), {
            created_at: String(bind[1]),
            data: String(bind[2]),
          });
          return [];
        }
        if (sql.includes("WHERE id = ?")) {
          const r = rows.get(String(bind[0]));
          return r ? [{ data: r.data }] : [];
        }
        if (sql.includes("ORDER BY created_at DESC")) {
          const limit = Number(bind[0] ?? 50);
          return [...rows.values()]
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, limit)
            .map((r) => ({ data: r.data }));
        }
        if (sql.includes("DELETE FROM")) {
          const limit = Number(bind[0] ?? 50);
          const keep = new Set(
            [...rows.entries()]
              .sort((a, b) => (a[1].created_at < b[1].created_at ? 1 : -1))
              .slice(0, limit)
              .map(([id]) => id),
          );
          for (const id of [...rows.keys()]) {
            if (!keep.has(id)) rows.delete(id);
          }
          return [];
        }
        throw new Error(`unexpected SQL in fake: ${sql.slice(0, 60)}`);
      },
    };
  }

  function record(id: string, i: number) {
    const rec = newEvidenceRecord({
      recommendationId: id,
      strategy: "bull_put",
      underlying: "SPY",
      sizerSpec: { contracts: 1 },
    });
    rec.issuedAt = new Date(Date.now() + i * 1000).toISOString();
    return rec;
  }

  it("round-trips save/get/list", () => {
    const fake = fakeSql();
    const store = new EvidenceStore(fake as unknown as SqlStorage);
    store.save(record("r1", 1));
    store.save(record("r2", 2));
    expect(store.get("r1")?.recommendationId).toBe("r1");
    expect(store.get("missing")).toBeNull();
    const listed = store.list();
    expect(listed.map((r) => r.recommendationId)).toEqual(["r2", "r1"]);
  });

  it("prunes to the keep cap", () => {
    const fake = fakeSql();
    const store = new EvidenceStore(fake as unknown as SqlStorage);
    for (let i = 0; i < EVIDENCE_MAX_KEPT + 5; i++) {
      store.save(record(`r${i}`, i));
    }
    expect(store.list()).toHaveLength(EVIDENCE_MAX_KEPT);
  });
});
