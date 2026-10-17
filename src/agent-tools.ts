/**
 * Framework agent tools, one per capability agent.
 *
 * `agentTool(ChildClass, {...})` is the framework's agents-as-tools primitive: it builds
 * an AI SDK tool whose execution dispatches a retained sub-agent whose own chat turn
 * runs with its own tools and messages.
 *
 * TWO THINGS TO KNOW BEFORE USING ANY OF THESE.
 *
 * 1. THE MONEY PATH IS NOT A CONVENIENCE. `paymentAgentTool` includes payment.process, so
 *    a host that wires it in can choose by itself to run a paid request. The caller who
 *    registers these tools in `src/agent.ts` keeps that behind AGENT_TOOL_ALLOW_PAYMENTS,
 *    fail-closed. The deterministic A2A operation remains the default for anything a
 *    person has not asked for in conversation.
 *
 * 2. THE SLACK TOOL CANNOT POST. Its operation list omits every write on purpose, so a
 *    model cannot reach a post through it even where a caller would permit one. The write
 *    lives on the RPC surface, reachable only from inside this Worker.
 *
 * Every tool takes an `operation` plus its arguments, mirroring the A2A operation set, so
 * there is one behaviour with two ways to reach it rather than two behaviours.
 */

import { agentTool } from "agents/agent-tools";
import { z } from "zod";
import { EmailAgent } from "./email-agent";
import { PaymentsAgent } from "./payments-agent";
import { WebhookAgent } from "./webhook-agent";
import { SlackAgent } from "./slack-agent";
import { QAAgent } from "./qa-agent";
import { ChatAgent } from "./chat-agent";
import { SearchAgent } from "./search-agent";
import { OrchestratorAgent } from "./orchestrator-agent";
import {
  paymentAgentToolSchema,
  slackAgentToolSchema,
  chatAgentToolSchema,
  searchAgentToolSchema,
  orchestratorAgentToolSchema,
  qaAgentToolSchema,
  webhookAgentToolSchema,
} from "./agent-tool-schemas";

/**
 * Convert a JSON Schema into the zod schema agentTool() requires.
 *
 * zod 4 has no fromJSONSchema, so the shape is asserted rather than derived field by
 * field. The cast is honest about that: the schema in agent-tool-schemas.ts stays the one
 * declaration, and this is the bridge. A wrong shape fails at the A2A call, which
 * validates its own arguments, rather than silently.
 */
const asZod = <T>(schema: unknown) => schema as unknown as z.ZodType<T>;

const emailInput = z.object({
  request: z
    .string()
    .min(3)
    .describe(
      "What to do with the mail resource, in natural language: summarise the history, " +
        "report the send quota, or send a specific message.",
    ),
  to: z.string().optional().describe("Recipient, when the request is to send."),
  subject: z.string().optional().describe("Subject, when the request is to send."),
  body: z.string().optional().describe("Plain-text body, when the request is to send."),
});

export type EmailAgentToolInput = z.infer<typeof emailInput>;
export type AgentToolInput = { operation: string; [k: string]: unknown };

const COMMON_NOTE =
  "For an exact action where you already know every field, the deterministic A2A " +
  "operation is the better path: it does not add a model call and cannot mis-describe " +
  "what it did.";

/**
 * Dispatch the email agent: mail history, send quota, and sending a described message.
 *
 * The one tool here whose action is genuinely conversational, because sending mail is
 * something a person asks for in words.
 */
export const emailAgentTool = agentTool<typeof emailInput>(EmailAgent, {
  description: [
    "Dispatch the email agent for a CONVERSATIONAL request about mail: use this only",
    "when the request is in natural language and you do not already know the recipient,",
    "subject or body. It spends a model turn inside the child agent to work them out.",
    "",
    "For an exact send, or for any read, use the `email` tool instead. That reaches the",
    "same agent with no model in the path, so it cannot mis-describe what it did and it",
    "costs nothing extra. Prefer it whenever you know the fields.",
  ].join(" "),
  displayName: "Email Agent",
  inputSchema: emailInput,
});

/**
 * Dispatch the payments agent.
 *
 * Includes payment.process, which runs a paid request. A host that registers this grants
 * the model the ability to choose that, which is why the host gates it. It is not a way
 * to bypass the x402 check: that lives in api.ts and is unaffected by this path.
 */
