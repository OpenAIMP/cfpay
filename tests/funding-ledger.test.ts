/**
 * Funding ledger (issue #242 P3.1, #331).
 *
 * Hermetic throughout: the Public MCP endpoint is a stubbed global
 * fetch (the desk.portfolio pattern), the DeskHost is a fake, and the
 * ledger arithmetic runs on the pure funding-core functions that
 * PaymentsAgent's callables wrap. No network, no credentials, and -
 * by design - no execution surface anywhere in what is tested here:
 * recording funding movements moves no money.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFundingRecords,
  extractFundingMovements,
  fundingPosition,
  isValidFundingRecord,
  mergeFundingRecords,
  renderFundingPositionText,
  type FundingMovement,
  type FundingRecord,
} from "../src/funding-core";
import { deskFunding, FUNDING_TOOL_CANDIDATES, type DeskHost } from "../src/desk-ops";
import { A2A_OPS } from "../src/a2a-ops";
import { OPERATION_CATALOG } from "../src/orchestrate";

/* ------------------------------ fixtures ------------------------------ */

const ATTR = { tenantId: "user-1", objectiveId: "1", goal: "premium income" };
const RECORDED_AT = "2026-10-20T14:00:00.000Z";

const movement = (over: Partial<FundingMovement> = {}): FundingMovement => ({
  sourceRef: "tr-1",
  direction: "deposit",
  amount: 1000,
  currency: "USD",
  ts: "2026-10-18T15:04:00.000Z",
  description: "ACH deposit",
  ...over,
});

const record = (over: Partial<FundingRecord> = {}): FundingRecord => ({
  ...movement(),
  attribution: { ...ATTR },
  recordedAt: RECORDED_AT,
  ...over,
});

/* ------------------------- extractFundingMovements ------------------------- */

