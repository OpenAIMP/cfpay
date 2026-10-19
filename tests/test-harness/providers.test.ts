/**
 * Registry + provider-resolution tests (cfpay #245).
 *
 * Pins the plugin contract: register/get/unknown-id listing, env-override
 * resolution with clear errors, and the swappability proof — a consumer
 * written against BacktestProvider works unchanged against a stub provider
 * with the same interface.
 */

import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  resolveProvider,
  type BacktestProvider,
  type BacktestHandle,
  type BacktestRequest,
  type ForwardTestProvider,
  type ProviderCapabilities,
  type ProviderEnv,
} from "../../src/test-harness/providers";

function makeRequest(): BacktestRequest {
  return {
    recommendationId: "rec-1",
    strategy: "bull_put",
    symbol: "SPY",
    legs: [
      {
        side: "put",
        direction: "short",
        strikeSelection: "delta",
        delta: 16,
        daysUntilExpiration: 45,
        quantity: 1,
      },
    ],
    windows: [{ start: "2023-01-01", end: "2024-01-01" }],
    profitTargetPct: 50,
  };
}

class StubBacktestProvider implements BacktestProvider {
  readonly providerId = "stub-backtest";
  readonly kind = "backtest" as const;

  capabilities(): ProviderCapabilities {
    return {
      multiLeg: true,
      maxLegs: 2,
      assetClasses: ["equity-option"],
      paperOnly: false,
      honestLimits: ["stub: not real data"],
    };
  }

  isConfigured(_cfg: ProviderEnv): boolean {
    return true;
  }

  requiredEnv(): string[] {
    return ["STUB_BACKTEST_KEY"];
  }

  async submitBacktest(
    _env: ProviderEnv,
    req: BacktestRequest,
  ): Promise<BacktestHandle> {
    return { runId: `stub-${req.recommendationId}`, providerId: this.providerId };
  }

  async getBacktestStatus(_env: ProviderEnv, _runId: string) {
    return {
      state: "complete" as const,
      results: [
        {
          start: "2023-01-01",
          end: "2024-01-01",
          tradeCount: 10,
          winRate: 0.7,
          netPnl: 120,
          avgWin: 20,
          avgLoss: -10,
          notices: [],
        },
      ],
    };
  }
}

class StubForwardProvider implements ForwardTestProvider {
  readonly providerId = "stub-forward";
  readonly kind = "forward" as const;

  capabilities(): ProviderCapabilities {
    return {
      multiLeg: true,
      maxLegs: 4,
      assetClasses: ["equity-option"],
      paperOnly: true,
      honestLimits: ["stub: fills simulated"],
    };
  }

  isConfigured(_cfg: ProviderEnv): boolean {
    return true;
  }

  requiredEnv(): string[] {
    return ["STUB_FORWARD_KEY"];
  }

  assertPaper(_env: ProviderEnv): void {
    // stub is always paper
  }

  async placeTestOrder() {
    throw new Error("not used in these tests");
  }

  async getTestOrder() {
    throw new Error("not used in these tests");
  }

  async listTestOrders() {
    return [];
  }

  async cancelTestOrder(): Promise<void> {
    // no-op
  }
}

/** Consumer written ONLY against the BacktestProvider interface. */
async function consumerBacktest(
  p: BacktestProvider,
  env: ProviderEnv,
): Promise<string> {
  const handle = await p.submitBacktest(env, makeRequest());
  const status = await p.getBacktestStatus(env, handle.runId);
  if (status.state !== "complete") throw new Error("expected complete");
  const trades = (status.results ?? []).reduce((n, w) => n + w.tradeCount, 0);
  return `${handle.providerId}:${trades}`;
}

