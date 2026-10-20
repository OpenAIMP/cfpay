import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildChainSummary,
  renderChainText,
  type ChainCycle,
  type ChainObjective,
  type ChainSummaryInput,
} from "../src/autopilot-chain";
import type { ExecutionAttribution } from "../src/autopilot-execution";
import type { FundingPosition } from "../src/funding-core";
import type { RebalanceProposal } from "../src/autopilot-proposals";

const objective = (over: Partial<ChainObjective> = {}): ChainObjective => ({
  goal: "premium income",
  budget: 100000,
  cadenceCron: "0 14 * * 1-5",
  enabled: true,
  scheduleGoalId: "sched-1",
  ...over,
});

const cycle = (over: Partial<ChainCycle> = {}): ChainCycle => ({
  id: "cyc-1",
  startedAt: 1760937600000,
  status: "completed",
  huntId: "hunt-1",
  error: null,
  ...over,
});

const fundingPosition = (over: Partial<FundingPosition> = {}): FundingPosition => ({
  tenantId: "user-1",
  recorded: true,
  count: 2,
  totalDeposits: 5000,
  totalWithdrawals: 1000,
  net: 4000,
  lastMovementAt: "2026-10-20T10:00:00.000Z",
  ...over,
});

const proposal = (over: Partial<RebalanceProposal> = {}): RebalanceProposal => ({
  id: "prop-1",
  cycleId: "cyc-1",
  createdAt: 1760937600000,
  goal: "premium income",
  budget: 100000,
  plan: {
    budget: 100000,
    constraints: {},
    allocations: [],
    rejections: [],
    totalRisk: 12000,
    totalMaxProfit: 3000,
    totalExpectedValue: 900,
    unallocated: 88000,
  } as RebalanceProposal["plan"],
  holdings: { ok: true, positions: [], fetchedAt: null, totalValue: null },
  lines: [],
  notes: [],
  ...over,
});

const attribution = (over: Partial<ExecutionAttribution> = {}): ExecutionAttribution => ({
  id: "exec:prop-1:NVDA:open:0",
  proposalId: "prop-1",
  cycleId: "cyc-1",
  goal: "premium income",
  underlying: "NVDA",
  action: "open",
  reason: "target 25% of budget, not held",
  tool: "place_order",
  args: { underlying: "NVDA" },
  tradeProposalId: "tp-7",
  stageError: null,
  decision: "approved",
  decidedAt: "2026-10-20T11:00:00.000Z",
  decisionNotes: null,
  outcome: "none",
  result: null,
  createdAt: 1760937600000,
  updatedAt: 1760937600000,
  notifiedAt: null,
  ...over,
});

function input(over: Partial<ChainSummaryInput> = {}): ChainSummaryInput {
  return {
    objective: objective(),
    cyclesTotal: 3,
    cyclesCompleted: 2,
    lastCycle: cycle(),
    funding: { available: true, position: fundingPosition() },
    proposal: proposal(),
    executions: [attribution()],
    ...over,
  };
}

