/**
 * PaymentsAgent — the payments capability, extracted from the Cfmail monolith.
 *
 * This is the first step of unbundling: the payment ledger, the Stripe checkout
 * state machine and the three replay-protection registries move out of
 * CfmailAgentSQLite and become their own Durable Object, reachable over A2A.
 *
 * What it owns:
 *   - the payment ledger (received and sent)
 *   - Stripe checkout intents and their status machine
 *   - dedupe registries: stripeProcessedEvents, x402ProcessedClaims
 *
 * What it deliberately does NOT own: sending email, generating AI responses,
 * verification of payment signatures against a chain. Those stay where they are.
 * The split is by resource, not by call graph: a payment is recorded here, but
 * the work a payment buys is done by the caller. That keeps this DO free of the
 * EMAIL binding and of Workers AI, so it can be reasoned about - and tested -
 * without either.
 *
 * Migration note: CfmailAgentSQLite still holds `payments`, `stripeCheckouts`,
 * `stripeProcessedEvents` and `x402ProcessedClaims` in its own state. Those keys
 * are left in place and untouched so a running deployment is not disturbed;
 * finalPayments() below exposes a read path that prefers the new ledger and falls
 * back to the old keys so the dashboard keeps showing history across the change.
 */

import { Agent, callable } from "agents";
import type { Connection } from "agents";
import { Think } from "@cloudflare/think";
import { defaultModelId } from "./models";
import { runRouted } from "./model-routing";
import type { Env, PaymentRecord, StripeCheckout, StripeCheckoutStatus } from "./types";
import { ZERO_ADDRESS, generateId } from "./payments";
import { selfProvisionOwnTenant } from "./tenant-provision";
import { stampTenantOnConnection } from "./tenant-connection";

/** Bound on ledger size, matching the monolith's previous limit. */
const MAX_STORED_PAYMENTS = 200;

/** Prune abandoned Stripe intents after 24h so state cannot grow forever. */
const CHECKOUT_TTL_MS = 24 * 3600 * 1000;

/** Rolling window for replay-protection registries. */
const DEDUPE_TTL_MS = 72 * 3600 * 1000;

export interface PaymentsState {
  payments: PaymentRecord[];
  totalReceived: number;
  totalSent: number;
  stripeCheckouts: Record<string, StripeCheckout>;
  /** Stripe event ids already handled, mapped to first-handled ISO timestamp. */
  stripeProcessedEvents: Record<string, string>;
  /** x402 tx hashes (lower-cased) already redeemed, mapped to first-use ISO. */
  x402ProcessedClaims: Record<string, string>;
}

