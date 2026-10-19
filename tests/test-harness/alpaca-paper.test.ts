/**
 * Tests for src/test-harness/alpaca-paper.ts.
 *
 * All HTTP is stubbed — no live network. The stub records every request so
 * idempotency (no POST on duplicate) and header assertions are checkable.
 */
import { describe, it, expect } from "vitest";
import {
  ALPACA_PAPER_DOMAIN,
  ALPACA_PROVIDER_ID,
  alpacaApiKey,
  alpacaApiSecret,
  alpacaBaseUrl,
  alpacaRequiredEnv,
  isAlpacaConfigured,
  isPaperBaseUrl,
  assertPaperBaseUrl,
  buildMlegOrderBody,
  normalizeAlpacaOrder,
  placeMlegOrder,
  getAlpacaOrder,
  listAlpacaOrders,
  cancelAlpacaOrder,
  createAlpacaPaperProvider,
} from "../../src/test-harness/alpaca-paper";
import type { ForwardOrder, ProviderEnv } from "../../src/test-harness/providers";

const KEY = "AKIA-TEST-KEY-VALUE-XYZ";
const SECRET = "test-secret-abc-123";
const configuredEnv: ProviderEnv = {
  ALPACA_API_KEY_ID: KEY,
  ALPACA_API_SECRET_KEY: SECRET,
};

