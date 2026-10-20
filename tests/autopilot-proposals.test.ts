/**
 * Holdings seam + rebalance proposals (issue #242 P2.2, #329).
 *
 * Hermetic throughout: the Public MCP endpoint is a stubbed global
 * fetch (the mcp-auth-google pattern), the DeskHost is a fake, and
 * the proposal store runs on an in-memory SqlStorage. No network, no
 * credentials, and - by design - no execution surface anywhere in
 * what is tested here: proposals are review records.
 */
import { afterEach, describe, expect, it } from "vitest";
import { extractPositions, type PortfolioPosition } from "../src/public-data";
import { deskHunt, deskPortfolio, type DeskHost } from "../src/desk-ops";
import { constructPortfolio } from "../src/portfolio-core";
import {
  buildRebalanceProposal,
  ProposalStore,
  underlyingOfPosition,
  type HoldingsSnapshot,
  type RebalanceProposal,
} from "../src/autopilot-proposals";
import type { SizedTrade } from "../src/opportunity-hunt";

/* ------------------------------ fixtures ------------------------------ */

const EXPIRY = "2026-11-20";

const sized = (over: Partial<SizedTrade> = {}): SizedTrade => ({
  underlying: "NVDA",
  strategy: "put credit spread",
  legs: [
    { action: "sell", type: "put", strike: 200 },
    { action: "buy", type: "put", strike: 195 },
  ],
  expiry: EXPIRY,
  credit: 1.25,
  probability: 0.8,
  thesis: "t",
  invalidation: "i",
  contracts: 1,
  spot: 218,
  maxLossPerContract: 500,
  maxProfitPerContract: 150,
  totalRisk: 500,
  totalMaxProfit: 150,
  expectedValue: 60,
  evPerRisk: 0.12,
  ...over,
});

const atRisk = (risk: number, over: Partial<SizedTrade> = {}): SizedTrade =>
  sized({ maxLossPerContract: risk, totalRisk: risk, totalMaxProfit: risk / 2, expectedValue: risk / 5, ...over });

const pos = (over: Partial<PortfolioPosition> = {}): PortfolioPosition => ({
  symbol: "NVDA",
  quantity: 10,
  marketValue: 1000,
  currentPrice: 100,
  kind: "equity",
  ...over,
});

const okHoldings = (positions: PortfolioPosition[]): HoldingsSnapshot => ({
  ok: true,
  positions,
  fetchedAt: "2026-10-20T13:00:00.000Z",
  totalValue: positions.reduce((s, p) => s + (p.marketValue ?? 0), 0),
});

const proposalFor = (
  plan: ReturnType<typeof constructPortfolio>,
  holdings: HoldingsSnapshot,
): RebalanceProposal =>
  buildRebalanceProposal({
    id: "proposal-cycle-1",
    cycleId: "cycle-1",
    createdAt: 1760000000000,
    goal: "premium income",
    budget: 10000,
    plan,
    holdings,
  });

/* --------------------------- extractPositions -------------------------- */