describe("extractFundingMovements", () => {
  it("parses a bare array of transfer rows (typed direction, string amounts)", () => {
    const out = extractFundingMovements([
      { id: "tr-1", type: "deposit", amount: "1000.50", createdAt: "2026-10-18T15:04:00Z" },
      { id: "tr-2", type: "withdrawal", amount: "250", createdAt: "2026-10-19T09:00:00Z" },
    ]);
    expect(out).toEqual([
      {
        sourceRef: "tr-1",
        direction: "deposit",
        amount: 1000.5,
        currency: "USD",
        ts: "2026-10-18T15:04:00.000Z",
        description: null,
      },
      {
        sourceRef: "tr-2",
        direction: "withdrawal",
        amount: 250,
        currency: "USD",
        ts: "2026-10-19T09:00:00.000Z",
        description: null,
      },
    ]);
  });

  it("finds rows nested under an activity key and reads the description", () => {
    const out = extractFundingMovements({
      activity: [
        {
          transferId: "x-9",
          direction: "in",
          amount: 500,
          date: "2026-10-17",
          description: "ACH transfer in",
          currency: "usd",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourceRef: "x-9",
      direction: "deposit",
      amount: 500,
      currency: "USD",
      description: "ACH transfer in",
    });
  });

  it("infers direction from a signed amount when no type says so", () => {
    const out = extractFundingMovements([
      { id: "s-1", amount: -125.25, timestamp: "2026-10-16T12:00:00Z" },
      { id: "s-2", amount: 40, timestamp: "2026-10-16T13:00:00Z" },
    ]);
    expect(out.map((m) => [m.sourceRef, m.direction, m.amount])).toEqual([
      ["s-1", "withdrawal", 125.25],
      ["s-2", "deposit", 40],
    ]);
  });

  it("reads direction words out of activity types and descriptions", () => {
    const out = extractFundingMovements([
      { id: "w-1", type: "ach_withdrawal", amount: 75, created_at: "2026-10-15T00:00:00Z" },
      { id: "d-1", amount: 75, created_at: "2026-10-15T01:00:00Z", description: "Cash deposit from bank" },
    ]);
    expect(out.map((m) => m.direction)).toEqual(["withdrawal", "deposit"]);
  });

  it("skips rows without a reference, a usable amount, a direction, or a date - never invents one", () => {
    const out = extractFundingMovements([
      { type: "deposit", amount: 10, createdAt: "2026-10-18T00:00:00Z" }, // no ref
      { id: "a", type: "deposit", amount: "not-a-number", createdAt: "2026-10-18T00:00:00Z" }, // bad amount
      { id: "b", type: "mystery", amount: 0, createdAt: "2026-10-18T00:00:00Z" }, // zero amount
      { id: "c", type: "deposit", amount: 10, createdAt: "not-a-date" }, // bad date
      { id: "ok", type: "deposit", amount: 10, createdAt: "2026-10-18T00:00:00Z" },
      "not a row",
    ]);
    expect(out.map((m) => m.sourceRef)).toEqual(["ok"]);
  });

  it("dedupes a payload that nests the same array twice", () => {
    const rows = [{ id: "tr-1", type: "deposit", amount: 5, createdAt: "2026-10-18T00:00:00Z" }];
    const out = extractFundingMovements({ transfers: rows, history: { transfers: rows } });
    expect(out).toHaveLength(1);
  });

  it("answers empty for payloads with no readable movements", () => {
    expect(extractFundingMovements(null)).toEqual([]);
    expect(extractFundingMovements({ balance: 12345 })).toEqual([]);
    expect(extractFundingMovements("plain text")).toEqual([]);
  });
});

/* --------------------- record / merge / position --------------------- */

describe("funding ledger arithmetic (the PaymentsAgent write/read path)", () => {
  it("round-trips: movements are attributed, recorded, and totalled exactly", () => {
    const movements = [
      movement({ sourceRef: "tr-1", amount: 1000 }),
      movement({ sourceRef: "tr-2", direction: "withdrawal", amount: 250, ts: "2026-10-19T09:00:00.000Z" }),
    ];
    const built = buildFundingRecords(movements, ATTR, RECORDED_AT);
    expect(built[0].attribution).toEqual(ATTR);
    expect(built[0].recordedAt).toBe(RECORDED_AT);

    const merged = mergeFundingRecords([], built, 200);
    expect(merged).toMatchObject({ recorded: 2, skipped: 0 });

    const position = fundingPosition(merged.records, ATTR.tenantId);
    expect(position).toEqual({
      tenantId: "user-1",
      recorded: true,
      count: 2,
      totalDeposits: 1000,
      totalWithdrawals: 250,
      net: 750,
      lastMovementAt: "2026-10-19T09:00:00.000Z",
    });
  });

  it("aggregates multiple events: deposits and withdrawals net", () => {
    const records = [
      record({ sourceRef: "a", amount: 500 }),
      record({ sourceRef: "b", amount: 1500.33, ts: "2026-10-19T00:00:00.000Z" }),
      record({ sourceRef: "c", direction: "withdrawal", amount: 200.33, ts: "2026-10-19T12:00:00.000Z" }),
      record({ sourceRef: "d", direction: "withdrawal", amount: 50, ts: "2026-10-20T00:00:00.000Z" }),
    ];
    const position = fundingPosition(records, "user-1");
    expect(position.totalDeposits).toBe(2000.33);
    expect(position.totalWithdrawals).toBe(250.33);
    expect(position.net).toBe(1750);
    expect(position.count).toBe(4);
  });

  it("is idempotent: re-recording the same source references records nothing twice", () => {
    const batch = [record({ sourceRef: "a" }), record({ sourceRef: "b", amount: 5 })];
    const first = mergeFundingRecords([], batch, 200);
    const second = mergeFundingRecords(first.records, batch, 200);
    expect(second.recorded).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.records).toHaveLength(2);
    // A mixed batch records only the genuinely new movement.
    const third = mergeFundingRecords(second.records, [batch[0], record({ sourceRef: "c", amount: 7 })], 200);
    expect(third).toMatchObject({ recorded: 1, skipped: 1 });
    expect(fundingPosition(third.records, "user-1").count).toBe(3);
  });

  it("skips invalid records instead of storing them", () => {
    const bad = [
      { ...record(), sourceRef: "" },
      { ...record(), amount: -5 },
      { ...record(), direction: "sideways" },
      { ...record(), attribution: { tenantId: "", objectiveId: "1", goal: "g" } },
    ] as unknown as FundingRecord[];
    const merged = mergeFundingRecords([], bad, 200);
    expect(merged).toMatchObject({ recorded: 0, skipped: 4 });
    expect(isValidFundingRecord(record())).toBe(true);
    expect(isValidFundingRecord(null)).toBe(false);
  });

  it("keeps the ledger bounded to the newest cap records", () => {
    const many = Array.from({ length: 10 }, (_, i) => record({ sourceRef: `r-${i}` }));
    const merged = mergeFundingRecords([], many, 3);
    expect(merged.recorded).toBe(10);
    expect(merged.records.map((r) => r.sourceRef)).toEqual(["r-7", "r-8", "r-9"]);
  });

  it("tenant isolation: another tenant's funding never appears in this tenant's position", () => {
    const records = [
      record({ sourceRef: "mine", amount: 900 }),
      record({
        sourceRef: "theirs",
        amount: 5000,
        attribution: { tenantId: "user-2", objectiveId: "1", goal: "other goal" },
      }),
      record({
        sourceRef: "theirs-2",
        direction: "withdrawal",
        amount: 4000,
        attribution: { tenantId: "user-2", objectiveId: "1", goal: "other goal" },
      }),
    ];
    const mine = fundingPosition(records, "user-1");
    expect(mine).toMatchObject({ count: 1, totalDeposits: 900, net: 900 });
    const theirs = fundingPosition(records, "user-2");
    expect(theirs).toMatchObject({ count: 2, net: 1000 });
    // A tenant with no records at all gets the zero state, not user-2's totals.
    expect(fundingPosition(records, "user-3").recorded).toBe(false);
  });

  it("honest zero state: no records is an explicit state, and the text says so", () => {
    const position = fundingPosition([], "user-1");
    expect(position).toEqual({
      tenantId: "user-1",
      recorded: false,
      count: 0,
      totalDeposits: 0,
      totalWithdrawals: 0,
      net: 0,
      lastMovementAt: null,
    });
    expect(renderFundingPositionText(position)).toContain("no brokerage funding movements recorded yet");
  });

  it("renders a recorded position with the ledger's own figures", () => {
    const text = renderFundingPositionText(fundingPosition([record()], "user-1"));
    expect(text).toContain("$1,000.00 deposited");
    expect(text).toContain("across 1 movement(s)");
    expect(text).toContain("payments ledger, attributed to the objective");
  });
});

/* ------------------------------ desk.funding ------------------------------ */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TRANSFERS_TOOL = {
  name: "get_transfers",
  inputSchema: {
    type: "object",
    properties: { accountId: { type: "string" } },
    required: ["accountId"],
  },
};
const ACTIVITY_TOOL = { name: "get_activity", inputSchema: { type: "object", properties: {} } };
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

describe("desk.funding", () => {
  it("reads movements from the offered transfers tool and maps the account id", async () => {
    const seen: { name: string; args: any }[] = [];
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [TRANSFERS_TOOL, ACCOUNTS_TOOL] };
      if (params.name === "get_accounts") return toolResult([{ accountId: "acct-1", type: "brokerage" }]);
      if (params.name === "get_transfers") {
        return toolResult({
          transfers: [
            { id: "tr-1", type: "deposit", amount: 2000, createdAt: "2026-10-18T10:00:00Z" },
            { id: "tr-2", type: "withdrawal", amount: 300, createdAt: "2026-10-19T10:00:00Z" },
          ],
        });
      }
      throw new Error("unexpected tool " + params.name);
    }, seen);
    const reply = await deskFunding(fakeHost("tok"), {}, "");
    const data = reply.data as any;
    expect(data.ok).toBe(true);
    expect(data.observable).toBe(true);
    expect(data.tool).toBe("get_transfers");
    expect(data.count).toBe(2);
    expect(data.movements[0]).toMatchObject({ sourceRef: "tr-1", direction: "deposit", amount: 2000 });
    expect(seen.find((c) => c.name === "get_transfers")?.args).toEqual({ accountId: "acct-1" });
  });

  it("falls back to a generic activity feed when no transfers tool is offered", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [ACTIVITY_TOOL] };
      if (params.name === "get_activity") {
        return toolResult([{ id: "a-1", type: "deposit", amount: 42, date: "2026-10-10" }]);
      }
      throw new Error("unexpected tool " + params.name);
    });
    const reply = await deskFunding(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: true, observable: true, tool: "get_activity", count: 1 });
  });

  it("the unobservable case: no funding tool offered answers observable:false and invents nothing", async () => {
    stubPublicMcp((method) =>
      method === "tools/list"
        ? { tools: [{ name: "get_portfolio", inputSchema: {} }, { name: "get_quotes", inputSchema: {} }] }
        : {},
    );
    const reply = await deskFunding(fakeHost("tok"), {}, "");
    const data = reply.data as any;
    expect(data.ok).toBe(true);
    expect(data.observable).toBe(false);
    expect(data.movements).toEqual([]);
    expect(reply.text).toContain("not observable");
    expect(reply.text).toContain("Nothing was recorded");
  });

  it("answers PUBLIC_NOT_CONNECTED when no Public token is stored", async () => {
    stubPublicMcp(() => {
      throw new Error("fetch must not be called without a token");
    });
    const reply = await deskFunding(fakeHost(null), {}, "");
    expect(reply.data).toMatchObject({ ok: false, code: "PUBLIC_NOT_CONNECTED" });
  });

  it("answers a structured error when the funding tool's result is not JSON", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [ACTIVITY_TOOL] };
      if (params.name === "get_activity") return toolResult("not json at all");
      throw new Error("unexpected tool " + params.name);
    });
    const reply = await deskFunding(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: false, error: "funding_unparseable", code: "PUBLIC_UPSTREAM" });
  });

  it("an offered tool reporting no movements is observable with an empty list", async () => {
    stubPublicMcp((method, params) => {
      if (method === "tools/list") return { tools: [ACTIVITY_TOOL] };
      if (params.name === "get_activity") return toolResult({ activity: [] });
      throw new Error("unexpected tool " + params.name);
    });
    const reply = await deskFunding(fakeHost("tok"), {}, "");
    expect(reply.data).toMatchObject({ ok: true, observable: true, count: 0, movements: [] });
  });

  it("candidate list is transfer-specific before generic", () => {
    expect(FUNDING_TOOL_CANDIDATES[0]).toBe("get_transfers");
    expect(FUNDING_TOOL_CANDIDATES).toContain("get_activity");
  });
});