function order(over: Partial<ForwardOrder> = {}): ForwardOrder {
  return {
    clientTestId: "test-ord-1",
    symbol: "SPY",
    strategy: "bull_put",
    recommendationId: "rec-1",
    orderClass: "mleg",
    legs: [
      { occSymbol: "SPY  260116P00580000", ratio: 1, side: "sell" },
      { occSymbol: "SPY  260116P00570000", ratio: 1, side: "buy" },
    ],
    limitPrice: -1.25,
    timeInForce: "day",
    testBudget: 10000,
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  init?: RequestInit;
}

interface Route {
  method: string;
  path: string; // matched by substring against the URL
  status: number;
  body: unknown;
}

function stubFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    calls.push({ method, url, init });
    const route = routes.find((r) => r.method === method && url.includes(r.path));
    const status = route?.status ?? 404;
    const body = route?.body ?? { message: "not found" };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const headersOf = (c: Call): Record<string, string> =>
  (c.init?.headers as Record<string, string>) ?? {};

describe("env aliasing (cfagent conventions)", () => {
  it("prefers ALPACA_API_KEY_ID over ALPACA_API_KEY", () => {
    expect(
      alpacaApiKey({ ALPACA_API_KEY_ID: "id-first", ALPACA_API_KEY: "legacy" }),
    ).toBe("id-first");
  });
  it("falls back to ALPACA_API_KEY", () => {
    expect(alpacaApiKey({ ALPACA_API_KEY: "legacy" })).toBe("legacy");
  });
  it("prefers ALPACA_API_SECRET_KEY over ALPACA_SECRET_KEY", () => {
    expect(
      alpacaApiSecret({ ALPACA_API_SECRET_KEY: "new", ALPACA_SECRET_KEY: "legacy" }),
    ).toBe("new");
  });
  it("returns empty string when nothing is set", () => {
    expect(alpacaApiKey({})).toBe("");
    expect(alpacaApiSecret({})).toBe("");
  });
  it("base URL defaults to the paper domain", () => {
    expect(alpacaBaseUrl({})).toBe(ALPACA_PAPER_DOMAIN);
    expect(alpacaBaseUrl({ ALPACA_BASE_URL: "https://example.test" })).toBe(
      "https://example.test",
    );
  });
  it("requiredEnv names both alias pairs", () => {
    expect(alpacaRequiredEnv()).toEqual([
      "ALPACA_API_KEY_ID|ALPACA_API_KEY",
      "ALPACA_API_SECRET_KEY|ALPACA_SECRET_KEY",
    ]);
  });
  it("isAlpacaConfigured needs key AND secret", () => {
    expect(isAlpacaConfigured(configuredEnv)).toBe(true);
    expect(isAlpacaConfigured({ ALPACA_API_KEY_ID: KEY })).toBe(false);
    expect(isAlpacaConfigured({ ALPACA_API_SECRET_KEY: SECRET })).toBe(false);
    expect(isAlpacaConfigured({})).toBe(false);
  });
});

describe("paper-only hard guard", () => {
  it("accepts the paper domain (bare and with path)", () => {
    expect(isPaperBaseUrl("https://paper-api.alpaca.markets")).toBe(true);
    expect(isPaperBaseUrl("https://paper-api.alpaca.markets/v2/orders")).toBe(true);
  });
  it("rejects the live domain", () => {
    expect(isPaperBaseUrl("https://api.alpaca.markets")).toBe(false);
    expect(isPaperBaseUrl("https://api.alpaca.markets/v2/orders")).toBe(false);
  });
  it("rejects lookalike and garbage hosts", () => {
    expect(isPaperBaseUrl("https://paper-api.alpaca.markets.evil.com")).toBe(false);
    expect(isPaperBaseUrl("not a url")).toBe(false);
    expect(isPaperBaseUrl("")).toBe(false);
  });
  it("assertPaperBaseUrl throws on the live domain", () => {
    expect(() => assertPaperBaseUrl("https://api.alpaca.markets")).toThrow(
      /refusing non-paper base URL/,
    );
  });
  it("assertPaperBaseUrl passes on the paper domain", () => {
    expect(() => assertPaperBaseUrl(ALPACA_PAPER_DOMAIN)).not.toThrow();
  });
  it("provider.assertPaper refuses a live base URL", () => {
    const p = createAlpacaPaperProvider();
    expect(() =>
      p.assertPaper({ ...configuredEnv, ALPACA_BASE_URL: "https://api.alpaca.markets" }),
    ).toThrow(/refusing non-paper base URL/);
    expect(() => p.assertPaper(configuredEnv)).not.toThrow();
  });
});

describe("buildMlegOrderBody", () => {
  it("builds the mleg POST body with signed limit_price passthrough", () => {
    const body = buildMlegOrderBody(order()) as Record<string, unknown>;
    expect(body.order_class).toBe("mleg");
    expect(body.symbol).toBe("SPY");
    expect(body.qty).toBe("1");
    expect(body.side).toBe("buy");
    expect(body.type).toBe("limit");
    expect(body.time_in_force).toBe("day");
    expect(body.limit_price).toBe(-1.25); // negative = credit
    expect(body.client_order_id).toBe("test-ord-1");
    expect(body.legs).toEqual([
      { symbol: "SPY  260116P00580000", ratio_qty: 1, side: "sell" },
      { symbol: "SPY  260116P00570000", ratio_qty: 1, side: "buy" },
    ]);
  });
  it("passes a positive limit_price (debit) through verbatim", () => {
    const body = buildMlegOrderBody(order({ limitPrice: 2.5 })) as Record<string, unknown>;
    expect(body.limit_price).toBe(2.5);
  });
  it("passes gtc time_in_force through", () => {
    const body = buildMlegOrderBody(order({ timeInForce: "gtc" })) as Record<string, unknown>;
    expect(body.time_in_force).toBe("gtc");
  });
  it("throws on unsupported time_in_force", () => {
    expect(() =>
      buildMlegOrderBody(order({ timeInForce: "ioc" as "day" })),
    ).toThrow(/unsupported time_in_force/);
  });
  it("throws on more than 4 legs", () => {
    const legs = Array.from({ length: 5 }, (_, i) => ({
      occSymbol: `SPY  260116P0058${i}000`,
      ratio: 1,
      side: "buy" as const,
    }));
    expect(() => buildMlegOrderBody(order({ legs }))).toThrow(/1-4 legs/);
  });
});

describe("placeMlegOrder idempotency", () => {
  it("does NOT POST when an order with the same client_order_id already exists", async () => {
    const existing = {
      id: "existing-1",
      status: "accepted",
      filled_qty: "0",
      filled_avg_price: null,
      client_order_id: "test-ord-1",
      legs: [],
    };
    const { fetchImpl, calls } = stubFetch([
      { method: "GET", path: "/v2/orders?status=all", status: 200, body: [existing] },
      { method: "POST", path: "/v2/orders", status: 200, body: { id: "should-not-happen" } },
    ]);
    const got = await placeMlegOrder(configuredEnv, order(), fetchImpl);
    expect(got.id).toBe("existing-1");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("POSTs when no duplicate exists and sends auth + UA headers", async () => {
    const created = {
      id: "ord-9",
      status: "new",
      filled_qty: "0",
      filled_avg_price: null,
      client_order_id: "test-ord-1",
      legs: [],
    };
    const { fetchImpl, calls } = stubFetch([
      { method: "GET", path: "/v2/orders?status=all", status: 200, body: [] },
      { method: "POST", path: "/v2/orders", status: 200, body: created },
    ]);
    const got = await placeMlegOrder(configuredEnv, order(), fetchImpl);
    expect(got.id).toBe("ord-9");
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    const h = headersOf(post!);
    expect(h["APCA-API-KEY-ID"]).toBe(KEY);
    expect(h["APCA-API-SECRET-KEY"]).toBe(SECRET);
    expect(h["User-Agent"]).toBe("cfpay-test-harness/1.0");
    const body = JSON.parse(String(post!.init?.body));
    expect(body.order_class).toBe("mleg");
    expect(body.client_order_id).toBe("test-ord-1");
  });

  it("truncates server error messages", async () => {
    const long = "x".repeat(500);
    const { fetchImpl } = stubFetch([
      { method: "GET", path: "/v2/orders?status=all", status: 200, body: [] },
      { method: "POST", path: "/v2/orders", status: 422, body: { message: long } },
    ]);
    await expect(placeMlegOrder(configuredEnv, order(), fetchImpl)).rejects.toThrow(
      new RegExp(`alpaca order failed: HTTP 422: ${"x".repeat(300)}$`),
    );
  });
});

describe("reads and cancel", () => {
  const raw = {
    id: "o-1",
    status: "filled",
    filled_qty: "2",
    filled_avg_price: "1.25",
    legs: [
      { symbol: "SPY  260116P00580000", filled_qty: "2" },
      { symbol: "SPY  260116P00570000", filled_qty: "0" },
    ],
  };

  it("getAlpacaOrder normalizes a 200", async () => {
    const { fetchImpl } = stubFetch([{ method: "GET", path: "/v2/orders/o-1", status: 200, body: raw }]);
    const got = await getAlpacaOrder(configuredEnv, "o-1", fetchImpl);
    expect(got.id).toBe("o-1");
    expect(got.status).toBe("filled");
    expect(got.filledQty).toBe(2);
    expect(got.filledAvgPrice).toBe(1.25);
  });

  it("getAlpacaOrder maps 404 to order-not-found", async () => {
    const { fetchImpl } = stubFetch([{ method: "GET", path: "/v2/orders/nope", status: 404, body: {} }]);
    await expect(getAlpacaOrder(configuredEnv, "nope", fetchImpl)).rejects.toThrow(
      "alpaca order not found: nope",
    );
  });

  it("listAlpacaOrders maps an array response", async () => {
    const { fetchImpl } = stubFetch([
      { method: "GET", path: "/v2/orders?status=open", status: 200, body: [raw] },
    ]);
    const got = await listAlpacaOrders(configuredEnv, "open", fetchImpl);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("o-1");
  });

  it("cancel 404 and 422 resolve silently (already gone)", async () => {
    for (const status of [404, 422]) {
      const { fetchImpl } = stubFetch([
        { method: "DELETE", path: "/v2/orders/gone", status, body: {} },
      ]);
      await expect(cancelAlpacaOrder(configuredEnv, "gone", fetchImpl)).resolves.toBeUndefined();
    }
  });

  it("cancel on other errors throws", async () => {
    const { fetchImpl } = stubFetch([
      { method: "DELETE", path: "/v2/orders/o-1", status: 500, body: { message: "boom" } },
    ]);
    await expect(cancelAlpacaOrder(configuredEnv, "o-1", fetchImpl)).rejects.toThrow(
      /alpaca cancel failed: HTTP 500/,
    );
  });
});

describe("normalizeAlpacaOrder", () => {
  it("maps fields with numeric parsing", () => {
    const got = normalizeAlpacaOrder({
      id: "o-1",
      status: "partially_filled",
      filled_qty: "1",
      filled_avg_price: "0.75",
      legs: [{ symbol: "OPT", filled_qty: "1" }],
    });
    expect(got).toEqual({
      id: "o-1",
      status: "partially_filled",
      filledQty: 1,
      filledAvgPrice: 0.75,
      legs: [{ symbol: "OPT", filledQty: 1 }],
    });
  });
  it("tolerates missing fields", () => {
    const got = normalizeAlpacaOrder({ id: "o-2" });
    expect(got.id).toBe("o-2");
    expect(got.filledQty).toBe(0);
    expect(got.legs).toEqual([]);
    expect(got.filledAvgPrice).toBeUndefined();
  });
});

describe("provider identity and NOT_CONFIGURED honesty", () => {
  it("exposes providerId, kind, and paper capabilities", () => {
    const p = createAlpacaPaperProvider();
    expect(p.providerId).toBe(ALPACA_PROVIDER_ID);
    expect(p.kind).toBe("forward");
    expect(p.capabilities()).toEqual({
      multiLeg: true,
      maxLegs: 4,
      assetClasses: ["equity-option"],
      paperOnly: true,
      honestLimits: [
        "paper fills simulate NBBO (buy at ask / sell at bid); quantity not checked against NBBO depth",
        "~10% random partial fills; market impact, latency, queue position, fees, dividends ignored",
        "forward-test evidence is optimistic on fill quality — never present as live performance",
      ],
    });
    expect(p.isConfigured(configuredEnv)).toBe(true);
    expect(p.isConfigured({})).toBe(false);
  });

  it("order methods throw NOT_CONFIGURED without secrets configured", async () => {
    const p = createAlpacaPaperProvider();
    const empty: ProviderEnv = {};
    await expect(p.placeTestOrder(empty, order())).rejects.toThrow(/NOT_CONFIGURED/);
    await expect(p.getTestOrder(empty, "x")).rejects.toThrow(/NOT_CONFIGURED/);
    await expect(p.listTestOrders(empty, "open")).rejects.toThrow(/NOT_CONFIGURED/);
    await expect(p.cancelTestOrder(empty, "x")).rejects.toThrow(/NOT_CONFIGURED/);
  });

  it("error strings never contain secret values", async () => {
    const { fetchImpl } = stubFetch([
      { method: "GET", path: "/v2/orders?status=all", status: 200, body: [] },
      { method: "POST", path: "/v2/orders", status: 500, body: { message: "venue exploded" } },
    ]);
    const p = createAlpacaPaperProvider(fetchImpl);
    const err = await p.placeTestOrder(configuredEnv, order()).catch((e) => e);
    const text = String(err?.message ?? err);
    expect(text).toContain("alpaca order failed");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("APCA-API-SECRET-KEY");
  });
});