describe("extractPositions", () => {
  it("parses a bare array of equity rows", () => {
    const out = extractPositions([
      { symbol: "NVDA", quantity: 10, marketValue: 2180, currentPrice: 218 },
      { symbol: "AMD", quantity: "5", marketValue: "700.5", lastPrice: 140.1 },
    ]);
    expect(out).toEqual([
      { symbol: "NVDA", quantity: 10, marketValue: 2180, currentPrice: 218, kind: null },
      { symbol: "AMD", quantity: 5, marketValue: 700.5, currentPrice: 140.1, kind: null },
    ]);
  });

  it("finds rows nested under portfolio/holdings keys", () => {
    const out = extractPositions({
      portfolio: { holdings: [{ ticker: "SPY", shares: 3, value: 2100, price: 700, type: "equity" }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "SPY", quantity: 3, marketValue: 2100, kind: "equity" });
  });

  it("reads a symbol off a nested instrument and keeps short quantities signed", () => {
    const out = extractPositions([
      { instrument: { symbol: "QQQ" }, quantity: -4, marketValue: -1800 },
    ]);
    expect(out).toEqual([
      { symbol: "QQQ", quantity: -4, marketValue: -1800, currentPrice: null, kind: null },
    ]);
  });

  it("marks option rows and skips rows without a symbol or a nonzero quantity", () => {
    const out = extractPositions([
      { symbol: "NVDA251121C00200000", quantity: -2, marketValue: 450, type: "option" },
      { symbol: "CASH", quantity: 0, marketValue: 5000 },
      { quantity: 7, marketValue: 100 },
      { symbol: "MSFT" },
      "not a row",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "NVDA251121C00200000", quantity: -2, kind: "option" });
  });

  it("does not double-count when the payload nests the same array twice", () => {
    const rows = [{ symbol: "NVDA", quantity: 10, marketValue: 2180 }];
    const out = extractPositions({ positions: rows, portfolio: { positions: rows } });
    expect(out).toHaveLength(1);
  });

  it("answers empty for payloads with no readable positions", () => {
    expect(extractPositions(null)).toEqual([]);
    expect(extractPositions({ totalValue: 12345 })).toEqual([]);
    expect(extractPositions("plain text")).toEqual([]);
  });
});

/* ----------------------------- desk.portfolio ---------------------------- */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PORTFOLIO_TOOL = {
  name: "get_portfolio",
  inputSchema: {
    type: "object",
    properties: { accountId: { type: "string" } },
    required: ["accountId"],
  },
};
const ACCOUNTS_TOOL = { name: "get_accounts", inputSchema: { type: "object", properties: {} } };

type McpHandler = (method: string, params: any) => unknown;

function stubPublicMcp(handler: McpHandler, seen?: { name: string; args: any }[]) {
  globalThis.fetch = (async (_input: unknown, init: any) => {
    const body = JSON.parse(init.body as string);
    if (body.method === "tools/call" && seen) {
      seen.push({ name: body.params.name, args: body.params.arguments });
    }
    const result = handler(body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const toolResult = (payload: unknown) => ({
  content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
});

const fakeHost = (token: string | null): DeskHost => ({
  getPublicToken: async () => token,
  getPublicModel: async () => null,
  runOpportunityHunt: async () => {
    throw new Error("unused in this suite");
  },
  runAutopilot: async () => {
    throw new Error("unused in this suite");
  },
});

describe("desk.portfolio", () => {
  it("returns parsed positions and maps the account id from get_accounts", async () => {
    const seen: { name: string; args: any }[] = [];
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [PORTFOLIO_TOOL, ACCOUNTS_TOOL] };
      if (params.name === "get_accounts") return toolResult([{ accountId: "acct-1", type: "brokerage" }]);
      if (params.name === "get_portfolio") {
        return toolResult({
          positions: [
            { symbol: "NVDA", quantity: 10, marketValue: 2180, currentPrice: 218 },
            { symbol: "AMD", quantity: 5, marketValue: 700, currentPrice: 140 },
          ],
        });
      }
      throw new Error("unexpected tool " + params.name);
    }, seen);
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    const data = reply.data as any;
    expect(data.ok).toBe(true);
    expect(data.count).toBe(2);
    expect(data.totalValue).toBe(2880);
    expect(data.positions[0]).toMatchObject({ symbol: "NVDA", quantity: 10, marketValue: 2180 });
    // Account id was resolved and passed under the schema's own name.
    expect(seen.find((c) => c.name === "get_portfolio")?.args).toEqual({ accountId: "acct-1" });
  });

  it("answers PUBLIC_NOT_CONNECTED when no Public token is stored", async () => {
    stubPublicMcp(() => {
      throw new Error("fetch must not be called without a token");
    });
    const reply = await deskPortfolio(fakeHost(null), {}, "");
    expect(reply.data).toMatchObject({ ok: false, code: "PUBLIC_NOT_CONNECTED" });
  });

  it("answers PUBLIC_NO_TOOLS when the account offers no tools", async () => {
    stubPublicMcp((method) => (method === "tools/list" ? { tools: [] } : {}));
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, code: "PUBLIC_NO_TOOLS" });
  });

  it("answers a structured error when get_portfolio is not offered", async () => {
    stubPublicMcp((method) =>
      method === "tools/list" ? { tools: [{ name: "get_quotes", inputSchema: {} }] } : {},
    );
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "portfolio_tool_unavailable", code: "PUBLIC_UPSTREAM" });
  });

  it("answers a structured error when no account id can be read", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [PORTFOLIO_TOOL, ACCOUNTS_TOOL] };
      if (params.name === "get_accounts") return toolResult([]);
      throw new Error("get_portfolio must not be called without an account id");
    });
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "account_id_unavailable", code: "PUBLIC_UPSTREAM" });
  });

  it("answers portfolio_read_failed when tools/list itself fails upstream", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream down", { status: 500 })) as typeof fetch;
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "portfolio_read_failed" });
  });

  it("answers portfolio_read_failed when the get_portfolio call fails upstream", async () => {
    globalThis.fetch = (async (_input: unknown, init: any) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "tools/call" && body.params.name === "get_portfolio") {
        return new Response("upstream down", { status: 500 });
      }
      const result =
        body.method === "tools/list"
          ? { tools: [PORTFOLIO_TOOL, ACCOUNTS_TOOL] }
          : toolResult([{ accountId: "acct-1" }]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "portfolio_read_failed" });
  });

  it("answers portfolio_unparseable when the result is not JSON", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [PORTFOLIO_TOOL, ACCOUNTS_TOOL] };
      if (params.name === "get_accounts") return toolResult([{ accountId: "acct-1" }]);
      if (params.name === "get_portfolio") return toolResult("portfolio unavailable right now");
      throw new Error("unexpected");
    });
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "portfolio_unparseable", code: "PUBLIC_UPSTREAM" });
  });

  it("answers ok with an empty list when the account holds nothing readable", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [PORTFOLIO_TOOL, ACCOUNTS_TOOL] };
      if (params.name === "get_accounts") return toolResult([{ accountId: "acct-1" }]);
      if (params.name === "get_portfolio") return toolResult({ positions: [] });
      throw new Error("unexpected");
    });
    const reply = await deskPortfolio(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: true, count: 0, positions: [], totalValue: null });
  });
});

