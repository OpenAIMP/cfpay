/**
 * Proposal surfaces (issue #242 P2.3, #330).
 *
 * P2.2 (#329) persisted rebalance proposals; this slice makes them
 * readable everywhere they are shown. The pins here:
 * - renderProposalText (src/autopilot-proposals.ts) is the ONE text
 *   renderer: goal + budget, the holdings basis, every delta line
 *   with its reason, the construction rejections, and the basis
 *   notes - plus honest renderings for the no-proposal state and
 *   for a proposal whose holdings read failed.
 * - Wiring: the autopilot summary/snapshot/proposals replies, the
 *   QA desk snapshot email, the dashboard Autopilot card, and smoke
 *   section 16 all reach the proposal through that renderer or the
 *   same structured record - no second text rendering exists.
 *
 * Hermetic: proposals are built with the pure constructors over
 * fixtures, exactly like tests/autopilot-proposals.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { constructPortfolio } from "../src/portfolio-core";
import {
  buildRebalanceProposal,
  renderProposalText,
  type HoldingsSnapshot,
  type RebalanceProposal,
} from "../src/autopilot-proposals";
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

/* --------------------------- renderProposalText --------------------------- */

describe("renderProposalText", () => {
  it("renders goal, budget, holdings basis, every delta line with its reason, and the basis notes", () => {
    const plan = constructPortfolio(
      [atRisk(1000, { underlying: "NVDA" }), atRisk(500, { underlying: "AMD", strategy: "call credit spread" })],
      { budget: 10000 },
    );
    // NVDA held above the band (reduce), AMD unheld (open), TSLA held
    // but untargeted (close): three distinct delta kinds in one text.
    const p = proposalFor(
      plan,
      okHoldings([pos({ marketValue: 2000 }), pos({ symbol: "TSLA", quantity: 4, marketValue: 900 })]),
    );
    const text = renderProposalText(p);
    expect(text).toContain("Rebalance proposal proposal-cycle-1 (cycle cycle-1,");
    expect(text).toContain("review record only; nothing has been executed.");
    expect(text).toContain('Goal: "premium income" - budget $10,000.');
    expect(text).toContain("Holdings basis: read OK at 2026-10-20T13:00:00.000Z - 2 position(s), total reported value $2,900.");
    expect(text).toContain("Target allocation: $1,500 total max risk across 2 allocated trade(s); $8,500 of the budget unallocated.");
    for (const l of p.lines) {
      expect(text).toContain(`- ${l.action.toUpperCase()} ${l.underlying}: ${l.reason}`);
    }
    expect(text).toContain("- REDUCE NVDA:");
    expect(text).toContain("- OPEN AMD:");
    expect(text).toContain("- CLOSE TSLA:");
    // The comparison basis is stated on the face of the rendering.
    expect(text).toContain("an exposure proxy for human review, not a like-for-like risk measure");
    expect(text).toContain("Notes:");
  });

  it("renders the construction rejections with reason codes and details", () => {
    const plan = constructPortfolio(
      [atRisk(1000, { underlying: "NVDA" }), atRisk(9000, { underlying: "SPY" })],
      { budget: 10000 },
    );
    expect(plan.rejections.length).toBeGreaterThan(0);
    const text = renderProposalText(proposalFor(plan, okHoldings([])));
    expect(text).toContain(`Construction rejections (${plan.rejections.length}):`);
    for (const r of plan.rejections) {
      expect(text).toContain(`- ${r.underlying} (${r.strategy}, exp ${r.expiry}) [${r.reason}]: ${r.detail}`);
    }
  });

  it("states 'Construction rejections: none.' when the plan rejected nothing", () => {
    const plan = constructPortfolio([atRisk(1000)], { budget: 10000 });
    const text = renderProposalText(proposalFor(plan, okHoldings([])));
    expect(text).toContain("Construction rejections: none.");
  });

  it("renders the no-proposal state honestly, never as an empty string", () => {
    for (const empty of [null, undefined]) {
      const text = renderProposalText(empty);
      expect(text.startsWith("No rebalance proposals yet.")).toBe(true);
      expect(text).toContain("autopilot.runCycle");
      expect(text).toContain("desk.portfolio");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("renders a holdings-failure proposal with the failure named and zero delta actions", () => {
    const plan = constructPortfolio(
      [atRisk(1000, { underlying: "NVDA" }), atRisk(500, { underlying: "AMD", strategy: "call credit spread" })],
      { budget: 10000 },
    );
    const p = proposalFor(plan, { ok: false, error: "portfolio_read_failed" });
    expect(p.lines).toEqual([]);
    const text = renderProposalText(p);
    expect(text).toContain("Holdings basis: READ FAILED (portfolio_read_failed)");
    expect(text).toContain("NO delta actions");
    expect(text).toContain("- none (no holdings diff was computed for this proposal).");
    expect(text).not.toContain("- OPEN ");
    expect(text).not.toContain("- CLOSE ");
    // The target side still renders: the plan was recorded, not lost.
    expect(text).toContain("Target allocation: $1,500 total max risk across 2 allocated trade(s)");
  });

  it("renders an empty plan against empty holdings with explicit empty sections", () => {
    const plan = constructPortfolio([], { budget: 10000 });
    const text = renderProposalText(proposalFor(plan, okHoldings([])));
    expect(text).toContain("Holdings basis: read OK");
    expect(text).toContain("0 position(s), total reported value $0.");
    expect(text).toContain("- none (no holdings diff was computed for this proposal).");
    expect(text).toContain("Construction rejections: none.");
  });
});

/* --------------------------------- wiring --------------------------------- */

describe("proposal surfaces wiring (#330)", () => {
  it("routes every text surface through the one renderer", () => {
    const agent = read("src/autopilot-agent.ts");
    const qa = read("src/qa-agent.ts");
    const stubs = read("src/agent-stubs.ts");
    // The agent: summary, snapshot (default reply) and proposals all
    // render via renderProposalText; the proposals op adds no second
    // hand-rolled rendering.
    expect(agent).toContain("renderProposalText");
    expect(agent).toContain("renderProposalText(s.lastProposal as RebalanceProposal | null)");
    expect(agent).toContain("renderProposalText(proposals[0] ?? null)");
    expect(agent).not.toContain("actionable");
    // The desk snapshot email includes the rendered latest proposal,
    // read through the single-owner stub.
    expect(stubs).toContain("autopilotAgentStub");
    expect(stubs).toContain('"autopilot"');
    expect(qa).toContain("autopilotAgentStub");
    expect(qa).toContain("autopilotProposals(1)");
    expect(qa).toContain("renderProposalText(proposals?.[0] ?? null)");
    expect(qa).toContain("Latest rebalance proposal could not be read");
  });

  it("surfaces the latest proposal on the dashboard Autopilot card", () => {
    const desk = read("public/public-data.js");
    expect(desk).toContain('id="deskApProposal"');
    expect(desk).toContain("deskApProposalHtml");
    expect(desk).toContain("s.lastProposal");
    expect(desk).toContain("No rebalance proposals yet");
    // User-influenced strings are escaped in the HTML renderer.
    expect(desk).toContain("escapeHtml(p.goal)");
    expect(desk).toContain("escapeHtml(l.reason)");
    expect(desk).toContain("escapeHtml(r.detail)");
  });

  it("extends the post-deploy smoke with the proposals read-surface section", () => {
    const smoke = read("scripts/qa-smoke.mjs");
    expect(smoke).toContain("autopilot rebalance proposals read surface");
    expect(smoke).toContain('"/a2a/autopilot"');
    expect(smoke).toContain('"autopilot.proposals"');
    // Both honest states pass; only a malformed/erroring surface fails.
    expect(smoke).toContain('text.includes("No rebalance proposals yet")');
    expect(smoke).toContain('text.includes("review record only")');
  });
});
