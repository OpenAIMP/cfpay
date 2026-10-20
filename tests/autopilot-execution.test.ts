/**
 * Execution attribution (issue #242 P3.2, #332).
 *
 * Hermetic throughout: proposals are built with the real construction
 * + proposal builders over fixture trades/holdings, the attribution
 * store runs on an in-memory SqlStorage, and the host trade ledger is
 * a plain status view - the fold logic under test is pure. No
 * network, no credentials.
 *
 * The guardrail under test, stated once: this slice stages trade
 * proposals into the EXISTING human-approval workflow and records
 * what the human gate decided. Nothing in it can approve, decide,
 * or execute a trade - the source pins at the bottom hold that
 * line for the new module and the agent's new seams.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { constructPortfolio } from "../src/portfolio-core";
import {
  buildRebalanceProposal,
  type HoldingsSnapshot,
  type RebalanceProposal,
} from "../src/autopilot-proposals";
import {
  applyTradeStatus,
  buildStagedOrders,
  ExecutionStore,
  executionStateLabel,
  isTerminalAttribution,
  renderExecutionsText,
  STAGED_ORDER_TOOL,
  tradeDoneText,
  type ExecutionAttribution,
} from "../src/autopilot-execution";
import type { PortfolioPosition } from "../src/public-data";
import type { SizedTrade } from "../src/opportunity-hunt";

const read = (p: string) => readFileSync(p, "utf8");

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

const planOf = (trades: SizedTrade[]) => constructPortfolio(trades, { budget: 10000 });

const baseRecord = (over: Partial<ExecutionAttribution> = {}): ExecutionAttribution => ({
  id: "exec:proposal-cycle-1:NVDA:open:0",
  proposalId: "proposal-cycle-1",
  cycleId: "cycle-1",
  goal: "premium income",
  underlying: "NVDA",
  action: "open",
  reason: "Target allocates $500 of risk.",
  tool: STAGED_ORDER_TOOL,
  args: { underlying: "NVDA" },
  tradeProposalId: "trade-1",
  stageError: null,
  decision: "pending",
  decidedAt: null,
  decisionNotes: null,
  outcome: "none",
  result: null,
  createdAt: 1760000000000,
  updatedAt: 1760000000000,
  notifiedAt: null,
  ...over,
});

/* --------------------------- buildStagedOrders --------------------------- */

describe("buildStagedOrders", () => {
  it("stages one order per allocated trade for an open line, with the trade's exact figures", () => {
    const proposal = proposalFor(
      planOf([sized(), sized({ underlying: "AMD", totalRisk: 400, maxLossPerContract: 400 })]),
      okHoldings([]),
    );
    const orders = buildStagedOrders(proposal);
    expect(orders).toHaveLength(2);
    const nvda = orders.find((o) => o.underlying === "NVDA")!;
    expect(nvda.action).toBe("open");
    expect(nvda.tool).toBe(STAGED_ORDER_TOOL);
    expect(nvda.args).toMatchObject({
      underlying: "NVDA",
      strategy: "put credit spread",
      expiry: EXPIRY,
      contracts: 1,
      credit: 1.25,
    });
    expect(nvda.args.legs).toEqual([
      { action: "sell", type: "put", strike: 200 },
      { action: "buy", type: "put", strike: 195 },
    ]);
    // The attribution rides the trade proposal's question: proposal
    // id + goal + the line's reason, for the human approver to read.
    expect(nvda.question).toContain("proposal-cycle-1");
    expect(nvda.question).toContain("premium income");
    expect(nvda.key).toBe("proposal-cycle-1:NVDA:open:0");
  });

  it("stages an increase line from the allocations behind it", () => {
    const proposal = proposalFor(
      planOf([sized()]), // target risk 500 = 5% of the 10000 budget
      okHoldings([pos({ marketValue: 100 })]), // held share 1% - below the band
    );
    expect(proposal.lines[0].action).toBe("increase");
    const orders = buildStagedOrders(proposal);
    expect(orders).toHaveLength(1);
    expect(orders[0].action).toBe("increase");
    expect(orders[0].args).toMatchObject({ underlying: "NVDA", contracts: 1, credit: 1.25 });
  });

  it("stages a reduce line against the held positions, exactly as read", () => {
    const proposal = proposalFor(
      planOf([sized()]), // target 5%
      okHoldings([pos({ marketValue: 3000, quantity: 7 })]), // held share 30% - above the band
    );
    expect(proposal.lines[0].action).toBe("reduce");
    const orders = buildStagedOrders(proposal);
    expect(orders).toHaveLength(1);
    expect(orders[0].action).toBe("reduce");
    expect(orders[0].args).toMatchObject({
      underlying: "NVDA",
      action: "reduce",
      currentValue: 3000,
      targetRisk: 500,
    });
    expect(orders[0].args.positions).toEqual([{ symbol: "NVDA", quantity: 7 }]);
  });

  it("stages a close line for a held underlying the target drops, OCC symbol intact", () => {
    const proposal = proposalFor(
      planOf([sized()]),
      okHoldings([
        pos({ symbol: "MSFT260116C00400000", quantity: -2, marketValue: 800, kind: "option" }),
      ]),
    );
    const close = proposal.lines.find((l) => l.underlying === "MSFT")!;
    expect(close.action).toBe("close");
    const orders = buildStagedOrders(proposal).filter((o) => o.underlying === "MSFT");
    expect(orders).toHaveLength(1);
    expect(orders[0].args.positions).toEqual([{ symbol: "MSFT260116C00400000", quantity: -2 }]);
  });

  it("stages nothing for an aligned (none) line", () => {
    const proposal = proposalFor(
      planOf([sized()]), // target 5%
      okHoldings([pos({ marketValue: 500 })]), // held share exactly 5% - inside the band
    );
    expect(proposal.lines[0].action).toBe("none");
    expect(buildStagedOrders(proposal)).toEqual([]);
  });

  it("stages nothing when the holdings read failed (the plan was recorded without a diff)", () => {
    const proposal = proposalFor(planOf([sized()]), { ok: false, error: "portfolio_unparseable" });
    expect(proposal.lines).toEqual([]);
    expect(buildStagedOrders(proposal)).toEqual([]);
  });
});

