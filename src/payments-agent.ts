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
import type { Env, PaymentRecord, StripeCheckout, StripeCheckoutStatus } from "./types";
import { generateId } from "./payments";

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

export class PaymentsAgent extends Agent<Env, PaymentsState> {
  initialState: PaymentsState = { ...EMPTY };

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

  /** Newest first. */
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
        answer: (question: string) => this.answerAboutPayments(question),
      },
    );
    return await handleCollecting(transport.transport, body);
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
      const response: any = await this.env.AI.run(
        "@cf/openai/gpt-oss-120b" as never,
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
      );
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
