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
} from "./types";
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

const PAYMENT_KEYWORDS = ["pay", "payment", "buy", "purchase", "subscribe", "process", "request"];

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

export class CfmailAgentSQLite extends Agent<Env, AgentState> {
  initialState: AgentState = {
    ...DEFAULT_STATE,
    emails: [],
    payments: [],
  };

  private chatHistory: ChatMessage[] = [];
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
    if (!this.env.SLACK_APP_TOKEN || !this.env.SLACK_BOT_TOKEN) {
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
   * Handle a Slack event from either HTTP webhook or Socket Mode.
   */
  async handleSlackEvent(event: SlackEvent): Promise<void> {
    const state = this.ensureState();

    // Check if this is a payment-related request
    const wantsPayment = isPaymentRequest(event.text);

    let response: string;

    if (wantsPayment) {
      // Pre-fill the payment page with the user's request
      const encodedRequest = encodeURIComponent(event.text);
      const paymentUrl = `https://pay.openaimp.com?request=${encodedRequest}`;
      
      await sendSlackMessageWithButton(
        this.env.SLACK_BOT_TOKEN,
        event.channel,
        "To process your request, please complete the payment below:",
        "Pay & Process",
        paymentUrl,
        event.thread_ts || event.ts,
      );
      response = "Payment button sent. Please complete the payment at https://pay.openaimp.com to proceed.";
    } else {
      // Generate AI response for non-payment messages
      response = await this.generateAIResponse(event.text);
      await sendSlackMessage(
        this.env.SLACK_BOT_TOKEN,
        event.channel,
        response,
        event.thread_ts || event.ts,
      );
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
      emails: [...state.emails, emailRecord],
      totalEmailsReceived: state.totalEmailsReceived + 1,
    });
  }

  // ─── AI ─────────────────────────────────────────────────────

  async generateAIResponse(
    userMessage: string,
    emailContext?: string,
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

    for (const message of this.chatHistory.slice(-10)) {
      messages.push({
        role: message.role as "user" | "assistant",
        content: message.content,
      });
    }

    try {
      let text: string;
      try {
        const response = await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
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

      this.chatHistory.push(
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
      );

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
   * Analyse a webhook event without touching chatHistory. Webhook analysis is
   * a side activity and must not pollute the conversational context reused by
   * onEmail() and chat(). Never throws.
   */
  private async generateAiInsight(prompt: string): Promise<string> {
    try {
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
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
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
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
    );

    emailRecord.aiResponse = aiResponse;

    const stateAfterInbound: AgentState = {
      ...state,
      emails: [...state.emails, emailRecord],
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
          emails: [...state.emails, record],
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
        emails: [...state.emails, record],
        totalEmailsSent: this.state.totalEmailsSent + 1,
      });

      return { success: true, emailId };
    } catch (error) {
      console.error("Failed to send email:", error);
      return { success: false, emailId };
    }
  }

  /**
   * Fulfil a paid request and record the payment.
   *
   * Two callers: the x402 rail passes a `claim`, while the Stripe webhook passes
   * a `card` descriptor. Only one may be supplied; without either, the payment
   * is recorded with the legacy x402 defaults so existing behaviour is unchanged.
   */
  @callable()
  async processPaidRequest(
    senderEmail: string,
    request: string,
    claim?: PaymentClaim,
    card?: { amount: string; currency: string; reference: string },
  ): Promise<{ success: boolean; response: string; paymentId: string }> {
    const state = this.ensureState();
    const paymentId = generateId();

    const payment: PaymentRecord = {
      id: paymentId,
      direction: "received",
      amount: card?.amount ?? claim?.amount ?? "10000",
      currency:
        card?.currency ??
        (claim?.asset === "0x0000000000000000000000000000000000000000" ? "ETH" : "USDC"),
      network: card ? "card" : claim?.network || "base",
      fromAddress: undefined,
      toAddress: this.env.PAY_TO_ADDRESS,
      description: this.env.PAYMENT_DESCRIPTION,
      status: "confirmed",
      txHash: card?.reference ?? claim?.txHash,
      createdAt: new Date().toISOString(),
    };

    const aiResponse = await this.generateAIResponse(request);

    const emailResult = await this.sendOutboundEmail(
      senderEmail,
      "CFmail Agent Request Received",
      `${aiResponse}\n\n---\nRequest ID: ${paymentId}\nPayment: ${payment.amount} ${payment.currency} on ${payment.network}\nStatus: Confirmed`,
    );

    payment.relatedEmailId = emailResult.emailId;

    this.setState({
      ...state,
      payments: [...state.payments, payment],
      totalPaymentsReceived: state.totalPaymentsReceived + 1,
    });

    return {
      success: emailResult.success,
      response: aiResponse,
      paymentId,
    };
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
    const existing = state.stripeCheckouts?.[requestId];
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
      stripeCheckouts: { ...(state.stripeCheckouts || {}), [requestId]: checkout },
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

  @callable()
  async getPayments(
    direction: string | null,
    limit: number,
  ): Promise<PaymentRecord[]> {
    const state = this.ensureState();

    const filtered = direction
      ? state.payments.filter((payment) => payment.direction === direction)
      : state.payments;

    return filtered.slice(-limit).reverse();
  }

  @callable()
  async getSlackMessages(limit: number): Promise<EmailRecord[]> {
    const state = this.ensureState();
    const slackMessages = state.emails.filter((email) => email.from.startsWith("slack:"));
    return slackMessages.slice(-limit).reverse();
  }

  @callable()
  async chat(
    message: string,
  ): Promise<{ response: string; history: ChatMessage[] }> {
    const response = await this.generateAIResponse(message);
    return {
      response,
      history: this.chatHistory,
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

      this.setState({
        ...latest,
        payments: [...latest.payments, payment],
        totalPaymentsSent: latest.totalPaymentsSent + 1,
      });

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
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }

    const url = new URL(request.url);
    const provider = url.pathname.split("/").pop() as "github" | "stripe" | "slack";

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
      agentName = payload?.data?.object?.customer || payload?.account || payload?.id || "default";
      agentName = String(agentName).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    } else if (provider === "slack") {
      eventType = payload.event?.type || payload.type || "event";
      agentName = payload.team_id || payload.event?.channel || "default";
      agentName = String(agentName).toLowerCase().replace(/[^a-z0-9-]/g, "-");
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
    const webhookEvents = [...(state.webhookEvents || []), event];

    this.setState({
      ...state,
      webhookEvents,
      totalWebhooksReceived: (state.totalWebhooksReceived || 0) + 1,
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
  // RPC: Get webhook events
  // ===========================================================================
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
    try {
      const ok = await sendSignedWebhook(url, payload, this.env.EMAIL_SECRET);
      return { success: ok };
    } catch (e) {
      console.error("Outgoing webhook failed:", e);
      return { success: false };
    }
  }
}
