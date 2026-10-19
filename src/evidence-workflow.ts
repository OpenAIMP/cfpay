import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { CfmailAgentSQLite } from "./agent";
import type { EvidenceWorkflowParams } from "./types";

/**
 * One RecommendationEvidenceWorkflow per recommendation (cfpay #245).
 *
 * The reasoning happened before this workflow starts: the model produced
 * the recommendation (structure, strikes, expiry, size) in the chat turn.
 * This workflow owns the two test lanes and nothing else:
 *
 *   1. step.do("backtest-submit") — submit the tastytrade backtests (one
 *      per window); handles persist on the evidence record. A submit
 *      failure records {state:"failed"} on the lane; the step only throws
 *      on store failure.
 *   2. step.do("forward-submit") — place the Alpaca paper mleg mirror at
 *      the verifier-approved size. The paper guard runs before any network
 *      call; the venue dedupes on clientTestId.
 *   3. step.do("advance-and-arm") — poll whatever is already terminal and,
 *      when a lane is still open, arm a `scheduled.once` follow-up carrying
 *      the ScheduledAgent goal-text contract
 *      ("Advance the evidence run for recommendation <id>
 *      (evidence.advance)."). Advancing is idempotent, so a duplicate
 *      follow-up is harmless.
 *
 * Lanes are failure-isolated by construction: each step records its own
 * lane's failure on the evidence record and the workflow continues — a
 * failed backtest never stalls the forward lane and vice versa. Steps run
 * sequentially (durable); the lane runners themselves are parallel-safe
 * (see runTestLanes in src/test-harness/lanes.ts).
 *
 * Started by CfmailAgentSQLite.startEvidenceRun via
 * runWorkflow("EVIDENCE_WORKFLOW").
 */
export class EvidenceWorkflow extends ThinkWorkflow<
  CfmailAgentSQLite,
  EvidenceWorkflowParams
> {
  async run(
    event: AgentWorkflowEvent<EvidenceWorkflowParams>,
    step: ThinkWorkflowStep,
  ): Promise<void> {
    const { recommendationId } = event.payload;

    await step.do("backtest-submit", async () => {
      await this.agent.evidenceSubmitBacktest(recommendationId);
    });

    await step.do("forward-submit", async () => {
      await this.agent.evidenceSubmitForward(recommendationId);
    });

    await step.do("advance-and-arm", async () => {
      await this.agent.evidenceAdvanceAndArm(recommendationId);
    });
  }
}
