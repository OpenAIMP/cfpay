/**
 * WebhookAgent — the webhook channel, extracted so any agent can reach it.
 *
 * Owns two things: the webhook event log, and the GitHub delivery registry that makes
 * redelivery safe. Both were in CfmailAgentSQLite's state, which meant the dedupe
 * registry protecting a signature-verified endpoint lived somewhere no other agent
 * could reach.
 *
 * Two design decisions worth reading before changing this file.
 *
 * 1. VERIFICATION STAYS OUTSIDE. `verifyAndParseWebhook` in src/webhooks.ts stays where
 *    it is, and the Worker keeps verifying at the edge before anything here is called.
 *    An A2A caller cannot produce a GitHub or Stripe HMAC, and it must never be able to:
 *    moving verification behind this endpoint would let a bearer token substitute for a
 *    provider signature. This agent receives ALREADY-VERIFIED payloads only.
 *
 * 2. IT DOES NOT CALL BACK INTO THE MONOLITH. The obvious implementation would forward
 *    the webhook to CfmailAgentSQLite, since that is where the side effects live - the
 *    Stripe fulfilment, the Slack notification, the email notification. That would
 *    deadlock: the monolith's sendOutboundEmail calls EmailAgent, so if cfmail were
 *    awaiting an A2A call to Webhook, and Webhook called back into cfmail, the pair
 *    would hang. Instead this agent owns only what it can own in isolation, and the
 *    monolith keeps fanning out from its own side. The resource moved; the orchestration
 *    did not.
 */

import { Agent, callable } from "agents";
import { Think } from "@cloudflare/think";
import { defaultModelId } from "./models";
import type { Env, WebhookEvent } from "./types";
import { generateId } from "./payments";

/** Bound on stored events, matching the monolith's previous limit. */
const MAX_STORED_WEBHOOK_EVENTS = 200;

/** Rolling window for the GitHub delivery registry. */
const GITHUB_DELIVERY_TTL_MS = 24 * 3600 * 1000;

export interface WebhookState {
  events: WebhookEvent[];
  totalReceived: number;
  /**
   * GitHub X-GitHub-Delivery ids already handled, mapped to first-receipt ISO time.
   * GitHub signatures cover no timestamp, so without this rolling set a captured
   * payload could be replayed indefinitely.
   */
  githubProcessedDeliveries: Record<string, string>;
  /**
   * Set once the monolith's pre-split events have been adopted. Absent means the
   * migration still has to run, so a failed attempt retries on the next call rather
   * than being silently forgotten.
   */
  backfilledAt?: string;
}

const EMPTY: WebhookState = {
  events: [],
  totalReceived: 0,
  githubProcessedDeliveries: {},
};

/** Drop registry entries older than the TTL so the set cannot grow without bound. */
function pruneDeliveries(registry: Record<string, string>): Record<string, string> {
  const cutoff = Date.now() - GITHUB_DELIVERY_TTL_MS;
  const out: Record<string, string> = {};
  for (const [id, stamp] of Object.entries(registry)) {
    const t = new Date(stamp).getTime();
    if (Number.isFinite(t) && t >= cutoff) out[id] = stamp;
  }
  return out;
}

export class WebhookAgent extends Think<Env, WebhookState> {
  initialState: WebhookState = { ...EMPTY };

  /* ---------------------------- Think surface ---------------------------- */