/* ---------------------------- applyTradeStatus ---------------------------- */

describe("applyTradeStatus", () => {
  it("keeps a pending trade awaiting approval, unchanged on re-fold", () => {
    const rec = baseRecord();
    const first = applyTradeStatus(rec, { status: "pending" }, 1000);
    expect(first.record.decision).toBe("pending");
    expect(first.record.outcome).toBe("none");
    expect(first.changed).toBe(false);
    expect(first.completed).toBeNull();
  });

  it("writes the approval decision back with its timestamp and notes", () => {
    const { record, changed } = applyTradeStatus(
      baseRecord(),
      { status: "approved", decidedAt: "2026-10-20T14:00:00.000Z", decisionNotes: "go" },
      1000,
    );
    expect(changed).toBe(true);
    expect(record.decision).toBe("approved");
    expect(record.decidedAt).toBe("2026-10-20T14:00:00.000Z");
    expect(record.decisionNotes).toBe("go");
    expect(record.outcome).toBe("none"); // approved is not executed
    expect(isTerminalAttribution(record)).toBe(false);
  });

  it("writes rejection back as terminal, with no execution outcome", () => {
    const { record, completed } = applyTradeStatus(
      baseRecord(),
      { status: "rejected", decidedAt: "2026-10-20T14:00:00.000Z", decisionNotes: "no" },
      1000,
    );
    expect(record.decision).toBe("rejected");
    expect(record.outcome).toBe("none");
    expect(completed).toBeNull();
    expect(isTerminalAttribution(record)).toBe(true);
  });

  it("writes expiry back as terminal with no decision", () => {
    const { record } = applyTradeStatus(baseRecord(), { status: "expired" }, 1000);
    expect(record.decision).toBe("expired");
    expect(record.outcome).toBe("none");
    expect(isTerminalAttribution(record)).toBe(true);
  });

  it("writes an executed outcome back against the approval, once", () => {
    const approved = applyTradeStatus(
      baseRecord(),
      { status: "approved", decidedAt: "2026-10-20T14:00:00.000Z" },
      1000,
    ).record;
    const done = applyTradeStatus(approved, { status: "executed", result: "filled 1 @ 1.25" }, 2000);
    expect(done.record.decision).toBe("approved");
    expect(done.record.outcome).toBe("executed");
    expect(done.record.result).toContain("filled");
    expect(done.completed).toBe("executed");
    expect(isTerminalAttribution(done.record)).toBe(true);
    // A second fold of the same state completes nothing again - the
    // Slack trade-done belongs to the first observation only.
    const again = applyTradeStatus(done.record, { status: "executed", result: "filled 1 @ 1.25" }, 3000);
    expect(again.completed).toBeNull();
    expect(again.changed).toBe(false);
  });

  it("writes an execution failure back with the recorded reason", () => {
    const approved = applyTradeStatus(
      baseRecord(),
      { status: "approved", decidedAt: "2026-10-20T14:00:00.000Z" },
      1000,
    ).record;
    const failed = applyTradeStatus(
      approved,
      { status: "failed", decidedAt: "2026-10-20T14:00:00.000Z", result: "Trading was disabled." },
      2000,
    );
    expect(failed.record.decision).toBe("approved");
    expect(failed.record.outcome).toBe("failed");
    expect(failed.record.result).toContain("Trading was disabled");
    expect(failed.completed).toBe("failed");
  });

  it("keeps the recorded decision when a failure carries no decision timestamp", () => {
    const rec = baseRecord({ decision: "approved", decidedAt: "2026-10-20T14:00:00.000Z" });
    const { record } = applyTradeStatus(rec, { status: "failed", result: "workflow error" }, 1000);
    expect(record.decision).toBe("approved");
    expect(record.outcome).toBe("failed");
  });

  it("never folds into a record whose staging failed (no trade id)", () => {
    const rec = baseRecord({ tradeProposalId: null, stageError: "workflow could not start", outcome: "failed" });
    const { record, changed, completed } = applyTradeStatus(rec, { status: "executed" }, 1000);
    expect(record).toBe(rec);
    expect(changed).toBe(false);
    expect(completed).toBeNull();
    expect(isTerminalAttribution(rec)).toBe(true);
  });

  it("ignores an unrecognized host status rather than inventing a state", () => {
    const rec = baseRecord();
    const { record, changed } = applyTradeStatus(rec, { status: "mystery" }, 1000);
    expect(record).toBe(rec);
    expect(changed).toBe(false);
  });
});

