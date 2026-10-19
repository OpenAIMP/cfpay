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

import { callable } from "agents";
import { Think } from "@cloudflare/think";

import type { Env, EmailRecord } from "./types";
import { generateId } from "./payments";
import { defaultModelId } from "./models";

/**
 * An attachment, as a caller supplies it.
 *
 * Content is base64: that is what a JSON A2A call can carry, so a caller does
 * not have to think about the wire. The cost is 33% overhead, which the byte
 * cap below accounts for. NOTE: the Workers EMAIL.send binding treats a string
 * as raw bytes, not base64 (unlike the REST API), so prepareAttachments decodes
 * to binary before sending — passing the base64 string through would produce a
 * corrupt file.
 */
export interface EmailAttachmentInput {
  filename: string;
  /** MIME type, e.g. text/plain or image/png. */
  type: string;
  /** Base64-encoded content, without a data: prefix. */
  content: string;
  /** Shown inline by the client rather than listed. Requires contentId. */
  inline?: { contentId: string };
}

/**
 * Total attachment budget per message, after base64 inflation.
 *
 * Cloudflare's send limits are finite and the exact ceiling is not documented here, so
 * this is deliberately conservative. It exists to refuse a plausible-looking but oversized
 * message with a named reason, rather than letting it fail somewhere inside the binding
 * with an error a caller cannot act on.
 */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Per-file cap, so one huge file cannot consume the whole budget silently. */
const MAX_SINGLE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/** Cap on the count, since the binding has to encode each one. */
const MAX_ATTACHMENTS = 5;

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

export class EmailAgent extends Think<Env, EmailState> {
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
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
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
  override getTools(): Record<string, never> {
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

  /* ----------------------------- attachments ----------------------------- */

  /**
   * Check and convert caller-supplied attachments.
   *
   * Returns a reason rather than throwing, because the caller is usually an agent that
   * should report the refusal instead of failing a whole turn. Every limit is checked
   * BEFORE the send, so an oversized message produces a named reason instead of an
   * opaque binding error after a token has already been spent.
   */
  private prepareAttachments(input: unknown): {
    ok: boolean;
    error?: string;
    attachments?: any[];
  } {
    if (input === undefined || input === null) return { ok: true, attachments: [] };
    if (!Array.isArray(input)) return { ok: false, error: "attachments must be an array." };
    if (input.length === 0) return { ok: true, attachments: [] };
    if (input.length > MAX_ATTACHMENTS) {
      return { ok: false, error: `At most ${MAX_ATTACHMENTS} attachments per message.` };
    }

    const out: any[] = [];
    let total = 0;

    for (const [i, raw] of input.entries()) {
      const a = raw as EmailAttachmentInput;
      if (!a || typeof a.filename !== "string" || a.filename.trim() === "") {
        return { ok: false, error: `Attachment ${i} needs a filename.` };
      }
      if (typeof a.type !== "string" || a.type.trim() === "") {
        return { ok: false, error: `Attachment ${i} needs a MIME type.` };
      }
      if (typeof a.content !== "string" || a.content.length === 0) {
        return { ok: false, error: `Attachment ${i} needs base64 content.` };
      }

      // Reject a data: prefix explicitly. Accepting it would silently double-encode and
      // produce a corrupt file that looks like a successful send.
      if (a.content.startsWith("data:")) {
        return {
          ok: false,
          error: `Attachment ${i} content must be raw base64 without a data: prefix.`,
        };
      }

      // base64 length to bytes, minus padding. Used for the cap rather than decoding,
      // which would allocate the whole buffer just to measure it.
      const padding = a.content.endsWith("==") ? 2 : a.content.endsWith("=") ? 1 : 0;
      const bytes = Math.floor((a.content.length * 3) / 4) - padding;

      if (bytes > MAX_SINGLE_ATTACHMENT_BYTES) {
        return {
          ok: false,
          error: `Attachment ${i} is ${Math.round(bytes / 1024)} KB; the per-file limit is ${Math.round(MAX_SINGLE_ATTACHMENT_BYTES / 1024)} KB.`,
        };
      }
      total += bytes;
      if (total > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false,
          error: `Attachments total ${Math.round(total / 1024)} KB; the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB.`,
        };
      }

      // The Workers EMAIL.send binding treats string content as RAW bytes, not
      // base64 (the REST API differs). Decode here so binary attachments (PNG
      // screenshots, PDFs) arrive intact instead of as base64 text in a file
      // the recipient cannot open.
      let binary: Uint8Array;
      try {
        binary = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
      } catch {
        return {
          ok: false,
          error: `Attachment ${i} content is not valid base64.`,
        };
      }

      out.push(
        a.inline && a.inline.contentId
          ? {
              disposition: "inline",
              contentId: a.inline.contentId,
              filename: a.filename,
              type: a.type,
              content: binary,
            }
          : {
              disposition: "attachment",
              filename: a.filename,
              type: a.type,
              content: binary,
            },
      );
    }

    return { ok: true, attachments: out };
  }

  /* -------------------------------- send --------------------------------- */

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
    /** Optional HTML body, sent alongside the plain-text body. */
    html?: string;
    /** Recorded as the sender. Defaults to the agent's own address. */
    from?: string;
    /** Base64 attachments. Validated and capped before anything is sent. */
    attachments?: EmailAttachmentInput[];
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

    // Validated BEFORE the quota is consulted and before anything is sent. An oversized
    // message should cost nothing: refusing it after a send attempt would consume a slot
    // and return an error the caller cannot act on.
    const prepared = this.prepareAttachments(input?.attachments);
    if (!prepared.ok) {
      return { ok: false, error: prepared.error };
    }
    const attachmentCount = prepared.attachments?.length ?? 0;

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

    // Noted on the record: a transcript that arrived with a file is a different thing
    // from one that did not, and the history should say which it was.
    if (attachmentCount > 0) {
      record.aiSummary =
        "Sent with " + attachmentCount + " attachment(s): " +
        (input?.attachments ?? []).map((a) => a.filename).join(", ");
    }

    try {
      await this.env.EMAIL.send({
        to,
        from,
        replyTo: `agent@${this.env.EMAIL_DOMAIN}`,
        subject,
        text: body,
        ...(input?.html ? { html: String(input.html) } : {}),
        // Spread conditionally: passing an empty array is harmless but noisy, and the
        // binding only needs the field when there is something in it.
        ...(attachmentCount > 0 ? { attachments: prepared.attachments } : {}),
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
      { agentName: "email", env: this.env },
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

      // Same send, with files. Separate from email.send so the common case carries no
      // attachment machinery, and so a reader can see at a glance that this is the
      // operation that moves bytes - the one worth thinking about before granting it.
      case "email.sendWithAttachments": {
        const result = await this.sendThroughAgent({
          to: String(args.to || ""),
          subject: String(args.subject || ""),
          body: String(args.body || ""),
          attachments: args.attachments,
        });
        return {
          text: result.ok
            ? `Sent with attachment(s). Message ${result.emailId}.`
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
            supported: [
              "email.summary",
              "email.totals",
              "email.list",
              "email.quota",
              "email.send",
              "email.sendWithAttachments",
            ],
          },
        };
    }
  }
}