/* ------------------------- desk.hunt plan passthrough ------------------------- */

describe("desk.hunt plan passthrough (#329)", () => {
  it("carries the full hunt plan to in-process callers", async () => {
    stubPublicMcp((method) => (method === "tools/list" ? { tools: [{ name: "get_quotes" }] } : {}));
    const plan = {
      trades: [sized()],
      unsized: [],
      rejected: [{ underlying: "TSLA", strategy: "put credit spread", reason: "no spot" }],
      totalRisk: 500,
      totalMaxProfit: 150,
      totalExpectedValue: 60,
      unallocated: 9500,
    };
    const host: DeskHost = {
      ...fakeHost("tok"),
      runOpportunityHunt: async () => ({
        hunt: {
          id: "hunt-1",
          createdAt: "2026-10-20T13:00:00.000Z",
          request: { budget: 10000 },
          model: "m",
          runId: "r1",
          plan,
          summary: "s",
        },
        answer: "answer",
        model: "m",
      }),
    };
    const reply = await deskHunt(host, { budget: 10000 }, "");
    const data = reply.data as any;
    expect(data.ok).toBe(true);
    expect(data.huntId).toBe("hunt-1");
    expect(data.plan).toEqual(plan);
  });
});

/* --------------------------- proposal diff math --------------------------- */