  /**
   * Used only when a host dispatches this agent through agentTool(). The channel paths
   * are not conversational: they are operation calls, so nothing here is chosen by a
   * model.
   */
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the webhook capability agent for this Worker.",
            "You own the webhook event log and the GitHub delivery registry that makes redelivery safe.",
            "You do NOT verify provider signatures: that happens at the Worker edge before you are called, and you must never treat an A2A caller as a verified provider.",
      "Report only what the resource actually holds, and never claim an action succeeded unless it did.",
    ].join(" ");
  }

  /**
   * No tools of its own.
   *
   * This agent is dispatched TO. It exposes capabilities through @callable() methods and
   * A2A, which does not require an AI SDK tool set. An empty set is deliberate: a
   * capability agent that could pick its own tools could pick one that acts.
   */
  override getTools(): Record<string, never> {
    return {};
  }

  private state_(): WebhookState {
    const s = (this.state || {}) as Partial<WebhookState>;
    return {
      events: Array.isArray(s.events) ? s.events : [],
      totalReceived: typeof s.totalReceived === "number" ? s.totalReceived : 0,
      githubProcessedDeliveries:
        s.githubProcessedDeliveries && typeof s.githubProcessedDeliveries === "object"
          ? s.githubProcessedDeliveries
          : {},
      backfilledAt: s.backfilledAt,
    };
  }

  private commit(next: WebhookState): void {
    this.setState(next);
  }

  /* --------------------------- replay protection -------------------------- */

  /**
   * Reject replayed GitHub deliveries.
   *
   * Returns true when this delivery id was already seen, meaning the caller must reject
   * the request. Check-and-record is atomic under the Durable Object input gate: the
   * read and the write cannot interleave with another request, which is what makes this
   * safe as replay protection rather than a best-effort guess.
   */
  @callable()
  async isDuplicateGitHubDelivery(deliveryId: string): Promise<boolean> {
    const s = this.state_();
    const seen = pruneDeliveries(s.githubProcessedDeliveries);

    // An empty id cannot be checked, and recording it would make every future
    // id-less delivery look like a replay of this one. Treat it as not-a-duplicate
    // and record nothing, so a missing header fails open on dedupe rather than
    // permanently poisoning the registry.
    if (!deliveryId) {
      this.commit({ ...s, githubProcessedDeliveries: seen });
      return false;
    }

    if (seen[deliveryId]) {
      this.commit({ ...s, githubProcessedDeliveries: seen });
      return true;
    }

    seen[deliveryId] = new Date().toISOString();
    this.commit({ ...s, githubProcessedDeliveries: seen });
    return false;
  }

  /* -------------------------------- record -------------------------------- */

  /**
   * Record one already-verified webhook event.
   *
   * The caller has done the signature check. This stores the event and can optionally
   * claim the GitHub delivery id in the same step, so a caller cannot record an event
   * and forget the dedupe entry - or dedupe and lose the event.
   */
  @callable()
  async recordEvent(
    provider: "github" | "stripe" | "slack",
    eventType: string,
    agentName: string,
    payload: unknown,
    aiInsight?: string,
    deliveryId?: string,
  ): Promise<{ recorded: boolean; duplicate: boolean; eventId: string }> {
    if (deliveryId) {
      const duplicate = await this.isDuplicateGitHubDelivery(deliveryId);
      if (duplicate) {
        return { recorded: false, duplicate: true, eventId: "" };
      }
    }

    const s = this.state_();
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

    this.commit({
      ...s,
      events: [...s.events, event].slice(-MAX_STORED_WEBHOOK_EVENTS),
      totalReceived: s.totalReceived + 1,
    });

    return { recorded: true, duplicate: false, eventId: event.id };
  }

  /* --------------------------------- reads -------------------------------- */

  /** Newest first. */
  @callable()
  async listEvents(provider: string | null, limit: number): Promise<WebhookEvent[]> {
    const s = this.state_();
    const filtered = provider ? s.events.filter((e) => e.provider === provider) : s.events;
    return filtered.slice(-limit).reverse();
  }

  @callable()
  async webhookTotals(): Promise<{
    received: number;
    stored: number;
    byProvider: Record<string, number>;
  }> {
    const s = this.state_();
    const byProvider: Record<string, number> = {};
    for (const e of s.events) {
      const p = e.provider || "unknown";
      byProvider[p] = (byProvider[p] || 0) + 1;
    }
    return { received: s.totalReceived, stored: s.events.length, byProvider };
  }

  /**
   * Adopt events recorded before this agent existed.
   *
   * Idempotent: an event is skipped when an identical id is already present, so running
   * this twice cannot duplicate the log. The monolith's copies are left in place rather
   * than cleared - they are the only record if the adoption turns out to be wrong.
   */
  @callable()
  async backfillEvents(events: WebhookEvent[]): Promise<{ adopted: number; skipped: number }> {
    const s = this.state_();
    const seen = new Set(s.events.map((e) => e.id));

    let adopted = 0;
    let skipped = 0;
    const added: WebhookEvent[] = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || !event.id || seen.has(event.id)) {
        skipped++;
        continue;
      }
      seen.add(event.id);
      added.push(event);
      adopted++;
    }

    if (adopted > 0) {
      this.commit({
        ...s,
        events: [...s.events, ...added].slice(-MAX_STORED_WEBHOOK_EVENTS),
        backfilledAt: new Date().toISOString(),
      });
    } else if (!s.backfilledAt) {
      // Mark the attempt even when nothing was adopted, so an empty migration does not
      // re-run on every call.
      this.commit({ ...s, backfilledAt: new Date().toISOString() });
    }

    return { adopted, skipped };
  }

  /* --------------------------------- A2A ---------------------------------- */

  @callable()
  async a2aSnapshot(): Promise<{
    received: number;
    stored: number;
    byProvider: Record<string, number>;
    recentTypes: string[];
  }> {
    const s = this.state_();
    const byProvider: Record<string, number> = {};
    for (const e of s.events) {
      const p = e.provider || "unknown";
      byProvider[p] = (byProvider[p] || 0) + 1;
    }
    return {
      received: s.totalReceived,
      stored: s.events.length,
      byProvider,
      recentTypes: s.events.slice(-10).map((e) => e.provider + "/" + e.eventType),
    };
  }

  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, webhookCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, webhookCard(origin), {
      card: webhookCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    }, { agentName: "webhooks", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /**
   * Route one A2A message.
   *
   * Read operations are open to any caller holding the bearer credential. Write
   * operations are deliberately NOT: receiving an event here records it as verified, and
   * an external caller has not verified anything. A payload that arrives through this
   * endpoint is stored as PROVIDED, flagged as a2a-sourced, and never triggers the
   * side effects the monolith runs for a real provider delivery.
   */
  async handleA2AMessage(
    message: any,
    // Unused: this capability is stateless per call. Kept to satisfy the interface.
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
      const snapshot = await this.a2aSnapshot();
      return {
        text:
          text ||
          `Webhooks: ${snapshot.received} received, ${snapshot.stored} stored. Providers: ${
            Object.keys(snapshot.byProvider).join(", ") || "none"
          }.`,
        data: snapshot,
      };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      case "webhook.summary":
        return { text: "Webhook totals.", data: await this.a2aSnapshot() };

      case "webhook.totals":
        return { text: "Webhook totals.", data: await this.webhookTotals() };

      case "webhook.list": {
        const provider = args.provider ? String(args.provider) : null;
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20;
        const events = await this.listEvents(provider, limit);
        // Payloads are omitted: a listing is not a content dump, and provider payloads
        // routinely carry tokens and customer identifiers.
        const trimmed = events.map(({ payload, aiInsight, ...rest }) => ({
          ...rest,
          hasInsight: Boolean(aiInsight),
        }));
        return { text: `Returned ${trimmed.length} event(s).`, data: { events: trimmed } };
      }

      case "webhook.receive": {
        // Explicitly NOT a verified ingest. An external caller holds no provider
        // signature, so this records the event as a2a-sourced and says so, rather than
        // letting it look like a genuine delivery.
        const provider = String(args.provider || "");
        if (!["github", "stripe", "slack"].includes(provider)) {
          return {
            text: "webhook.receive needs provider to be github, stripe or slack.",
            data: { ok: false, error: "bad_provider" },
          };
        }
        const result = await this.recordEvent(
          provider as "github" | "stripe" | "slack",
          String(args.eventType || "a2a"),
          "a2a:" + String(args.agentName || "external"),
          args.payload ?? null,
          undefined,
          // No delivery id is honoured here: claiming one would let an external caller
          // suppress a genuine GitHub delivery by pre-registering its id.
          undefined,
        );
        return {
          text: result.recorded
            ? "Recorded as an a2a-sourced event. No signature was verified and no side effects ran."
            : "Not recorded.",
          data: { ...result, verified: false, source: "a2a" },
        };
      }

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["webhook.summary", "webhook.totals", "webhook.list", "webhook.receive"],
          },
        };
    }
  }
}