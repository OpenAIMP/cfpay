/**
 * MyAgent — the main stateful AI agent.
 *
 * Combines:
 *   • AI/LLM capabilities (Workers AI + AI SDK)
 *   • MCP tools (connects to ToolsMCP and external MCP servers)
 *   • Scheduled tasks (cron, delayed, one-time)
 *   • Email handling (inbound + outbound via Email Routing)
 *   • Cloudflare Workflows (durable multi-step processing)
 *   • State management (setState, initialState, onStateChanged)
 *   • Callable methods (RPC via @callable)
 *   • Client SDK (useAgent / AgentClient)
 *   • Webhooks (GitHub, Stripe, Slack — incoming + outgoing)
 *
 * Docs:
 *   https://developers.cloudflare.com/agents/
 *   https://developers.cloudflare.com/agents/runtime/agents-api/
 *   https://developers.cloudflare.com/agents/communication-channels/webhooks/
 */

import { Agent, callable } from "agents";
import { routeAgentEmail, createAddressBasedEmailResolver } from "agents/email";
import type { AgentEmail } from "agents/email";
import { createWorkersAI } from "@cloudflare/ai-providers";
import { streamText } from "ai";
import PostalMime from "postal-mime";
import { ProcessingWorkflow } from "./workflow";
import { sendSlackNotification, sendSignedWebhook } from "./webhooks";
import type { WebhookProvider } from "./webhooks";

// ── State type ────────────────────────────────────────────────────
export interface WebhookEvent {
  id: string;
  provider: WebhookProvider;
  eventType: string;
  agentName: string;
  payload: unknown;
  receivedAt: string;
  processed: boolean;
}

export interface AgentState {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  taskProgress: number;
  tasks: Array<{ id: string; status: string; data: string }>;
  pendingEmails: Array<{ from: string; subject: string; body: string }>;
  webhookEvents: WebhookEvent[];
  totalWebhooksReceived: number;
}

// ── Environment bindings ──────────────────────────────────────────
interface Env {
  AI: Ai;
  EMAIL: SendEmail;
  AGENT: DurableObjectNamespace;
  MCP_SERVER: DurableObjectNamespace;
  PROCESSING_WORKFLOW: Workflow;
  ASSETS: Fetcher;
  // Webhook secrets (incoming verification)
  GITHUB_WEBHOOK_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  SLACK_WEBHOOK_SECRET: string;
  // Outgoing webhook URLs
  SLACK_WEBHOOK_URL: string;
}

// ── Agent ─────────────────────────────────────────────────────────
export class MyAgent extends Agent<Env, AgentState> {
  // Initial state when a new agent instance starts
  initialState: AgentState = {
    messages: [],
    taskProgress: 0,
    tasks: [],
    pendingEmails: [],
    webhookEvents: [],
    totalWebhooksReceived: 0,
  };

  // ── Lifecycle: onStart ─────────────────────────────────────────
  async onStart() {
    // Connect to our own MCP server (Durable Object binding, no HTTP)
    await this.addMcpServer("internal-tools", this.env.MCP_SERVER);

    // Connect to an external MCP server (with OAuth)
    // await this.addMcpServer("github", "https://mcp.github.com/mcp", {
    //   callbackHost: "https://your-worker.workers.dev",
    // });

    // Schedule a daily summary (cron — runs every day at 9 AM)
    await this.schedule("0 9 * * *", "dailySummary", {}, { idempotent: true });
  }

