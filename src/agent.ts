import { Agent, callable } from "agents";
import { isAutoReplyEmail, type AgentEmail } from "agents/email";
import PostalMime from "postal-mime";
import type { AgentState, ChatMessage, EmailRecord, Env, PaymentClaim, PaymentRecord, WebhookEvent } from "./types";
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

  @callable()
  async processPaidRequest(
    senderEmail: string,
    request: string,
    claim?: PaymentClaim,
  ): Promise<{ success: boolean; response: string; paymentId: string }> {
    const state = this.ensureState();
    const paymentId = generateId();

    const payment: PaymentRecord = {
      id: paymentId,
      direction: "received",
      amount: claim?.amount || "10000",
      currency: claim?.asset === "0x0000000000000000000000000000000000000000" ? "ETH" : "USDC",
      network: claim?.network || "base",
      fromAddress: undefined,
      toAddress: this.env.PAY_TO_ADDRESS,
      description: this.env.PAYMENT_DESCRIPTION,
      status: "confirmed",
      txHash: claim?.txHash,
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
  // Webhooks: Process a verified webhook event
  // ===========================================================================
  private async processWebhookEvent(provider: "github" | "stripe" | "slack", payload: any) {
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
