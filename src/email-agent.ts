/**
 * EmailAgent — the email capability, extracted from the Cfmail monolith.
 *
 * Owns the mail resource: the message history, outbound sends, and the inbound
 * record path. Other agents reach this through the shared email tool instead of
 * reaching into CfmailAgentSQLite's state, so an agent can send mail without
 * depending on another agent's internals.
 *
 * Sends are rate limited here rather than in the caller. The A2A endpoint accepts
 * any caller holding the Worker credential, and an unthrottled send is a spam relay
 * with an open relay's failure mode: the reputation of this domain pays for it. The
 * limit belongs to the capability, not to the goodwill of each caller.
 *
 * What it deliberately does NOT own: generating reply text. That is a caller's
 * business, and keeping it out means this agent can be tested without Workers AI.
 */

import { Agent, callable } from "agents";

import type { Env, EmailRecord } from "./types";
import { generateId } from "./payments";
import { defaultModelId } from "./models";

/** Bound on stored message history, matching the monolith's previous limit. */
const MAX_STORED_EMAILS = 500;

/** Outbound sends allowed inside one window, per agent instance. */
const SEND_LIMIT = 60;

/** Window for the send limit. */
const SEND_WINDOW_MS = 60 * 60 * 1000;

/** Reject a send whose body is implausibly large, to bound a single message. */
const MAX_BODY_CHARS = 200_000;

export interface EmailState {
  emails: EmailRecord[];
  totalReceived: number;
  totalSent: number;
  /** Epoch-ms timestamps of recent sends, pruned to the window on each use. */
  sendLog: number[];
}

const EMPTY: EmailState = {
  emails: [],
  totalReceived: 0,
  totalSent: 0,
  sendLog: [],
};

export class EmailAgent extends Agent<Env> {
  initialState: EmailState = { ...EMPTY };

  /* ---------------------------- Think surface ---------------------------- */

  /**
   * The model used when this agent runs a chat turn as an agent tool.

   * Sending mail is deterministic and does not go through the model: the direct
   * path stays the capability call, and this model is only used when a parent
   * agent dispatches `emailAgent` for a conversational reply. Keeping it the same
   * default the rest of the Worker uses means a dispatch cannot quietly change
   * which model answers.
   */
  getModel(): string {
    return defaultModelId();
  }

  getSystemPrompt(): string {
    return [
      "You are the email capability agent for this Worker.",
      "You own the mail resource: the message history, outbound sends, and the inbound record path.",
      "Other agents send through you. If asked to send, use the sendThroughAgent method semantics",
      "and report the message id and remaining quota. Never claim a message was sent unless it was:",
      "sends are rate limited and can be refused, and a refusal must be reported as a refusal.",
    ].join(" ");
  }

  /**
   * No tools of its own.

   * This agent is dispatched TO, not a dispatcher: it exposes capabilities through
   * @callable() methods and A2A, which does not require an AI SDK tool set. An empty
   * set is deliberate rather than unfinished.
   */
  getTools(): Record<string, never> {
    return {};
  }

  /** Normalise whatever is stored into the current shape. */
  private state_(): EmailState {
    const s = (this.state || {}) as Partial<EmailState>;
    return {
      emails: Array.isArray(s.emails) ? s.emails : [],
      totalReceived: typeof s.totalReceived === "number" ? s.totalReceived : 0,
      totalSent: typeof s.totalSent === "number" ? s.totalSent : 0,
      sendLog: Array.isArray(s.sendLog) ? s.sendLog.filter((t) => typeof t === "number") : [],
    };
  }

  private commit(next: EmailState): void {
    this.setState(next);
  }

  /** Own address, so a message to ourselves is never sent. */
  private ownAddress(): string {
    return `agent@${this.env.EMAIL_DOMAIN}`.toLowerCase();
  }

  /* ------------------------------ history -------------------------------- */