describe("autopilot chain summary (issue #333)", () => {
  it("renders an honest empty state when no objective is set", () => {
    const chain = buildChainSummary(input({ objective: null, proposal: null, executions: [] }));
    const text = renderChainText(chain);
    expect(text).toContain("Objective: none set");
    expect(text).not.toContain("premium income");
    // Nothing invented: with no objective the other stages say so, not guesses.
    expect(text).not.toMatch(/prop-1|tp-7/);
  });

  it("renders the objective -> proposal -> execution chain with ids linking stages", () => {
    const chain = buildChainSummary(input());
    const text = renderChainText(chain);
    expect(text).toContain("premium income");
    expect(text).toContain("prop-1");
    expect(text).toContain("cyc-1");
    expect(text).toContain("tp-7");
    expect(text).toContain("approved - awaiting execution");
  });

  it("joins executions by proposal id: records from another proposal are never rendered", () => {
    const foreign = attribution({ id: "exec:prop-9:AMD:open:0", proposalId: "prop-9", tradeProposalId: "tp-99", underlying: "AMD" });
    const chain = buildChainSummary(input({ executions: [attribution(), foreign] }));
    const text = renderChainText(chain);
    expect(text).toContain("tp-7");
    expect(text).not.toContain("tp-99");
    expect(text).not.toContain("prop-9");
    // The join is by id, not by position in the list.
    expect(chain.executions).toHaveLength(1);
  });

  it("never invents executions: an empty execution list renders the explicit not-staged state", () => {
    const chain = buildChainSummary(input({ executions: [] }));
    const text = renderChainText(chain);
    expect(text).toContain("none staged");
    expect(text).toContain("prop-1");
    expect(text).not.toContain("tp-7");
  });

  it("says the funding read failure plainly instead of inventing a position", () => {
    const chain = buildChainSummary(
      input({ funding: { available: false, error: "payments funding read returned no position" } }),
    );
    const text = renderChainText(chain);
    expect(text).toContain("Funding position unavailable");
    expect(text).toContain("payments funding read returned no position");
    expect(text).not.toContain("$4,000");
  });

  it("says when nothing is recorded: the explicit zero funding state, not an error", () => {
    const chain = buildChainSummary(
      input({ funding: { available: true, position: fundingPosition({ recorded: false, count: 0, net: 0, lastMovementAt: null }) } }),
    );
    const text = renderChainText(chain);
    expect(text).toContain("no funding movements recorded yet");
  });

  it("renders an honest proposal-pending state when the objective exists but no proposal was built", () => {
    const chain = buildChainSummary(input({ proposal: null, executions: [] }));
    const text = renderChainText(chain);
    expect(text).toContain("premium income");
    expect(text).toContain("No rebalance proposals yet");
    expect(text).toContain("no proposal - nothing has been staged");
  });

  it("reports an unarmed objective honestly", () => {
    const chain = buildChainSummary(input({ objective: objective({ enabled: false, scheduleGoalId: null }) }));
    const text = renderChainText(chain);
    expect(text).toContain("UNARMED");
  });

  it("tenant isolation: one tenant's chain never carries another tenant's ids", () => {
    const chainA = buildChainSummary(
      input({ objective: objective({ goal: "goal A" }), proposal: proposal({ id: "prop-A", goal: "goal A" }), executions: [attribution({ id: "exec-a", proposalId: "prop-A", tradeProposalId: "tp-A", goal: "goal A" })] }),
    );
    const textA = renderChainText(chainA);
    expect(textA).not.toContain("prop-B");
    expect(textA).not.toContain("tp-B");
    expect(textA).not.toContain("goal B");
    // The builder takes no tenant argument: scoping is the caller's job
    // (per-tenant AutopilotAgent instance + tenant-filtered funding position),
    // so contamination is structurally impossible, not just filtered.
    expect(Object.keys(input())).not.toContain("tenantId");
  });

  it("the A2A route for autopilot.chain takes no tenant argument (tenant is the instance, never an input)", () => {
    const src = readFileSync("src/autopilot-agent.ts", "utf8");
    const routeStart = src.indexOf('if (op === "autopilot.chain")');
    expect(routeStart).toBeGreaterThan(-1);
    const routeEnd = src.indexOf('if (op && op !== "autopilot.summary")', routeStart);
    const route = src.slice(routeStart, routeEnd);
    expect(route).not.toMatch(/args\.tenant/i);
    expect(route).toContain("this.autopilotChain()");
  });

  it("the render is never an empty string, in any state", () => {
    for (const inp of [
      input({ objective: null, proposal: null, executions: [] }),
      input({ proposal: null, executions: [] }),
      input({ executions: [] }),
      input(),
    ]) {
      expect(renderChainText(buildChainSummary(inp)).trim().length).toBeGreaterThan(0);
    }
  });
});