/* ----------------------------- ExecutionStore ----------------------------- */

class FakeCursor extends Array<any> {
  toArray() {
    return [...this];
  }
}

class FakeSql {
  private rows = new Map<string, { id: string; proposal_id: string; created_at: number; data: string }>();

  exec(sql: string, ...params: any[]) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("CREATE TABLE")) return new FakeCursor();
    if (s.startsWith("INSERT OR REPLACE INTO autopilot_executions")) {
      const [id, proposal_id, created_at, data] = params;
      this.rows.set(id, { id, proposal_id, created_at, data });
      return new FakeCursor();
    }
    if (s.startsWith("SELECT id FROM autopilot_executions")) {
      const sorted = [...this.rows.values()].sort((a, b) => b.created_at - a.created_at);
      return new FakeCursor(...sorted.map((r) => ({ id: r.id })));
    }
    if (s.startsWith("DELETE FROM autopilot_executions")) {
      this.rows.delete(params[0]);
      return new FakeCursor();
    }
    if (s.startsWith("SELECT data FROM autopilot_executions WHERE proposal_id")) {
      const sorted = [...this.rows.values()]
        .filter((r) => r.proposal_id === params[0])
        .sort((a, b) => b.created_at - a.created_at);
      return new FakeCursor(...sorted.map((r) => ({ data: r.data })));
    }
    if (s.startsWith("SELECT data FROM autopilot_executions")) {
      const limit = typeof params[0] === "number" ? params[0] : 50;
      const sorted = [...this.rows.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
      return new FakeCursor(...sorted.map((r) => ({ data: r.data })));
    }
    if (s.startsWith("SELECT COUNT(*)")) return new FakeCursor({ c: this.rows.size });
    throw new Error("unhandled SQL in fake: " + s);
  }
}

describe("ExecutionStore", () => {
  it("persists attribution records and reads them back by proposal", () => {
    const store = new ExecutionStore(new FakeSql() as unknown as SqlStorage);
    store.save(baseRecord());
    store.save(baseRecord({ id: "exec:proposal-cycle-1:AMD:open:0", proposalId: "proposal-cycle-1", underlying: "AMD", createdAt: 1760000001000 }));
    store.save(baseRecord({ id: "exec:proposal-cycle-9:AMD:open:0", proposalId: "proposal-cycle-9", createdAt: 1760000002000 }));
    expect(store.count()).toBe(3);
    expect(store.byProposal("proposal-cycle-1").map((r) => r.underlying).sort()).toEqual(["AMD", "NVDA"]);
    expect(store.byProposal("proposal-cycle-9")).toHaveLength(1);
    expect(store.list(1)[0].proposalId).toBe("proposal-cycle-9");
  });

  it("updates a record in place on re-save (the write-back path)", () => {
    const store = new ExecutionStore(new FakeSql() as unknown as SqlStorage);
    store.save(baseRecord());
    const done = applyTradeStatus(baseRecord(), { status: "executed", result: "filled" }, 2000).record;
    store.save(done);
    expect(store.count()).toBe(1);
    expect(store.list()[0].outcome).toBe("executed");
  });
});