  /**
   * Record an inbound message.
   *
   * The caller has already parsed the message and decided whether it is
   * answerable; this only stores it, so the monolith keeps ownership of its
   * interpretation while the record lives with the resource.
   */
  @callable()
  async recordInbound(record: EmailRecord): Promise<void> {
    const s = this.state_();
    this.commit({
      ...s,
      emails: [...s.emails, { ...record, direction: "inbound" as const }].slice(-MAX_STORED_EMAILS),
      totalReceived: s.totalReceived + 1,
    });
  }

  /** Newest first. */
  @callable()
  async listEmails(direction: string | null, limit: number): Promise<EmailRecord[]> {
    const s = this.state_();
    const filtered = direction ? s.emails.filter((e) => e.direction === direction) : s.emails;
    return filtered.slice(-limit).reverse();
  }

  @callable()
  async emailTotals(): Promise<{ received: number; sent: number; stored: number }> {
    const s = this.state_();
    return { received: s.totalReceived, sent: s.totalSent, stored: s.emails.length };
  }

  /**
   * Remaining sends in the current window, so a caller can back off before being
   * refused rather than discovering the limit by hitting it.
   */
  @callable()
  async sendQuota(): Promise<{ used: number; limit: number; remaining: number; windowMs: number }> {
    const used = this.state_().sendLog.length;
    return { used, limit: SEND_LIMIT, remaining: Math.max(0, SEND_LIMIT - used), windowMs: SEND_WINDOW_MS };
  }

  /* ------------------------------ migration ------------------------------ */