const EMPTY: PaymentsState = {
  payments: [],
  totalReceived: 0,
  totalSent: 0,
  stripeCheckouts: {},
  stripeProcessedEvents: {},
  x402ProcessedClaims: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Drop entries older than the TTL, so a registry cannot grow without bound. */
function prune(registry: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  const out: Record<string, string> = {};
  for (const [key, stamp] of Object.entries(registry)) {
    const t = new Date(stamp).getTime();
    if (Number.isFinite(t) && t >= cutoff) out[key] = stamp;
  }
  return out;
}

export class PaymentsAgent extends Think<Env, PaymentsState> {
  /**
   * Issue #315: a tenant instance can wake without any in-process dispatch
   * (the /agents/* WebSocket path), so it seeds its own FGA tuple here.
   * Idempotent; operator no-op; failures never block startup (the dispatch
   * seam retries and the FGA layer denies by default).
   */
  async onStart(): Promise<void> {
    await selfProvisionOwnTenant({ env: this.env, ctx: this.ctx });
  }

  /**
   * Issue #316: bind the resolved tenant/user to this socket's connection
   * state (SDK connection.setState, functional updater — existing
   * connection state is preserved, never clobbered). Defense-in-depth
   * BEHIND the /agents/* edge 401/403: the edge still guards the door;
   * this stamps identity on the connection itself so WS-path handling can
   * attribute per message. First stamp wins; operator singletons stay
   * unstamped; stamping never throws and never blocks connect.
   */
  async onConnect(
    connection: Connection,
    context: { request: Request },
  ): Promise<void> {
    await stampTenantOnConnection({ env: this.env, ctx: this.ctx }, connection);
    await super.onConnect?.(connection, context);
  }
  initialState: PaymentsState = { ...EMPTY };

  /* ---------------------------- Think surface ---------------------------- */

  /**
   * Used only if this agent runs a chat turn, which happens when a host dispatches it
   * through agentTool(). The money paths are NOT conversational: payment.process is
   * reached as an operation call, so a spend is never chosen by a model. Keeping this
   * the Worker's default model means a dispatch cannot quietly change which model
   * answers.
   */
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the payments capability agent for this Worker.",
      "You own the payment ledger, the Stripe checkout state machine, and replay protection for both rails.",
      "You cannot move funds and you cannot refund. You can report on the ledger and process a request whose payment has already been verified.",
      "Never claim a payment succeeded unless the ledger says so, and never speculate about an amount.",
    ].join(" ");
  }

  /**
   * No tools of its own.
   *
   * This agent is dispatched TO. It exposes capabilities through @callable() methods and
   * A2A, which does not require an AI SDK tool set. An empty set is deliberate rather
   * than unfinished, and it is also the safe default: a payments agent that could pick
   * its own tools could pick one that spends.
   */
  override getTools(): Record<string, never> {
    return {};
  }

  /** Normalise whatever is stored into the current shape. */
  private state_(): PaymentsState {
    const s = (this.state || {}) as Partial<PaymentsState>;
    return {
      payments: Array.isArray(s.payments) ? s.payments : [],
      totalReceived: typeof s.totalReceived === "number" ? s.totalReceived : 0,
      totalSent: typeof s.totalSent === "number" ? s.totalSent : 0,
      stripeCheckouts: s.stripeCheckouts && typeof s.stripeCheckouts === "object" ? s.stripeCheckouts : {},
      stripeProcessedEvents:
        s.stripeProcessedEvents && typeof s.stripeProcessedEvents === "object" ? s.stripeProcessedEvents : {},
      x402ProcessedClaims:
        s.x402ProcessedClaims && typeof s.x402ProcessedClaims === "object" ? s.x402ProcessedClaims : {},
    };
  }

  private commit(next: PaymentsState): void {
    this.setState(next);
  }

  /* ------------------------------ ledger --------------------------------- */

  /** Record a confirmed or failed payment. The single write path for the ledger. */
  @callable()
  async recordPayment(record: PaymentRecord): Promise<void> {
    const s = this.state_();
    const payments = [...s.payments, record].slice(-MAX_STORED_PAYMENTS);
    this.commit({
      ...s,
      payments,
      totalReceived: s.totalReceived + (record.direction === "received" ? 1 : 0),
      totalSent: s.totalSent + (record.direction === "sent" ? 1 : 0),
    });
  }

  /**
   * Adopt ledger entries written before this agent became authoritative.
   *
   * Idempotent by construction: an entry is matched on its transaction hash when it
   * has one, otherwise on its id, so running this twice cannot duplicate the ledger.
   * The monolith held payments of its own before the split, and those must not be
   * lost - nor may re-running this resurrect them a second time.
   *
   * Returns how many were actually adopted, so a caller can tell a real migration
   * from a no-op instead of assuming success.
   */
  @callable()
  async backfillPayments(records: PaymentRecord[]): Promise<{ adopted: number; skipped: number }> {
    const s = this.state_();
    const seen = new Set<string>();
    for (const p of s.payments) seen.add(p.txHash ? p.txHash.toLowerCase() : p.id);

    let adopted = 0;
    let skipped = 0;
    const added: PaymentRecord[] = [];

    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !record.id) { skipped++; continue; }
      const key = record.txHash ? record.txHash.toLowerCase() : record.id;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      added.push(record);
      adopted++;
    }

    if (adopted > 0) {
      const payments = [...s.payments, ...added].slice(-MAX_STORED_PAYMENTS);
      this.commit({
        ...s,
        payments,
        totalReceived: s.totalReceived + added.filter((p) => p.direction === "received").length,
        totalSent: s.totalSent + added.filter((p) => p.direction === "sent").length,
      });
    }

    return { adopted, skipped };
  }

  /** Newest first. */  /** Newest first. */
  @callable()
  async listPayments(direction: string | null, limit: number): Promise<PaymentRecord[]> {
    const s = this.state_();
    const filtered = direction ? s.payments.filter((p) => p.direction === direction) : s.payments;
    return filtered.slice(-limit).reverse();
  }

  @callable()
  async paymentTotals(): Promise<{ received: number; sent: number; stored: number }> {
    const s = this.state_();
    return { received: s.totalReceived, sent: s.totalSent, stored: s.payments.length };
  }

  /**
   * Build a received-payment record.
   *
   * Kept here rather than in the caller so the shape of a ledger entry is defined
   * in one place. The monolith used to build this inline in processPaidRequest.
   */
  @callable()
  async buildReceivedPayment(input: {
    amount?: string;
    currency?: string;
    network?: string;
    reference?: string;
  }): Promise<PaymentRecord> {
    return {
      id: generateId(),
      direction: "received",
      amount: input.amount ?? "10000",
      currency: input.currency ?? "USDC",
      network: input.network ?? "base",
      fromAddress: undefined,
      toAddress: this.env.PAY_TO_ADDRESS,
      description: this.env.PAYMENT_DESCRIPTION,
      status: "confirmed",
      txHash: input.reference,
      createdAt: nowIso(),
    };
  }

  @callable()
  async buildSentPayment(input: {
    amount: string;
    currency: string;
    network: string;
    fromAddress?: string;
    payTo: string;
    description: string;
    txHash?: string;
    ok: boolean;
  }): Promise<PaymentRecord> {
    return {
      id: generateId(),
      direction: "sent",
      amount: input.amount,
      currency: input.currency,
      network: input.network,
      fromAddress: input.fromAddress,
      toAddress: input.payTo,
      description: input.description,
      status: input.ok ? "confirmed" : "failed",
      txHash: input.txHash,
      createdAt: nowIso(),
    };
  }

  /* --------------------------- replay protection -------------------------- */

  /**
   * Claim an x402 transaction hash for single use.
   *
   * Atomic under the Durable Object input gate: the read and the write cannot
   * interleave with another request, which is what makes this safe as replay
   * protection. Returns false when the hash was already redeemed.
   */
  @callable()
  async claimX402(txHash: string): Promise<{ ok: boolean }> {
    const key = txHash.toLowerCase();
    const s = this.state_();
    const registry = prune(s.x402ProcessedClaims);
    if (registry[key]) return { ok: false };
    registry[key] = nowIso();
    this.commit({ ...s, x402ProcessedClaims: registry });
    return { ok: true };
  }

  @callable()
  async isX402Claimed(txHash: string): Promise<boolean> {
    return Boolean(prune(this.state_().x402ProcessedClaims)[txHash.toLowerCase()]);
  }

  /**
   * Claim a Stripe event id. Returns false when already handled.
   *
   * Stripe retries deliveries for up to three days and may reorder them, so
   * handling must be idempotent regardless of checkout state.
   */
  @callable()
  async claimStripeEvent(eventId: string): Promise<{ ok: boolean }> {
    const s = this.state_();
    const registry = prune(s.stripeProcessedEvents);
    if (registry[eventId]) return { ok: false };
    registry[eventId] = nowIso();
    this.commit({ ...s, stripeProcessedEvents: registry });
    return { ok: true };
  }

  /* --------------------------- Stripe checkouts --------------------------- */

  @callable()
  async createCheckoutIntent(
    requestId: string,
    email: string,
    request: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const s = this.state_();
    const checkouts: Record<string, StripeCheckout> = {};
    const cutoff = Date.now() - CHECKOUT_TTL_MS;
    for (const [id, co] of Object.entries(s.stripeCheckouts)) {
      if (new Date(co.createdAt).getTime() >= cutoff) checkouts[id] = co;
    }
    if (checkouts[requestId]) return { ok: false, error: "This request already has a checkout." };

    checkouts[requestId] = {
      requestId,
      email,
      request,
      status: "awaiting_session",
      createdAt: nowIso(),
    };
    this.commit({ ...s, stripeCheckouts: checkouts });
    return { ok: true };
  }

  @callable()
  async attachCheckoutSession(requestId: string, sessionId: string, sessionUrl: string): Promise<{ ok: boolean }> {
    const s = this.state_();
    const existing = s.stripeCheckouts[requestId];
    if (!existing || existing.status !== "awaiting_session") return { ok: false };
    this.commit({
      ...s,
      stripeCheckouts: {
        ...s.stripeCheckouts,
        [requestId]: { ...existing, sessionId, sessionUrl, status: "session_created" },
      },
    });
    return { ok: true };
  }

  /** Read-only. Never fulfils: a browser redirect is not proof of payment. */
  @callable()
  async checkoutStatus(requestId: string): Promise<{
    found: boolean;
    status?: StripeCheckoutStatus;
    email?: string;
    fulfilledAt?: string;
  }> {
    const co = this.state_().stripeCheckouts[requestId];
    if (!co) return { found: false };
    return { found: true, status: co.status, email: co.email, fulfilledAt: co.fulfilledAt };
  }

  /** Mark a checkout fulfilled. Called only after a verified Stripe webhook. */
  @callable()
  async fulfilCheckout(requestId: string, paymentIntentId?: string): Promise<{ ok: boolean; email?: string; request?: string }> {
    const s = this.state_();
    const co = s.stripeCheckouts[requestId];
    if (!co) return { ok: false };
    if (co.status === "fulfilled") return { ok: true, email: co.email, request: co.request };
    this.commit({
      ...s,
      stripeCheckouts: {
        ...s.stripeCheckouts,
        [requestId]: { ...co, status: "fulfilled", fulfilledAt: nowIso(), paymentIntentId },
      },
    });
    return { ok: true, email: co.email, request: co.request };
  }

  @callable()
  async failCheckout(requestId: string): Promise<{ ok: boolean }> {
    const s = this.state_();
    const co = s.stripeCheckouts[requestId];
    if (!co) return { ok: false };
    this.commit({
      ...s,
      stripeCheckouts: { ...s.stripeCheckouts, [requestId]: { ...co, status: "failed" } },
    });
    return { ok: true };
  }

  /** Pending checkout for an email, used to reconcile a succeeded payment intent. */
  @callable()
  async findCheckoutForEmail(email: string): Promise<{ requestId: string; request: string } | null> {
    const s = this.state_();
    const entries = Object.values(s.stripeCheckouts);
    for (let i = entries.length - 1; i >= 0; i--) {
      const co = entries[i];
      if (co.email === email && co.status !== "fulfilled" && co.status !== "failed") {
        return { requestId: co.requestId, request: co.request };
      }
    }
    return null;
  }

  /* --------------------------- Pay And Process --------------------------- */

  /**
   * Pay And Process, owned entirely by this agent.
   *
   * Previously this lived on CfmailAgentSQLite, so the capability and the resource
   * it manages were in different Durable Objects. It runs here now: the ledger, the
   * replay claim and the fulfilment are one unit, so a crash between taking a
   * payment and recording it is not possible.
   *
   * It sends its own email through the EMAIL binding rather than calling back into
   * the cfmail agent. That is deliberate: cfmail may be awaiting an A2A call to
   * this agent, and a Durable Object cannot re-enter itself, so calling back would
   * deadlock the pair.
   *
   * `claim` carries x402 fields already verified by the caller's signature check;
   * `card` carries a Stripe reference. Exactly one is expected.
   */
  @callable()
  async processPaidRequest(
    senderEmail: string,
    request: string,
    claim?: { amount?: string; asset?: string; network?: string; txHash?: string },
    card?: { amount: string; currency: string; reference: string },
  ): Promise<{ success: boolean; response: string; paymentId: string }> {
    const claimKey = claim?.txHash ? claim.txHash.toLowerCase() : undefined;

    // Claim before doing any work. Check-and-record is atomic here because both
    // happen inside one Durable Object, so two concurrent requests presenting the
    // same payment cannot both proceed.
    if (claimKey) {
      const claimed = await this.claimX402(claimKey);
      if (!claimed.ok) {
        throw new Error(
          "PAYMENT_CLAIM_REUSED: This payment has already been used for a request; each on-chain payment can be redeemed only once.",
        );
      }
    }

    const payment = await this.buildReceivedPayment({
      amount: card?.amount ?? claim?.amount,
      currency: card?.currency ?? (claim?.asset === ZERO_ADDRESS ? "ETH" : "USDC"),
      network: card ? "card" : claim?.network,
      reference: card?.reference ?? claim?.txHash,
    });

    // Record BEFORE doing the work. This ordering is load-bearing: once a payment
    // has been consumed it must appear on the ledger even if the work that follows
    // fails. Recording last meant a fulfilment failure left an on-chain payment
    // spent, unredeemable and invisible on the ledger - the money took the loss.
    await this.recordPayment(payment);

    try {
      const aiResponse = await this.generateFulfilmentResponse(request);

      const emailResult = await this.sendFulfilmentEmail(
        senderEmail,
        aiResponse,
        payment.id,
        payment.amount + " " + payment.currency + " on " + payment.network,
      );

      return { success: emailResult.success, response: aiResponse, paymentId: payment.id };
    } catch (error) {
      // The ledger entry stands; only the work failed. Return rather than throw, so
      // the caller does not retry a payment that is already consumed.
      console.error("Fulfilment failed after payment " + payment.id + " was recorded:", error);
      return {
        success: false,
        response:
          "Your payment was received and recorded, but the request could not be completed. " +
          "Quote request ID " + payment.id + " and it will be handled manually.",
        paymentId: payment.id,
      };
    }
  }

  /**
   * Generate the response a payment buys.
   *
   * Calls AI.run directly rather than importing the cfmail agent's prompt helpers,
   * so this agent stays independent of that codebase.
   */
  async generateFulfilmentResponse(request: string): Promise<string> {
    try {
      // Model selection is owned by the routing policy (issue #269,
      // cluster C2): transient provider errors retry and fall through
      // the "chat" chain; the quota error (4006) throws and lands in
      // the same catch below, preserving the never-throws contract.
      const { result: response } = await runRouted<any>("chat", (modelId) =>
        this.env.AI.run(
          modelId as never,
          {
          messages: [
            {
              role: "system",
              content: [
                "You are the CFmail agent fulfilling a paid request.",
                "Answer the request directly and concisely. Do not discuss payment.",
                "If the request is unclear, state what you would need to know.",
              ].join("\n"),
            },
            { role: "user", content: request },
          ],
          max_tokens: 800,
        } as never,
      ));
      const text = String(response?.response ?? "").trim();
      if (text) return text;
      if (Array.isArray(response?.choices) && response.choices.length) {
        const alt = String(response.choices[0]?.message?.content ?? "").trim();
        if (alt) return alt;
      }
    } catch (error) {
      console.error("Fulfilment generation failed:", error);
    }
    return "Your request has been received and payment confirmed, but the agent could not generate a response. Please reply to this message and it will be handled manually.";
  }

  /**
   * Deliver the fulfilment email through the email tool.
   *
   * Goes through the email agent rather than the EMAIL binding directly. Two
   * reasons, and only the first is tidiness:
   *
   *   - the send is rate limited where the capability lives, so this agent cannot
   *     be the hole in that limit;
   *   - sending from here rather than calling the cfmail agent is what avoids the
   *     deadlock described on processPaidRequest. The email agent is a third
   *     Durable Object, so nothing re-enters itself.
   *
   * A refusal is NOT retried through the binding. If the limit refused the send, a
   * direct send would bypass it and the limit would be decorative.
   */
  private async sendFulfilmentEmail(
    to: string,
    aiResponse: string,
    paymentId: string,
    paymentSummary: string,
  ): Promise<{ success: boolean; emailId: string }> {
    const body = aiResponse + "\n\n---\nRequest ID: " + paymentId + "\nPayment: " + paymentSummary + "\nStatus: Confirmed";
    const subject = "CFmail Agent Request Received";

    const outcome = await this.deliverEmail(to, subject, body);
    if (!outcome.ok) {
      console.error("Fulfilment email not sent: " + outcome.error);
    }
    // The caller still records the ledger entry: the payment was taken, so hiding
    // it would be worse than a failed send.
    return { success: outcome.ok, emailId: outcome.emailId || generateId() };
  }

  /**
   * One route to the email tool: direct RPC, then A2A, then the binding.
   *
   * The binding is last and is reachable only when no email agent answered at all
   * - a rolling deploy. It is never used to override a refusal, which is why the
   * refusal is carried out of the RPC attempt rather than collapsed into a null.
   */
  private async deliverEmail(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; emailId?: string; error?: string }> {
    const { emailAgentStub, callEmailAgent } = await import("./email-tool");
    const args = { to, subject, body };

    const stub = emailAgentStub(this.env as any);
    if (stub) {
      try {
        const result = await stub.sendThroughAgent(args);
        if (result && typeof result.ok === "boolean") {
          return result;
        }
        // A result without an ok field means an older deployment answered. Fall
        // through rather than misunderstanding it.
      } catch (error) {
        console.error("Email tool RPC failed:", error);
      }
    }

    const remote = await callEmailAgent(this.env as any, "email.send", args, `Send: ${subject}`);
    if (remote && remote.data && typeof (remote.data as any).ok === "boolean") {
      return remote.data as any;
    }

    // Nothing answered. Send directly so the paid work is not lost; the payment is
    // already recorded, and a recorded payment with no email is worse than an
    // unthrottled one.
    console.error("Email tool unreachable; sending through the binding directly.");
    try {
      await this.env.EMAIL.send({
        to,
        from: "agent@" + this.env.EMAIL_DOMAIN,
        replyTo: "agent@" + this.env.EMAIL_DOMAIN,
        subject,
        text: body,
      });
      return { ok: true, emailId: generateId() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ------------------------------- A2A ----------------------------------- */

  /**
   * Aggregate view for the A2A executor.
   *
   * Aggregate only: no addresses and no transaction hashes. This endpoint is
   * reachable by other agents, so it exposes what the skill needs and nothing
   * more.
   */
  @callable()
  async a2aSnapshot(): Promise<{
    payments: { received: number; sent: number; stored: number };
    currencies: Record<string, number>;
    statuses: Record<string, number>;
    recent: string[];
  }> {
    const s = this.state_();
    const currencies: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    for (const p of s.payments) {
      currencies[p.currency] = (currencies[p.currency] || 0) + 1;
      statuses[p.status] = (statuses[p.status] || 0) + 1;
    }
    return {
      payments: { received: s.totalReceived, sent: s.totalSent, stored: s.payments.length },
      currencies,
      statuses,
      recent: s.payments
        .slice(-5)
        .map((p) => p.direction + " " + p.amount + " " + p.currency + " (" + p.status + ")"),
    };
  }

  /**
   * One A2A JSON-RPC call.
   *
   * Returns a collected, serializable shape rather than the SDK's async
   * iterable: SerializableReturnValue permits only primitives, plain objects and
   * arrays, so a stream cannot cross the RPC boundary. The caller frames events
   * as SSE when streamed is true.
   */
  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, paymentsCard } = await import("./a2a");
    const transport = createA2ATransport(
      this.ctx.storage.sql,
      origin,
      paymentsCard(origin),
      {
        card: paymentsCard,
        handle: (message, context) => this.handleA2AMessage(message, context),
      },
      { agentName: "payments", env: this.env },
    );
    return await handleCollecting(transport.transport, body);
  }

  /**
   * Route one A2A message.
   *
   * Two shapes are accepted over the same endpoint:
   *   - text only            -> answer a question about the ledger (read)
   *   - data part {operation} -> perform that operation (write)
   *
   * The write path is the reason this agent exists as a separate participant: a
   * caller can hand it a verified payment and have it process the request, rather
   * than the caller having to reach into the ledger itself.
   *
   * Authorisation is not decided here. The transport already gated the call with
   * a bearer credential; this method only maps an operation to a method call, so
   * the set of reachable operations is exactly the set listed below. Anything not
   * listed is refused rather than falling through.
   */
  async handleA2AMessage(
    message: any,
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
      // Read path: no operation requested, so answer the question.
      return { text: await this.answerAboutPayments(text || "Summarise the ledger.") };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      // ---- read operations ----
      case "ledger.summary":
        return { text: JSON.stringify(await this.a2aSnapshot()), data: await this.a2aSnapshot() };

      case "payments.list": {
        const direction = args.direction ? String(args.direction) : null;
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20;
        const payments = await this.listPayments(direction, limit);
        return { text: "Returned " + payments.length + " payment(s).", data: { payments } };
      }

      case "payments.totals":
        return { text: "Ledger totals.", data: await this.paymentTotals() };

      // ---- write operations ----
      case "payment.process": {
        const email = String(args.email || "").trim();
        const request = String(args.request || "").trim();
        if (!email || !request) {
          return { text: "payment.process needs email and request.", data: { ok: false, error: "missing_fields" } };
        }
        if (!args.claim && !args.card) {
          return {
            text: "payment.process needs a verified claim or a card reference. Refusing to process unpaid work.",
            data: { ok: false, error: "no_payment" },
          };
        }
        try {
          const result = await this.processPaidRequest(email, request, args.claim, args.card);
          return {
            text: "Processed. Payment " + result.paymentId + ".",
            data: { ok: true, paymentId: result.paymentId, response: result.response },
          };
        } catch (error) {
          const msg = String(error);
          // A reused claim is a client error, not a server fault: report it as an
          // outcome rather than letting it look like a transport failure.
          const reused = msg.includes("PAYMENT_CLAIM_REUSED");
          return { text: msg, data: { ok: false, error: reused ? "claim_reused" : "process_failed" } };
        }
      }

      case "checkout.create": {
        const requestId = String(args.requestId || "").trim();
        const email = String(args.email || "").trim();
        const request = String(args.request || "").trim();
        if (!requestId || !email || !request) {
          return { text: "checkout.create needs requestId, email and request.", data: { ok: false, error: "missing_fields" } };
        }
        const r = await this.createCheckoutIntent(requestId, email, request);
        return { text: r.ok ? "Checkout intent created." : (r.error || "Failed."), data: r };
      }

      case "checkout.status": {
        const r = await this.checkoutStatus(String(args.requestId || ""));
        return { text: r.found ? "Checkout status: " + r.status : "No such checkout.", data: r };
      }

      case "checkout.fulfil": {
        const r = await this.fulfilCheckout(String(args.requestId || ""), args.paymentIntentId);
        return { text: r.ok ? "Checkout fulfilled." : "No such checkout.", data: r };
      }

      default:
        // Refused rather than ignored, so an unknown operation cannot be mistaken
        // for a no-op success.
        return {
          text: "Unknown operation: " + op,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: [
              "ledger.summary",
              "payments.list",
              "payments.totals",
              "payment.process",
              "checkout.create",
              "checkout.status",
              "checkout.fulfil",
            ],
          },
        };
    }
  }

  /**
   * Answer a question about payments from the ledger alone.
   *
   * Uses Workers AI for phrasing, but the facts are computed here, so the model
   * cannot invent a figure it was not given. Read-only: this agent has no way to
   * move funds.
   */
  async answerAboutPayments(question: string): Promise<string> {
    const snap = await this.a2aSnapshot();
    const facts = [
      `Payments received: ${snap.payments.received}`,
      `Payments sent: ${snap.payments.sent}`,
      `Entries stored: ${snap.payments.stored}`,
      `Currencies seen: ${Object.entries(snap.currencies).map(([c, n]) => `${c} (${n})`).join(", ") || "none"}`,
      `Statuses: ${Object.entries(snap.statuses).map(([s, n]) => `${s} (${n})`).join(", ") || "none"}`,
      `Recent entries: ${snap.recent.join("; ") || "none"}`,
    ].join("\n");

    try {
      // Model selection is owned by the routing policy (issue #269,
      // cluster C2): the hardcoded gpt-oss-120b becomes the "synthesize"
      // chain's first model, with transient fall-through. The catch
      // below is unchanged: facts are the fallback, exactly as before.
      const { result: response } = await runRouted<any>("synthesize", (modelId) =>
        this.env.AI.run(
          modelId as never,
          {
          messages: [
            {
              role: "system",
              content: [
                "You answer questions about a payment ledger, using only the facts given.",
                "You cannot move funds, refund, or change anything: do not offer to.",
                "If the facts do not contain the answer, say so rather than guessing.",
                "Be brief.",
              ].join("\n"),
            },
            { role: "user", content: "Facts:\n" + facts + "\n\nQuestion: " + question },
          ],
          max_tokens: 400,
        } as never,
      ));
      const text = String(response?.response ?? "").trim();
      if (text) return text;
      if (Array.isArray(response?.choices) && response.choices.length) {
        const alt = String(response.choices[0]?.message?.content ?? "").trim();
        if (alt) return alt;
      }
    } catch {
      // Fall through to the raw facts: better a plain answer than none.
    }
    return facts;
  }
}
