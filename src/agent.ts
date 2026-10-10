import { Agent, callable } from "agents";
import { isAutoReplyEmail, type AgentEmail } from "agents/email";
import PostalMime from "postal-mime";
import type { AgentState, ChatMessage, EmailRecord, Env, PaymentClaim, PaymentRecord, WebhookEvent } from "./types";
import { formatAmount, generateId } from "./payments";
import { sendSlackNotification, sendSignedWebhook } from "./webhooks";
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

  @callable()
  async payExternalEndpoint(
    _url: string,
    _method: string,
    _body: string | null,
  ): Promise<{ success: boolean; status: number; response: string }> {
    return {
      success: false,
      status: 403,
      response: "External payments are disabled.",
    };
  }

  // ===========================================================================
  // Webhooks: Incoming webhook handler (onRequest)
  // ===========================================================================
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Provider identified by the X-Webhook-Provider header set by the Worker
    // when forwarding verified webhooks, or by the /webhooks/<provider> path.
    const headerProvider = request.headers.get("X-Webhook-Provider");
    const pathProvider = url.pathname.startsWith("/webhooks/")
      ? url.pathname.split("/").pop()
      : null;

    // Direct agent requests (via routeAgentRequest) get a status summary.
    if (request.method !== "POST") {
      return this.statusResponse();
    }

    const rawBody = await request.text();
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }

    const provider = (headerProvider || pathProvider) as "github" | "stripe" | "slack" | null;
    if (!provider) {
      return this.statusResponse();
    }

    // Slack URL verification challenge
    if (provider === "slack" && payload?.type === "url_verification" && payload?.challenge) {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    await this.processWebhookEvent(provider, payload);

    // AI analysis of the event
    const aiInsight = await this.generateAIResponse(
      `Analyze this ${provider} webhook event:\n${JSON.stringify(payload, null, 2).slice(0, 2000)}\n\nProvide a brief summary and any recommended actions:`,
    );

    // Slack: post the analysis to the payload's response_url (slash commands,
    // interactive payloads, app_home events)
    if (provider === "slack" && typeof payload?.response_url === "string" && payload.response_url) {
      try {
        await fetch(payload.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: aiInsight }),
        });
      } catch (err) {
        console.error("Failed to send Slack response_url reply:", err);
      }
    }

    // Slack slash commands expect the reply as the immediate HTTP response
    if (provider === "slack" && payload?.command) {
      return new Response(JSON.stringify({ text: aiInsight }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("OK");
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
      const customerId = payload?.data?.object?.customer || payload?.account || payload?.id || "default";
      agentName = `stripe-${customerId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    } else if (provider === "slack") {
      eventType = payload.event?.type || payload.type || "event";
      const channelId = payload.channel_id ?? payload.team_id ?? payload.event?.channel ?? "default";
      agentName = `slack-${channelId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    const event: WebhookEvent = {
      id: generateId(),
      provider,
      eventType,
      agentName,
      payload,
      receivedAt: new Date().toISOString(),
      processed: true,
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
