/**
 * QA capability tests for the non-A2A Slack paths (issue #260).
 *
 * The interactive A2A tester (issue #258 / public/a2a-tester.js) covers
 * every agent's A2A operations, but several real capabilities never touch
 * an A2A endpoint:
 *
 *  - Inbound Slack events at POST /slack/events (src/index.ts), which are
 *    Slack-signature-verified (src/slack.ts) and recorded on the host
 *    agent's email store by handleSlackEvent (src/agent.ts) — NOT on
 *    SlackAgent's SQL history, so slack.totals would never move.
 *  - Outbound Slack file posts via src/slack-files.ts
 *    (getUploadURLExternal -> byte upload -> completeUploadExternal),
 *    the path the QA report mirror uses and that has never been observed
 *    landing because every file-producing smoke section capacity-skips.
 *
 * Two dashboard-authenticated routes below exercise those paths for real
 * and report honestly — {ok:false, configured:false} when the secret or
 * bot/channel pair is absent, never a faked pass. This module is SDK-free
 * (WebCrypto only) so unit tests can import it.
 *
 * Deliberate safety choice: the synthetic event always uses the
 * clearly-fake channel "CQATESTQA1", never SLACK_QA_CHANNEL_ID. The
 * handler auto-replies to processed messages with an AI response via the
 * bot token; a real channel id would put that AI reply into the channel.
 * The recording path is channel-agnostic, so the test proves the same
 * code without writing anything anywhere a human reads.
 */

import { A2A_SURFACE_RPC } from "./a2a-ops";
import { errorBody } from "./errors";
import { postFilesToSlack } from "./slack-files";

/** The synthetic channel id. Fake on purpose — see the module comment. */
export const QA_TEST_CHANNEL = "CQATESTQA1";
export const QA_TEST_USER = "UQATEST";

/**
 * Sign a Slack request body with the exact scheme src/slack.ts's
 * verifySlackSignature checks: "v0" HMAC-SHA256 over
 * `v0:<timestamp>:<rawBody>`, hex-encoded, "v0=" prefixed.
 */