/* --------------------------- wiring / guard pins --------------------------- */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("funding wiring + no-execution guard", () => {
  it("catalogues the new ops with the right access classes", () => {
    const byOp = (surface: string, op: string) =>
      (A2A_OPS as Record<string, { operation: string; access: string }[]>)[surface].find(
        (o) => o.operation === op,
      );
    expect(byOp("cfmail", "desk.funding")?.access).toBe("read");
    expect(byOp("payments", "funding.list")?.access).toBe("read");
    expect(byOp("payments", "funding.totals")?.access).toBe("read");
    expect(byOp("payments", "funding.record")?.access).toBe("write");
    expect(byOp("autopilot", "autopilot.funding")?.access).toBe("read");
    expect(byOp("autopilot", "autopilot.fundingSync")?.access).toBe("action");
    // The orchestrator's plannable catalog carries the same surface.
    const autopilotEntry = OPERATION_CATALOG.find((e) => e.agent === "autopilot");
    expect(autopilotEntry?.operations).toContain("autopilot.fundingSync");
    const paymentsEntry = OPERATION_CATALOG.find((e) => e.agent === "payments");
    expect(paymentsEntry?.operations).toContain("funding.record");
  });

  it("routes the ops in their agents' handlers", () => {
    expect(src("agent.ts")).toContain('case "desk.funding"');
    expect(src("payments-agent.ts")).toContain('case "funding.record"');
    expect(src("payments-agent.ts")).toContain('case "funding.list"');
    expect(src("payments-agent.ts")).toContain('case "funding.totals"');
    expect(src("autopilot-agent.ts")).toContain('op === "autopilot.funding"');
    expect(src("autopilot-agent.ts")).toContain('op === "autopilot.fundingSync"');
    expect(src("autopilot-agent.ts")).toContain('"funding.record"');
    expect(src("autopilot-agent.ts")).toContain('"desk.funding"');
  });

  it("the funding paths never invoke payment execution, checkout, or the trade workflow", () => {
    const core = src("funding-core.ts");
    expect(core).not.toContain("processPaidRequest");
    expect(core).not.toContain("createCheckoutIntent");
    expect(core).not.toContain("checkout.create");
    expect(core).not.toContain("payment.process");
    expect(core).not.toContain("callTool");

    // The host's funding read records nothing itself.
    const desk = src("desk-ops.ts");
    const deskFundingBody = desk.slice(desk.indexOf("export async function deskFunding"));
    expect(deskFundingBody).not.toContain("recordFunding");
    expect(deskFundingBody).not.toContain("recordPayment");

    // PaymentsAgent's funding write path is the ledger merge only:
    // slice the funding section and check what it can reach.
    const payments = src("payments-agent.ts");
    const fundingSection = payments.slice(
      payments.indexOf("async recordFunding"),
      payments.indexOf("async fundingTotals"),
    );
    expect(fundingSection).toContain("mergeFundingRecords");
    expect(fundingSection).not.toContain("processPaidRequest");
    expect(fundingSection).not.toContain("createCheckoutIntent");
    expect(fundingSection).not.toContain("fulfilCheckout");

    // AutopilotAgent's funding sync touches no trade path.
    const autopilot = src("autopilot-agent.ts");
    const syncSection = autopilot.slice(
      autopilot.indexOf("async autopilotFundingSync"),
      autopilot.indexOf("async autopilotSummary"),
    );
    expect(syncSection).not.toContain("proposeTrade");
    expect(syncSection).not.toContain("TradeWorkflow");
    expect(syncSection).not.toContain("runWorkflow");
    expect(syncSection).not.toContain("payment.process");
    expect(syncSection).not.toContain("checkout");
  });

  it("funding records live in PaymentsAgent state, not in AutopilotAgent storage", () => {
    const payments = src("payments-agent.ts");
    expect(payments).toContain("funding: FundingRecord[]");
    expect(payments).toContain("MAX_STORED_FUNDING");
    const autopilot = src("autopilot-agent.ts");
    expect(autopilot).not.toContain("CREATE TABLE IF NOT EXISTS autopilot_funding");
    expect(autopilot).not.toContain("autopilot_funding");
  });
});