describe("ProviderRegistry", () => {
  it("registers and gets a provider by id", () => {
    const reg = new ProviderRegistry();
    reg.register(() => new StubBacktestProvider());
    const p = reg.get("stub-backtest");
    expect(p).toBeDefined();
    expect(p?.providerId).toBe("stub-backtest");
    expect(p?.kind).toBe("backtest");
  });

  it("returns undefined for an unknown id and lists registered ids", () => {
    const reg = new ProviderRegistry();
    reg.register(() => new StubBacktestProvider());
    expect(reg.get("no-such-provider")).toBeUndefined();
    expect(reg.ids()).toEqual(["stub-backtest"]);
  });

  it("filters providers by lane", () => {
    const reg = new ProviderRegistry();
    reg.register(() => new StubBacktestProvider());
    reg.register(() => new StubForwardProvider());
    expect(reg.backtestProviders().map((p) => p.providerId)).toEqual([
      "stub-backtest",
    ]);
    expect(reg.forwardProviders().map((p) => p.providerId)).toEqual([
      "stub-forward",
    ]);
  });
});

describe("resolveProvider", () => {
  function regWithBoth(): ProviderRegistry {
    const reg = new ProviderRegistry();
    reg.register(() => new StubBacktestProvider());
    reg.register(() => new StubForwardProvider());
    return reg;
  }

  it("uses the fallback id when the env key is absent", () => {
    const p = resolveProvider(
      regWithBoth(),
      {},
      "backtest",
      "BACKTEST_PROVIDER",
      "stub-backtest",
    );
    expect(p.providerId).toBe("stub-backtest");
  });

  it("honors the env override", () => {
    const reg = regWithBoth();
    reg.register(() => new StubBacktestProvider2());
    const p = resolveProvider(
      reg,
      { BACKTEST_PROVIDER: "stub-backtest-2" },
      "backtest",
      "BACKTEST_PROVIDER",
      "stub-backtest",
    );
    expect(p.providerId).toBe("stub-backtest-2");
  });

  it("throws a clear error naming the unknown provider and listing ids", () => {
    const reg = regWithBoth();
    expect(() =>
      resolveProvider(
        reg,
        { BACKTEST_PROVIDER: "nope-backtest" },
        "backtest",
        "BACKTEST_PROVIDER",
        "stub-backtest",
      ),
    ).toThrow(/Unknown test-harness provider "nope-backtest"/);
    expect(() =>
      resolveProvider(
        reg,
        { BACKTEST_PROVIDER: "nope-backtest" },
        "backtest",
        "BACKTEST_PROVIDER",
        "stub-backtest",
      ),
    ).toThrow(/stub-backtest/);
  });

  it("throws when a provider of the wrong lane is selected", () => {
    expect(() =>
      resolveProvider(
        regWithBoth(),
        { BACKTEST_PROVIDER: "stub-forward" },
        "backtest",
        "BACKTEST_PROVIDER",
        "stub-backtest",
      ),
    ).toThrow(/forward provider/);
  });
});

class StubBacktestProvider2 extends StubBacktestProvider {
  override readonly providerId = "stub-backtest-2";
}

describe("provider swappability", () => {
  it("a consumer written against BacktestProvider works unchanged with a swapped provider", async () => {
    // The consumer never names a concrete class; resolving through the
    // registry + interface proves the platform plugin swap (#248).
    const reg = new ProviderRegistry();
    reg.register(() => new StubBacktestProvider());
    const resolved = resolveProvider(
      reg,
      {},
      "backtest",
      "BACKTEST_PROVIDER",
      "stub-backtest",
    );
    const out = await consumerBacktest(
      resolved as BacktestProvider,
      {} as ProviderEnv,
    );
    expect(out).toBe("stub-backtest:10");

    // Swap the implementation under the same id; the consumer is untouched.
    const reg2 = new ProviderRegistry();
    reg2.register(() => new StubBacktestProvider2());
    const resolved2 = resolveProvider(
      reg2,
      { BACKTEST_PROVIDER: "stub-backtest-2" },
      "backtest",
      "BACKTEST_PROVIDER",
      "stub-backtest",
    );
    const out2 = await consumerBacktest(
      resolved2 as BacktestProvider,
      {} as ProviderEnv,
    );
    expect(out2).toBe("stub-backtest-2:10");
  });
});
