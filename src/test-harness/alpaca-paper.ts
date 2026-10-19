/**
 * Alpaca paper forward-test provider for the #245 test harness.
 *
 * Implements ForwardTestProvider against Alpaca's PAPER trading API only.
 * Conventions mirror cfagent's Alpaca wiring (fossResearch.ts AlpacaMarketDataProvider):
 * key aliases ALPACA_API_KEY_ID|ALPACA_API_KEY and ALPACA_API_SECRET_KEY|ALPACA_SECRET_KEY,
 * APCA-API-KEY-ID / APCA-API-SECRET-KEY headers, ALPACA_BASE_URL override.
 *
 * The mleg order shape is fresh from the #244 docs-confirmed audit (cfagent has
 * no mleg/options order code — its platform.ts options path throws; not ported):
 * order_class "mleg", <= 4 legs as one unit, limit_price positive = debit /
 * negative = credit, OCC symbols passed verbatim.
 *
 * Paper-only hard guard: every order path asserts the resolved base URL is
 * exactly the paper domain before any network call. There is no live order
 * path in this code.
 *
 * SDK-free; fetch is injectable so tests run with a stub (no live network).
 */

import type {
  ForwardOrder,
  ForwardTestProvider,
  ProviderEnv,
  VenueOrderStatus,
} from "./providers";

export const ALPACA_PAPER_DOMAIN = "https://paper-api.alpaca.markets";
export const ALPACA_PROVIDER_ID = "alpaca-paper";

const USER_AGENT = "cfpay-test-harness/1.0";
const MAX_SERVER_MESSAGE = 300;
const LIST_LIMIT = 200;

// ---------------------------------------------------------------- env

export function alpacaApiKey(env: ProviderEnv): string {
  return env.ALPACA_API_KEY_ID ?? env.ALPACA_API_KEY ?? "";
}

export function alpacaApiSecret(env: ProviderEnv): string {
  return env.ALPACA_API_SECRET_KEY ?? env.ALPACA_SECRET_KEY ?? "";
}

export function alpacaBaseUrl(env: ProviderEnv): string {
  return env.ALPACA_BASE_URL ?? ALPACA_PAPER_DOMAIN;
}

export function alpacaRequiredEnv(): string[] {
  return [
    "ALPACA_API_KEY_ID|ALPACA_API_KEY",
    "ALPACA_API_SECRET_KEY|ALPACA_SECRET_KEY",
  ];
}

export function isAlpacaConfigured(env: ProviderEnv): boolean {
  return alpacaApiKey(env) !== "" && alpacaApiSecret(env) !== "";
}

// ---------------------------------------------------------------- paper guard

/** Pure check: is this URL the Alpaca paper trading domain? */
export function isPaperBaseUrl(u: string): boolean {
  try {
    return new URL(u).host === "paper-api.alpaca.markets";
  } catch {
    return false;
  }
}

/** Throws unless the resolved base URL is exactly the paper domain. */
export function assertPaperBaseUrl(baseUrl: string): void {
  if (!isPaperBaseUrl(baseUrl)) {
    throw new Error(
      `alpaca-paper: refusing non-paper base URL "${baseUrl}" — forward tests run on Alpaca paper only`,
    );
  }
}

// ---------------------------------------------------------------- order build

const MAX_LEGS = 4;

/**
 * Build the Alpaca POST /v2/orders body for a multi-leg options order.
 * OCC symbols pass through verbatim; limit_price sign carries debit/credit
 * (positive = debit, negative = credit).
 */
export function buildMlegOrderBody(o: ForwardOrder): unknown {
  const tif: string = o.timeInForce;
  if (tif !== "day" && tif !== "gtc") {
    throw new Error(
      `alpaca-paper: unsupported time_in_force "${tif}" (supported: day, gtc)`,
    );
  }
  if (o.legs.length < 1 || o.legs.length > MAX_LEGS) {
    throw new Error(
      `alpaca-paper: mleg requires 1-${MAX_LEGS} legs, got ${o.legs.length}`,
    );
  }
  return {
    symbol: o.symbol,
    qty: "1",
    side: "buy",
    type: "limit",
    time_in_force: o.timeInForce,
    order_class: "mleg",
    limit_price: o.limitPrice,
    legs: o.legs.map((l) => ({
      symbol: l.occSymbol,
      ratio_qty: l.ratio,
      side: l.side,
    })),
    client_order_id: o.clientTestId,
  };
}

// ---------------------------------------------------------------- http helpers

type FetchImpl = typeof fetch;

function alpacaHeaders(env: ProviderEnv): Record<string, string> {
  return {
    "APCA-API-KEY-ID": alpacaApiKey(env),
    "APCA-API-SECRET-KEY": alpacaApiSecret(env),
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

/** Extract a truncated server message for errors. Never includes secrets —
 *  Alpaca error bodies contain no credentials, and the key/secret are never
 *  interpolated into error text. */
async function serverMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { message?: unknown }).message === "string"
      ) {
        return (parsed as { message: string }).message.slice(0, MAX_SERVER_MESSAGE);
      }
    } catch {
      // fall through to raw text
    }
    return text.slice(0, MAX_SERVER_MESSAGE);
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * Submit an mleg forward-test order. Idempotent: if an order with the same
 * client_order_id is already on the venue, its status is returned and no
 * duplicate POST is made (step retries cannot double-submit).
 */