export async function slackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBase));
  return (
    "v0=" +
    Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * The event_callback body the handler accepts and records: parseSlackEvent
 * (src/slack.ts) requires type === "event_callback" with an event object,
 * and handleSlackWebhook (src/index.ts) skips bot_id and text-less events.
 */
export function buildSlackTestEvent(
  channel: string,
  user: string,
  text: string,
  ts: string,
): { type: "event_callback"; event: { type: string; channel: string; user: string; text: string; ts: string } } {
  return {
    type: "event_callback",
    event: { type: "message", channel, user, text, ts },
  };
}

/** Minimal read-only A2A dispatch over HTTP self-fetch (same contract as src/a2a-dispatch.ts). */
async function a2aRead(c: any, surface: string, operation: string): Promise<any> {
  const origin = new URL(c.req.url).origin;
  const res = await fetch(`${origin}${(A2A_SURFACE_RPC as any)[surface]}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.env.DASHBOARD_API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `qa-cap-${operation}`,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: `qa-cap-${Date.now()}`,
          parts: [{ kind: "data", data: { operation } }],
        },
      },
    }),
  });
  const json = (await res.json().catch(() => null)) as any;
  const parts = json?.result?.parts;
  const dataPart = Array.isArray(parts) ? parts.find((p: any) => p && p.kind === "data") : null;
  return dataPart?.data ?? null;
}

async function hostEmailCount(c: any): Promise<number | null> {
  const data = await a2aRead(c, "cfmail", "chat.facts");
  return typeof data?.emails === "number" ? data.emails : null;
}

export function registerCapabilityTests(app: any, requireAuth: any): void {
  /**
   * Test the inbound Slack events path for real.
   *
   * (a) url_verification: a signed payload must be answered with the
   *     challenge echoed (handleSlackWebhook verifies the signature
   *     BEFORE parsing — even for url_verification — so this proves the
   *     signing scheme end to end; a wrong scheme yields 401).
   * (b) signed event_callback: expect 200 after handleSlackEvent ran.
   * (c) recorded: host chat.facts (emails) before/after — the delta is
   *     the honest signal, since the record lands on the host instance's
   *     email store and SlackAgent's totals would not move.
   */
  app.post("/api/dashboard/qa/slack-events-test", requireAuth, async (c: any) => {
    try {
      const secret = (c.env.SLACK_SIGNING_SECRET ?? "").trim();
      if (!secret) {
        return c.json({
          ok: false,
          configured: false,
          error: "SLACK_SIGNING_SECRET is not configured; the inbound Slack events path cannot be tested.",
        });
      }
      const origin = new URL(c.req.url).origin;
      const sign = (ts: string, raw: string) => slackSignature(secret, ts, raw);

      const challenge = "qa-" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const ts0 = String(Math.floor(Date.now() / 1000));
      const uvBody = JSON.stringify({ type: "url_verification", challenge });
      const uvRes = await fetch(`${origin}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": ts0,
          "X-Slack-Signature": await sign(ts0, uvBody),
        },
        body: uvBody,
      });
      const uvJson = (await uvRes.json().catch(() => null)) as any;
      const verificationOk = uvRes.status === 200 && uvJson?.challenge === challenge;

      const emailsBefore = await hostEmailCount(c);
      const now = new Date().toISOString();
      const event = buildSlackTestEvent(
        QA_TEST_CHANNEL,
        QA_TEST_USER,
        `[QA capability test] synthetic Slack event ${now}`,
        (Date.now() / 1000).toFixed(6),
      );
      const evBody = JSON.stringify(event);
      const evTs = String(Math.floor(Date.now() / 1000));
      const evRes = await fetch(`${origin}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": evTs,
          "X-Slack-Signature": await sign(evTs, evBody),
        },
        body: evBody,
      });
      const eventAccepted = evRes.status === 200;
      const emailsAfter = await hostEmailCount(c);
      const recordedDelta =
        typeof emailsBefore === "number" && typeof emailsAfter === "number"
          ? emailsAfter - emailsBefore
          : null;

      return c.json({
        ok: verificationOk && eventAccepted,
        verificationOk,
        eventAccepted,
        emailsBefore,
        emailsAfter,
        recordedDelta,
        recorded: recordedDelta === 1,
        note:
          "The event is recorded on the host agent's email store (src/agent.ts handleSlackEvent -> setState), " +
          "not in SlackAgent's SQL — that is why host chat.facts (emails) is the before/after signal and " +
          "slack.totals would not move. The synthetic channel is always " + QA_TEST_CHANNEL + ": a real channel " +
          "id would trigger the handler's AI auto-reply into that channel via the bot token.",
      });
    } catch (err) {
      return c.json(
        { ok: false, ...errorBody("INTERNAL"), detail: String(err) },
        500,
      );
    }
  });

  /**
   * Test the Slack file-post path for real, through the exact helper the
   * QA report mirror uses (src/slack-files.ts postFilesToSlack).
   */
  app.post("/api/dashboard/qa/slack-file-test", requireAuth, async (c: any) => {
    try {
      const stamp = new Date().toISOString();
      const filename = `qa-capability-test-${stamp.replace(/[:.]/g, "-")}.txt`;
      const contents =
        `This is a QA capability test file posted at ${stamp} via POST /api/dashboard/qa/slack-file-test (issue #260).\n` +
        `It exercises the Slack file-post path (getUploadURLExternal -> byte upload -> completeUploadExternal) ` +
        `used by the QA report mirror.\nSafe to delete.`;
      const contentB64 = btoa(unescape(encodeURIComponent(contents)));
      const result = await postFilesToSlack(
        c.env,
        `[QA capability test] file post ${stamp}`,
        [{ filename, contentB64 }],
      );
      return c.json({
        ok: result.configured && result.posted > 0,
        configured: result.configured,
        posted: result.posted,
        filename,
        error: result.error,
      });
    } catch (err) {
      return c.json(
        { ok: false, ...errorBody("INTERNAL"), detail: String(err) },
        500,
      );
    }
  });
}