describe("buildRebalanceProposal - diff math", () => {
  const planNvdaAmd = () =>
    constructPortfolio(
      [atRisk(1000, { underlying: "NVDA" }), atRisk(500, { underlying: "AMD", strategy: "call credit spread" })],
      { budget: 10000 },
    );

  it("opens underlyings that are targeted but not held", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([]));
    expect(p.lines.map((l) => [l.underlying, l.action])).toEqual([
      ["AMD", "open"],
      ["NVDA", "open"],
    ]);
    for (const l of p.lines) expect(l.reason.length).toBeGreaterThan(0);
    expect(p.lines.find((l) => l.underlying === "NVDA")).toMatchObject({
      targetRisk: 1000,
      targetShare: 0.1,
      targetTrades: 1,
      currentQuantity: 0,
      currentValue: null,
    });
  });

  it("closes underlyings that are held but absent from the target", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([pos({ symbol: "TSLA", quantity: 4, marketValue: 900 })]));
    const tsla = p.lines.find((l) => l.underlying === "TSLA");
    expect(tsla).toMatchObject({ action: "close", targetRisk: 0, currentQuantity: 4, currentValue: 900 });
    expect(tsla!.reason).toContain("full exit");
  });

  it("treats a held, in-target underlying inside the band as aligned (no action)", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([pos({ marketValue: 1050 })]));
    const nvda = p.lines.find((l) => l.underlying === "NVDA");
    expect(nvda).toMatchObject({ action: "none", currentValue: 1050, currentShare: 0.105 });
    expect(nvda!.reason).toContain("within");
  });

  it("proposes reduce when current exposure is above the band", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([pos({ marketValue: 2000 })]));
    const nvda = p.lines.find((l) => l.underlying === "NVDA");
    expect(nvda).toMatchObject({ action: "reduce", currentShare: 0.2, targetShare: 0.1 });
    expect(nvda!.reason).toContain("above the target risk share");
  });

  it("proposes increase when current exposure is below the band", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([pos({ marketValue: 400 })]));
    const nvda = p.lines.find((l) => l.underlying === "NVDA");
    expect(nvda).toMatchObject({ action: "increase", currentShare: 0.04, targetShare: 0.1 });
    expect(nvda!.reason).toContain("below the target risk share");
  });

  it("proposes no sized delta when a held, in-target underlying has no reported value", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([pos({ marketValue: null, currentPrice: null })]));
    const nvda = p.lines.find((l) => l.underlying === "NVDA");
    expect(nvda).toMatchObject({ action: "none", currentValue: null, currentShare: null });
    expect(nvda!.reason).toContain("no market value");
    expect(p.notes.join(" ")).toContain("no market value from the read path");
  });

  it("aggregates option positions under their underlying", () => {
    const p = proposalFor(
      planNvdaAmd(),
      okHoldings([pos({ symbol: "NVDA251121C00200000", kind: "option", quantity: -2, marketValue: 1000 })]),
    );
    const nvda = p.lines.find((l) => l.underlying === "NVDA");
    expect(nvda).toMatchObject({ action: "none", currentQuantity: -2, currentValue: 1000 });
    expect(underlyingOfPosition(pos({ symbol: "NVDA251121C00200000", kind: "option" }))).toBe("NVDA");
    expect(underlyingOfPosition(pos({ symbol: "BRK.B" }))).toBe("BRK.B");
  });

  it("carries the construction plan's rejections through untouched", () => {
    const plan = constructPortfolio(
      [atRisk(1000, { underlying: "NVDA" }), atRisk(9000, { underlying: "SPY" })],
      { budget: 10000 },
    );
    expect(plan.rejections.length).toBeGreaterThan(0);
    const p = proposalFor(plan, okHoldings([]));
    expect(p.plan.rejections).toEqual(plan.rejections);
    expect(p.plan.allocations).toEqual(plan.allocations);
  });

  it("records the target with NO delta lines when the holdings read failed", () => {
    const p = proposalFor(planNvdaAmd(), { ok: false, error: "portfolio_read_failed" });
    expect(p.lines).toEqual([]);
    expect(p.holdings).toEqual({ ok: false, error: "portfolio_read_failed" });
    expect(p.plan.allocations).toHaveLength(2);
    expect(p.notes.join(" ")).toContain("WITHOUT a diff");
  });

  it("states the review-only guardrail on every proposal", () => {
    const p = proposalFor(planNvdaAmd(), okHoldings([]));
    expect(p.notes.join(" ")).toContain("executes nothing");
    expect(p.notes.join(" ")).toContain("human-approved trade workflow");
  });
});

