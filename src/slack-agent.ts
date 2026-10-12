/**
 * SlackAgent — the Slack channel, extracted so its credential and its history have one
 * owner.
 *
 * Owns three things that were spread across the monolith: the bot token, the Slack
 * message records, and the ability to post. Before this, the token lived in
 * CfmailAgentSQLite's state and Slack messages were stored in that same agent's
 * `emails[]` array with a `slack:<user>` sender, which is why every consumer of mail had
 * to remember to filter them out - see getEmailsExcludingSlack. Moving them here removes
 * that trap: mail is mail, and Slack is Slack.
 *
 * TWO DECISIONS WORTH READING BEFORE CHANGING THIS FILE.
 *
 * 1. THE BOT TOKEN IS NEVER READABLE. There is no method that returns it, not even a
 *    redacted one, and it is never included in a snapshot. The token lets a caller post
 *    as this workspace, so exposing it over A2A would make every credential holder an
 *    impersonator. Callers ask for the ACT of posting, not for the credential.
 *
 * 2. POSTING IS INTERNAL ONLY. `postMessage` and `notifyViaWebhook` are @callable() so
 *    the Worker can use them, and reachable over A2A, but they are deliberately NOT
 *    exposed as A2A operations. Posting into someone's Slack is not a read, and the A2A
 *    gate is a single shared bearer token: one credential would otherwise be enough to
 *    speak in this workspace. The read operations are open; the writes have no A2A path
 *    at all, which is a stronger guarantee than a check inside the handler.
 *
 * It does not call back into the monolith, for the same reason the webhook agent does
 * not: cfmail's sendOutboundEmail reaches EmailAgent, so a callback while cfmail awaited
 * an A2A call here would deadlock the pair.
 */

import { Agent, callable } from "agents";
import type { Env, EmailRecord } from "./types";
import { generateId } from "./payments";

/** Bound on stored Slack messages, matching the monolith's shared limit. */
const MAX_STORED_SLACK_MESSAGES = 500;

export interface SlackState {
  messages: EmailRecord[];
  totalReceived: number;
  /**
   * Bot token from the OAuth install flow. Takes precedence over the SLACK_BOT_TOKEN
   * env var when present. Never returned by any method.
   */
  botToken?: string;
  /**
   * Set once the monolith's pre-split Slack messages have been adopted. Absent means the
   * migration still has to run, so a failed attempt retries rather than being forgotten.
   */
  backfilledAt?: string;
}

const EMPTY: SlackState = { messages: [], totalReceived: 0 };

export class SlackAgent extends Agent<Env, SlackState> {
  initialState: SlackState = { ...EMPTY };

  private state_(): SlackState {
    const s = (this.state || {}) as Partial<SlackState>;
    return {
      messages: Array.isArray(s.messages) ? s.messages : [],
      totalReceived: typeof s.totalReceived === "number" ? s.totalReceived : 0,
      botToken: typeof s.botToken === "string" ? s.botToken : undefined,
      backfilledAt: s.backfilledAt,
    };
  }

  private commit(next: SlackState): void {
    this.setState(next);
  }

  /**
   * The bot token, for this agent's own use only.
   *
   * Private on purpose: the only way to use it is to ask this agent to post.
   */
  private botTokenForUse(): string {
    return this.state_().botToken || (this.env as any).SLACK_BOT_TOKEN || "";
  }

  /* ------------------------------ credential ------------------------------ */

  /**
   * Store the bot token from the OAuth install flow.
   *
   * Returns only success: an echo of the token, even partially, would put it in a
   * response body and a log line.
   */
  @callable()
  async setBotToken(token: string): Promise<{ success: boolean }> {
    if (!token || typeof token !== "string") return { success: false };
    const s = this.state_();
    this.commit({ ...s, botToken: token });
    return { success: true };
  }

