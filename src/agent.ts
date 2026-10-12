import { emailToolDefinition } from "./email-tool";
import {
  paymentAgentToolSchema,
  chatAgentToolSchema,
  qaAgentToolSchema,
  slackAgentToolSchema,
  webhookAgentToolSchema,
} from "./agent-tool-schemas";
import { EmailAgent } from "./email-agent";
import { PaymentsAgent } from "./payments-agent";
import { SlackAgent } from "./slack-agent";
import { QAAgent } from "./qa-agent";
import { ChatAgent } from "./chat-agent";
import { WebhookAgent } from "./webhook-agent";
import { Agent, callable } from "agents";
import { Think } from "@cloudflare/think";
import { isAutoReplyEmail, type AgentEmail } from "agents/email";
import PostalMime from "postal-mime";
import type {
  AgentState,
  ChatMessage,
  EmailRecord,
  Env,
  PaymentClaim,
  PaymentRecord,
  StripeCheckout,
  StripeCheckoutStatus,
  StripeConfig,
  WebhookEvent,
  ToolTrace,
} from "./types";
import type { UsageCost } from "./models";
import type { ToolSet } from "ai";
import {
  emailAgentTool,
  chatAgentTool,
  qaAgentTool,
  slackAgentTool,
  webhookAgentTool,
} from "./agent-tools";
import { callTool, isOrderPlacingTool, safeJson } from "./public-mcp";
import type { McpSession, McpTool } from "./public-mcp";
import {
  computeCost,
  defaultModelId,
  normaliseToolCalls,
  readCompletion,
  resolveModelId,
} from "./models";
import {
  formatAmount,
  generateId,
  payX402EndpointWithReceipt,
  type X402AcceptedPayment,
} from "./payments";
import {
  sendSlackNotification,
  sendSlackNotificationDetailed,
  sendSignedWebhook,
} from "./webhooks";
import {
  connectSlackSocketMode,
  sendSlackMessage,
  sendSlackMessageWithButton,
  type SlackEvent,
} from "./slack";

/**
 * Tool name -> child agent class.
 *
 * Names carry an `Agent` suffix because the MCP tool namespace already uses the bare
 * names: `email` is the deterministic capability tool, and `emailAgent` is the
 * dispatched agent. Keeping them distinct means the model can be offered both and a
 * reader can tell which is which from the call site.
 */
const AGENT_TOOL_DISPATCH = {
  emailAgent: { cls: EmailAgent, displayName: "Email Agent" },
  paymentAgent: { cls: PaymentsAgent, displayName: "Payments Agent" },
  webhookAgent: { cls: WebhookAgent, displayName: "Webhook Agent" },
  slackAgent: { cls: SlackAgent, displayName: "Slack Agent" },
  qaAgent: { cls: QAAgent, displayName: "QA Agent" },
  chatAgent: { cls: ChatAgent, displayName: "Chat Agent" },
} as const;

/**
 * JSON Schema for each agent tool's arguments, as advertised to the model.
 *
 * Derived from the same declarations the agents validate against, so the model's view
 * and the runtime's view cannot drift apart.
 */
const agentToolInputSchema = {
  email: {
    type: "object",
    properties: {
      request: { type: "string", description: "What to do with the mail resource." },
      to: { type: "string", description: "Recipient, when sending." },
      subject: { type: "string", description: "Subject, when sending." },
      body: { type: "string", description: "Body, when sending." },
    },
    required: ["request"],
  },
  payments: paymentAgentToolSchema,
  webhooks: webhookAgentToolSchema,
  slack: slackAgentToolSchema,
  qa: qaAgentToolSchema,
  chat: chatAgentToolSchema,
} as const;
const DEFAULT_STATE: AgentState = {
  emails: [],
  payments: [],
  totalEmailsReceived: 0,
  totalEmailsSent: 0,
  totalPaymentsReceived: 0,
  totalPaymentsSent: 0,
  webhookEvents: [],
  totalWebhooksReceived: 0,
};

type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const PAYMENT_KEYWORDS = ["pay", "payment", "buy", "purchase", "subscribe"];

// "request" and "process" were deliberately dropped from the list above: they
// matched ordinary Slack chatter and sent a payment button for almost every
// message. Keep this list to unambiguous payment intent.

/** Per-sender conversational messages kept for the AI prompt. */
const MAX_CHAT_HISTORY_PER_SENDER = 10;

/** Bound Durable Object storage: only the most recent records are kept. */
const MAX_STORED_EMAILS = 500;
const MAX_STORED_PAYMENTS = 200;
const MAX_STORED_WEBHOOK_EVENTS = 200;

function isPaymentRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return PAYMENT_KEYWORDS.some(keyword => lower.includes(keyword));
}

/**
 * Only POST back to Slack's own HTTPS hosts. response_url arrives inside an
 * attacker-influenceable webhook payload, so an unchecked fetch would let a
 * caller point this agent at an arbitrary URL.
 */
function isTrustedResponseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" || url.hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Prefix of the error message thrown by processPaidRequest() when a verified
 * x402 payment claim is presented more than once. api.ts matches on this
 * prefix to return HTTP 409 instead of a generic 500. A plain string prefix
 * is used rather than an error subclass because the agent is invoked over
 * RPC, which does not preserve prototypes across the boundary.
 */
export const PAYMENT_CLAIM_REUSED_PREFIX = "PAYMENT_CLAIM_REUSED:";

export class CfmailAgentSQLite extends Think<Env, AgentState> {
  /* ---------------------------- Think surface ---------------------------- */

