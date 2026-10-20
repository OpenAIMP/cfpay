import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./types";
import { a2aReplyFromOutcome } from "./a2a";
import {
  MCP_AGENT_TOOLS,
  MCP_DESK_TOOLS,
  MCP_FIELDS,
  type McpAgentToolSpec,
  type McpFieldDef,
} from "./mcp-agent-tools";
import { mintCorrelationId, withTracePart } from "./aspect-logging";
import {
  OPERATOR_TENANT_ID,
  resolveTenantInstance,
  checkDispatchEnvelope,
} from "./tenancy";
import { ensureTenantProvisioned } from "./tenant-dispatch";
import { enforceAuthz } from "./aspect-authz";
import type { McpIdentity } from "./mcp-auth";

/**
 * Remote MCP server for the CFmail agent, exposed at POST/GET /mcp using the
 * stateless Streamable HTTP handler from agents/mcp (the MCP SDK v2 lane).
 *
 * The original tools are READ-ONLY record reads. Issue #173 added
 * the agent-operation tools (src/mcp-agent-tools.ts): every agent's
 * A2A operations as MCP tools, dispatched through the owning agent's
 * own A2A handler so its gates apply unchanged. Write-class tools
 * (send / post / process / create / delete) are gated for JWT
 * callers by mcp:tools:write (src/mcp-jwt.ts WRITE_TOOLS, built
 * from the same table). The endpoint itself is protected by the
 * credential check in src/mcp-auth.ts (see MCP_AUTH_MODE).
 * Trade decisions stay dashboard-only - the desk tools list
 * proposals and hunts, nothing more.
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
export function createCfmailMcpHandler(env: Env, mcpIdentity?: McpIdentity | null) {
  // P3 tenancy (issue #252, design §4): the dispatch tenant comes from the
  // token claims (JWT → tenant_id bound to sub), never from request params;
  // every other credential — and the anonymous handshake — stays on the
  // operator tenant, exactly as today.
  const identity: McpIdentity = mcpIdentity ?? {
    source: "anonymous",
    tenantId: OPERATOR_TENANT_ID,
    userId: OPERATOR_TENANT_ID,
  };
  const tenantId = identity.tenantId || OPERATOR_TENANT_ID;

  const hostInstance = resolveTenantInstance("agent", tenantId);
  // First-use provisioning is a backstop here (the factory is sync); the
  // per-dispatch path awaits it properly below.
  void ensureTenantProvisioned(env, "agent", tenantId, hostInstance).catch(() => {});
  const agent = env.CfmailAgent.get(env.CfmailAgent.idFromName(hostInstance)) as any;

  // WS1 aspects (issue #252, design §2.3): every in-process A2A dispatch
  // carries the private trace part so the receiving executor emits under the
  // same correlationId. P3: the trace carries the token's tenant.
  const a2aTrace = () => ({
    correlationId: mintCorrelationId(),
    tenantId,
    userId: identity.userId,
  });

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

  // Read-only diagnostics. This exists because the dashboard reported 0 payments and
  // nothing said why: the stats route swallowed the error and returned zeros. A
  // health surface has to be able to fail loudly, so this reports each hop of the
  // ledger read separately and returns the real error text rather than a zero.
  //
  // Nothing here writes, sends, or spends — it only observes, which is why it is
  // appropriate for a read-only tool surface.
  server.registerTool(
    "cfmail_ledger_diagnostics",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "Ledger diagnostics",
      description:
        "Report whether the payment ledger is reachable and consistent, hop by hop: dashboard totals, the merged ledger read, and the ledger's own totals from the payments agent. Returns the real error text when a hop fails instead of a zero.",
      inputSchema: {},
    },
    async () => {
      const probe: Record<string, unknown> = {};

      // Hop 1: what the dashboard's stats route calls.
      try {
        probe.getPaymentTotals = await agent.getPaymentTotals();
      } catch (error) {
        probe.getPaymentTotals = { error: String(error) };
      }

      // Hop 2: the ledger read the Payments tab uses.
      try {
        const ledger = await agent.getPayments(null, 100);
        probe.getPayments = {
          rows: Array.isArray(ledger) ? ledger.length : null,
          received: Array.isArray(ledger) ? ledger.filter((p: any) => p.direction === "received").length : null,
          sent: Array.isArray(ledger) ? ledger.filter((p: any) => p.direction === "sent").length : null,
        };
      } catch (error) {
        probe.getPayments = { error: String(error) };
      }

      // Hop 3: the payments agent directly, bypassing the monolith entirely, so a
      // failure can be attributed to the hop rather than to the ledger.
      try {
        const ns = (env as any).PAYMENTS_AGENT;
        if (!ns) {
          probe.paymentsAgentDirect = { error: "PAYMENTS_AGENT binding is absent" };
        } else {
          const stub = ns.get(ns.idFromName("payments"));
          const totals = await stub.paymentTotals();
          const rows = await stub.listPayments(null, 100);
          probe.paymentsAgentDirect = {
            totals,
            rows: Array.isArray(rows) ? rows.length : null,
          };
        }
      } catch (error) {
        probe.paymentsAgentDirect = { error: String(error) };
      }

      // Hop 4: the email agent, same reasoning.
      try {
        const ns = (env as any).EMAIL_AGENT;
        if (!ns) {
          probe.emailAgentDirect = { error: "EMAIL_AGENT binding is absent" };
        } else {
          const stub = ns.get(ns.idFromName("email"));
          probe.emailAgentDirect = {
            totals: await stub.emailTotals(),
            quota: await stub.sendQuota(),
          };
        }
      } catch (error) {
        probe.emailAgentDirect = { error: String(error) };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(probe, null, 2) }],
      };
    },
  );
  // QA and browser diagnostics. Same reasoning as the ledger probe above: the QA tab
  // reported a message that has two possible causes, and the difference decides the fix.
  server.registerTool(
    "cfmail_qa_diagnostics",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "QA diagnostics",
      description:
        "Report whether the QA agent is reachable and whether the Browser Rendering binding is provisioned, distinguishing a missing binding from a refused session. Returns real error text.",
      inputSchema: {},
    },
    async () => {
      const probe: Record<string, unknown> = {};

      // Is the binding present at all?
      const browser = (env as any).BROWSER;
      probe.browserBindingPresent = Boolean(browser);
      if (!browser) {
        probe.browserBinding = { error: "BROWSER is absent from env - the binding is not configured on this Worker." };
      } else {
        probe.browserBindingShape = {
          hasFetch: typeof browser.fetch === "function",
          type: typeof browser,
        };

        // The decisive test: run connectBrowser itself, which is what the QA agent calls,
        // and drive one real CDP command through it. A session opened here is closed and
        // the target removed, so the probe leaves nothing behind - an unclosed session
        // exhausts the concurrency limit and causes the failure this is meant to find.
        try {
          const { connectBrowser } = await import("agents/browser");
          const conn = await connectBrowser(browser);
          try {
            const created = (await conn.send("Target.createTarget", {
              url: "about:blank",
            })) as { targetId: string };
            const sessionId = await conn.attachToTarget(created.targetId);
            const doc = (await conn.send("DOM.getDocument", {}, { sessionId })) as any;
            await conn.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
            probe.connectBrowser = {
              ok: true,
              targetId: created.targetId,
              domRootPresent: Boolean(doc?.root),
            };
          } finally {
            // Closes the session, which also deletes it via the connection's onClose.
            conn.close();
          }
        } catch (error) {
          probe.connectBrowser = { ok: false, error: String(error) };
        }
      }

      // And the agent itself, so a failure can be attributed to the route rather than the
      // binding. Its qaDashboard is the same check the dashboard's second button runs.
      try {
        const ns = (env as any).QA_AGENT;
        if (!ns) {
          probe.qaAgentDirect = { error: "QA_AGENT binding is absent" };
        } else {
          const stub = ns.get(ns.idFromName("qa"));
          const snapshot = await stub.a2aSnapshot();
          probe.qaAgentDirect = { snapshot };
        }
      } catch (error) {
        probe.qaAgentDirect = { error: String(error) };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(probe, null, 2) }],
      };
    },
  );
  // ---- Agent operations as MCP tools (issue #173) ----
  // Every spec in src/mcp-agent-tools.ts becomes a tool that
  // dispatches through the owning agent's own A2A handler, with
  // the same message/send body the orchestrator builds.
  const zodField = (def: McpFieldDef) => {
    switch (def.kind) {
      case "string":
        return z.string().optional().describe(def.describe);
      case "number":
        return z.number().optional().describe(def.describe);
      case "boolean":
        return z.boolean().optional().describe(def.describe);
      case "object":
        return z.record(z.string(), z.unknown()).optional().describe(def.describe);
      case "array":
        return z.array(z.record(z.string(), z.unknown())).optional().describe(def.describe);
    }
  };

  const dispatchAgentOperation = async (
    toolSpec: McpAgentToolSpec,
    input: Record<string, unknown>,
  ): Promise<{ text: string; data: unknown }> => {
    // P3 tenancy: the instance comes from the token claims (never request
    // params); the trace carries the same tenant so the cross-tenant
    // envelope rule holds end to end.
    const instanceName = resolveTenantInstance(toolSpec.instance, tenantId);
    // P3 FGA (design §2.4/§5.4): write-class tools need the actor_for tuple
    // the issuance seeded — the token acts for its tenant, bounded by
    // issuance. Non-JWT credentials are operator-scoped by construction
    // (their dispatch tenant is the operator tenant) and keep today's
    // credential-only authorization.
    if (toolSpec.access === "write" && identity.source === "jwt") {
      const correlationId = mintCorrelationId();
      const gate = await enforceAuthz(
        {
          kind: "jwt",
          tenantId,
          userId: identity.jti ?? identity.sub ?? "unknown",
          role: "viewer",
          tokenId: identity.jti,
        },
        { objectType: "tenant", objectId: tenantId, relation: "actor_for" },
        { correlationId, identityEnv: env, env },
      );
      if (!gate.allow) {
        throw new Error(
          `forbidden: this token is not authorized to run write tools for tenant ${tenantId}`,
        );
      }
    }
    await ensureTenantProvisioned(env, toolSpec.instance, tenantId, instanceName);
    const trace = a2aTrace();
    const envelope = checkDispatchEnvelope(trace, instanceName);
    if (!envelope.ok) throw new Error(envelope.reason ?? "cross-tenant dispatch rejected");
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[toolSpec.binding];
    if (!ns) throw new Error(`${toolSpec.binding} binding is absent`);
    const stub = ns.get(ns.idFromName(instanceName)) as unknown as {
      handleA2A: (b: unknown, o: string) => Promise<unknown>;
    };
    const { args: extra, ...fields } = input ?? {};
    const data: Record<string, unknown> = { operation: toolSpec.operation };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) data[k] = v;
    if (extra && typeof extra === "object") Object.assign(data, extra as Record<string, unknown>);
    const textValue = [data.text, data.question, data.message, data.goal].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const parts: unknown[] = [];
    if (textValue) parts.push({ kind: "text", text: textValue });
    parts.push({ kind: "data", data });
    const body = {
      jsonrpc: "2.0",
      id: `mcp-${toolSpec.tool}`,
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: `mcp-${Date.now()}`,
          parts,
        },
      },
    };
    // message/stream + the shared extractor: the reply Message
    // (text) and the artifact-update (structured data, with its
    // error-catalog code on failures) both travel as events.
    const outcome = await stub.handleA2A(withTracePart(body, a2aTrace()), "https://mcp.internal");
    const reply = a2aReplyFromOutcome(outcome);
    return { text: reply.text, data: reply.data };
  };

  for (const toolSpec of MCP_AGENT_TOOLS) {
    const inputSchema: Record<string, z.ZodType> = {};
    for (const f of toolSpec.fields) inputSchema[f] = zodField(MCP_FIELDS[f]);
    inputSchema.args = z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Escape hatch: extra operation arguments, merged over the named fields.");
    server.registerTool(
      toolSpec.tool,
      {
        title: `${toolSpec.operation} (${toolSpec.agent})`,
        description: `${toolSpec.blurb} Dispatches the ${toolSpec.operation} A2A operation through the ${toolSpec.agent} agent's own handler.`,
        inputSchema,
        annotations: {
          readOnlyHint: toolSpec.access === "read",
          destructiveHint:
            toolSpec.operation === "chat.clear" || toolSpec.operation === "scheduled.delete",
          idempotentHint: toolSpec.access === "read",
          openWorldHint: false,
        },
      },
      async (input: Record<string, unknown>) => {
        const { text, data } = await dispatchAgentOperation(toolSpec, input ?? {});
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ operation: toolSpec.operation, text, data }, null, 2),
            },
          ],
        };
      },
    );
  }

  // Desk listings (read-only; decisions stay on the dashboard).
  for (const desk of MCP_DESK_TOOLS) {
    server.registerTool(
      desk.tool,
      {
        title: desk.tool,
        description: desk.blurb,
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const rows =
          desk.tool === "cfpay_desk_hunts_list"
            ? await agent.listOpportunityHunts()
            : await agent.listTradeProposals();
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      },
    );
  }

  return createMcpHandler(server, { route: "/mcp" });
}
