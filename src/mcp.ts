import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./types";

/**
 * Remote MCP server for the CFmail agent, exposed at POST/GET /mcp using the
 * stateless Streamable HTTP handler from agents/mcp (the MCP SDK v2 lane).
 *
 * Phase 1 is deliberately READ-ONLY: every tool below only reads records the
 * agent already stores. Nothing here can send email, spend funds, or trigger an
 * outbound request, because this endpoint is unauthenticated.
 *
 * In particular these are intentionally NOT exposed:
 *   - payExternalEndpoint  (broadcasts a real EVM transfer)
 *   - processPaidRequest   (the x402 payment check lives in api.ts, so exposing
 *     it here would hand out the paid outcome for free)
 *   - sendOutboundEmail    (would make the worker an open mail relay)
 *   - sendWebhook          (arbitrary outbound URL -> SSRF)
 *
 * createMcpHandler builds a new McpServer per request, so the agent below must
 * be constructed inside this factory, not shared at module scope.
 */
export function createCfmailMcpHandler(env: Env) {
  const agent = env.CfmailAgent.get(env.CfmailAgent.idFromName("agent")) as any;

  const server = new McpServer({
    name: "cfmail-agent",
    version: "1.0.0",
  });

  const limitSchema = z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of records to return (1-100, default 10).");

  server.registerTool(
    "cfmail_recent_emails",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Recent emails",
      description:
        "List recent EMAIL messages handled by the CFmail agent, newest first, with their AI summary when available. Excludes Slack chat, which has its own tool.",
      inputSchema: {
        direction: z
          .enum(["inbound", "outbound"])
          .optional()
          .describe("Filter by direction. Omit for both."),
        limit: limitSchema,
      },
    },
    async ({ direction, limit }) => {
      const emails = await agent.getEmailsExcludingSlack(
        direction ?? null,
        limit ?? 10,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(emails, null, 2) }],
      };
    },
  );

  server.registerTool(
    "cfmail_recent_payments",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Recent payments",
      description:
        "List recent x402 payments recorded by the CFmail agent, newest first.",
      inputSchema: {
        direction: z
          .enum(["received", "sent"])
          .optional()
          .describe("Filter by direction. Omit for both."),
        limit: limitSchema,
      },
    },
    async ({ direction, limit }) => {
      const payments = await agent.getPayments(direction ?? null, limit ?? 10);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payments, null, 2) }],
      };
    },
  );

  server.registerTool(
    "cfmail_recent_webhooks",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Recent webhooks",
      description:
        "List recent inbound webhook events (github, stripe, slack) with their AI analysis, newest first.",
      inputSchema: {
        provider: z
          .enum(["github", "stripe", "slack"])
          .optional()
          .describe("Filter by provider. Omit for all providers."),
        limit: limitSchema,
      },
    },
    async ({ provider, limit }) => {
      const events = await agent.getWebhookEvents(provider ?? null, limit ?? 10);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }],
      };
    },
  );

  server.registerTool(
    "cfmail_projects_catalog",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Projects catalog",
      description:
        "List services available for discovery and automated provisioning under the Stripe Projects / Agents-with-Payment protocol.",
      inputSchema: {},
    },
    async () => {
      const catalog = await agent.getProjectsCatalog();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }],
      };
    },
  );

  server.registerTool(
    "cfmail_projects_provision",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      title: "Provision project service",
      description:
        "Provision an agent service or resource for a user with identity attestation and payment token/budget under Stripe Projects.",
      inputSchema: {
        email: z.string().email().describe("User email address for account attestation."),
        service: z
          .string()
          .describe("Service identifier to provision (e.g., 'cfmail/agent:process', 'cfmail/registrar:domain')."),
        paymentToken: z
          .string()
          .optional()
          .describe("Optional platform payment token from Stripe Projects."),
        budgetLimitUsd: z
          .number()
          .optional()
          .describe("Optional monthly spending budget cap in USD (default $100.00)."),
      },
    },
    async ({ email, service, paymentToken, budgetLimitUsd }) => {
      const result = await agent.provisionProject({
        user: { email },
        service,
        paymentToken,
        budgetLimitUsd,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "cfmail_projects_status",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Provisioned project accounts",
      description:
        "List active provisioned project accounts, services, and monthly spending budgets.",
      inputSchema: {
        limit: limitSchema,
      },
    },
    async ({ limit }) => {
      const accounts = await agent.getProjectAccounts(limit ?? 10);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(accounts, null, 2) }],
      };
    },
  );

  return createMcpHandler(server, { route: "/mcp" });
}
