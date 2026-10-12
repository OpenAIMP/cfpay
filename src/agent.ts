import { Agent, callable } from "agents";
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

export class CfmailAgentSQLite extends Agent<Env, AgentState> {
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

For general questions, be concise, professional, and helpful.
Do not claim to have completed a payment unless you have received confirmation.`;

    const messages: AiMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    if (emailContext) {
      messages.push({
        role: "user",
        content: `Email context:\n${emailContext}\n\nRequest: ${userMessage}`,
      });
    } else {
      messages.push({
        role: "user",
        content: userMessage,
      });
    }

    // Only the current sender's history is included, so one user's messages
    // can neither leak to nor steer another user's replies.
    const senderKey = senderId ?? "unknown";
    const priorHistory = this.chatHistoryBySender[senderKey] ?? [];
    for (const message of priorHistory.slice(-MAX_CHAT_HISTORY_PER_SENDER)) {
      messages.push({
        role: message.role as "user" | "assistant",
        content: message.content,
      });
    }

    try {
      let text: string;
      try {
        const response = await this.env.AI.run(
          defaultModelId() as never,
          {
            messages,
          } as never,
        );
        text = (response as { response?: string }).response ?? "I could not generate a response.";
      } catch (modelError) {
        console.warn("Primary model failed, trying fallback:", modelError);
        const fallbackResponse = await this.env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct" as never,
          {
            messages,
          } as never,
        );
        text = (fallbackResponse as { response?: string }).response ?? "I could not generate a response.";
      }

      // Annotated as ChatMessage[] so the object literals below are
      // contextually typed and `role` narrows to the union instead of
      // widening to `string` (TS2322).
      const updatedHistory: ChatMessage[] = [
        ...priorHistory,
        {
          role: "user",
          content: userMessage,
          timestamp: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ];
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

      await this.env.EMAIL.send({
        to,
        from: `agent@${this.env.EMAIL_DOMAIN}`,
        replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
        subject,
        text: body,
      });

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
    const state = this.ensureState();

    const filtered = direction
      ? state.emails.filter((email) => email.direction === direction)
      : state.emails;

    return filtered.slice(-limit).reverse();
  }

  /**
   * Emails only. Slack conversations are stored in the same emails[] array
   * (from "slack:<user>"), so callers that present mail must exclude them.
   */
  @callable()
  async getEmailsExcludingSlack(
    direction: string | null,
    limit: number,
  ): Promise<EmailRecord[]> {
    const state = this.ensureState();

    let emails = state.emails.filter(
      (email) =>
        !email.from.startsWith("slack:") && !email.to.startsWith("slack:"),
    );

    if (direction) {
      emails = emails.filter((email) => email.direction === direction);
    }

    return emails.slice(-limit).reverse();
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
      return null;
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
  }  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, cfmailCard } = await import("./a2a");
    const a2a = createA2ATransport(
      this.ctx.storage.sql,
      origin,
      cfmailCard(origin),
      {
        card: cfmailCard,
        // The monolith's A2A surface stays read-only: it reports on emails,
        // payments and webhooks. Writes belong to the agent that owns the resource.
        handle: async (message: any) => {
          const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
          const question =
            parts
              .filter((x) => x && x.kind === "text" && typeof x.text === "string")
              .map((x) => x.text as string)
              .join("\n")
              .trim() || "Summarise the current state.";
          return { text: await this.answerAboutState(question) };
        },
      },
    );
    // Collected, not streamed: an async iterable cannot cross the RPC boundary.
    return await handleCollecting(a2a.transport, body);
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
    const local = this.ensureState().payments;

    // Read BOTH ledgers. Payments recorded by the payments agent are authoritative,
    // but this instance still holds entries written before the split and any written
    // while the binding was unreachable. Consulting only the local list meant a card
    // payment settled by the agent appeared in the webhook feed and nowhere else -
    // the Stripe tab reported a payment the Payments tab could not see.
    const pa = this.paymentsAgent();
    if (pa) {
      try {
        const remote: PaymentRecord[] = await pa.listPayments(direction, limit * 2);
        const byId = new Map<string, PaymentRecord>();
        for (const payment of [...local, ...remote]) {
          // The remote copy wins on a collision: it is the authoritative ledger.
          if (payment && payment.id) byId.set(payment.id, payment);
        }
        const merged = [...byId.values()].filter(
          (payment) => !direction || payment.direction === direction,
        );
        merged.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return merged.slice(-limit).reverse();
      } catch (error) {
        console.error("Payments agent read failed; falling back to local state:", error);
      }
    }

    const filtered = direction
      ? local.filter((payment) => payment.direction === direction)
      : local;

    return filtered.slice(-limit).reverse();
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
    /** Last finish_reason, so  "stopped" can be told from "ran out of rounds". */
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
    // Bounded by tool calls, not by rounds: a round may make several calls, and  
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
          const output = await callTool(token, name, args, session);
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
  private toAiToolSpecs(tools: McpTool[]): Array<Record<string, unknown>> {
    return tools.map((t) => ({
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
  }

  @callable()
  async chat(

    message: string,
  ): Promise<{ response: string; history: ChatMessage[] }> {
    const response = await this.generateAIResponse(message, undefined, "dashboard");
    return {
      response,
      history: this.chatHistoryBySender["dashboard"] ?? [],
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

      const pa = this.paymentsAgent();
      if (pa) {
        await pa.recordPayment(payment);
      } else {
        this.setState({
          ...latest,
          payments: [...latest.payments, payment].slice(-MAX_STORED_PAYMENTS),
          totalPaymentsSent: latest.totalPaymentsSent + 1,
        });
      }

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
      const { browserScreenshot, browserExtract } = await import("agents/browser");
      const env = this.env as any;
      if (!env.BROWSER) {
        return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
      }

      // Extract page text and take a screenshot in parallel (stateless).
      const [extractResult, shotResult] = await Promise.all([
        browserExtract(env.BROWSER, { url }),
        browserScreenshot(env.BROWSER, { url }),
      ]);

      const text = typeof extractResult === "string" ? extractResult : JSON.stringify(extractResult);
      let screenshot: string | undefined;
      if (shotResult && (shotResult as any).data) {
        const data = (shotResult as any).data as ArrayBuffer | Uint8Array;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        screenshot = `data:image/png;base64,${btoa(binary)}`;
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