  // ── State: onStateChanged ──────────────────────────────────────
  onStateChanged(previous: AgentState | undefined, current: AgentState) {
    // React to state changes — e.g. trigger notifications
    if (previous?.taskProgress !== current.taskProgress) {
      this.broadcastToClients({
        type: "progress",
        progress: current.taskProgress,
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  AI / LLM CAPABILITIES
  // ════════════════════════════════════════════════════════════════

  /**
   * Stream a response from Workers AI back to a WebSocket client.
   * Docs: https://developers.cloudflare.com/agents/runtime/operations/using-ai-models/
   */
  async callReasoningModel(userPrompt: string, connection: Connection) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      prompt: userPrompt,
    });

    for await (const chunk of result.textStream) {
      if (chunk) {
        connection.send(JSON.stringify({ type: "chunk", content: chunk }));
      }
    }
    connection.send(JSON.stringify({ type: "done" }));
  }

  /**
   * Generate a one-shot insight (called from Workflow via RPC).
   */
  async generateInsight(text: string): Promise<string> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = await streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      prompt: `Analyze this text and provide a concise insight:\n\n${text}`,
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }
    return fullText;
  }

  // ════════════════════════════════════════════════════════════════
  //  MCP TOOLS
  // ════════════════════════════════════════════════════════════════

  /**
   * Add or remove MCP servers at runtime via callable RPC.
   * Docs: https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/
   */
  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async listMcpTools() {
    const state = this.getMcpServers();
    return state.tools.map((t) => ({ name: t.name, server: t.serverId }));
  }

  // ════════════════════════════════════════════════════════════════
  //  SCHEDULED TASKS
  // ════════════════════════════════════════════════════════════════

  /**
   * Schedule a one-time task (runs after a delay in seconds).
   * Docs: https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/
   */
  @callable()
  async scheduleTask(delaySeconds: number, taskName: string, data: Record<string, unknown>) {
    return await this.schedule(delaySeconds, taskName, data);
  }

  /**
   * Schedule a cron-based recurring task.
   */
  @callable()
  async scheduleCron(cron: string, taskName: string, data: Record<string, unknown>) {
    return await this.schedule(cron, taskName, data, { idempotent: true });
  }

  /** Daily summary — runs on the cron schedule set in onStart. */
  async dailySummary() {
    const summary = `You have ${this.state.tasks.length} tasks and ${this.state.pendingEmails.length} pending emails.`;
    await this.sendEmail({
      binding: this.env.EMAIL,
      to: "owner@yourdomain.com",
      from: "agent@yourdomain.com",
      subject: "Daily Agent Summary",
      text: summary,
    });
  }

  /** Example scheduled callback. */
  async processTask(data: { taskId: string }) {
    // Kick off a durable Workflow for long-running processing
    await this.env.PROCESSING_WORKFLOW.create({
      params: { taskId: data.taskId, data: "sample" },
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  EMAIL HANDLING
  // ════════════════════════════════════════════════════════════════

  /**
   * Handle inbound email — parse, store, and auto-reply.
   * Docs: https://developers.cloudflare.com/agents/communication-channels/email/
   */
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    // Store in agent state
    const pendingEmails = [
      ...this.state.pendingEmails,
      {
        from: email.from,
        subject: parsed.subject ?? "(no subject)",
        body: parsed.text ?? "",
      },
    ];
    this.setState({ ...this.state, pendingEmails });

    // Generate an AI-powered reply
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = await streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      prompt: `A user sent this email:\n\nSubject: ${parsed.subject}\nBody: ${parsed.text}\n\nWrite a helpful, concise reply.`,
    });

    let replyBody = "";
    for await (const chunk of result.textStream) {
      replyBody += chunk;
    }

    await this.replyToEmail(email, {
      fromName: "AI Agent",
      subject: `Re: ${parsed.subject}`,
      body: replyBody,
      contentType: "text/plain",
    });
  }

  /**
   * Send an outbound email (callable from clients).
   */
  @callable()
  async sendAgentEmail(to: string, subject: string, body: string) {
    await this.sendEmail({
      binding: this.env.EMAIL,
      to,
      from: "agent@yourdomain.com",
      replyTo: "agent@yourdomain.com",
      subject,
      text: body,
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  WORKFLOWS
  // ════════════════════════════════════════════════════════════════

  /**
   * Kick off a durable Workflow for long-running processing.
   * Docs: https://developers.cloudflare.com/agents/runtime/execution/run-workflows/
   */
  @callable()
  async startProcessing(taskId: string, data: string) {
    const instance = await this.env.PROCESSING_WORKFLOW.create({
      params: { taskId, data },
    });
    return { workflowId: instance.id };
  }

  // ════════════════════════════════════════════════════════════════
  //  CALLABLE METHODS (RPC)
  // ════════════════════════════════════════════════════════════════

  /** Update task status (called by Workflow via RPC). */
  async updateStatus(taskId: string, status: string) {
    const tasks = this.state.tasks.map((t) =>
      t.id === taskId ? { ...t, status } : t,
    );
    this.setState({ ...this.state, tasks });
  }

  /** Get current state (callable from client SDK). */
  @callable()
  async getState() {
    return this.state;
  }

  /** Add a new task. */
  @callable()
  async addTask(title: string, data: string) {
    const taskId = crypto.randomUUID();
    const tasks = [
      ...this.state.tasks,
      { id: taskId, status: "pending", data: `${title}: ${data}` },
    ];
    this.setState({ ...this.state, tasks });
    return { taskId };
  }

  // ════════════════════════════════════════════════════════════════
  //  WEBSOCKET CHAT
  // ════════════════════════════════════════════════════════════════

  async onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: "state",
        state: this.state,
      }),
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    const data = JSON.parse(message as string);

    if (data.type === "chat") {
      // Store user message in state
      const messages = [
        ...this.state.messages,
        { role: "user" as const, content: data.content },
      ];
      this.setState({ ...this.state, messages });

      // Stream AI response
      await this.callReasoningModel(data.content, connection);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  WEBHOOKS
  // ════════════════════════════════════════════════════════════════

  /**
   * Handle an incoming verified webhook request.
   * The Worker's fetch handler verifies the signature and routes here.
   * Docs: https://developers.cloudflare.com/agents/communication-channels/webhooks/
   */
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // The Worker has already verified the signature before routing here.
    const rawBody = await request.text();
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }

    // Determine provider from the request URL path
    const url = new URL(request.url);
    const provider = url.pathname.split("/").pop() as WebhookProvider;

    // Slack URL verification challenge
    if (provider === "slack" && payload?.type === "url_verification" && payload?.challenge) {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    await this.processWebhookEvent(provider, payload);
    return new Response("OK");
  }

  /**
   * Process a verified webhook event — store in state, optionally notify Slack.
   */
  private async processWebhookEvent(provider: WebhookProvider, payload: any) {
    let eventType = "unknown";
    let agentName = "default";

    if (provider === "github") {
      eventType = payload.action || payload.event || "push";
      agentName = payload.repository?.full_name?.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "default";
    } else if (provider === "stripe") {
      eventType = payload.type || "event";
      agentName = payload?.data?.object?.customer || payload?.account || payload?.id || "default";
      agentName = String(agentName).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    } else if (provider === "slack") {
      eventType = payload.event?.type || payload.type || "event";
      agentName = payload.team_id || payload.event?.channel || "default";
      agentName = String(agentName).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      provider,
      eventType,
      agentName,
      payload,
      receivedAt: new Date().toISOString(),
      processed: true,
    };

    const webhookEvents = this.state.webhookEvents || [];
    webhookEvents.push(event);
    this.setState({
      ...this.state,
      webhookEvents,
      totalWebhooksReceived: (this.state.totalWebhooksReceived || 0) + 1,
    });

    // Broadcast to connected WebSocket clients
    this.broadcastToClients({
      type: "webhook",
      provider,
      eventType,
      agentName,
    });

    // Optional: notify via outgoing Slack webhook
    if (this.env.SLACK_WEBHOOK_URL) {
      try {
        await sendSlackNotification(
          this.env.SLACK_WEBHOOK_URL,
          `📥 Webhook received: *${provider}* — \`${eventType}\` (agent: ${agentName})`,
        );
      } catch (e) {
        console.error("Slack notification for webhook failed:", e);
      }
    }
  }

  /** Get webhook events (callable from client SDK). */
  @callable()
  async getWebhookEvents(provider: string | null, limit: number): Promise<WebhookEvent[]> {
    const events = this.state.webhookEvents || [];
    let filtered = events;
    if (provider) {
      filtered = events.filter((e) => e.provider === provider);
    }
    return filtered.slice(-limit).reverse();
  }

  /** Send an outgoing Slack notification (callable from client SDK). */
  @callable()
  async notifySlack(message: string): Promise<{ success: boolean }> {
    if (!this.env.SLACK_WEBHOOK_URL) {
      return { success: false };
    }
    try {
      const ok = await sendSlackNotification(this.env.SLACK_WEBHOOK_URL, message);
      return { success: ok };
    } catch (e) {
      console.error("Slack notification failed:", e);
      return { success: false };
    }
  }

  /** Send a signed outgoing webhook to any URL (callable from client SDK). */
  @callable()
  async sendWebhook(url: string, payload: unknown): Promise<{ success: boolean }> {
    try {
      const ok = await sendSignedWebhook(url, payload, this.env.GITHUB_WEBHOOK_SECRET || "");
      return { success: ok };
    } catch (e) {
      console.error("Outgoing webhook failed:", e);
      return { success: false };
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  WORKER ENTRY POINT
// ══════════════════════════════════════════════════════════════════

export { MyAgent, ProcessingWorkflow };
export { ToolsMCP } from "./mcp-server";

import { verifyAndParseWebhook } from "./webhooks";
import { getAgentByName } from "agents";

export default {
  // Route inbound emails to the agent
  async email(message: ForwardableEmailMessage, env: Env) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("MyAgent"),
      onNoRoute: (email) => {
        console.warn(`No route for email from ${email.from}`);
        email.setReject("Unknown recipient");
      },
    });
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // ── Webhook routes — verify signature, then forward to the agent ──
    if (request.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const verified = await verifyAndParseWebhook(request.clone(), env);
      if (!verified) {
        return new Response("Invalid signature", { status: 401 });
      }

      // Slack URL verification challenge — respond directly
      if (verified.slackChallenge) {
        return new Response(JSON.stringify({ challenge: verified.slackChallenge }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Route to the agent instance derived from the webhook payload
      const agent = await getAgentByName<MyAgent>(env.AGENT, verified.agentName);
      return agent.fetch(request);
    }

    // Serve static assets (the React frontend)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