  /**
   * Adopt mail recorded before this agent was authoritative.
   *
   * Idempotent by id, so re-running cannot duplicate the history. Slack conversations
   * are NOT adopted: they are stored in the monolith's emails[] with a `slack:` sender
   * and belong to SlackAgent now. Importing them here would recreate the exact problem
   * this split removes - every consumer of mail having to remember to filter them out.
   */
  @callable()
  async backfillEmails(records: EmailRecord[]): Promise<{ adopted: number; skipped: number }> {
    const s = this.state_();
    const seen = new Set(s.emails.map((e) => e.id));

    let adopted = 0;
    let skipped = 0;
    const added: EmailRecord[] = [];

    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !record.id || seen.has(record.id)) {
        skipped++;
        continue;
      }
      // Slack messages are a different resource and a different agent.
      if (String(record.from || "").startsWith("slack:") || String(record.to || "").startsWith("slack:")) {
        skipped++;
        continue;
      }
      seen.add(record.id);
      added.push(record);
      adopted++;
    }

    if (adopted > 0) {
      const received = added.filter((r) => r.direction === "inbound").length;
      const sent = added.filter((r) => r.direction === "outbound").length;
      this.commit({
        ...s,
        emails: [...s.emails, ...added].slice(-MAX_STORED_EMAILS),
        totalReceived: s.totalReceived + received,
        totalSent: s.totalSent + sent,
      });
    }

    return { adopted, skipped };
  }

  /* -------------------------------- send --------------------------------- */  /* -------------------------------- send --------------------------------- */

  /**
   * Send a message through the EMAIL binding and record it.
   *
   * Returns a result rather than throwing, because the caller needs to tell "not
   * sent because the limit was reached" apart from "not sent because the binding
   * failed". Those mean different things to an agent deciding whether to retry.
   */
  @callable()
  async sendThroughAgent(input: {
    to: string;
    subject: string;
    body: string;
    /** Recorded as the sender. Defaults to the agent's own address. */
    from?: string;
  }): Promise<{ ok: boolean; emailId?: string; error?: string; remaining?: number }> {
    const to = String(input?.to || "").trim();
    const subject = String(input?.subject || "").trim();
    const body = String(input?.body || "");

    if (!to || !subject) {
      return { ok: false, error: "email.send needs both to and subject." };
    }
    if (body.length > MAX_BODY_CHARS) {
      return { ok: false, error: `Message body exceeds ${MAX_BODY_CHARS} characters.` };
    }

    // Sending to ourselves would arrive back through the inbound path and could
    // generate a reply to a reply. The monolith guards this for webhook mail; the
    // same guard belongs on the send path, which any agent can now reach.
    if (to.toLowerCase() === this.ownAddress()) {
      return { ok: false, error: "Refusing to send to the agent's own address." };
    }

    const s = this.state_();
    const cutoff = Date.now() - SEND_WINDOW_MS;
    const recent = s.sendLog.filter((t) => t >= cutoff);

    if (recent.length >= SEND_LIMIT) {
      const retryAfterMs = Math.max(0, recent[0] + SEND_WINDOW_MS - Date.now());
      return {
        ok: false,
        error: `Send limit reached: ${SEND_LIMIT} messages per hour. Retry in ~${Math.ceil(retryAfterMs / 60000)} minute(s).`,
        remaining: 0,
      };
    }

    const emailId = generateId();
    const from = String(input?.from || "").trim() || `agent@${this.env.EMAIL_DOMAIN}`;
    const record: EmailRecord = {
      id: emailId,
      from,
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
        from,
        replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
        subject,
        text: body,
      });
    } catch (error) {
      // A failed send must not consume the quota: refusing the next legitimate
      // attempt because a binding blipped would compound one failure into two.
      console.error("EmailAgent send failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    this.commit({
      ...s,
      emails: [...s.emails, record].slice(-MAX_STORED_EMAILS),
      totalSent: s.totalSent + 1,
      sendLog: [...recent, Date.now()],
    });

    return { ok: true, emailId, remaining: Math.max(0, SEND_LIMIT - recent.length - 1) };
  }

  /* -------------------------------- A2A ---------------------------------- */

  /**
   * Aggregate view for the A2A executor. Counts and recent subjects only: the
   * endpoint is reachable by other agents, so bodies are not exposed wholesale.
   */
  @callable()
  async a2aSnapshot(): Promise<{
    received: number;
    sent: number;
    stored: number;
    recentSubjects: string[];
  }> {
    const s = this.state_();
    return {
      received: s.totalReceived,
      sent: s.totalSent,
      stored: s.emails.length,
      recentSubjects: s.emails.slice(-10).map((e) => e.subject).filter(Boolean),
    };
  }

  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, emailCard } = await import("./a2a");
    const a2a = createA2ATransport(
      this.ctx.storage.sql,
      origin,
      emailCard(origin),
      {
        card: emailCard,
        handle: (message: any, context: { taskId: string; contextId: string }) =>
          this.handleA2AMessage(message, context),
      },
    );
    // Collected, not streamed: an async iterable cannot cross the RPC boundary.
    return await handleCollecting(a2a.transport, body);
  }

  /**
   * Route one A2A message.
   *
   * Text alone answers a question; a data part carrying an operation performs one.
   * Authorisation is not decided here - the transport already checked the bearer
   * credential - so this maps an operation to a method call and refuses anything
   * not on the list rather than falling through.
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
      const snapshot = await this.a2aSnapshot();
      return {
        text:
          text ||
          `Email: ${snapshot.received} received, ${snapshot.sent} sent, ${snapshot.stored} stored.`,
        data: snapshot,
      };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      // ---- read ----
      case "email.summary":
        return { text: "Email totals.", data: await this.a2aSnapshot() };

      case "email.totals":
        return { text: "Email totals.", data: await this.emailTotals() };

      case "email.list": {
        const direction = args.direction ? String(args.direction) : null;
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20;
        const emails = await this.listEmails(direction, limit);
        // Subjects and metadata, not bodies: a listing is not a content dump.
        const trimmed = emails.map(({ body, html, ...rest }) => rest);
        return { text: `Returned ${trimmed.length} message(s).`, data: { emails: trimmed } };
      }

      case "email.quota":
        return { text: "Send quota.", data: await this.sendQuota() };

      // ---- write ----
      case "email.send": {
        const result = await this.sendThroughAgent({
          to: String(args.to || ""),
          subject: String(args.subject || ""),
          body: String(args.body || ""),
        });
        return {
          text: result.ok
            ? `Sent. Message ${result.emailId}.`
            : `Not sent: ${result.error}`,
          data: result,
        };
      }

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["email.summary", "email.totals", "email.list", "email.quota", "email.send"],
          },
        };
    }
  }
}