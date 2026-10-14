import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { CfmailAgentSQLite } from "./agent";
import type { TradeWorkflowParams } from "./types";

/**
 * The approval gate between a model-proposed Public.com order and its
 * execution, following the think-workflows pattern: a durable Workflow owns
 * the waiting, the human decides out of band, and the side effect is a
 * deterministic step that runs only after approval.
 *
 * The reasoning step of the pattern happened before this workflow starts:
 * the model already produced the "draft" — a concrete tool call with exact
 * arguments — inside the chat turn. So this workflow deliberately does NOT
 * prompt a model. Its steps are bookkeeping and the one side effect:
 *
 *   1. waitForEvent("approval", 24h) — parked, costing nothing, until the
 *      dashboard delivers a decision via the agent's sendWorkflowEvent. A
 *      trade proposal is only meaningful against roughly current prices, so
 *      the window is a day, not the days-long windows a report draft gets.
 *   2. step.do("record-decision") — the agent persists approved/rejected.
 *   3. step.do("execute-approved-trade") — only when approved: the agent
 *      executes the recorded call against the Public.com MCP. The agent
 *      re-reads the credential at this moment (never via workflow params)
 *      and claims the proposal before calling out, so a step retry cannot
 *      place the order twice.
 *
 * A timeout lands in the catch: the proposal is recorded as expired and
 * nothing executes. Expiry is a normal outcome, not an error.
 *
 * Started by CfmailAgentSQLite.proposeTrade via runWorkflow("TRADE_WORKFLOW").
 */
export class TradeWorkflow extends ThinkWorkflow<CfmailAgentSQLite, TradeWorkflowParams> {
  async run(event: AgentWorkflowEvent<TradeWorkflowParams>, step: ThinkWorkflowStep): Promise<void> {
    const { proposalId } = event.payload;

    let approval: { approved?: boolean; notes?: string } | null = null;
    try {
      const decision = await step.waitForEvent("wait-for-approval", {
        type: "approval",
        timeout: "24 hours",
      });
      approval = (decision.payload ?? {}) as { approved?: boolean; notes?: string };
    } catch {
      // waitForEvent throws when the window closes with no decision.
      approval = null;
    }

    if (!approval) {
      await step.do("record-expiry", async () => {
        await this.agent.expireTradeProposal(proposalId);
      });
      return;
    }

    const approved = approval.approved === true;
    await step.do("record-decision", async () => {
      await this.agent.recordTradeDecision(proposalId, approved, approval.notes);
    });
    if (!approved) return;

    await step.do("execute-approved-trade", async () => {
      await this.agent.executeTradeProposal(proposalId);
    });
  }
}