/* ------------------------- rendering + Slack text ------------------------- */

describe("renderExecutionsText + tradeDoneText", () => {
  it("renders the explicit empty state", () => {
    const text = renderExecutionsText([]);
    expect(text).toContain("No execution attributions yet.");
    expect(text).toContain("autopilot.submitProposal");
  });

  it("renders all four chain states with their ids", () => {
    const awaiting = baseRecord();
    const rejected = baseRecord({
      id: "exec:p:AMD:open:0",
      underlying: "AMD",
      decision: "rejected",
      decidedAt: "2026-10-20T14:00:00.000Z",
      decisionNotes: "not this week",
    });
    const executed = baseRecord({
      id: "exec:p:SPY:close:0",
      underlying: "SPY",
      action: "close",
      decision: "approved",
      outcome: "executed",
      result: "closed 2 contracts",
    });
    const failed = baseRecord({
      id: "exec:p:QQQ:open:0",
      underlying: "QQQ",
      decision: "approved",
      outcome: "failed",
      result: "Trading was disabled on this deployment.",
    });
    const text = renderExecutionsText([awaiting, rejected, executed, failed]);
    expect(text).toContain("awaiting approval");
    expect(text).toContain("rejected");
    expect(text).toContain("not this week");
    expect(text).toContain("executed");
    expect(text).toContain("closed 2 contracts");
    expect(text).toContain("execution failed");
    expect(text).toContain("proposal-cycle-1");
    expect(text).toContain("trade-1");
    expect(executionStateLabel(awaiting)).toBe("awaiting approval");
  });

  it("renders a staging failure as its own state, with the error", () => {
    const rec = baseRecord({ tradeProposalId: null, stageError: "workflow could not start", outcome: "failed", decision: "none" });
    const text = renderExecutionsText([rec]);
    expect(text).toContain("staging failed");
    expect(text).toContain("workflow could not start");
  });

  it("trade-done text carries the proposal id, the trade id, and the goal", () => {
    const executed = baseRecord({ decision: "approved", outcome: "executed" });
    const text = tradeDoneText(executed);
    expect(text).toContain("proposal-cycle-1");
    expect(text).toContain("trade-1");
    expect(text).toContain("premium income");
    expect(text).toContain("executed");
    const failed = tradeDoneText(baseRecord({ decision: "approved", outcome: "failed", result: "boom" }));
    expect(failed).toContain("FAILED");
    expect(failed).toContain("boom");
  });
});

/* ------------------------------- guard pins ------------------------------- */

describe("guardrail pins (issue #242: no new approval or execution path)", () => {
  const core = read("src/autopilot-execution.ts");
  const agent = read("src/autopilot-agent.ts");

  it("the slice never decides, approves, or executes a trade proposal", () => {
    for (const src of [core, agent]) {
      expect(src).not.toContain("decideTradeProposal");
      expect(src).not.toContain("executeTradeProposal");
      expect(src).not.toContain("recordTradeDecision");
      expect(src).not.toContain("sendWorkflowEvent");
    }
    // The new core module references no workflow machinery at all.
    expect(core).not.toContain("TradeWorkflow");
    expect(core).not.toContain("runWorkflow");
  });

  it("staging enters only through the host's proposeTrade callable seam", () => {
    expect(agent).toContain("hostStubFor");
    expect(agent).toContain(".proposeTrade(");
    // The read seam is the host's own trade-ledger callable.
    expect(agent).toContain(".getTradeProposal(");
  });

  it("staging refuses while trading is disabled on the deployment", () => {
    expect(agent).toContain("PUBLIC_ALLOW_TRADING");
    expect(agent).toContain("trading_disabled");
  });

  it("the agent routes both new operations", () => {
    expect(agent).toContain('op === "autopilot.submitProposal"');
    expect(agent).toContain('op === "autopilot.executions"');
    expect(agent).toContain("autopilotSubmitProposal");
    expect(agent).toContain("autopilotExecutions");
  });

  it("the trade-done rides the existing SlackAgent notify path", () => {
    expect(agent).toContain("tradeDoneText");
    // bestEffortNotify is the agent's pre-existing slack.notify dispatch.
    expect(agent).toContain('dispatchToAgent("SLACK_AGENT", "slack", "slack.notify"');
  });
});