  /**
   * Say whether a token exists and where it came from — never what it is.
   *
   * The dashboard needs to show whether Slack is connected. This answers that without
   * a secret ever crossing the boundary.
   */
  @callable()
  async botTokenStatus(): Promise<{ configured: boolean; source: "install" | "env" | "none" }> {
    const s = this.state_();
    if (s.botToken) return { configured: true, source: "install" };
    if ((this.env as any).SLACK_BOT_TOKEN) return { configured: true, source: "env" };
    return { configured: false, source: "none" };
  }

  /* -------------------------------- posting ------------------------------- */

  /**
   * Post a message to a Slack channel.
   *
   * The token stays inside this agent. Callers pass what to say, not how to authenticate.
   * Returns a result rather than throwing, because a caller needs to tell "Slack refused"
   * apart from "no token configured" - the second is a deployment problem and the first
   * is not.
   */
  @callable()
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = this.botTokenForUse();
    if (!token) return { ok: false, error: "No Slack bot token is configured." };
    if (!channel || !text) return { ok: false, error: "postMessage needs channel and text." };

    const { sendSlackMessage } = await import("./slack");
    try {
      await sendSlackMessage(token, channel, text, threadTs);
      return { ok: true };
    } catch (error) {
      console.error("Slack post failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Post a message with a button, for the payment-request reply.
   *
   * Separate from postMessage because the interactive reply is the one place Slack needs
   * structured blocks, and collapsing the two would mean every plain post carried a
   * button payload it does not want.
   */
  @callable()
  async postMessageWithButton(
    channel: string,
    text: string,
    buttonText: string,
    url: string,
    threadTs?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = this.botTokenForUse();
    if (!token) return { ok: false, error: "No Slack bot token is configured." };

    const { sendSlackMessageWithButton } = await import("./slack");
    try {
      await sendSlackMessageWithButton(token, channel, text, buttonText, url, threadTs);
      return { ok: true };
    } catch (error) {
      console.error("Slack button post failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Post through the Slack incoming webhook, when one is configured.
   *
   * A second Slack mechanism, kept because SLACK_WEBHOOK_URL is what the existing
   * notifications use and it does not need a bot token. Both live here so there is one
   * place that can speak to Slack, rather than two that can.
   */
  @callable()
  async notifyViaWebhook(message: string): Promise<{ ok: boolean; error?: string }> {
    const url = (this.env as any).SLACK_WEBHOOK_URL ?? "";
    if (!url) return { ok: false, error: "SLACK_WEBHOOK_URL is not configured." };

    const { sendSlackNotificationDetailed } = await import("./webhooks");
    const { ok, detail } = await sendSlackNotificationDetailed(url, message);
    if (!ok) console.error("Slack notification failed:", detail);
    return ok ? { ok: true } : { ok: false, error: detail };
  }

  /* -------------------------------- history ------------------------------- */

  /**
   * Record an inbound Slack message.
   *
   * Called by the monolith after it has generated a reply, because the reply text is
   * produced by the shared AI responder and this agent has no model in its path. The
   * record is what the dashboard reads.
   */
  @callable()
  async recordMessage(
    user: string,
    channel: string,
    text: string,
    aiResponse?: string,
  ): Promise<{ id: string }> {
    const s = this.state_();
    const record: EmailRecord = {
      id: generateId(),
      from: `slack:${user}`,
      to: `slack:${channel}`,
      subject: text.slice(0, 50),
      body: text,
      direction: "inbound",
      receivedAt: new Date().toISOString(),
      paid: false,
      aiResponse,
    };
    this.commit({
      ...s,
      messages: [...s.messages, record].slice(-MAX_STORED_SLACK_MESSAGES),
      totalReceived: s.totalReceived + 1,
    });
    return { id: record.id };
  }

  /** Newest first. */
  @callable()
  async listMessages(limit: number): Promise<EmailRecord[]> {
    return this.state_().messages.slice(-limit).reverse();
  }

  @callable()
  async slackTotals(): Promise<{ received: number; stored: number }> {
    const s = this.state_();
    return { received: s.totalReceived, stored: s.messages.length };
  }

  /**
   * Adopt Slack messages recorded in the monolith before this agent owned them.
   *
   * Idempotent by id, so re-running cannot duplicate the history. The monolith's copies
   * stay where they are: they are the only record if the adoption turns out to be wrong,
   * and clearing them is the irreversible half of a migration.
   */
  @callable()
  async backfillMessages(records: EmailRecord[]): Promise<{ adopted: number; skipped: number }> {
    const s = this.state_();
    const seen = new Set(s.messages.map((m) => m.id));

    let adopted = 0;
    let skipped = 0;
    const added: EmailRecord[] = [];
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !record.id || seen.has(record.id)) {
        skipped++;
        continue;
      }
      seen.add(record.id);
      added.push(record);
      adopted++;
    }

    this.commit({
      ...s,
      messages: adopted > 0 ? [...s.messages, ...added].slice(-MAX_STORED_SLACK_MESSAGES) : s.messages,
      totalReceived: s.totalReceived + adopted,
      backfilledAt: new Date().toISOString(),
    });

    return { adopted, skipped };
  }

  /* --------------------------------- A2A ---------------------------------- */

  /**
   * Aggregate view for the A2A executor.
   *
   * No token, no channel ids, and no message bodies: subjects only. This endpoint is
   * reachable by other agents, and a Slack channel id is a target for posting.
   */
  @callable()
  async a2aSnapshot(): Promise<{
    received: number;
    stored: number;
    connected: boolean;
    tokenSource: string;
    recentSubjects: string[];
  }> {
    const s = this.state_();
    const status = await this.botTokenStatus();
    return {
      received: s.totalReceived,
      stored: s.messages.length,
      connected: status.configured,
      tokenSource: status.source,
      recentSubjects: s.messages.slice(-10).map((m) => m.subject).filter(Boolean),
    };
  }

  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, slackCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, slackCard(origin), {
      card: slackCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    });
    return await handleCollecting(a2a.transport, body);
  }

  /**
   * Route one A2A message.
   *
   * Read operations only. There is no case here for posting, and that absence is the
   * control: an external caller cannot reach a Slack write even if it holds the bearer
   * credential, because no operation maps to one. A switch that is missing a case cannot
   * be talked into it.
   */
  async handleA2AMessage(
    message: any,
    // Unused: each call is self-contained. Kept to satisfy the interface.
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
          `Slack: ${snapshot.received} received, ${snapshot.stored} stored, connected: ${snapshot.connected}.`,
        data: snapshot,
      };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      case "slack.summary":
        return { text: "Slack totals.", data: await this.a2aSnapshot() };

      case "slack.totals":
        return { text: "Slack totals.", data: await this.slackTotals() };

      case "slack.status":
        return { text: "Slack connection status.", data: await this.botTokenStatus() };

      case "slack.list": {
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20;
        const messages = await this.listMessages(limit);
        // Subjects and direction only. A Slack body is a conversation, and the endpoint
        // is reachable by other agents.
        const trimmed = messages.map(({ body, aiResponse, ...rest }) => ({
          ...rest,
          hasReply: Boolean(aiResponse),
        }));
        return { text: `Returned ${trimmed.length} message(s).`, data: { messages: trimmed } };
      }

      // Any post-like operation is refused BY NAME, so a caller gets a clear answer
      // rather than "unknown operation", and so the refusal is visible in the code as a
      // deliberate absence.
      case "slack.post":
      case "slack.notify":
      case "slack.send":
        return {
          text:
            "Refused: posting to Slack is not available over A2A. It is reachable only " +
            "inside this Worker, because a shared bearer credential must not be enough to " +
            "speak in this workspace.",
          data: { ok: false, error: "not_available_over_a2a" },
        };

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["slack.summary", "slack.totals", "slack.status", "slack.list"],
          },
        };
    }
  }
}