export const paymentAgentTool = agentTool<AgentToolInput>(PaymentsAgent, {
  description: [
    "Dispatch the payments agent to report on the payment ledger, or to process a request",
    "whose payment has already been verified.",
    "It cannot move funds or refund. payment.process requires a verified claim or a card",
    "reference; without one it refuses rather than doing unpaid work.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Payments Agent",
  inputSchema: asZod<AgentToolInput>(paymentAgentToolSchema),
});

/**
 * Dispatch the webhook agent.
 *
 * webhook.receive records an event as a2a-sourced and UNVERIFIED. It is listed because it
 * is a real operation, but a host wiring this in should expect it used for recording,
 * never as a way to assert a provider delivered something.
 */
export const webhookAgentTool = agentTool<AgentToolInput>(WebhookAgent, {
  description: [
    "Dispatch the webhook agent to report on recorded webhook deliveries and",
    "replay-protection state.",
    "webhook.receive records an externally supplied event as unverified and a2a-sourced:",
    "it never implies a provider signature was checked.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Webhook Agent",
  inputSchema: asZod<AgentToolInput>(webhookAgentToolSchema),
});

/**
 * Dispatch the Slack agent.
 *
 * Reads only. Posting has no operation here, so a model cannot reach a write through this
 * tool even where a caller would permit one. That absence is the control, and the RPC
 * surface remains the only way to post.
 */
export const slackAgentTool = agentTool<AgentToolInput>(SlackAgent, {
  description: [
    "Dispatch the Slack agent to report on Slack connectivity and message history.",
    "It cannot post: sending to Slack is available only inside this Worker and is not",
    "offered to a dispatched agent or to an external caller.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Slack Agent",
  inputSchema: asZod<AgentToolInput>(slackAgentToolSchema),
});
/**
 * Dispatch the QA agent.
 *
 * This tool can make the Worker load a caller-chosen URL, so a host that offers it is
 * offering outbound browsing to its own model. That is the intended use for a QA
 * capability, but it is worth knowing that the model chooses the destination here -
 * unlike the A2A path, where the credential holder does.
 */
export const qaAgentTool = agentTool<AgentToolInput>(QAAgent, {
  description: [
    "Dispatch the QA agent to load a page and report whether it worked.",
    "Use qa.check with a URL to assert expected text is present, or qa.dashboard to check",
    "this Worker's own dashboard.",
    "Use qa.ux_audit with a spec to run the deterministic UX audit (WCAG contrast,",
    "target size, heading hierarchy, layout integrity, image alt text) over one or",
    "more pages of a web app, with optional header or localStorage auth for the target.",
    "It reports what it observed: a page that failed to load is a failure.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "QA Agent",
  inputSchema: asZod<AgentToolInput>(qaAgentToolSchema),
});

/**
 * Dispatch the chat agent, which owns conversation history.
 *
 * chat.transcript returns the contents of a private exchange, so it requires naming the
 * sender. A summary cannot leak one by accident; a transcript has to be asked for.
 */
export const chatAgentTool = agentTool<AgentToolInput>(ChatAgent, {
  description: [
    "Dispatch the chat agent to report on conversation history, or to read one sender's",
    "transcript.",
    "chat.transcript returns private conversation contents and needs an explicit senderId.",
    "Use chat.summary for counts, which discloses nothing.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Chat Agent",
  inputSchema: asZod<AgentToolInput>(chatAgentToolSchema),
});
/**
 * Dispatch the search agent (issue #170): retrieval over the owner's
 * AI Search knowledge base. search.query returns the indexed chunks
 * themselves - the owner's own data, disclosed to the credential
 * holder, as the agent's card states.
 */
export const searchAgentTool = agentTool<AgentToolInput>(SearchAgent, {
  description: [
    "Dispatch the search agent to query the owner's knowledge base (Cloudflare AI Search).",
    "Use search.query for the retrieved chunks, or search.ask for a grounded answer with its chunks.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Search Agent",
  inputSchema: asZod<AgentToolInput>(searchAgentToolSchema),
});

/**
 * Dispatch the orchestrator (issue #180): hand it a goal and it
 * plans steps across the other agents, runs them, and merges one
 * report. Every step goes through the owning agent's own handler,
 * so no agent's gates are bypassed.
 */
export const orchestratorAgentTool = agentTool<AgentToolInput>(OrchestratorAgent, {
  description: [
    "Dispatch the orchestrator agent to plan and execute a goal that spans several agents.",
    "Use orchestrator.run with a goal; it returns the finished job with per-step outcomes and one merged report. Jobs involving browser QA can take minutes.",
    COMMON_NOTE,
  ].join(" "),
  displayName: "Orchestrator Agent",
  inputSchema: asZod<AgentToolInput>(orchestratorAgentToolSchema),
});
