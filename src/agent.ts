import { Agent, callable } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
  type AgentEmail,
} from "agents/email";
import PostalMime from "postal-mime";
import type { Env, AgentState, EmailRecord, PaymentRecord, ChatMessage } from "./types";
import { generateId, formatAmount } from "./payments";

const DEFAULT_STATE: AgentState = {
  emails: [],
  payments: [],
  totalEmailsReceived: 0,
  totalEmailsSent: 0,
  totalPaymentsReceived: 0,
  totalPaymentsSent: 0,
};

export class CfmailAgent extends Agent<Env, AgentState> {
  private chatHistory: ChatMessage[] = [];

  async onStart() {
    if (!this.state || !this.state.emails) {
      this.setState({ ...DEFAULT_STATE });
    }
  }

  async generateAIResponse(userMessage: string, emailContext?: string): Promise<string> {
    const systemPrompt = `You are the CFmail Agent, an AI assistant operating via email at cfmail.openaimp.com.
You receive and respond to emails, and you accept payments through the x402 protocol (USDC on Base).
Be concise, professional, and helpful.`;
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    if (emailContext) {
      messages.push({ role: "user", content: `Email context:\n${emailContext}\n\nRequest: ${userMessage}` });
    } else {
      messages.push({ role: "user", content: userMessage });
    }
    if (this.chatHistory.length > 0) {
      for (const m of this.chatHistory.slice(-10)) {
        messages.push({ role: m.role, content: m.content });
      }
    }
    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
        messages: messages.map((m) => ({ role: m.role as any, content: m.content })),
      });
      const text = (response as any).response || "I could not generate a response.";
      this.chatHistory.push(
        { role: "user", content: userMessage, timestamp: new Date().toISOString() },
        { role: "assistant", content: text, timestamp: new Date().toISOString() }
      );
      return text;
    } catch (error) {
      console.error("AI generation failed:", error);
      return `I received your message but encountered an issue generating an AI response. Your request has been logged.`;
    }
  }

  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);
    console.log(`Email from ${email.from}: ${parsed.subject}`);
    const emailId = generateId();
    const emailRecord: EmailRecord = {
      id: emailId, from: email.from, to: email.to, subject: parsed.subject || "(no subject)",
      body: parsed.text || "", html: parsed.html, direction: "inbound",
      receivedAt: new Date().toISOString(), paid: false,
    };
    const emails = this.state.emails || [];
    emails.push(emailRecord);
    let aiSummary: string | undefined;
    try {
      const summaryResponse = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
        messages: [
          { role: "system", content: "Summarize this email in 1-2 sentences." },
          { role: "user", content: `Subject: ${parsed.subject}\n\n${parsed.text || ""}` },
        ],
      });
      aiSummary = (summaryResponse as any).response;
      emailRecord.aiSummary = aiSummary;
    } catch (e) { console.error("AI summary failed:", e); }
    const aiResponse = await this.generateAIResponse(
      parsed.text || parsed.subject || "",
      `From: ${email.from}\nSubject: ${parsed.subject}\nBody: ${parsed.text}`
    );
    emailRecord.aiResponse = aiResponse;
    this.setState({ ...this.state, emails, totalEmailsReceived: (this.state.totalEmailsReceived || 0) + 1 });
    await this.replyToEmail(email, {
      fromName: "CFmail Agent",
      subject: `Re: ${parsed.subject || "Your email"}`,
      body: aiResponse,
      secret: this.env.EMAIL_SECRET,
    });
    const outboundRecord: EmailRecord = {
      id: generateId(), from: email.to, to: email.from,
      subject: `Re: ${parsed.subject || "Your email"}`, body: aiResponse,
      direction: "outbound", receivedAt: new Date().toISOString(), paid: false,
    };
    emails.push(outboundRecord);
    this.setState({ ...this.state, emails, totalEmailsSent: (this.state.totalEmailsSent || 0) + 1 });
  }

  @callable()
  async sendOutboundEmail(to: string, subject: string, body: string): Promise<{ success: boolean; emailId: string }> {
    const emailId = generateId();
    const record: EmailRecord = {
      id: emailId, from: `agent@${this.env.EMAIL_DOMAIN}`, to, subject, body,
      direction: "outbound", receivedAt: new Date().toISOString(), paid: false,
    };
    try {
      await this.env.EMAIL.send({
        to,
        from: `agent@${this.env.EMAIL_DOMAIN}`,
        replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
        subject,
        text: body,
      });
      const emails = this.state.emails || [];
      emails.push(record);
      this.setState({ ...this.state, emails, totalEmailsSent: (this.state.totalEmailsSent || 0) + 1 });
      return { success: true, emailId };
    } catch (error) {
      console.error("Failed to send email:", error);
      return { success: false, emailId };
    }
  }

  @callable()
  async processPaidRequest(senderEmail: string, request: string): Promise<{ success: boolean; response: string; paymentId: string }> {
    const paymentId = generateId();
    const payment: PaymentRecord = {
      id: paymentId, direction: "received", amount: this.env.PAYMENT_AMOUNT,
      currency: "USDC", network: this.env.PAYMENT_NETWORK, toAddress: this.env.PAY_TO_ADDRESS,
      description: this.env.PAYMENT_DESCRIPTION, status: "confirmed", createdAt: new Date().toISOString(),
    };
    const payments = this.state.payments || [];
    payments.push(payment);
    const aiResponse = await this.generateAIResponse(request);
    const emailResult = await this.sendOutboundEmail(
      senderEmail, "Paid Response — CFmail Agent",
      `${aiResponse}\n\n---\nPayment: ${formatAmount(this.env.PAYMENT_AMOUNT)} USDC on ${this.env.PAYMENT_NETWORK}\nPayment ID: ${paymentId}\nStatus: Confirmed`
    );
    payment.relatedEmailId = emailResult.emailId;
    this.setState({ ...this.state, payments, totalPaymentsReceived: (this.state.totalPaymentsReceived || 0) + 1 });
    return { success: true, response: aiResponse, paymentId };
  }

  @callable()
  async getDashboardData(): Promise<AgentState> { return this.state; }

  @callable()
  async getEmails(direction: string | null, limit: number): Promise<EmailRecord[]> {
    const emails = this.state.emails || [];
    let filtered = emails;
    if (direction) { filtered = emails.filter((e) => e.direction === direction); }
    return filtered.slice(-limit).reverse();
  }

  @callable()
  async getPayments(direction: string | null, limit: number): Promise<PaymentRecord[]> {
    const payments = this.state.payments || [];
    let filtered = payments;
    if (direction) { filtered = payments.filter((p) => p.direction === direction); }
    return filtered.slice(-limit).reverse();
  }

  @callable()
  async chat(message: string): Promise<{ response: string; history: ChatMessage[] }> {
    const response = await this.generateAIResponse(message);
    return { response, history: this.chatHistory };
  }

  @callable()
  async payExternalEndpoint(url: string, method: string, body: string | null): Promise<{ success: boolean; status: number; response: string }> {
    try {
      const { payX402Endpoint } = await import("./payments");
      const res = await payX402Endpoint(url, method, body, this.env.PAYMENT_PRIVATE_KEY);
      const text = await res.text();
      const payment: PaymentRecord = {
        id: generateId(), direction: "sent", amount: this.env.PAYMENT_AMOUNT,
        currency: "USDC", network: this.env.PAYMENT_NETWORK, toAddress: url,
        description: `Payment to ${url}`, status: res.ok ? "confirmed" : "failed",
        createdAt: new Date().toISOString(),
      };
      const payments = this.state.payments || [];
      payments.push(payment);
      this.setState({ ...this.state, payments, totalPaymentsSent: (this.state.totalPaymentsSent || 0) + 1 });
      return { success: res.ok, status: res.status, response: text };
    } catch (error: any) {
      console.error("External payment failed:", error);
      return { success: false, status: 0, response: error.message || "Payment failed" };
    }
  }
}