/* ------------------------------ ProposalStore ------------------------------ */

class FakeCursor extends Array<any> {
  toArray() {
    return [...this];
  }
}

class FakeSql {
  private rows = new Map<string, { id: string; created_at: number; cycle_id: string; data: string }>();

  exec(sql: string, ...params: any[]) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("CREATE TABLE")) return new FakeCursor();
    if (s.startsWith("INSERT OR REPLACE INTO autopilot_proposals")) {
      const [id, created_at, cycle_id, data] = params;
      this.rows.set(id, { id, created_at, cycle_id, data });
      return new FakeCursor();
    }
    if (s.startsWith("SELECT id FROM autopilot_proposals")) {
      const sorted = [...this.rows.values()].sort((a, b) => b.created_at - a.created_at);
      return new FakeCursor(...sorted.map((r) => ({ id: r.id })));
    }
    if (s.startsWith("DELETE FROM autopilot_proposals")) {
      this.rows.delete(params[0]);
      return new FakeCursor();
    }
    if (s.startsWith("SELECT data FROM autopilot_proposals")) {
      const limit = typeof params[0] === "number" ? params[0] : 20;
      const sorted = [...this.rows.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
      return new FakeCursor(...sorted.map((r) => ({ data: r.data })));
    }
    if (s.startsWith("SELECT COUNT(*)")) return new FakeCursor({ c: this.rows.size });
    throw new Error("unhandled SQL in fake: " + s);
  }
}

describe("ProposalStore", () => {
  it("persists proposals and reads the latest back whole", () => {
    const store = new ProposalStore(new FakeSql() as unknown as SqlStorage);
    const plan = constructPortfolio([atRisk(1000)], { budget: 10000 });
    const first = proposalFor(plan, okHoldings([]));
    const second = buildRebalanceProposal({
      id: "proposal-cycle-2",
      cycleId: "cycle-2",
      createdAt: 1760000100000,
      goal: "premium income",
      budget: 10000,
      plan,
      holdings: okHoldings([pos({ marketValue: 2000 })]),
    });
    store.save(first);
    store.save(second);
    expect(store.count()).toBe(2);
    expect(store.latest()?.id).toBe("proposal-cycle-2");
    expect(store.latest()?.lines.find((l) => l.underlying === "NVDA")?.action).toBe("reduce");
    expect(store.list(1).map((p) => p.id)).toEqual(["proposal-cycle-2"]);
    expect(store.list().map((p) => p.id)).toEqual(["proposal-cycle-2", "proposal-cycle-1"]);
  });

  it("prunes to the newest PROPOSALS_MAX_KEPT", () => {
    const store = new ProposalStore(new FakeSql() as unknown as SqlStorage);
    const plan = constructPortfolio([atRisk(1000)], { budget: 10000 });
    for (let i = 0; i < 25; i++) {
      store.save(
        buildRebalanceProposal({
          id: `proposal-${i}`,
          cycleId: `cycle-${i}`,
          createdAt: 1760000000000 + i * 1000,
          goal: "g",
          budget: 10000,
          plan,
          holdings: okHoldings([]),
        }),
      );
    }
    expect(store.count()).toBe(20);
    expect(store.latest()?.id).toBe("proposal-24");
    expect(store.list(20).at(-1)?.id).toBe("proposal-5");
  });

  it("answers honestly when nothing is stored", () => {
    const store = new ProposalStore(new FakeSql() as unknown as SqlStorage);
    expect(store.latest()).toBeNull();
    expect(store.list()).toEqual([]);
    expect(store.count()).toBe(0);
  });
});
