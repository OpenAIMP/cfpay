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
 * 2. POSTING OVER A2A IS ALLOWED - BY THE OWNER'S EXPLICIT DECISION (2026-10-17,
 *    issue #188), reversing this file's original policy. Originally `postMessage` and
 *    `notifyViaWebhook` were internal-only and slack.post / slack.notify / slack.send
 *    were refused by name over A2A, on the reasoning that one shared bearer credential
 *    should not be enough to speak in this workspace. The owner weighed that and
 *    reversed it: the same credential already authorizes email.send over A2A, so
 *    posting to the owner's own Slack is the same trust class. slack.post with a
 *    channel argument posts via the bot token; without one it posts via the incoming
 *    webhook. Decision 1 stands unchanged: the token itself is never returned.
 *
 * It does not call back into the monolith, for the same reason the webhook agent does
 * not: cfmail's sendOutboundEmail reaches EmailAgent, so a callback while cfmail awaited
 * an A2A call here would deadlock the pair.
 */

import { Agent, callable } from "agents";
import type { Connection } from "agents";
import { Think } from "@cloudflare/think";
import { defaultModelId } from "./models";
import type { Env, EmailRecord, SlackMechanism, SlackVia } from "./types";
import { buildSlackRecord, type SlackRecordInput } from "./slack-record";
import { selfProvisionOwnTenant } from "./tenant-provision";
import { stampTenantOnConnection } from "./tenant-connection";

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

export class SlackAgent extends Think<Env, SlackState> {
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
  initialState: SlackState = { ...EMPTY };

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
      "You are the Slack capability agent for this Worker.",
            "You own the Slack bot token, the Slack message history, and the ability to post.",
            "You must never disclose the bot token, and you must never post on behalf of an external A2A caller: posting is reachable only from inside this Worker.",
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
   * Record a Slack message in this agent's history (what `slack.list` reads).
   *
   * Originally "called by the monolith after it has generated a reply" — that call
   * never materialized, so this store held only adopted legacy records. Issue #262
   * wires it in for real. `labels` is optional; omitted, the record keeps the legacy
   * shape (direction inbound, no via/mechanism).
   */
  @callable()
  async recordMessage(
    user: string,
    channel: string,
    text: string,
    aiResponse?: string,
    labels?: {
      id?: string;
      direction?: EmailRecord["direction"];
      via?: SlackVia;
      mechanism?: SlackMechanism;
    },
  ): Promise<{ id: string }> {
    return this.recordLocal({ user, channel, text, aiResponse, ...labels });
  }

  /** Internal record path: the post handler calls this directly, not via RPC. */
  private recordLocal(input: SlackRecordInput): { id: string } {
    const s = this.state_();
    const record = buildSlackRecord(input);
    this.commit({
      ...s,
      messages: [...s.messages, record].slice(-MAX_STORED_SLACK_MESSAGES),
      totalReceived:
        input.direction === "outbound" ? s.totalReceived : s.totalReceived + 1,
    });
    return { id: record.id };
  }

  /**
   * Record an outbound A2A post in this agent's history (issue #262): history
   * covers sends, not just receives. Call only after a successful send. The
   * webhook path does not know its channel: recorded as "" (honest), never invented.
   */
  private recordOutboundPost(text: string, channel: string, mechanism: SlackMechanism): void {
    this.recordLocal({
      user: mechanism === "bot" ? "bot" : "webhook",
      channel: mechanism === "bot" ? channel : "",
      text,
      direction: "outbound",
      via: "a2a",
      mechanism,
    });
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
    }, { agentName: "slack", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /**
   * Route one A2A message. Reads plus posting: slack.post / slack.notify /
   * slack.send post for an authenticated caller (owner's decision,
   * issue #188 - see the header). The bot token itself is never
   * returned by any operation.
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

      // Posting over A2A, allowed by the owner's explicit decision
      // (issue #188; this case refused by name before that). With a
      // channel argument the post goes through the bot token;
      // without one it goes through the incoming webhook - the same
      // two mechanisms internal callers use.
      case "slack.post":
      case "slack.notify":
      case "slack.send": {
        const postText = String(args.text || args.message || "").trim();
        if (!postText) {
          return { text: "slack.post needs a text argument.", data: { ok: false, error: "missing_text" } };
        }
        const channel = String(args.channel || "").trim();
        if (channel) {
          const r = await this.postMessage(channel, postText);
          if (r.ok) this.recordOutboundPost(postText, channel, "bot");
          return r.ok
            ? { text: `Posted to Slack channel ${channel} via the bot.`, data: { ok: true, via: "bot", channel } }
            : { text: `Slack post failed: ${r.error}`, data: { ok: false, error: r.error } };
        }
        const r = await this.notifyViaWebhook(postText);
        if (r.ok) this.recordOutboundPost(postText, "", "webhook");
        return r.ok
          ? { text: "Posted to Slack via the incoming webhook.", data: { ok: true, via: "webhook" } }
          : { text: `Slack post failed: ${r.error} Pass a channel argument to post via the bot instead.`, data: { ok: false, error: r.error } };
      }

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