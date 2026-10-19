import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { CfmailAgentSQLite } from "./agent";
import type { TradeWorkflowParams } from "./types";
// WS1 aspects (issue #252, design §2.1): each step boundary emits through
// the error classifier. The aspect records — it never retries and the
// workflow's waitForEvent semantics are unchanged.
import { withWorkflowStepAspect } from "./aspect-error";
import {
  accountingEvent,
  emitAspectEvent,
  mintCorrelationId,
  type AspectEnv,
} from "./aspect-logging";

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
    // WS1 aspects (issue #252, design §2.3): workflow params carry the trace.
    const correlationId = event.payload.trace?.correlationId ?? mintCorrelationId();
    const stepAspect = <T>(operation: string, fn: () => Promise<T>): Promise<T> =>
      withWorkflowStepAspect(fn, {
        agent: "trade-workflow",
        operation,
        correlationId,
        env: (this.env as AspectEnv | undefined) ?? null,
      });

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
      await step.do("record-expiry", () =>
        stepAspect("workflow.step.record-expiry", async () => {
          await this.agent.expireTradeProposal(proposalId);
        }),
      );
      return;
    }

    const approved = approval.approved === true;
    await step.do("record-decision", () =>
      stepAspect("workflow.step.record-decision", async () => {
        await this.agent.recordTradeDecision(proposalId, approved, approval.notes);
      }),
    );
    if (!approved) return;

    // P3 money-gate integrity check (issue #252, design §5.4): the approval
    // event only records intent — execution additionally requires an
    // approver tuple on the proposal. The dashboard decision route seeds
    // that tuple after verifying tenant ownership, so a workflow event
    // that bypassed the route (e.g. a direct decideTradeProposal RPC) can
    // never reach execution. Deny-by-default: no tuple → no execution.
    const authorized = await step.do("verify-approval-authorization", () =>
      stepAspect("workflow.step.verify-approval-authorization", async () => {
        try {
          const { identityStub } = await import("./agent-stubs");
          const identity = await identityStub(this.env);
          const tuples = (await identity.tuplesForObject(
            "trade_proposal",
            proposalId,
          )) as { relation?: string }[];
          return tuples.some((t) => t?.relation === "approver");
        } catch {
          return false;
        }
      }),
    );
    if (!authorized) {
      await step.do("record-unauthorized-approval", () =>
        stepAspect("workflow.step.record-unauthorized-approval", async () => {
          await this.agent.recordTradeDecision(
            proposalId,
            false,
            "Blocked: no approver authorization tuple for this proposal.",
          );
        }),
      );
      // The workflow cannot know who sent the event — only that no
      // authorization exists. Account the deny without attributing it.
      emitAspectEvent(
        accountingEvent("authz.deny", {
          tenantId: "operator",
          userId: "operator",
          correlationId,
          agent: "trade-workflow",
          authDecision: {
            relation: "approver",
            object: `trade_proposal:${proposalId}`,
            allow: false,
          },
          detail: { reason: "no-approver-tuple", step: "verify-approval-authorization" },
        }),
        (this.env as AspectEnv | undefined) ?? null,
      );
      return;
    }

    await step.do("execute-approved-trade", () =>
      stepAspect("workflow.step.execute-approved-trade", async () => {
        await this.agent.executeTradeProposal(proposalId);
      }),
    );
  }
}