  /**
   * Used when this agent runs a chat turn through Think rather than the custom loop.
   *
   * The dashboard's chat speaks the custom loop, so this is not in that path today. It
   * exists because Think declares it, and because a host that can be dispatched as a
   * tool should be able to answer on its own terms.
   */
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the CFmail agent, operating over email, Slack, chat and webhooks.",
      "You own no resource: mail, the ledger, webhook records and Slack each belong to a capability agent,",
      "reachable as a tool by name. Prefer dispatching those to reach into their data, rather than assuming it.",
      "Never claim a payment succeeded, a message was sent, or a check passed unless the agent that owns it said so.",
    ].join(" ");
  }

  /**
   * The child capability agents, as this agent's own tool set.
   *
   * Deliberately the same four tools the custom tool loop advertises, so a model reaching
   * them through Think and a model reaching them through the dashboard's loop see the same
   * surface. Two lists maintained separately is how one of them silently loses a tool.
   *
   * Payments is excluded here, matching AGENT_TOOL_ALLOW_PAYMENTS being unset: a payments
   * tool lets the model choose to run a paid request, which is authority rather than
   * convenience and belongs behind an explicit opt-in.
   */
  override getTools(): ToolSet {
    return {
      emailAgent: emailAgentTool,
      webhookAgent: webhookAgentTool,
      slackAgent: slackAgentTool,
      qaAgent: qaAgentTool,
      chatAgent: chatAgentTool,
    };
  }

  initialState: AgentState = {
    ...DEFAULT_STATE,
    emails: [],
    payments: [],
  };

  /**
   * Conversational history, keyed by sender so one user's messages never leak
   * into another user's prompt. In-memory only (not persisted in DO state).
   */
  private chatHistoryBySender: Record<string, ChatMessage[]> = {};
  /** Set once the pre-split histories have been adopted by the chat agent. */
  private chatHistoryBackfilled = false;
  private slackSocket: WebSocket | null = null;

  async onStart(): Promise<void> {
    this.ensureState();

    // Socket Mode disabled — using HTTP webhook
    // if (this.env.SLACK_APP_TOKEN) {
    //   this.connectSlack();
    // }
  }

  private ensureState(): AgentState {
    const current = this.state;

    if (!current) {
      const next: AgentState = {
        ...DEFAULT_STATE,
        emails: [],
        payments: [],
      };
      this.setState(next);
      return next;
    }

    const next: AgentState = {
      ...DEFAULT_STATE,
      ...current,
      emails: Array.isArray(current.emails) ? current.emails : [],
      payments: Array.isArray(current.payments) ? current.payments : [],
      totalEmailsReceived:
        typeof current.totalEmailsReceived === "number"
          ? current.totalEmailsReceived
          : 0,
      totalEmailsSent:
        typeof current.totalEmailsSent === "number"
          ? current.totalEmailsSent
          : 0,
      totalPaymentsReceived:
        typeof current.totalPaymentsReceived === "number"
          ? current.totalPaymentsReceived
          : 0,
      totalPaymentsSent:
        typeof current.totalPaymentsSent === "number"
          ? current.totalPaymentsSent
          : 0,
    };

    const needsMigration =
      current.emails !== next.emails ||
      current.payments !== next.payments ||
      current.totalEmailsReceived !== next.totalEmailsReceived ||
      current.totalEmailsSent !== next.totalEmailsSent ||
      current.totalPaymentsReceived !== next.totalPaymentsReceived ||
      current.totalPaymentsSent !== next.totalPaymentsSent;

    if (needsMigration) {
      this.setState(next);
    }

    return next;
  }

  // ─── Slack Integration ──────────────────────────────────────

  /**
   * Connect to Slack Socket Mode for modern Slack agents.
   * The Durable Object maintains a persistent WebSocket connection to Slack.
   */
  private async connectSlack(): Promise<void> {
    if (!this.env.SLACK_APP_TOKEN || !this.getSlackBotToken()) {
      console.log("Slack tokens not configured — skipping Socket Mode");
      return;
    }

    try {
      this.slackSocket = await connectSlackSocketMode(
        this.env.SLACK_APP_TOKEN,
        async (event: SlackEvent) => {
          await this.handleSlackEvent(event);
        },
      );
      console.log("Slack Socket Mode connected successfully");
    } catch (error) {
      console.error("Failed to connect Slack Socket Mode:", error);
    }
  }

  /**
   * Slack bot token: the OAuth install flow (/slack/install) stores the token
   * in DO state; otherwise fall back to the SLACK_BOT_TOKEN env var/secret.
   */
  private getSlackBotToken(): string {
    return this.ensureState().slackBotToken || this.env.SLACK_BOT_TOKEN;
  }

  /**
   * Persist the bot token from the Slack OAuth install flow (see
   * handleSlackInstall in index.ts).
   */
  @callable()
  async setSlackBotToken(token: string): Promise<{ success: boolean }> {
    if (!token || typeof token !== "string") return { success: false };
    const state = this.ensureState();
    this.setState({ ...state, slackBotToken: token });
    return { success: true };
  }

  /**
   * Handle a Slack event from either HTTP webhook or Socket Mode.
   */
  async handleSlackEvent(event: SlackEvent): Promise<void> {
    const state = this.ensureState();

    // Check if this is a payment-related request
    const wantsPayment = isPaymentRequest(event.text);

    let response: string;

    // Reply failures must never prevent the message from being recorded —
    // the dashboard's live state sync depends on the record being written.
    try {
      if (wantsPayment) {
        // Pre-fill the payment page with the user's request
        const encodedRequest = encodeURIComponent(event.text);
        const paymentUrl = `https://pay.openaimp.com?request=${encodedRequest}`;
        
        await sendSlackMessageWithButton(
          this.getSlackBotToken(),
          event.channel,
          "To process your request, please complete the payment below:",
          "Pay & Process",
          paymentUrl,
          event.thread_ts || event.ts,
        );
        response = "Payment button sent. Please complete the payment at https://pay.openaimp.com to proceed.";
      } else {
        // Generate AI response for non-payment messages
        response = await this.generateAIResponse(event.text, undefined, `slack:${event.user}`);
        await sendSlackMessage(
          this.getSlackBotToken(),
          event.channel,
          response,
          event.thread_ts || event.ts,
        );
      }
    } catch (err) {
      console.error("Failed to reply to Slack message:", err);
      response = "Thanks for your message — I'll get back to you shortly.";
    }

    // Store as email-like record
    const emailRecord: EmailRecord = {
      id: generateId(),
      from: `slack:${event.user}`,
      to: `slack:${event.channel}`,
      subject: event.text.slice(0, 50),
      body: event.text,
      direction: "inbound",
      receivedAt: new Date().toISOString(),
      paid: false,
      aiResponse: response,
    };

    this.setState({
      ...state,
      emails: [...state.emails, emailRecord].slice(-MAX_STORED_EMAILS),
      totalEmailsReceived: state.totalEmailsReceived + 1,
    });
  }

  // ─── AI ─────────────────────────────────────────────────────

  /**
   * Answer one message and generate the reply.
   *
   * Runs a real tool loop: the capability agents are dispatched from here, which is what
   * makes them used rather than merely offered. Before this the method was a single model
   * call with no tools at all - the agents were wired into getTools() and into the tool
   * list, but nothing in this path ever called runAgentTool, so a question about the
   * ledger was answered from the system prompt instead of by asking the ledger's owner.
   *
   * Same shape as the Public.com loop, and for the same reasons: the model may answer in
   * either envelope, tool calls may arrive in the legacy or current shape, and the loop is
   * bounded by CALLS rather than rounds because one round can make several.
   */
  async generateAIResponse(
    userMessage: string,
    emailContext?: string,
    senderId?: string,
  ): Promise<string> {
    const systemPrompt = `You are the CFmail Agent, an AI assistant operating via email and Slack.
You are connected to a payment system using the x402 protocol.

When a user wants to use a paid service or make a payment, respond with:
"To process your request, please visit https://pay.openaimp.com and use the Pay & Process tab. You can pay with ETH or USDC via MetaMask on Base, Base Sepolia, or Ethereum Sepolia."

When a user asks about pricing, respond with:
"Each request costs 0.001 ETH or 0.01 USDC. You can pay via MetaMask at https://pay.openaimp.com"

You have tools that reach the agents owning each resource: emailAgent for mail,
webhookAgent for deliveries, slackAgent for Slack, qaAgent for browser checks. Prefer
asking them over guessing - they hold the records and you do not.

For general questions, be concise, professional, and helpful.
Do not claim to have completed a payment unless you have received confirmation.`;

    const messages: AiMessage[] = [{ role: "system", content: systemPrompt }];

    if (emailContext) {
      messages.push({
        role: "user",
        content: `Email context:\n${emailContext}\n\nRequest: ${userMessage}`,
      });
    } else {
      messages.push({ role: "user", content: userMessage });
    }

    // Only the current sender's history is included, so one user's messages
    // can neither leak to nor steer another user's replies.
    const senderKey = senderId ?? "unknown";
    // History is the chat agent's resource. Read it there, adopting anything this
    // instance still holds from before the split. A failure here degrades to no history
    // rather than failing the turn: an answer without context is worse than one with it,
    // but far better than no answer at all.
    let priorHistory: ChatMessage[] = [];
    const chatStub = this.chatAgent();
    if (chatStub) {
      try {
        await this.migrateLegacyChatHistory(chatStub);
        priorHistory = await chatStub.getHistory(senderKey);
      } catch (error) {
        console.error("Chat history read failed; continuing without it:", error);
      }
    } else {
      console.warn("CHAT_AGENT is unbound; this turn runs without conversation history.");
    }
    for (const message of priorHistory.slice(-MAX_CHAT_HISTORY_PER_SENDER)) {
      messages.push({
        role: message.role as "user" | "assistant",
        content: message.content,
      });
    }

    let text = "";
    try {
      const toolSpecs = this.toAiToolSpecs([]);

      for (let turn = 0; turn < 6; turn++) {
        let completion;
        try {
          const response: any = await this.env.AI.run(
            defaultModelId() as never,
            { messages, tools: toolSpecs, max_tokens: 2048 } as never,
          );
          completion = readCompletion(response);
        } catch (modelError) {
          // The fallback is deliberately NOT given the tools: it is a smaller model, and a
          // failed tool round should degrade to plain text rather than to a different set
          // of capabilities the operator did not choose.
          console.warn("Primary model failed mid-turn, falling back without tools:", modelError);
          const fallback: any = await this.env.AI.run(
            "@cf/meta/llama-3.1-8b-instruct" as never,
            { messages } as never,
          );
          text = readCompletion(fallback).text.trim();
          break;
        }

        // Models answer in either the legacy or the current tool-call shape. Normalising
        // is what makes the follow-up request valid: echoing a legacy call back as
        // tool_calls fails validation with AiError 8007.
        const toolCalls = normaliseToolCalls(completion.toolCalls);
        if (toolCalls.length === 0) {
          text = completion.text.trim();
          break;
        }

        // Echo the assistant's own calls back verbatim, ids included.
        messages.push({
          role: "assistant",
          content: completion.text,
          tool_calls: toolCalls,
        } as never);

        for (const call of toolCalls) {
          const name = call.function?.name ?? "";
          const id = call.id ?? "";
          let args: unknown = {};
          try {
            args =
              typeof call.function?.arguments === "string"
                ? JSON.parse(call.function.arguments)
                : (call.function?.arguments ?? {});
          } catch {
            // A malformed argument object is the model's error, not a crash: pass an empty
            // object so the tool reports its own validation message back to the model.
            args = {};
          }

          const target = AGENT_TOOL_DISPATCH[name as keyof typeof AGENT_TOOL_DISPATCH];
          let output: string;
          try {
            output =
              name === "email"
                ? await this.callEmailTool((args ?? {}) as Record<string, unknown>)
                : target
                  ? await this.dispatchAgentTool(target, args)
                  : "No such tool: " + name;
          } catch (err) {
            // Reported to the model as text so it can answer differently or try another
            // route, rather than aborting the turn with no reply at all.
            output = "Tool failed: " + String(err);
          }

          messages.push({
            role: "tool",
            content: output.slice(0, 6000),
            tool_call_id: id,
          } as never);
        }

        if (turn === 5) {
          // Out of rounds with the model still calling tools. Say so rather than returning
          // an empty answer that reads as a refusal.
          text =
            "I gathered some information but ran out of steps before finishing. Please narrow the question and I will try again.";
        }
      }

      if (!text) {
        // Last resort, and specific: the caller learns that inference failed and that the
        // request was recorded, rather than receiving a bare apology.
        text =
          "I could not reach a model to answer that. The message has been recorded, and " +
          "nothing was sent or charged. Please try again shortly.";
      }

      // Annotated as ChatMessage[] so the object literals are contextually typed and
      // `role` narrows to the union instead of widening to `string` (TS2322).
      const updatedHistory: ChatMessage[] = [
        ...priorHistory,
        { role: "user", content: userMessage, timestamp: new Date().toISOString() },
        { role: "assistant", content: text, timestamp: new Date().toISOString() },
      ];
      // Recorded in the chat agent, which owns it. This instance keeps no copy: two
      // writers is how a conversation ends up half-remembered.
      if (chatStub) {
        try {
          await chatStub.recordTurn(senderKey, userMessage, text);
        } catch (error) {
          // The reply still goes out. Losing the record is worse than losing nothing, but
          // it is not worth failing a turn the user has already been answered on.
          console.error("Chat history write failed:", error);
        }
      }
      // kept only so the local field is not silently stale during the migration window
      this.chatHistoryBySender[senderKey] = updatedHistory.slice(-MAX_CHAT_HISTORY_PER_SENDER);

      return text;
    } catch (error) {
      console.error("AI generation failed:", error);
      return "I received your message but encountered an issue generating an AI response. Your request has been logged.";
    }
  }

  /**
   * True when this deployment must not deliver outbound email.
   *
   * Used by staging so a full payment flow can be exercised without sending real
   * mail from the production domain. The intended message is still recorded, so
   * its content can be inspected in the dashboard.
   */
  private isEmailCaptureMode(): boolean {
    return this.env.EMAIL_CAPTURE_MODE === "true";
  }

  // ─── Webhook AI analysis ───────────────────────────

  /**
   * Analyse a webhook event without touching chatHistoryBySender. Webhook analysis is
   * a side activity and must not pollute the conversational context reused by
   * onEmail() and chat(). Never throws.
   */
  private async generateAiInsight(prompt: string): Promise<string> {
    try {
      const response = await this.env.AI.run(
        defaultModelId() as never,
        {
          messages: [
            {
              role: "system",
              content:
                "You analyse inbound webhook events for the CFmail agent. Give a brief summary and any recommended actions.",
            },
            { role: "user", content: prompt },
          ],
        } as never,
      );
      return (
        (response as { response?: string }).response ??
        "Webhook received; no analysis generated."
      );
    } catch (error) {
      console.error("Webhook AI analysis failed:", error);
      return "Webhook received; analysis unavailable.";
    }
  }

  /**
   * Decide whether a webhook event should be emailed to a human.
   *
   * Guarded twice: never mail the agent's own address (the reply would come
   * back through onEmail() and generate another auto-reply), and honour an
   * optional provider allowlist so a high-volume source can be excluded.
   */
  private shouldEmailWebhookEvent(provider: string, notifyTo: string): boolean {
    const ownAddress = `agent@${this.env.EMAIL_DOMAIN}`.toLowerCase();
    if (notifyTo.toLowerCase() === ownAddress) return false;

    const allowlist = (this.env.WEBHOOK_NOTIFY_PROVIDERS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);

    if (allowlist.length === 0) return true;
    return allowlist.includes(provider.toLowerCase());
  }

  // ─── Email ──────────────────────────────────────────────────

  async onEmail(email: AgentEmail): Promise<void> {
    const emailHeaders = Array.from(email.headers.entries()).map(
      ([key, value]) => ({ key, value }),
    );

    if (isAutoReplyEmail(emailHeaders)) {
      console.log("Skipping auto-reply email");
      return;
    }

    const state = this.ensureState();
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);
    const now = new Date().toISOString();

    const emailRecord: EmailRecord = {
      id: generateId(),
      from: email.from,
      to: email.to,
      subject: parsed.subject || "(no subject)",
      body: parsed.text || "",
      html: parsed.html,
      direction: "inbound",
      receivedAt: now,
      paid: false,
    };

    let aiSummary: string | undefined;

    try {
      const summaryResponse = await this.env.AI.run(
        defaultModelId() as never,
        {
          messages: [
            {
              role: "system",
              content: "Summarize this email in one or two sentences.",
            },
            {
              role: "user",
              content: `Subject: ${parsed.subject || "(no subject)"}\n\n${parsed.text || ""}`,
            },
          ],
        } as never,
      );

      aiSummary = (summaryResponse as { response?: string }).response;
    } catch (error) {
      console.error("AI summary failed:", error);
    }

    emailRecord.aiSummary = aiSummary;

    const aiResponse = await this.generateAIResponse(
      parsed.text || parsed.subject || "",
      [
        `From: ${email.from}`,
        `To: ${email.to}`,
        `Subject: ${parsed.subject || "(no subject)"}`,
        `Body: ${parsed.text || ""}`,
      ].join("\n"),
      email.from,
    );

    emailRecord.aiResponse = aiResponse;

    const stateAfterInbound: AgentState = {
      ...state,
      emails: [...state.emails, emailRecord].slice(-MAX_STORED_EMAILS),
      totalEmailsReceived: state.totalEmailsReceived + 1,
    };

    this.setState(stateAfterInbound);
    console.log(
      `State after inbound: ${stateAfterInbound.emails.length} emails, ${stateAfterInbound.totalEmailsReceived} received`,
    );

    // Mirror the message into the email agent, which owns the mail resource. This
    // instance keeps its own copy because the dashboard reads it, and the mirror is
    // best-effort: a failure to record must not drop an inbound message that has
    // already been accepted.
    try {
      const { emailAgentStub } = await import("./email-tool");
      const emailStub = emailAgentStub(this.env as any);
      if (emailStub) await emailStub.recordInbound(emailRecord);
    } catch (error) {
      console.error("Email agent could not record the inbound message:", error);
    }

    // Send auto-reply (requires Workers Paid plan for Email Sending)
    try {
      if (this.isEmailCaptureMode()) {
        console.log(
          `[email-capture] auto-reply suppressed: to=${email.from} subject="Re: ${parsed.subject || "Your email"}" bytes=${aiResponse.length}`,
        );
        throw new Error("__captured__");
      }
      await this.env.EMAIL.send({
        to: email.from,
        from: `agent@${this.env.EMAIL_DOMAIN}`,
        replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
        subject: `Re: ${parsed.subject || "Your email"}`,
        // Marks this as machine-generated so isAutoReplyEmail() suppresses
        // auto-responder ping-pong between agents.
        headers: { "Auto-Submitted": "auto-replied" },
        text: aiResponse,
      });

      const outboundRecord: EmailRecord = {
        id: generateId(),
        from: `agent@${this.env.EMAIL_DOMAIN}`,
        to: email.from,
        subject: `Re: ${parsed.subject || "Your email"}`,
        body: aiResponse,
        direction: "outbound",
        receivedAt: new Date().toISOString(),
        paid: false,
      };

      this.setState({
        ...stateAfterInbound,
        emails: [...stateAfterInbound.emails, outboundRecord],
        totalEmailsSent: stateAfterInbound.totalEmailsSent + 1,
      });
    } catch (error) {
      console.error(
        "Failed to send auto-reply. Confirm the EMAIL binding and sender domain are configured.",
        error,
      );
    }
  }

  // ─── Callable Methods ──────────────────────────────────────

  @callable()
  async sendOutboundEmail(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ success: boolean; emailId: string }> {
    const state = this.ensureState();
    const emailId = generateId();

    const record: EmailRecord = {
      id: emailId,
      from: `agent@${this.env.EMAIL_DOMAIN}`,
      to,
      subject,
      body,
      direction: "outbound",
      receivedAt: new Date().toISOString(),
      paid: false,
    };

    try {
      if (this.isEmailCaptureMode()) {
        // Record the message without delivering it, then skip the send by
        // leaving through the same success path.
        console.log(
          `[email-capture] outbound suppressed: to=${to} subject="${subject}" bytes=${body.length}`,
        );
        console.log("[email-capture] body:\n" + body);
        this.setState({
          ...state,
          emails: [...state.emails, record].slice(-MAX_STORED_EMAILS),
          totalEmailsSent: this.state.totalEmailsSent + 1,
        });
        return { success: true, emailId };
      }

      // Send through the shared email tool, so this path obeys the same rate limit
      // and the same guard against mailing ourselves as every other caller. Falls
      // back to the binding only when no email agent answered at all - never to
      // override a refusal, which would make the limit decorative.
      const { emailAgentStub } = await import("./email-tool");
      const stub = emailAgentStub(this.env as any);
      let sentOk = true;
      let sendError: string | undefined;

      if (stub) {
        try {
          const result = await stub.sendThroughAgent({ to, subject, body });
          if (result && typeof result.ok === "boolean") {
            sentOk = result.ok;
            sendError = result.error;
          }
        } catch (error) {
          console.error("Email tool RPC failed; sending directly:", error);
        }
      }

      if (stub && !sentOk && sendError) {
        // The tool refused (a rate limit, or our own address). Surface that rather
        // than sending anyway.
        console.error("Email tool refused the send:", sendError);
        return { success: false, emailId };
      }

      if (!stub) {
        await this.env.EMAIL.send({
          to,
          from: `agent@${this.env.EMAIL_DOMAIN}`,
          replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
          subject,
          text: body,
        });
      }

      // This instance keeps its own copy too: the dashboard reads it, and a rolling
      // deploy must not show a gap where the new ledger has the message and the old
      // reader does not.
      this.setState({
        ...state,
        emails: [...state.emails, record].slice(-MAX_STORED_EMAILS),
        totalEmailsSent: this.state.totalEmailsSent + 1,
      });

      return { success: true, emailId };
    } catch (error) {
      console.error("Failed to send email:", error);
      return { success: false, emailId };
    }
  }

  /**
   * Fulfil a paid request.
   *
   * The capability now belongs to the payments agent, so this forwards. Two paths
   * reach the same method on the same Durable Object:
   *
   *   - A2A: an HTTP JSON-RPC message to the endpoint the payments agent card
   *     advertises. This is the inter-agent contract, and the path a third party
   *     would use.
   *   - Direct Durable Object RPC, used when A2A is unavailable - during a rolling
   *     deploy, or when DASHBOARD_API_KEY is absent from the environment.
   *
   * A refusal from A2A is surfaced, not retried over RPC. A reused payment must not
   * get a second attempt through a different door, or the replay check is pointless.
   */
  async processPaidRequest(
    senderEmail: string,
    request: string,
    claim?: PaymentClaim,
    card?: { amount: string; currency: string; reference: string },
  ): Promise<{ success: boolean; response: string; paymentId: string }> {
    const clamped = claim
      ? {
          amount: claim.amount,
          asset: claim.asset,
          network: claim.network,
          txHash: claim.txHash,
        }
      : undefined;

    const viaA2A = await this.callPaymentsAgentOverA2A(
      "payment.process",
      { email: senderEmail, request, claim: clamped, card },
      "Process this paid request: " + request,
    );

    const data = (viaA2A && (viaA2A.data as any)) || null;

    if (data && data.ok) {
      return {
        success: true,
        response: String(data.response ?? (viaA2A ? viaA2A.text : "") ?? ""),
        paymentId: String(data.paymentId ?? ""),
      };
    }

    if (data && data.error === "claim_reused") {
      throw new Error(
        PAYMENT_CLAIM_REUSED_PREFIX +
          " This payment has already been used for a request; each on-chain payment can be redeemed only once.",
      );
    }

    // Any other explicit refusal is final. Falling through to RPC here would present
    // the same payment to the same ledger a second time.
    if (data && data.error) {
      throw new Error(String((viaA2A && viaA2A.text) || "The payments agent refused this request."));
    }

    // A2A could not complete. Fall back to RPC, which fails closed when the
    // binding is missing rather than pretending the request was fulfilled.
    const pa = this.paymentsAgent();
    if (!pa) {
      throw new Error(
        "The payments agent is unavailable, so this request cannot be processed. No payment has been recorded.",
      );
    }
    return await pa.processPaidRequest(senderEmail, request, claim, card);
  }

  // ===========================================================================
  // Stripe card payments: checkout state and idempotent fulfilment
  // ===========================================================================

  /**
   * Record an intent to pay by card, before any Stripe session exists.
   * The request text is held server-side so the return path never has to trust
   * a client-supplied payload.
   */
  @callable()
  async createStripeCheckoutIntent(
    requestId: string,
    email: string,
    request: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const state = this.ensureState();
    // Prune abandoned intents (older than 24h) so they cannot grow state forever.
    const checkouts = { ...(state.stripeCheckouts || {}) };
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, co] of Object.entries(checkouts)) {
      if (new Date(co.createdAt).getTime() < cutoff) delete checkouts[id];
    }
    const existing = checkouts[requestId];
    if (existing) {
      return { ok: false, error: "This request already has a checkout." };
    }

    const checkout: StripeCheckout = {
      requestId,
      email,
      request,
      status: "awaiting_session",
      createdAt: new Date().toISOString(),
    };

    this.setState({
      ...state,
      stripeCheckouts: { ...checkouts, [requestId]: checkout },
    });

    return { ok: true };
  }

  /** Attach the Stripe session to an intent so the return page can report it. */
  @callable()
  async attachStripeSession(
    requestId: string,
    sessionId: string,
    sessionUrl: string,
  ): Promise<{ ok: boolean }> {
    const state = this.ensureState();
    const existing = state.stripeCheckouts?.[requestId];
    if (!existing || existing.status !== "awaiting_session") {
      return { ok: false };
    }

    this.setState({
      ...state,
      stripeCheckouts: {
        ...(state.stripeCheckouts || {}),
        [requestId]: { ...existing, sessionId, sessionUrl, status: "session_created" },
      },
    });

    return { ok: true };
  }

  /** Read-only view for the return page. Never fulfils. */
  @callable()
  async getStripeCheckoutStatus(requestId: string): Promise<{
    found: boolean;
    status?: StripeCheckoutStatus;
    email?: string;
    fulfilledAt?: string;
  }> {
    const checkout = this.ensureState().stripeCheckouts?.[requestId];
    if (!checkout) return { found: false };
    return {
      found: true,
      status: checkout.status,
      email: checkout.email,
      fulfilledAt: checkout.fulfilledAt,
    };
  }

  /** Mark a checkout failed (e.g. async payment failed). */
  @callable()
  async markStripeCheckoutFailed(requestId: string): Promise<{ ok: boolean }> {
    const state = this.ensureState();
    const existing = state.stripeCheckouts?.[requestId];
    if (!existing || existing.status === "fulfilled") return { ok: false };

    this.setState({
      ...state,
      stripeCheckouts: {
        ...(state.stripeCheckouts || {}),
        [requestId]: { ...existing, status: "failed" },
      },
    });
    return { ok: true };
  }

  /**
   * Fulfil a card payment exactly once.
   *
   * Called only from the signature-verified Stripe webhook, after the caller has
   * checked payment_status, mode, currency and amount. Idempotency comes from
   * three independent guards, because Stripe retries for up to three days and
   * may deliver events out of order:
   *   1. the event id must be new,
   *   2. the checkout must not already be fulfilled,
   *   3. no payment may already be recorded for this payment reference.
   */
  @callable()
  async fulfilStripeCheckout(params: {
    eventId: string;
    requestId: string;
    paymentReference: string;
    amount: string;
    currency: string;
  }): Promise<{ ok: boolean; duplicate: boolean; paymentId?: string; error?: string }> {
    const { eventId, requestId, paymentReference, amount, currency } = params;
    const state = this.ensureState();

    // Guard 1: duplicate delivery of the same event.
    const processed = state.stripeProcessedEvents || {};
    if (processed[eventId]) {
      return { ok: true, duplicate: true };
    }

    const checkout = state.stripeCheckouts?.[requestId];
    if (!checkout) {
      return { ok: false, duplicate: false, error: `Unknown checkout ${requestId}.` };
    }

    // Guard 2: already fulfilled by an earlier delivery.
    if (checkout.status === "fulfilled") {
      return { ok: true, duplicate: true };
    }

    // Guard 3: the ledger already holds a payment for this reference.
    const alreadyPaid = state.payments.some(
      (payment) => payment.txHash === paymentReference,
    );
    if (alreadyPaid) {
      return { ok: true, duplicate: true };
    }

    const result = await this.processPaidRequest(checkout.email, checkout.request, undefined, {
      amount,
      currency,
      reference: paymentReference,
    });

    // Re-read: processPaidRequest wrote state while we were awaiting.
    const latest = this.ensureState();
    this.setState({
      ...latest,
      stripeCheckouts: {
        ...(latest.stripeCheckouts || {}),
        [requestId]: {
          ...checkout,
          status: "fulfilled",
          fulfilledAt: new Date().toISOString(),
          paymentIntentId: paymentReference,
        },
      },
      stripeProcessedEvents: {
        ...(latest.stripeProcessedEvents || {}),
        [eventId]: new Date().toISOString(),
      },
    });

    return { ok: true, duplicate: false, paymentId: result.paymentId };
  }

  /** Record that an event was seen but deliberately not acted on. */
  @callable()
  async recordStripeEvent(eventId: string): Promise<{ ok: boolean }> {
    const state = this.ensureState();
    if (state.stripeProcessedEvents?.[eventId]) return { ok: false };

    this.setState({
      ...state,
      stripeProcessedEvents: {
        ...(state.stripeProcessedEvents || {}),
        [eventId]: new Date().toISOString(),
      },
    });
    return { ok: true };
  }

  @callable()
  async getDashboardData(): Promise<AgentState> {
    return this.ensureState();
  }

  @callable()
  async getEmails(
    direction: string | null,
    limit: number,
  ): Promise<EmailRecord[]> {
    // The email agent owns the mail resource now. This instance still holds mail
    // written before the split and outbound copies written since, so the read is
    // authoritative from the agent and the local copies are merged in rather than
    // dropped - dropping them would make old mail vanish from the dashboard.
    const ea = (this.env as any).EMAIL_AGENT;
    if (!ea) {
      // Fail loudly rather than answering from a stale copy: a wrong answer about
      // what the agent received is worse than an error.
      throw new Error("The email agent is unavailable, so mail cannot be read.");
    }
    const stub = ea.get(ea.idFromName("email"));
    await this.migrateLegacyEmails(stub);

    const remote: EmailRecord[] = await stub.listEmails(direction, limit);
    const local = this.ensureState().emails.filter(
      (e) => !e.from.startsWith("slack:") && !e.to.startsWith("slack:"),
    );

    // Deduplicate by id. The agent's copy wins: it is authoritative, and a local
    // duplicate would otherwise double-count the same message.
    const byId = new Map<string, EmailRecord>();
    for (const email of [...local, ...remote]) {
      if (email && email.id) byId.set(email.id, email);
    }
    const merged = [...byId.values()].filter((e) => !direction || e.direction === direction);
    merged.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    return merged.slice(-limit).reverse();
  }

  /**
   * Adopt this instance's pre-split mail into the email agent, once.
   *
   * Slack messages are skipped by the agent itself, since they belong to SlackAgent.
   * The local copies stay: they are the only record if the adoption turns out to be
   * wrong, and clearing them would be the irreversible half of a migration.
   */
  private async migrateLegacyEmails(stub: any): Promise<void> {
    const state = this.ensureState();
    if ((state as any).emailsBackfilledAt) return;
    const legacy = Array.isArray(state.emails) ? state.emails : [];

    try {
      if (legacy.length > 0) {
        const outcome = await stub.backfillEmails(legacy);
        console.log(
          "Email backfill: adopted " + outcome.adopted + ", skipped " + outcome.skipped,
        );
      }
      this.setState({ ...this.ensureState(), emailsBackfilledAt: new Date().toISOString() } as any);
    } catch (error) {
      // Leave the marker unset so the next read retries. Not marking it done is the
      // safe failure: a retry is cheap, a lost message is not.
      console.error("Email backfill failed; will retry on the next read:", error);
    }
  }

  /**
   * Mail totals, from the mail resource.
   *
   * @callable() matters here: without the decorator the method is not on the RPC
   * surface, and the dashboard reaches it through an any-typed stub, so neither the
   * type checker nor the build would notice.
   */
  @callable()
  async getEmailTotals(): Promise<{ received: number; sent: number; stored: number }> {
    const ea = (this.env as any).EMAIL_AGENT;
    if (!ea) return { received: 0, sent: 0, stored: 0 };
    const stub = ea.get(ea.idFromName("email"));
    await this.migrateLegacyEmails(stub);
    return await stub.emailTotals();
  }

  /**
   * Mail only.
   *
   * Kept so the dashboard's call site does not change, but it no longer filters:
   * Slack messages live in SlackAgent, so mail read from the email agent cannot
   * contain them. The filtering this used to do was a symptom of two channels
   * sharing one array.
   */
  @callable()
  async getEmailsExcludingSlack(
    direction: string | null,
    limit: number,
  ): Promise<EmailRecord[]> {
    return await this.getEmails(direction, limit);
  }

  // ===========================================================================
  // A2A protocol
  // ===========================================================================

  /**
   * The payments capability agent.
   *
   * Returns null when the binding is absent, so this agent still functions if the
   * payments DO has not been deployed yet. Callers fall back to writing their own
   * state in that case, which keeps a rolling deploy safe.
   */
  /**
   * Call the payments agent over A2A.
   *
   * This is the real inter-agent path: an HTTP POST of an A2A JSON-RPC message to
   * the endpoint the payments agent card advertises, carrying the same bearer
   * credential the transport checks. The direct Durable Object RPC remains for
   * latency-critical ledger reads, but a capability call goes over the protocol so
   * the two agents are only coupled by the contract, not by a binding.
   *
   * Returns null when the call could not be completed, so callers can decide
   * whether to fall back rather than assuming success.
   */
  private async callPaymentsAgentOverA2A(
    operation: string,
    args: Record<string, unknown>,
    text: string,
  ): Promise<{ text: string; data?: any } | null> {
    const origin = (this.env as any).SELF_ORIGIN || "https://pay.openaimp.com";
    const key = (this.env as any).DASHBOARD_API_KEY || "";
    if (!key) return null;

    const { A2A_PAYMENTS_RPC_PATH } = await import("./a2a");
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text }, { kind: "data", data: { operation, ...args } }],
        },
      },
    };

    try {
      const res = await fetch(origin + A2A_PAYMENTS_RPC_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error("A2A call to payments agent failed:", res.status);
        return null;
      }
      const raw = await res.text();
      const parsed = raw.trim().startsWith("{")
        ? JSON.parse(raw)
        : (function () {
            // SSE framing: take the last complete data frame.
            const frames = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
            for (let i = frames.length - 1; i >= 0; i--) {
              try { return JSON.parse(frames[i].slice(5).trim()); } catch { /* keep looking */ }
            }
            return null;
          })();
      if (!parsed) return null;

      // The JSON-RPC result carries the task; the answer is in its artifacts and
      // history. Pull whichever is present rather than assuming one shape.
      const result = parsed.result ?? parsed;
      const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
      const dataArtifact = artifacts.find((a: any) =>
        Array.isArray(a?.parts) && a.parts.some((p: any) => p && p.kind === "data"),
      );
      const dataPart = dataArtifact?.parts?.find((p: any) => p && p.kind === "data");

      const history = Array.isArray(result?.history) ? result.history : [];
      const lastAgent = [...history].reverse().find((m: any) => m && m.role === "agent");
      const textOut = (Array.isArray(lastAgent?.parts) ? lastAgent.parts : [])
        .filter((x: any) => x && x.kind === "text" && typeof x.text === "string")
        .map((x: any) => x.text as string)
        .join("\n")
        .trim();

      return { text: textOut, data: dataPart?.data };
    } catch (error) {
      console.error("A2A call to payments agent threw:", error);

      // Tell "the other agent refused this" apart from "I could not reach the other
      // agent". Collapsing both into null was a money bug, and it is the one the
      // dashboard reports as "Payment already used": a REFUSAL was reported as
      // unreachable, so the caller fell through to the direct RPC path and presented
      // the same payment a second time. On the live x402 reconciliation path - where
      // the browser re-POSTs the same signature while it waits for the chain - the
      // first attempt has already been charged and fulfilled, and the second is then
      // truthfully told the payment is spent. The dashboard is entitled to treat that
      // phrase as final (isRetryableVerificationError excludes it), so the fix is to
      // stop producing a retryable-looking error for a reused claim.
      const message = error instanceof Error ? error.message : String(error);

      // The canonical reuse phrase. api.ts maps it to HTTP 409, and the dashboard
      // recognises it as final - which is correct when the FIRST attempt succeeded.
      if (message.includes("already been used") || message.includes("already been redeemed")) {
        throw new Error(
          PAYMENT_CLAIM_REUSED_PREFIX +
            " This payment has already been used for a request; each on-chain payment can be redeemed only once.",
        );
      }

      // Any other explicit refusal is final too. Falling through would present the same
      // payment to the same ledger again, which on the reconciliation path means
      // charging twice for one request.
      if (message.includes("Unknown operation") || message.includes("Refused")) {
        return { text: message, data: { ok: false, error: "refused" } };
      }

      return null;
    }
  }

  /**
   * The chat agent stub, or null when the binding is absent.
   *
   * Conversation history lives there now. This instance keeps no copy: a history with two
   * writers is how a conversation ends up half-remembered, which is what the split removes.
   */
  private chatAgent(): any | null {
    const ns = (this.env as any).CHAT_AGENT;
    if (!ns) return null;
    try {
      return ns.get(ns.idFromName("chat"));
    } catch {
      return null;
    }
  }

  /**
   * Adopt this instance's pre-split chat histories into the chat agent, once.
   *
   * The local map is a plain field rather than persisted state, so it only exists on a
   * warm instance - which is precisely why the history belongs in an agent that can
   * store it. Adopting what is here is best-effort and idempotent; a cold instance simply
   * has nothing to adopt.
   */
  private async migrateLegacyChatHistory(stub: any): Promise<void> {
    if (this.chatHistoryBackfilled) return;
    const legacy = this.chatHistoryBySender;
    const senders = Object.keys(legacy ?? {});
    try {
      if (senders.length > 0) {
        const outcome = await stub.backfillHistories(legacy);
        console.log(
          "Chat backfill: " + outcome.sendersAdopted + " sender(s), " + outcome.messagesAdopted + " message(s)",
        );
      }
      this.chatHistoryBackfilled = true;
    } catch (error) {
      // Leave the flag unset so the next turn retries. A retry is cheap; a forgotten
      // conversation is not.
      console.error("Chat history backfill failed; will retry:", error);
    }
  }

  private paymentsAgent(): any | null {
    const ns = (this.env as any).PAYMENTS_AGENT;
    if (!ns) return null;
    try {
      return ns.get(ns.idFromName("payments"));
    } catch {
      return null;
    }
  }

  /**
   * Aggregate state for the A2A executor.
   *
   * Counts and types only. The A2A endpoint is reachable by other agents, so it
   * must not hand out email bodies, addresses or transaction hashes that its
   * read-only skill does not need.
   */
  /**
   * Handle one A2A JSON-RPC call.
   *
   * Runs inside the Durable Object so it can use ctx.storage.sql directly. Doing
   * this from the Worker would mean reaching into the DO's internals for the SQL
   * handle, which is not part of any public surface.
   *
   * Returns { streamed, events, result } - always serializable, because the RPC
   * boundary rejects anything else. The Worker frames events as SSE when streamed
   * is true.
   */
  /**
   * Answer a question about emails, payments and webhooks from the aggregate
   * snapshot. Facts are computed here and the model only phrases them, so it
   * cannot invent a figure it was not given. Read-only.
   */
  async answerAboutState(question: string): Promise<string> {
    const snap = await this.a2aSnapshot();
    const facts = [
      "Emails handled: " + snap.emails,
      "Payments on the ledger: " + snap.payments,
      "Webhook events received: " + snap.webhooks,
      "Webhook providers: " + (Object.entries(snap.webhookProviders).map(function (e) { return e[0] + " (" + e[1] + ")"; }).join(", ") || "none"),
      "Recent payment descriptions: " + (snap.recentPaymentDescriptions.join("; ") || "none"),
      "Recent webhook types: " + (snap.recentWebhookTypes.join("; ") || "none"),
    ].join("\n");
    try {
      const response: any = await this.env.AI.run(
        "@cf/openai/gpt-oss-120b" as never,
        {
          messages: [
            {
              role: "system",
              content: [
                "You answer questions about a mail and payment agent, using only the facts given.",
                "You cannot act: do not offer to send email, move funds or change anything.",
                "If the facts do not contain the answer, say so rather than guessing. Be brief.",
              ].join("\n"),
            },
            { role: "user", content: "Facts:\n" + facts + "\n\nQuestion: " + question },
          ],
          max_tokens: 400,
        } as never,
      );
      const text = String(response?.response ?? "").trim();
      if (text) return text;
      if (Array.isArray(response?.choices) && response.choices.length) {
        const alt = String(response.choices[0]?.message?.content ?? "").trim();
        if (alt) return alt;
      }
    } catch {
      // Fall through to the raw facts rather than returning nothing.
    }
    return facts;
  }

  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, cfmailCard } = await import("./a2a");
    const a2a = createA2ATransport(
      this.ctx.storage.sql,
      origin,
      cfmailCard(origin),
      {
        card: cfmailCard,
        handle: (message: any, context: { taskId: string; contextId: string }) =>
          this.handleA2AMessage(message, context),
      },
    );
    // Collected, not streamed: an async iterable cannot cross the RPC boundary.
    return await handleCollecting(a2a.transport, body);
  }

  /**
   * Route one A2A message for the chat channel.
   *
   * Chat owns no resource - it reads mail, payments and webhooks and produces a reply -
   * so it is not a fifth agent. Making it one would mean a Durable Object with no
   * authoritative state, which is a service wearing an agent's shape. It is an
   * operation on the endpoint that already generates the text instead.
   *
   * THE SURFACE REMAINS READ-ONLY, and that is the point. `chat.send` produces a
   * conversational reply and mutates nothing: it cannot send mail, post to Slack, move
   * funds or record a payment. Those belong to the agents that own those resources, and
   * each of them decides what a caller may do. What this exposes is the ability to ask
   * questions, which is what chat is for.
   *
   * It does spend Workers AI tokens, so it is behind the bearer credential like every
   * other A2A call. A caller that wants facts without inference can omit the operation
   * and get the composed snapshot instead.
   */
  async handleA2AMessage(
    message: any,
    // Unused: each call is self-contained. Kept to satisfy the interface.
    context: { taskId: string; contextId: string },
  ): Promise<{ text: string; data?: unknown }> {
    const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];

    const text = parts
      .filter((x) => x && x.kind === "text" && typeof x.text === "string")
      .map((x) => x.text as string)
      .join("\n")
      .trim();

    const dataPart = parts.find((x) => x && x.kind === "data" && x.data && typeof x.data === "object");
    const op = dataPart ? String((dataPart.data as any).operation || "") : "";

    if (!op) {
      // No operation: answer from the facts. This is the read-only path and needs no
      // inference beyond phrasing.
      return { text: await this.answerAboutState(text || "Summarise the current state.") };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      case "chat.summary":
        return { text: await this.answerAboutState(String(args.question || text || "Summarise.")) };

      case "chat.facts": {
        // The snapshot with no model in the path at all, for a caller that wants numbers
        // rather than prose and should not pay for inference to get them.
        const snap = await this.a2aSnapshot();
        return { text: "Current state.", data: snap };
      }

      case "chat.send": {
        const message_ = String(args.message || text || "").trim();
        if (!message_) {
          return { text: "chat.send needs a message.", data: { ok: false, error: "missing_message" } };
        }
        try {
          const result = await this.chatRpc(message_);
          return {
            text: result.response,
            data: { ok: true, response: result.response, historyLength: result.history.length },
          };
        } catch (error) {
          // Reported as an outcome rather than thrown, so a caller can tell a refusal
          // from a transport failure.
          return {
            text: "Chat failed: " + String(error),
            data: { ok: false, error: "chat_failed" },
          };
        }
      }

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["chat.summary", "chat.facts", "chat.send"],
          },
        };
    }
  }

  @callable()
  async a2aSnapshot(): Promise<{
    emails: number;
    payments: number;
    webhooks: number;
    webhookProviders: Record<string, number>;
    recentPaymentDescriptions: string[];
    recentWebhookTypes: string[];
  }> {
    const state = this.ensureState();
    const webhookProviders: Record<string, number> = {};
    for (const e of state.webhookEvents || []) {
      const provider = e.provider || 'unknown';
      webhookProviders[provider] = (webhookProviders[provider] || 0) + 1;
    }
    return {
      emails: state.emails.length,
      payments: state.payments.length,
      webhooks: (state.webhookEvents || []).length,
      webhookProviders,
      recentPaymentDescriptions: state.payments
        .slice(-5)
        .map((p) => p.direction + ' ' + p.amount + ' ' + p.currency + ' (' + p.status + ')'),
      recentWebhookTypes: (state.webhookEvents || []).slice(-5).map((e) => e.provider + '/' + e.eventType),
    };
  }

  @callable()
  async getPayments(
    direction: string | null,
    limit: number,
  ): Promise<PaymentRecord[]> {
    // The payments agent is the ledger, exclusively. There is no local merge: a
    // ledger with two writers is how a settled card payment once appeared in the
    // webhook feed while the Payments tab showed nothing.
    const pa = this.paymentsAgent();
    if (!pa) {
      // Fail loudly. A wrong answer about money is worse than an error, and
      // answering from a stale copy is how the dashboard reported the wrong number
      // without anyone being able to tell.
      throw new Error("The payments agent is unavailable, so the ledger cannot be read.");
    }

    await this.migrateLegacyPayments(pa);
    return await pa.listPayments(direction, limit);
  }

  /**
   * Adopt this instance's pre-split payment entries into the ledger, once.
   *
   * Local copies are left in place rather than cleared: they are the only record if
   * the adoption turns out to be wrong, and clearing them would be the irreversible
   * half of a migration that may need to be reversed.
   */
  private async migrateLegacyPayments(pa: any): Promise<void> {
    const state = this.ensureState();
    if (state.paymentsBackfilledAt) return;
    const legacy = Array.isArray(state.payments) ? state.payments : [];

    try {
      if (legacy.length > 0) {
        const outcome = await pa.backfillPayments(legacy);
        console.log(
          "Payments backfill: adopted " + outcome.adopted + ", skipped " + outcome.skipped,
        );
      }
      this.setState({ ...this.ensureState(), paymentsBackfilledAt: new Date().toISOString() });
    } catch (error) {
      // Leave the marker unset so the next read retries. Not marking it done is the
      // safe failure: a retry is cheap, a lost payment is not.
      console.error("Payments backfill failed; will retry on the next read:", error);
    }
  }

  /**
   * Ledger totals, from the ledger.
   *
   * The stats route reads this. It must be @callable(): without the decorator the
   * method is not exposed on the Durable Object RPC surface, and a caller reaches it
   * through an any-typed stub, so neither the type checker nor the build notices the
   * absent method - the call only fails at runtime.
   */
  @callable()
  async getPaymentTotals(): Promise<{ received: number; sent: number; stored: number }> {
    const pa = this.paymentsAgent();
    if (!pa) {
      // Returns zeros here rather than throwing, because this feeds a dashboard
      // counter. The diagnostics tool reports the failure separately, so a zero can
      // be told apart from an outage.
      return { received: 0, sent: 0, stored: 0 };
    }
    await this.migrateLegacyPayments(pa);
    return await pa.paymentTotals();
  }

  @callable()
  async getSlackMessages(limit: number): Promise<EmailRecord[]> {
    const state = this.ensureState();
    const slackMessages = state.emails.filter((email) => email.from.startsWith("slack:"));
    return slackMessages.slice(-limit).reverse();
  }

  // ===========================================================================
  // Public.com chat
  // ===========================================================================

  /**
   * The active Public.com credential: the OAuth access token when the user
   * connected with "Connect Public" (refreshing it when it expires), otherwise
   * the pasted personal access token. Never returned to the browser - only a
   * hint is exposed so the user can confirm what they stored.
   */
  @callable()
  async getPublicToken(): Promise<string | null> {
    const state = this.ensureState() as any;
    const oauth = state.publicOAuth ?? null;
    if (oauth?.accessToken) {
      if (oauth.expiresAt && Date.now() + 60_000 >= oauth.expiresAt && oauth.refreshToken) {
        try {
          const { refreshTokens } = await import("./public-oauth");
          const next = await refreshTokens(oauth);
          this.setState({ ...state, publicOAuth: next });
          return next.accessToken;
        } catch (err) {
          console.error("Public.com refresh grant failed:", err);
          // Fall through: the stored access token may still be usable.
        }
      }
      return oauth.accessToken as string;
    }
    return (state.publicToken as string | undefined) ?? null;
  }

  /** Which credential is active, or null when not connected. */
  @callable()
  async getPublicTokenSource(): Promise<"oauth" | "token" | null> {
    const state = this.ensureState() as any;
    if (state.publicOAuth?.accessToken) return "oauth";
    if (state.publicToken) return "token";
    return null;
  }

  /** The stored OAuth token set, for connect/callback bookkeeping. */
  @callable()
  async getPublicOAuthRecord(): Promise<any> {
    const state = this.ensureState() as any;
    return state.publicOAuth ?? null;
  }

  /** Persist the OAuth token set and drop the pending PKCE session. */
  @callable()
  async savePublicOAuthTokens(tokens: unknown): Promise<void> {
    const state = this.ensureState() as any;
    const next = { ...state, publicOAuth: tokens };
    delete next.publicOAuthPending;
    this.setState(next);
  }

  /** Drop the OAuth token set (Disconnect). The pasted token is separate. */
  @callable()
  async clearPublicOAuthTokens(): Promise<void> {
    const state = this.ensureState() as any;
    const next = { ...state };
    delete next.publicOAuth;
    delete next.publicOAuthPending;
    this.setState(next);
  }

  /** Store the in-flight PKCE session (state + verifier) between redirects. */
  @callable()
  async setPublicOAuthPending(pending: unknown): Promise<void> {
    const state = this.ensureState() as any;
    this.setState({ ...state, publicOAuthPending: pending });
  }

  /** The in-flight PKCE session, if any. Validity (age/state) is checked by the caller. */
  @callable()
  async getPublicOAuthPending(): Promise<any> {
    const state = this.ensureState() as any;
    return state.publicOAuthPending ?? null;
  }

  /** Clear the pending PKCE session after it is consumed or rejected. */
  @callable()
  async clearPublicOAuthPending(): Promise<void> {
    const state = this.ensureState() as any;
    const next = { ...state };
    delete next.publicOAuthPending;
    this.setState(next);
  }

  /** The stored model preference, if any. Unset means use the default. */
  @callable()
  async getPublicModel(): Promise<string | null> {
    const state = this.ensureState() as any;
    return (state.publicModel as string | undefined) ?? null;
  }

  /** Store the model preference. Caller validates against the catalogue. */
  @callable()
  async setPublicModel(modelId: string): Promise<void> {
    const state = this.ensureState() as any;
    this.setState({ ...state, publicModel: modelId });
  }

  @callable()
  async setPublicToken(token: string): Promise<void> {
    const state = this.ensureState() as any;
    this.setState({ ...state, publicToken: token });
  }

  @callable()
  async clearPublicToken(): Promise<void> {
    const state = this.ensureState() as any;
    const next = { ...state };
    delete next.publicToken;
    this.setState(next);
  }

  /**
   * Answer a question by letting the model call Public.com's MCP tools.
   *
   * Returns a full trace so the UI can show which tools ran and what each
   * returned - without that, a plausible-sounding answer is unverifiable.
   *
   * Read-only unless PUBLIC_ALLOW_TRADING is "true": an order-placing tool is
   * refused before it is called, because their guide warns that a trade through
   * an MCP client is a real order using real money.
   */
  async answerInstrumentQuestion(
    token: string,
    question: string,
    tools: McpTool[],
    session: McpSession,
    model?: string | null,
  ): Promise<{
    answer: string;
    trace: ToolTrace[];
    model: string;
    cost: UsageCost | null;
    /** Last finish_reason, so "stopped" can be told from "ran out of rounds". */
    finishReason: string;
  }> {
    const trace: ToolTrace[] = [];
    // Summed across every round of the tool loop: one question is several model
    // calls, so reporting only the last would understate the cost.
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let lastFinishReason = "";
    // Resolved once per question: the user's stored choice, else the configured
    // default from src/models.json.
    const modelId = resolveModelId(model);
    const tradingAllowed =
      String((this.env as any).PUBLIC_ALLOW_TRADING || "").trim().toLowerCase() === "true";
    // tool_call_id it answers, or the model cannot match it to its own request.
    const messages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: [
          "You answer questions about tradeable instruments using Public.com's data.",
          "You have tools available. Always call them to get real data: prices, chains, greeks, balances.",
          "Never invent a price, symbol, balance or expiry. If a tool returns nothing, say so.",
          "Prefer several focused calls over one vague one: quote the candidates first, then pull the option chain for the ones worth comparing.",
          "When the account is unknown, call check_setup or get_accounts once to resolve the account id, then carry on.",
          "Never repeat a call you have already made in this conversation - the result is above. If a call returned nothing useful, try different arguments or answer with what you have.",
          "Stop gathering once you can answer. Say which instruments you compared and why.",
          "This is not investment advice; say so when recommending anything.",
          tradingAllowed
            ? "Order-placing tools are enabled, but only call one when the user has clearly asked to trade."
            : "Trading is disabled on this deployment. Do not attempt order-placing tools; explain that reads work and trading is off.",
          // The tool list is NOT repeated here: 37 entries cost ~450 prompt tokens on
          // every round, and the definitions are already sent structurally via the
          // tools parameter. Repeating them was pure duplication.
        ].join("\n"),
      },
      { role: "user", content: question },
    ];

    // Indices into `messages` that hold actual tool output. These are the only
    // large messages, and they are the ones that may be shortened after a few
    // rounds. Control messages (system, user, assistant) are never touched.
    const resultIndexes: number[] = [];

    // Bounded: without a cap a model can call tools indefinitely.
    // Bounded by tool calls, not by rounds: a round may make several calls, and 
    // the failure this guards against is unbounded backtracking, which shows up
    // as call count rather than round count.
    const MAX_TOOL_CALLS = 12;
    const PRUNE_AFTER_CALLS = 4;
    for (let turn = 0; turn < 10 && trace.length < MAX_TOOL_CALLS; turn++) {
      const response: any = await this.env.AI.run(
        modelId as never,
        { messages, tools: this.toAiToolSpecs(tools), max_tokens: 2048 } as never,
      );

      // Models disagree on the envelope: older ones put response/tool_calls at the
      // top level, newer ones nest them under choices[0].message. Reading the wrong
      // one yields undefined for both, which looks like "no tools, no answer".
      const completion = readCompletion(response);
      if (completion.finishReason) lastFinishReason = completion.finishReason;

      const u: any = completion.usage;
      if (u) {
        usage.prompt_tokens += Number(u.prompt_tokens || 0);
        usage.completion_tokens += Number(u.completion_tokens || 0);
        usage.total_tokens +=
          Number(u.total_tokens || 0) || Number(u.prompt_tokens || 0) + Number(u.completion_tokens || 0);
      }

      // Models answer in either the legacy or the current tool-call shape.
      // Normalising here is what makes the follow-up request valid: echoing a
      // legacy call back as tool_calls fails validation with AiError 8007.
      const toolCalls = normaliseToolCalls(completion.toolCalls);
      if (toolCalls.length === 0) {
        return {
          answer: completion.text.trim(),
          trace,
          model: modelId,
          cost: computeCost(modelId, usage),
          finishReason: lastFinishReason,
        };
      }

      // Echo the assistant's own tool_calls back verbatim, ids included.
      messages.push({
        role: "assistant",
        content: completion.text,
        tool_calls: toolCalls,
      });

      // Shorten all but the most recent results before the next request.
      //
      // Nothing pruned history before, so every round re-sent every earlier result
      // at full size: an option chain is up to 6000 characters, so eight rounds
      // grew the prompt monotonically to ~112k input tokens over a single question.
      // The full results are still returned to the caller in `trace`, so the UI is
      // unaffected - only what the model re-reads is reduced.
      if (trace.length >= PRUNE_AFTER_CALLS) {
        const keep = 2;
        resultIndexes.slice(0, Math.max(0, resultIndexes.length - keep)).forEach((idx) => {
          const m: any = messages[idx];
          if (m && m.role === "tool" && typeof m.content === "string" && m.content.length > 400) {
            m.content = m.content.slice(0, 400) + "\n[... shortened: " + (m.content.length - 400) + " more characters; the full result is shown in the tool panel]\n";
          }
        });
      }

      for (const call of toolCalls) {
        const id = call.id;
        const name = call.function.name;
        const args = safeJson(call.function.arguments);

        if (!tradingAllowed && isOrderPlacingTool(name)) {
          const refusal =
            "Refused: " + name + " would place or modify an order, and this deployment is read-only.";
          trace.push({ name, args, ok: false, refused: true, result: refusal });
          messages.push({ role: "tool", content: refusal, tool_call_id: id });
          continue;
        }

        try {
          // AGENT_TOOL_DISPATCH: the capability agents are reached here, through the
          // framework's own runAgentTool, which gives each child its own chat turn and
          // an event stream the caller can follow. Names are prefixed to keep them from
          // colliding with the MCP tool namespace, where "email" already exists as the
          // deterministic capability tool.
          const agentToolTarget = AGENT_TOOL_DISPATCH[name as keyof typeof AGENT_TOOL_DISPATCH];
          const output =
            name === "email"
              ? await this.callEmailTool((args ?? {}) as Record<string, unknown>)
              : agentToolTarget
                ? await this.dispatchAgentTool(agentToolTarget, args)
                : await callTool(token, name, args, session);
          const firstLine = output.split("\n").find((l) => l.trim() !== "") || "(empty)";
          trace.push({ name, args, ok: true, result: output, summary: firstLine.slice(0, 200) });
          resultIndexes.push(messages.length);
          messages.push({ role: "tool", content: output.slice(0, 6000), tool_call_id: id });
        } catch (err) {
          const msg = String(err);
          trace.push({ name, args, ok: false, result: msg });
          resultIndexes.push(messages.length);
          messages.push({ role: "tool", content: "Tool error: " + msg, tool_call_id: id });
        }
      }
    }

    return {
      answer:
        "I stopped after " +
        trace.length +
        " tool calls without settling on an answer. The results I gathered are in the tool panel above; asking about a specific instrument or expiry usually gets further.",
      trace,
      model: modelId,
      cost: computeCost(modelId, usage),
      finishReason: lastFinishReason || "round_limit",
    };
  }

  /**
   * Translate MCP tool definitions into the Workers AI chat-completions tool
   * schema: [{type:"function", function:{name, description, parameters}}].
   *
   * The flat {name, description, parameters} form is the LEGACY schema. Sending
   * it makes the model report that the provided function definitions do not
   * cover the task, and it then avoids the tools.
   */
  /**
   * Run one capability agent as a tool.
   *
   * Dispatches the child through the framework's runAgentTool and returns its summary,
   * so the model sees a normal tool result. The child gets its own chat turn with its own
   * tools and messages, and the framework owns the run registry and cancellation.
   *
   * `input` is the tool's arguments in the shape the child's schema declares. The child's
   * own operation handling validates them, so a malformed argument fails there with a
   * readable error rather than being silently coerced here.
   */
  private async dispatchAgentTool(
    target: { cls: any; displayName: string },
    args: unknown,
  ): Promise<string> {
    const run: any = await (this as any).runAgentTool(target.cls, {
      input: args ?? {},
      display: { name: target.displayName },
    });

    if (!run) return target.displayName + " returned nothing.";

    // The framework reports terminal states rather than throwing, so each is surfaced
    // as text the model can act on instead of a silent empty result.
    if (run.status === "completed") {
      return typeof run.summary === "string" && run.summary.length > 0
        ? run.summary
        : JSON.stringify(run.output ?? {}, null, 2).slice(0, 4000);
    }
    if (run.status === "aborted") return target.displayName + " run was cancelled.";
    if (run.status === "interrupted") {
      return target.displayName + " was interrupted before it finished and can be retried.";
    }
    return target.displayName + " failed: " + String(run.error ?? "unknown error");
  }

  private toAiToolSpecs(tools: McpTool[]): Array<Record<string, unknown>> {
    const specs = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ? String(t.description).slice(0, 600) : t.name,
        parameters:
          t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object", properties: {} },
      },
    }));

    // The email capability belongs to this Worker, not to an MCP server, so it is
    // appended rather than discovered. One definition in email-tool.ts is what every
    // agent's tool list is built from, so adding an operation reaches all of them.
    specs.push({
      type: "function",
      function: {
        name: emailToolDefinition.name,
        description: emailToolDefinition.description,
        parameters: emailToolDefinition.parameters,
      },
    });

    // The capability agents, as dispatchable tools. Same in-process pattern as email:
    // the model picks a name, this loop runs the tool, and the child agent's own chat
    // turn happens inside runAgentTool.
    //
    // PAYMENTS IS GATED. paymentAgentTool can run payment.process, which executes a
    // paid request, so exposing it to the model is a grant of authority rather than a
    // convenience. It stays out of the tool list unless AGENT_TOOL_ALLOW_PAYMENTS is
    // set to exactly "true", the same fail-closed shape as PUBLIC_ALLOW_TRADING: not
    // "not false", but an explicit opt-in.
    specs.push({
      type: "function",
      function: {
        name: "emailAgent",
        description:
          "Dispatch the email agent for a CONVERSATIONAL request about mail, when you do not " +
          "already know the fields. For an exact send or any read, use the `email` tool: it " +
          "reaches the same agent with no model in the path.",
        parameters: agentToolInputSchema.email,
      },
    });

    if (this.env.AGENT_TOOL_ALLOW_PAYMENTS === "true") {
      specs.push({
        type: "function",
        function: {
          name: "paymentAgent",
          description:
            "Dispatch the payments agent to report on the ledger or to process an already-verified payment.",
          parameters: agentToolInputSchema.payments,
        },
      });
    }

    specs.push({
      type: "function",
      function: {
        name: "webhookAgent",
        description:
          "Dispatch the webhook agent to report on recorded deliveries. Any event it records is unverified.",
        parameters: agentToolInputSchema.webhooks,
      },
    });

    specs.push({
      type: "function",
      function: {
        name: "slackAgent",
        description:
          "Dispatch the Slack agent to report on Slack connectivity and message history. It cannot post.",
        parameters: agentToolInputSchema.slack,
      },
    });

    specs.push({
      type: "function",
      function: {
        name: "qaAgent",
        description:
          "Dispatch the QA agent to load a page and report whether it worked, or to check this Worker's own dashboard.",
        parameters: agentToolInputSchema.qa,
      },
    });

    specs.push({
      type: "function",
      function: {
        name: "chatAgent",
        description:
          "Dispatch the chat agent to report on conversation history, or to read one sender's transcript. A transcript is a disclosure and needs an explicit senderId.",
        parameters: agentToolInputSchema.chat,
      },
    });

    return specs;
  }

  /**
   * Dispatch the email tool.
   *
   * Separate from callTool() because the email capability is not an MCP tool: it is
   * another Durable Object in this Worker. Direct RPC first, A2A as the fallback, so
   * the same method answers either way.
   */
  private async callEmailTool(args: Record<string, unknown>): Promise<string> {
    const { emailAgentStub, callEmailAgent } = await import("./email-tool");
    const operation = String((args && args.operation) || "");
    if (!operation) return "email tool: missing operation.";

    const stub = emailAgentStub(this.env as any);
    if (stub) {
      try {
        switch (operation) {
          case "email.summary":
            return JSON.stringify(await stub.a2aSnapshot());
          case "email.totals":
            return JSON.stringify(await stub.emailTotals());
          case "email.quota":
            return JSON.stringify(await stub.sendQuota());
          case "email.list": {
            const rows = await stub.listEmails(
              args.direction ? String(args.direction) : null,
              Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20,
            );
            // Bodies are omitted: a listing is not a content dump.
            return JSON.stringify({
              emails: rows.map(({ body, html, ...rest }: any) => rest),
            });
          }
          case "email.send":
          case "email.sendWithAttachments": {
            const result = await stub.sendThroughAgent({
              to: String(args.to || ""),
              subject: String(args.subject || ""),
              body: String(args.body || ""),
              // Passed through only for the attachments operation; absent for email.send,
              // which validates undefined as no attachments.
              attachments: args.attachments,
            });
            return JSON.stringify(result);
          }
          default:
            return "email tool: unknown operation " + operation;
        }
      } catch (error) {
        console.error("Email tool RPC failed; trying A2A:", error);
      }
    }

    const remote = await callEmailAgent(this.env as any, operation, args, String(args.subject || operation));
    if (remote) return remote.text || JSON.stringify(remote.data ?? {});
    return "The email tool is unavailable, so nothing was sent or read.";
  }

  /**
   * Answer one dashboard chat message.
   *
   * Named chatRpc, not chat: Think declares `chat(userMessage, callback): Promise<void>`
   * as its streaming turn API, and this is a request/response call with a different
   * contract. Overriding Think's would keep the name and lose the framework's chat
   * machinery, so the two are kept separate. Think's chat is what a Think turn uses;
   * this is what the dashboard's REST route calls.
   */
  @callable()
  async chatRpc(
    message: string,
  ): Promise<{ response: string; history: ChatMessage[] }> {
    const response = await this.generateAIResponse(message, undefined, "dashboard");
    // History from the chat agent, which owns it. generateAIResponse has just recorded
    // this turn there, so the reply and the transcript come from one source.
    let history: ChatMessage[] = [];
    const stub = this.chatAgent();
    if (stub) {
      try {
        history = await stub.getHistory("dashboard");
      } catch (error) {
        console.error("Chat history read failed for the dashboard:", error);
      }
    }
    return {
      response,
      history,
    };
  }

  /**
   * Pay an external x402 endpoint, then record the outgoing payment.
   *
   * Keeps the original `{ success, status, response }` contract; `txHash` is
   * additive.
   *
   * Spends real funds, so it fails closed on three independent gates:
   *   1. PAYMENT_PRIVATE_KEY must be configured.
   *   2. OUTBOUND_PAY_TO_WHITELIST must be a non-empty comma-separated list, and
   *      the endpoint's advertised `payTo` must appear in it. The check runs
   *      BEFORE the transfer is signed, so a non-allowlisted endpoint is never paid.
   *   3. OUTBOUND_MAX_AMOUNT_ATOMIC, when set, caps the requested amount.
   *
   * A payment is only written to the ledger when a transaction was actually
   * broadcast, and it records the terms the endpoint requested rather than
   * hard-coded values.
   */
  @callable()
  async payExternalEndpoint(
    url: string,
    method: string,
    body: string | null,
  ): Promise<{
    success: boolean;
    status: number;
    response: string;
    txHash?: string;
  }> {
    if (!this.env.PAYMENT_PRIVATE_KEY) {
      return {
        success: false,
        status: 403,
        response:
          "External payments are disabled: PAYMENT_PRIVATE_KEY is not configured.",
      };
    }

    const allowedPayTo = new Set(
      (this.env.OUTBOUND_PAY_TO_WHITELIST ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );

    if (allowedPayTo.size === 0) {
      return {
        success: false,
        status: 403,
        response:
          "External payments are disabled: OUTBOUND_PAY_TO_WHITELIST is empty.",
      };
    }

    const maxAmountRaw = this.env.OUTBOUND_MAX_AMOUNT_ATOMIC?.trim();
    let maxAmount: bigint | undefined;
    if (maxAmountRaw) {
      try {
        maxAmount = BigInt(maxAmountRaw);
      } catch {
        return {
          success: false,
          status: 403,
          response:
            "External payments are disabled: OUTBOUND_MAX_AMOUNT_ATOMIC is not an integer.",
        };
      }
    }

    // Captured by the validator below; only set once a term passed every gate.
    let approved: X402AcceptedPayment | undefined;

    try {
      const { response, txHash } = await payX402EndpointWithReceipt(
        url,
        method,
        body,
        this.env.PAYMENT_PRIVATE_KEY,
        {},
        (payment) => {
          if (!allowedPayTo.has(payment.payTo.toLowerCase())) {
            throw new Error(
              `Refusing to pay ${payment.payTo}: not in OUTBOUND_PAY_TO_WHITELIST.`,
            );
          }
          if (maxAmount !== undefined && BigInt(payment.amount) > maxAmount) {
            throw new Error(
              `Refusing to pay ${payment.amount}: exceeds OUTBOUND_MAX_AMOUNT_ATOMIC (${maxAmount}).`,
            );
          }
          approved = payment;
        },
      );

      const responseText = await response.text();

      // No txHash means the endpoint never issued an x402 challenge, so no
      // transfer happened and nothing may be recorded.
      if (!txHash || !approved) {
        return {
          success: false,
          status: 502,
          response: `No payment was made: ${url} did not return an x402 payment challenge.`,
        };
      }

      const record: X402AcceptedPayment = approved;

      // Re-read state after the network round-trip so a concurrent webhook or
      // email update is not clobbered by a stale snapshot.
      const latest = this.ensureState();

      const payment: PaymentRecord = {
        id: generateId(),
        direction: "sent",
        amount: record.amount,
        currency:
          record.asset.toLowerCase() === "0x0000000000000000000000000000000000000000" ? "ETH" : "USDC",
        network: record.network,
        fromAddress: record.fromAddress,
        toAddress: record.payTo,
        description: `Payment to ${url}`,
        status: response.ok ? "confirmed" : "failed",
        txHash,
        createdAt: new Date().toISOString(),
      };

      // The ledger is the payments agent's, exclusively. There is no local fallback:
      // a second writer is what let a card payment settle into one store while the
      // dashboard read the other. Failing closed is the honest outcome - the transfer
      // has already been broadcast, and recording it nowhere is better than recording
      // it somewhere no reader consults.
      const pa = this.paymentsAgent();
      if (!pa) {
        throw new Error(
          "The payments agent is unavailable, so this outgoing payment could not be recorded.",
        );
      }
      await pa.recordPayment(payment);

      return {
        success: response.ok,
        status: response.status,
        response: responseText,
        txHash,
      };
    } catch (error) {
      console.error("External payment failed:", error);
      return {
        success: false,
        status: 502,
        response:
          error instanceof Error ? error.message : "External payment failed.",
      };
    }
  }

  // ===========================================================================
  // Webhooks: Incoming webhook handler (onRequest)
  // ===========================================================================
  async onRequest(request: Request): Promise<Response> {
    // Webhooks are handled via the handleWebhookRpc @callable() method (RPC),
    // not through here. This handles other direct HTTP requests.
    return this.statusResponse();
  }

  /** Status summary returned for direct agent requests. */
  private statusResponse(): Response {
    const state = this.ensureState();
    return new Response(
      JSON.stringify({
        status: "ok",
        agent: "cfmail-agent",
        emails: state.emails.length,
        payments: state.payments.length,
        webhookEvents: (state.webhookEvents || []).length,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ===========================================================================
  // Stripe: fulfil a completed card payment
  // ===========================================================================

  /**
   * Turn a completed Checkout Session into delivered work.
   *
   * Only reached through the signature-verified webhook. Every condition below
   * is checked BEFORE anything is fulfilled, so an unpaid, partial, wrong-currency
   * or foreign-account event cannot release work:
   *   - the event is one of the three completion types we accept,
   *   - the session is a paid, one-off payment (not a subscription or setup),
   *   - payment_status is "paid" (async methods report otherwise at this point),
   *   - currency and amount_total match our own server-side price exactly,
   *   - and the session carries our own cfmail_request_id marker.
   *
   * Idempotency is enforced in fulfilStripeCheckout.
   */
  private async handleStripeWebhook(payload: any, eventId: string): Promise<void> {
    const type = typeof payload?.type === "string" ? payload.type : "";
    const session = payload?.data?.object;

    const isCompletionType =
      type === "checkout.session.completed" ||
      type === "checkout.session.async_payment_succeeded";

    if (!isCompletionType) {
      // Async failure is worth recording so the dashboard shows it, but it must
      // never fulfil.
      if (type === "checkout.session.async_payment_failed") {
        const failedId = String(session?.metadata?.cfmail_request_id || "");
        if (failedId) {
          await this.markStripeCheckoutFailed(failedId);
        }
      }
      await this.recordStripeEvent(eventId);
      return;
    }

    const config = this.getStripeConfig();
    if (!config) {
      console.error("Stripe event received but STRIPE_CONFIG is unusable; not fulfilling.");
      return;
    }

    const requestId = String(session?.metadata?.cfmail_request_id || "");
    const paymentReference = String(session?.payment_intent || "");

    const rejection = (reason: string) => {
      console.error(`Stripe fulfilment refused for ${requestId || "unknown"}: ${reason}`);
    };

    if (!requestId) {
      rejection("session carries no cfmail_request_id");
      await this.recordStripeEvent(eventId);
      return;
    }

    if (session?.metadata?.cfmail_source !== "cfmail") {
      rejection("session was not created by this app");
      await this.recordStripeEvent(eventId);
      return;
    }

    if (session?.mode !== "payment") {
      rejection("session mode is not a one-off payment");
      await this.recordStripeEvent(eventId);
      return;
    }

    if (session?.payment_status !== "paid") {
      rejection(`payment_status is ${String(session?.payment_status)}, not paid`);
      // Deliberately not recorded as processed: Stripe may follow up with a
      // succeeded event, and that one should be allowed to fulfil.
      return;
    }

    const sessionCurrency = String(session?.currency || "").toLowerCase();
    if (sessionCurrency !== config.currency) {
      rejection(`currency ${sessionCurrency} does not match ${config.currency}`);
      await this.recordStripeEvent(eventId);
      return;
    }

    const amountTotal = Number(session?.amount_total);
    if (!Number.isInteger(amountTotal) || amountTotal !== config.amountCents) {
      rejection(
        `amount_total ${amountTotal} does not match the configured ${config.amountCents}`,
      );
      await this.recordStripeEvent(eventId);
      return;
    }

    if (!paymentReference) {
      rejection("session has no payment_intent reference");
      await this.recordStripeEvent(eventId);
      return;
    }

    const result = await this.fulfilStripeCheckout({
      eventId,
      requestId,
      paymentReference,
      amount: String(amountTotal),
      currency: sessionCurrency.toUpperCase(),
    });

    if (!result.ok) {
      console.error("Stripe fulfilment failed:", result.error);
    } else if (result.duplicate) {
      console.log(`Stripe event ${eventId} already handled; no action taken.`);
    }
  }

  /** Parse and validate STRIPE_CONFIG, or null when card payments are off. */
  private getStripeConfig(): StripeConfig | null {
    const raw = this.env.STRIPE_CONFIG;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StripeConfig>;
      if (
        typeof parsed.priceId !== "string" ||
        parsed.priceId.length === 0 ||
        typeof parsed.amountCents !== "number" ||
        !Number.isInteger(parsed.amountCents) ||
        parsed.amountCents <= 0 ||
        typeof parsed.currency !== "string" ||
        parsed.currency.length === 0
      ) {
        return null;
      }
      return {
        priceId: parsed.priceId,
        amountCents: parsed.amountCents,
        currency: parsed.currency.toLowerCase(),
      };
    } catch {
      return null;
    }
  }
  // ===========================================================================
  // Webhooks: Process a verified webhook event
  // ===========================================================================
  private async processWebhookEvent(provider: "github" | "stripe" | "slack", payload: any) {
    // Card payment fulfilment runs first. It is idempotent and every condition
    // is validated internally, so it cannot release work without a paid session.
    // payload.id is the Stripe event id, which is what duplicate suppression keys on.
    if (provider === "stripe") {
      try {
        await this.handleStripeWebhook(payload, String(payload?.id || generateId()));
      } catch (error) {
        // Never let a fulfilment error break the webhook response: Stripe would
        // retry, and a retry is safe because fulfilment is idempotent.
        console.error("Stripe webhook handling failed:", error);
      }
    }


    let eventType = "unknown";
    let agentName = "default";

    if (provider === "github") {
      eventType = payload.action || payload.event || "push";
      agentName = payload.repository?.full_name?.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "default";
    } else if (provider === "stripe") {
      eventType = payload.type || "event";
      const customerId = payload?.data?.object?.customer || payload?.account || payload?.id || "default";
      agentName = `stripe-${customerId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    } else if (provider === "slack") {
      eventType = payload.event?.type || payload.type || "event";
      const channelId = payload.channel_id ?? payload.team_id ?? payload.event?.channel ?? "default";
      agentName = `slack-${channelId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    // AI analysis of the event (non-recording; returns a fallback on failure).
    const aiInsight = await this.generateAiInsight(
      `Analyze this ${provider} webhook event (${eventType}):\n${JSON.stringify(
        payload,
        null,
        2,
      ).slice(0, 2000)}\n\nProvide a brief summary and any recommended actions:`,
    );

    const event: WebhookEvent = {
      id: generateId(),
      provider,
      eventType,
      agentName,
      payload,
      receivedAt: new Date().toISOString(),
      processed: true,
      aiInsight,
    };

    const state = this.ensureState();
    const webhookEvents = [...(state.webhookEvents || []), event].slice(-MAX_STORED_WEBHOOK_EVENTS);

    this.setState({
      ...state,
      webhookEvents,
      totalWebhooksReceived: (state.totalWebhooksReceived || 0) + 1,
    });
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

    // Optional: notify a human by email. Off unless WEBHOOK_NOTIFY_EMAIL is
    // set, so an unconfigured deployment stays silent. Reuses sendOutboundEmail
    // so the notification is recorded in the Emails tab like any other mail.
    const notifyTo = this.env.WEBHOOK_NOTIFY_EMAIL?.trim();
    if (notifyTo && this.shouldEmailWebhookEvent(provider, notifyTo)) {
      try {
        await this.sendOutboundEmail(
          notifyTo,
          `[webhook] ${provider} ${eventType}${agentName ? ` - ${agentName}` : ""}`,
          [
            `Provider: ${provider}`,
            `Event:    ${eventType}`,
            `Agent:    ${agentName}`,
            `Received: ${event.receivedAt}`,
            "",
            "AI analysis:",
            aiInsight,
          ].join("\n"),
        );
      } catch (e) {
        console.error("Webhook email notification failed:", e);
      }
    }

    // When Slack asked us to reply asynchronously, post the analysis back.
    if (provider === "slack" && isTrustedResponseUrl(payload?.response_url)) {
      try {
        await fetch(payload.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: aiInsight }),
        });
      } catch (e) {
        console.error("Failed to post Slack response_url reply:", e);
      }
    }
  }

  // ===========================================================================
  // RPC: GitHub webhook delivery dedup
  // ===========================================================================
  /**
   * Reject replayed GitHub webhook deliveries. Returns true when this delivery
   * ID was already seen (the caller must reject the request); otherwise records
   * it and returns false. Entries older than 24h are pruned, bounding the set.
   * Check-and-record is atomic under the Durable Object input gate.
   */
  @callable()
  async isDuplicateGitHubDelivery(deliveryId: string): Promise<boolean> {
    const state = this.ensureState();
    const seen = { ...(state.githubProcessedDeliveries || {}) };
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, ts] of Object.entries(seen)) {
      if (new Date(ts).getTime() < cutoff) delete seen[id];
    }
    if (seen[deliveryId]) {
      this.setState({ ...state, githubProcessedDeliveries: seen });
      return true;
    }
    seen[deliveryId] = new Date().toISOString();
    this.setState({ ...state, githubProcessedDeliveries: seen });
    return false;
  }

  /**
   * Webhook entrypoint via RPC (bypasses DO fetch).
   * The Agents SDK fetch throws on POST /webhooks/* before reaching onRequest,
   * so the Worker calls this directly instead of agent.fetch(request).
   */
  @callable()
  async handleWebhookRpc(
    provider: "github" | "stripe" | "slack",
    payload: any,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; message: string; challenge?: string }> {
    // Slack URL verification challenge (must return the challenge)
    if (provider === "slack" && payload?.type === "url_verification" && payload?.challenge) {
      return { ok: true, status: 200, message: "OK", challenge: payload.challenge };
    }
    // GitHub dedupe (same logic as onRequest)
    if (provider === "github") {
      const deliveryId = headers["x-github-delivery"] ?? headers["X-Github-Delivery"] ?? "";
      const duplicate = await this.isDuplicateGitHubDelivery(deliveryId);
      if (duplicate) {
        return { ok: false, status: 409, message: "Duplicate webhook delivery" };
      }
    }
    await this.processWebhookEvent(provider, payload);
    return { ok: true, status: 200, message: "OK" };
  }

  // ===========================================================================
  // RPC: Autonomous QA via Cloudflare Browser tools (issue #32)
  // ===========================================================================
  /**
   * Run a QA check against a URL: loads the page, extracts text and takes a
   * screenshot. Uses stateless Quick Actions (no browser session held).
   */
  @callable()
  async qaCheck(
    url: string,
    checks?: { textContains?: string[]; selectorPresent?: string[] },
  ): Promise<{
    ok: boolean;
    url: string;
    title?: string;
    textLength: number;
    screenshot?: string;
    checks?: { name: string; passed: boolean; detail?: string }[];
    error?: string;
  }> {
    try {
      const env = this.env as any;
      if (!env.BROWSER) {
        return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
      }

      // Use Puppeteer via the BROWSER binding for full page control.
      const puppeteer = await import("@cloudflare/puppeteer");
      const browser = await puppeteer.default.launch(env.BROWSER);
      let text = "";
      let screenshot: string | undefined;
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        // Runs in the PAGE's context, so `document` is the browser's. The Worker
        // has no document, which is why this is cast rather than typed via a DOM
        // lib: adding DOM to the Worker's globals would let a real mistake compile.
        text = await page.evaluate(() =>
          (globalThis as unknown as { document: { body: { innerText: string } } }).document.body
            .innerText,
        );
        const shot = await page.screenshot() as Uint8Array;
        let binary = "";
        for (let i = 0; i < shot.length; i++) binary += String.fromCharCode(shot[i]);
        screenshot = `data:image/png;base64,${btoa(binary)}`;
        await page.close();
      } finally {
        await browser.close();
      }

      // Run assertions.
      const results: { name: string; passed: boolean; detail?: string }[] = [];
      if (checks?.textContains) {
        for (const needle of checks.textContains) {
          const passed = text.includes(needle);
          results.push({
            name: `text contains "${needle}"`,
            passed,
            detail: passed ? undefined : "not found in extracted text",
          });
        }
      }
      // selectorPresent requires a live DOM; report as unsupported via Quick Actions.
      if (checks?.selectorPresent?.length) {
        for (const sel of checks.selectorPresent) {
          results.push({
            name: `selector present "${sel}"`,
            passed: false,
            detail: "selector checks need a Puppeteer session (not yet implemented)",
          });
        }
      }

      const allPassed = results.every((r) => r.passed);
      return {
        ok: allPassed,
        url,
        textLength: text.length,
        screenshot,
        checks: results.length ? results : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        url,
        textLength: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * QA the dashboard itself: loads the dashboard URL and checks it renders.
   */
  @callable()
  async qaDashboard(): Promise<{
    ok: boolean;
    url: string;
    textLength: number;
    screenshot?: string;
    checks?: { name: string; passed: boolean; detail?: string }[];
    error?: string;
  }> {
    const origin = (this.env as any).SELF_ORIGIN ?? "https://pay.openaimp.com";
    return this.qaCheck(origin, {
      textContains: ["PaymentAgent"],
    });
  }

  // ===========================================================================
  // RPC: OAuth refresh-token rotation
  // ===========================================================================
  /**
   * Consume one OAuth refresh-token id (single-use rotation). Returns
   * { ok: true } on first presentation and records the id; returns
   * { ok: false, reused: true } when the id was already consumed, which the
   * token endpoint treats as suspected token theft. Entries older than the
   * refresh-token lifetime cannot be replayed usefully and are pruned.
   * Check-and-record is atomic under the Durable Object input gate.
   */
  @callable()
  async rotateOAuthRefreshToken(jti: string): Promise<{ ok: boolean; reused?: boolean }> {
    const state = this.ensureState();
    const consumed = { ...(state.oauthConsumedRefreshJtis || {}) };
    // Refresh tokens live 30 days (REFRESH_TTL_S in mcp-oauth-server.ts); keep
    // a small grace period so clock skew cannot resurrect a consumed id.
    const cutoff = Date.now() - 31 * 24 * 3600 * 1000;
    for (const [id, ts] of Object.entries(consumed)) {
      if (new Date(ts).getTime() < cutoff) delete consumed[id];
    }
    if (consumed[jti]) {
      this.setState({ ...state, oauthConsumedRefreshJtis: consumed });
      return { ok: false, reused: true };
    }
    consumed[jti] = new Date().toISOString();
    this.setState({ ...state, oauthConsumedRefreshJtis: consumed });
    return { ok: true };
  }

  // ===========================================================================
  // RPC: Get webhook events
  // ===========================================================================
  @callable()
  async debugWebhookState(): Promise<{ eventCount: number; totalReceived: number; hasState: boolean }> {
    const state = this.ensureState();
    return {
      eventCount: (state.webhookEvents || []).length,
      totalReceived: state.totalWebhooksReceived || 0,
      hasState: !!this.state,
    };
  }

  @callable()
  async getWebhookEvents(provider: string | null, limit: number): Promise<WebhookEvent[]> {
    const state = this.ensureState();
    const events = state.webhookEvents || [];
    let filtered = events;
    if (provider) {
      filtered = events.filter((e) => e.provider === provider);
    }
    return filtered.slice(-limit).reverse();
  }

  // ===========================================================================
  // RPC: Send an outgoing Slack notification
  // ===========================================================================
  @callable()
  async notifySlack(
    message: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { ok, detail } = await sendSlackNotificationDetailed(
      this.env.SLACK_WEBHOOK_URL ?? "",
      message,
    );

    if (!ok) {
      console.error("Slack notification failed:", detail);
    }

    return ok ? { success: true } : { success: false, error: detail };
  }

  // ===========================================================================
  // RPC: Send a signed outgoing webhook
  // ===========================================================================
  @callable()
  async sendWebhook(url: string, payload: unknown): Promise<{ success: boolean }> {
    // This RPC can make the Worker fetch an arbitrary URL, so an optional
    // allowlist restricts where it may point. Configure it with the
    // OUTBOUND_WEBHOOK_ALLOWLIST env var (comma-separated URL prefixes).
    // When unset, any URL is still allowed but a warning is logged, because an
    // authenticated dashboard key currently unlocks this primitive.
    const allowlist = (this.env.OUTBOUND_WEBHOOK_ALLOWLIST ?? "")
      .split(",")
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0);
    if (allowlist.length > 0) {
      if (!allowlist.some((prefix) => url.startsWith(prefix))) {
        console.warn(`Outgoing webhook blocked: ${url} is not in OUTBOUND_WEBHOOK_ALLOWLIST.`);
        return { success: false };
      }
    } else {
      console.warn(
        "OUTBOUND_WEBHOOK_ALLOWLIST is not set: sendWebhook can fetch any URL. " +
          "Set it to a comma-separated list of allowed URL prefixes.",
      );
    }
    try {
      const ok = await sendSignedWebhook(url, payload, this.env.EMAIL_SECRET);
      return { success: ok };
    } catch (e) {
      console.error("Outgoing webhook failed:", e);
      return { success: false };
    }
  }
}
