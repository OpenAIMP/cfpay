/**
 * ProcessingWorkflow — durable, multi-step background processing.
 *
 * AgentWorkflow gives typed access to the originating Agent via this.agent,
 * so the workflow can call agent methods, update state, and broadcast to
 * connected clients while Workflows handles retries and durability.
 *
 * Docs: https://developers.cloudflare.com/agents/runtime/execution/run-workflows/
 */

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { MyAgent } from "./agent";

export interface TaskParams {
  taskId: string;
  data: string;
}

export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(
    event: AgentWorkflowEvent<TaskParams>,
    step: AgentWorkflowStep,
  ) {
    const { taskId, data } = event.payload;

    // Step 1 — update agent status via RPC
    await step.do("mark-processing", async () => {
      await this.agent.updateStatus(taskId, "processing");
      return { status: "processing" };
    });

    // Step 2 — report progress to connected clients (non-durable)
    await this.reportProgress({ step: "analyze", percent: 0.25 });
    this.broadcastToClients({ type: "update", taskId, phase: "analyzing" });

    // Step 3 — durable analysis step
    const analysis = await step.do("analyze-data", async () => {
      // Replace with real processing logic
      return {
        wordCount: data.split(/\s+/).length,
        summary: data.slice(0, 200),
      };
    });

    // Step 4 — persist progress in agent state (durable)
    await step.mergeAgentState({ taskProgress: 0.75 });

    // Step 5 — generate AI response
    const aiResponse = await step.do("generate-response", async () => {
      // Call the agent's AI method via RPC
      const result = await this.agent.generateInsight(analysis.summary);
      return result;
    });

    // Step 6 — mark complete
    await step.do("mark-complete", async () => {
      await this.agent.updateStatus(taskId, "complete");
      await step.mergeAgentState({ taskProgress: 1.0 });
      return { status: "complete" };
    });

    await this.reportComplete(aiResponse);
    this.broadcastToClients({ type: "complete", taskId, result: aiResponse });

    return aiResponse;
  }
}
