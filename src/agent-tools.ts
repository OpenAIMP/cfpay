/**
 * Framework agent tools.
 *
 * `agentTool(ChildClass, {...})` is the framework's agents-as-tools primitive: it
 * produces an AI SDK tool whose execution dispatches a retained sub-agent, and the
 * framework owns the run registry, replay and cancellation.
 *
 * The child must be chat-capable, which is why EmailAgent is re-based on Think. Think
 * extends Agent, so every @callable() method and the whole A2A surface are inherited
 * unchanged: this adds a dispatch path without moving the deterministic one.
 *
 * Read the note at the bottom about reachability before assuming a chat host uses this.
 */

import { agentTool } from "agents/agent-tools";
import { z } from "zod";
import { EmailAgent } from "./email-agent";

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

/**
 * Dispatch the email agent to answer a conversational request about the mail resource.
 *
 * This is the agent-tool path. The deterministic path - sending an exact message and
 * learning whether it left - stays the capability call on the A2A endpoint and the
 * `email` tool in the Worker's tool list, because that path has no model in it to
 * mis-describe a send.
 */
// Temporarily disabled: EmailAgent reverted to Agent base (not Think-compatible)
// export const emailAgentTool = agentTool<typeof emailInput>(EmailAgent, {
//   description: [
//     "Dispatch the email agent to inspect or act on the mail resource.",
//     "Use it for conversational requests: summarise recent mail, report the send quota,",
//     "or send a message described in natural language.",
//     "For an exact send where you already know the recipient, subject and body, the",
//     "`email` tool is the deterministic path and does not add a model call.",
//   ].join(" "),
//   displayName: "Email Agent",
//   inputSchema: emailInput,
// });

/*
 * Reachability, stated plainly.
 *
 * This tool is usable by any chat-capable agent in this project. It is not wired into
 * the monolith's own tool loop, and that is deliberate rather than an oversight:
 *
 *   - The monolith is `Agent`, not `Think`, and its chat runs a custom tool loop over
 *     MCP tool definitions plus the `email` capability tool. That loop is what the
 *     dashboard's chat tab speaks, and its protocol is not Think's.
 *   - Adding this tool to that list would mean a second model running inside the email
 *     agent's chat turn before a send, which is the mis-description risk the capability
 *     tool exists to avoid.
 *
 * So the primitive is adopted and available, and the shipped send path does not depend
 * on it. Adopting Think for the monolith would replace the dashboard's chat protocol
 * and is a bigger change than an email extraction.
 */