export async function placeMlegOrder(
  env: ProviderEnv,
  order: ForwardOrder,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<VenueOrderStatus> {
  const base = alpacaBaseUrl(env);
  assertPaperBaseUrl(base);
  const headers = alpacaHeaders(env);

  const existing = await fetchImpl(`${base}/v2/orders?status=all&limit=${LIST_LIMIT}`, {
    headers,
  });
  if (!existing.ok) {
    throw new Error(
      `alpaca order failed: HTTP ${existing.status}: ${await serverMessage(existing)}`,
    );
  }
  const orders: unknown = await existing.json().catch(() => []);
  if (Array.isArray(orders)) {
    const hit = orders.find(
      (o) =>
        o !== null &&
        typeof o === "object" &&
        (o as { client_order_id?: unknown }).client_order_id === order.clientTestId,
    );
    if (hit !== undefined) {
      return normalizeAlpacaOrder(hit);
    }
  }

  const res = await fetchImpl(`${base}/v2/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildMlegOrderBody(order)),
  });
  if (!res.ok) {
    throw new Error(
      `alpaca order failed: HTTP ${res.status}: ${await serverMessage(res)}`,
    );
  }
  return normalizeAlpacaOrder(await res.json());
}

export async function getAlpacaOrder(
  env: ProviderEnv,
  id: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<VenueOrderStatus> {
  const base = alpacaBaseUrl(env);
  const res = await fetchImpl(`${base}/v2/orders/${encodeURIComponent(id)}`, {
    headers: alpacaHeaders(env),
  });
  if (res.status === 404) {
    throw new Error(`alpaca order not found: ${id}`);
  }
  if (!res.ok) {
    throw new Error(
      `alpaca get order failed: HTTP ${res.status}: ${await serverMessage(res)}`,
    );
  }
  return normalizeAlpacaOrder(await res.json());
}

export async function listAlpacaOrders(
  env: ProviderEnv,
  status: "open" | "closed" | "all",
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<VenueOrderStatus[]> {
  const base = alpacaBaseUrl(env);
  const res = await fetchImpl(
    `${base}/v2/orders?status=${status}&limit=${LIST_LIMIT}&direction=desc`,
    { headers: alpacaHeaders(env) },
  );
  if (!res.ok) {
    throw new Error(
      `alpaca list orders failed: HTTP ${res.status}: ${await serverMessage(res)}`,
    );
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("alpaca list orders failed: unexpected response shape");
  }
  return data.map((o) => normalizeAlpacaOrder(o));
}

/**
 * Cancel an order. 404/422 mean the order is already gone (filled, cancelled,
 * or rejected) — treated as success so exit-step retries are safe.
 */
export async function cancelAlpacaOrder(
  env: ProviderEnv,
  id: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<void> {
  const base = alpacaBaseUrl(env);
  assertPaperBaseUrl(base);
  const res = await fetchImpl(`${base}/v2/orders/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: alpacaHeaders(env),
  });
  if (res.ok || res.status === 404 || res.status === 422) {
    return;
  }
  throw new Error(
    `alpaca cancel failed: HTTP ${res.status}: ${await serverMessage(res)}`,
  );
}

/** Pure normalization of an Alpaca order object to the harness shape. */
export function normalizeAlpacaOrder(raw: any): VenueOrderStatus {
  const num = (v: unknown): number => {
    const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const rawAvg = (raw as { filled_avg_price?: unknown } | null)?.filled_avg_price;
  const rawLegs = (raw as { legs?: unknown } | null)?.legs;
  return {
    id: String(raw?.id ?? ""),
    status: String(raw?.status ?? "unknown"),
    filledQty: num((raw as { filled_qty?: unknown } | null)?.filled_qty),
    ...(rawAvg != null ? { filledAvgPrice: num(rawAvg) } : {}),
    legs: Array.isArray(rawLegs)
      ? rawLegs.map((l) => ({
          symbol: String((l as { symbol?: unknown } | null)?.symbol ?? ""),
          filledQty: num((l as { filled_qty?: unknown } | null)?.filled_qty),
        }))
      : [],
  };
}

// ---------------------------------------------------------------- provider

const NOT_CONFIGURED =
  "alpaca-paper: NOT_CONFIGURED — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY";

export function createAlpacaPaperProvider(
  fetchImpl: FetchImpl = globalThis.fetch,
): ForwardTestProvider {
  const guard = (env: ProviderEnv): void => {
    if (!isAlpacaConfigured(env)) {
      throw new Error(NOT_CONFIGURED);
    }
    assertPaperBaseUrl(alpacaBaseUrl(env));
  };
  return {
    providerId: ALPACA_PROVIDER_ID,
    kind: "forward",
    capabilities: () => ({
      multiLeg: true,
      maxLegs: MAX_LEGS,
      assetClasses: ["equity-option"],
      paperOnly: true,
      honestLimits: [
        "paper fills simulate NBBO (buy at ask / sell at bid); quantity not checked against NBBO depth",
        "~10% random partial fills; market impact, latency, queue position, fees, dividends ignored",
        "forward-test evidence is optimistic on fill quality — never present as live performance",
      ],
    }),
    isConfigured: (env) => isAlpacaConfigured(env),
    requiredEnv: () => alpacaRequiredEnv(),
    assertPaper: (env) => assertPaperBaseUrl(alpacaBaseUrl(env)),
    placeTestOrder: async (env, o) => {
      guard(env);
      return placeMlegOrder(env, o, fetchImpl);
    },
    getTestOrder: async (env, id) => {
      guard(env);
      return getAlpacaOrder(env, id, fetchImpl);
    },
    listTestOrders: async (env, status) => {
      guard(env);
      return listAlpacaOrders(env, status, fetchImpl);
    },
    cancelTestOrder: async (env, id) => {
      guard(env);
      return cancelAlpacaOrder(env, id, fetchImpl);
    },
  };
}
