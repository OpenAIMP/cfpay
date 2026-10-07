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
} from "./types";
import { formatAmount, formatEthAmount, generateId, parsePaymentConfig } from "./payments";

const DEFAULT_STATE: AgentState = {
  emails: [],
  payments: [],
  totalEmailsReceived: 0,
  totalEmailsSent: 0,
  totalPaymentsReceived: 0,
  totalPaymentsSent: 0,
};

type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class CfmailAgentSQLite extends Agent<Env, AgentState> {
  initialState: AgentState = {
    ...DEFAULT_STATE,
    emails: [],
    payments: [],
  };

  private chatHistory: ChatMessage[] = [];

  async onStart(): Promise<void> {
    this.ensureState();
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

  async generateAIResponse(
    userMessage: string,
    emailContext?: string,
  ): Promise<string> {
    const systemPrompt = `You are the CFmail Agent, an AI assistant operating via email.
Be concise, professional, and helpful. Do not claim to have completed an action
unless the supplied system data confirms it.`;

    const messages: AiMessage[] = [
      {
        role: "system",
        content: systemPrompt,
      },
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
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as never,
        {
          messages,
        } as never,
      );

      const text =
        (response as { response?: string }).response ??
        "I could not generate a response.";

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
    console.log(`State after inbound: ${stateAfterInbound.emails.length} emails, ${stateAfterInbound.totalEmailsReceived} received`);

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
        totalEmailsSent: state.totalEmailsSent + 1,
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
    paymentClaim: PaymentClaim,
  ): Promise<{ success: boolean; response: string; paymentId: string }> {
    const state = this.ensureState();
    const paymentId = generateId();
    const isNativeEth =
      paymentClaim.asset.toLowerCase() === "0x0000000000000000000000000000000000000000";
    const paymentConfig = parsePaymentConfig(this.env.PAYMENT_CONFIG);
    if (!paymentConfig.networks[paymentClaim.network]) {
      throw new Error("PAYMENT-SIGNATURE specifies an unsupported network");
    }
    const paymentAmount = isNativeEth
      ? formatEthAmount(paymentClaim.amount)
      : formatAmount(paymentClaim.amount).replace("$", "");
    const currency = isNativeEth ? "ETH" : "USDC";

    const payment: PaymentRecord = {
      id: paymentId,
      direction: "received",
      amount: paymentClaim.amount,
      currency,
      network: paymentClaim.network,
      toAddress: paymentClaim.payTo,
      description: this.env.PAYMENT_DESCRIPTION,
      status: "confirmed",
      txHash: paymentClaim.txHash,
      createdAt: new Date().toISOString(),
    };

    const aiResponse = await this.generateAIResponse(request);

    const emailResult = await this.sendOutboundEmail(
      senderEmail,
      "CFmail Agent Request Received",
      `${aiResponse}\n\n---\nRequest ID: ${paymentId}\nVerified payment: ${paymentAmount} ${currency} on ${paymentClaim.network}\nTransaction: ${paymentClaim.txHash}`,
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
      const state = this.ensureState();
      console.log(`Dashboard data requested: ${state.emails.length} emails, ${state.totalEmailsReceived} received`);
      return state;
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
}