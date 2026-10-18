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
 * Five dashboard-authenticated routes below exercise those paths for real
 * and report honestly — {ok:false, configured:false} when the secret or
 * bot/channel pair is absent, never a faked pass. This module is SDK-free
 * (WebCrypto only; the agents SDK is reached through a dynamic import in
 * probeViaQAAgent) so unit tests can import it.
 *
 * Issue #264: every HTTP leg below that targets the Worker's own origin
 * goes through QAAgent's qaHttpProbe callable (src/a2a-dispatch.ts
 * probeViaQAAgent) — the plain fetch-handler context cannot self-fetch
 * the own domain in production (Cloudflare 522), while QAAgent's Durable
 * Object context can (§12-proven). The only exception is the file test,
 * whose fetch targets Slack's API, not our own domain.
 *
 * Deliberate safety choice: the synthetic event always uses the
 * clearly-fake channel "CQATESTQA1", never SLACK_QA_CHANNEL_ID. The
 * handler auto-replies to processed messages with an AI response via the
 * bot token; a real channel id would put that AI reply into the channel.
 * The recording path is channel-agnostic, so the test proves the same
 * code without writing anything anywhere a human reads.
 */

import { A2A_SURFACE_RPC } from "./a2a-ops";
import { probeJson, probeViaQAAgent } from "./a2a-dispatch";
import { errorBody } from "./errors";
import { resolveMcpAuthMode } from "./mcp-auth";
import { postFilesToSlack } from "./slack-files";

/** The synthetic channel id. Fake on purpose — see the module comment. */
export const QA_TEST_CHANNEL = "CQATESTQA1";
export const QA_TEST_USER = "UQATEST";

/**
 * Sign a Slack request body with the exact scheme src/slack-verify.ts's
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

/** HMAC-SHA256, hex-encoded (the primitive every provider scheme here builds on). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * GitHub's scheme (src/webhooks.ts verifyGitHub): HMAC-SHA256 over the raw
 * body, sent as the X-Hub-Signature-256 header in "sha256=<hex>" form.
 */
export async function githubSignature(secret: string, rawBody: string): Promise<string> {
  return "sha256=" + (await hmacSha256Hex(secret, rawBody));
}

/**
 * The GitHub `ping` payload the /webhooks/github route accepts: the parser
 * (src/webhooks.ts) requires a JSON body with repository.full_name; a `ping`
 * event is recorded by processWebhookEvent (src/agent.ts) without any action,
 * so it is inert by construction.
 */
export function buildGitHubPingPayload(marker: string): {
  zen: string;
  hook_id: string;
  repository: { full_name: string };
} {
  return {
    zen: `[QA capability test ${marker}] Keep it logically awesome.`,
    hook_id: `qa-${marker}`,
    repository: { full_name: "qa-synthetic/ping-test" },
  };
}

/**
 * The Slack legacy (/webhooks/slack) synthetic event. verifyAndParseWebhook
 * derives the agent name from channel_id/team_id/event.channel, and the
 * /webhooks/* route's slack branch runs handleSlackEvent for message events —
 * so this uses the same clearly-fake channel as the /slack/events test (the
 * handler auto-replies via the bot; a real channel id would post that reply
 * into a human-read channel). The signing scheme is identical to
 * (src/slack-verify.ts verifySlackSignature), so
 * slackSignature() is reused — the only difference is the secret used:
 * SLACK_WEBHOOK_SECRET for /webhooks/slack vs SLACK_SIGNING_SECRET for
 * /slack/events.
 */
export function buildSlackLegacyTestPayload(marker: string): {
  event: { type: string; channel: string; user: string; text: string; ts: string };
} {
  return {
    event: {
      type: "message",
      channel: QA_TEST_CHANNEL,
      user: QA_TEST_USER,
      text: `[QA capability test ${marker}] synthetic legacy slack webhook event`,
      ts: (Date.now() / 1000).toFixed(6),
    },
  };
}

export type McpUnauthExpectation = { listStatus: number; writeStatus: number } | { misconfigured: true };

/**
 * What an UNAUTHENTICATED tools/list and a write-class tools/call must return
 * from POST /mcp, computed from the configured MCP_AUTH_MODE. Mirrors
 * authorizeMcpRequest (src/mcp-auth.ts) — the mode normalization comes
 * straight from resolveMcpAuthMode (unset defaults to "either", a typo fails
 * closed with 503s):
 * - "none": reads serve openly (200); a write-class tools/call is refused
 *   with 401 by the issue-#239 guard, before any handler runs.
 * - any other mode: with a usable credential configured the refusal is 401;
 *   with none configured the endpoint fails closed with 503.
 * - unrecognised mode: 503 for everything.
 */
export function mcpUnauthExpectations(
  rawMode: string | undefined,
  secrets: { staticToken: string; githubOrg: string; jwtSecret: string },
): McpUnauthExpectation {
  const mode = resolveMcpAuthMode(rawMode);
  if (mode === null) return { misconfigured: true };
  if (mode === "none") return { listStatus: 200, writeStatus: 401 };
  const trim = (s: string) => s.trim().length > 0;
  const ready =
    mode === "static"
      ? trim(secrets.staticToken)
      : mode === "github"
        ? trim(secrets.githubOrg)
        : mode === "jwt"
          ? trim(secrets.jwtSecret)
          : trim(secrets.staticToken) || trim(secrets.githubOrg) || trim(secrets.jwtSecret);
  return ready ? { listStatus: 401, writeStatus: 401 } : { listStatus: 503, writeStatus: 503 };
}

/**
 * Minimal read-only A2A dispatch, issued through QAAgent's qaHttpProbe
 * (issue #264) — the plain fetch-handler context cannot HTTP self-fetch
 * the Worker's own domain in production (Cloudflare 522). Same contract
 * as src/a2a-dispatch.ts.
 */
async function a2aRead(c: any, surface: string, operation: string): Promise<any> {
  const probe = await probeViaQAAgent(
    c,
    (A2A_SURFACE_RPC as any)[surface],
    "POST",
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.env.DASHBOARD_API_KEY}`,
    },
    JSON.stringify({
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
  );
  const json = probe.status === 200 ? probeJson(probe.text) : null;
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
      const sign = (ts: string, raw: string) => slackSignature(secret, ts, raw);

      const challenge = "qa-" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const ts0 = String(Math.floor(Date.now() / 1000));
      const uvBody = JSON.stringify({ type: "url_verification", challenge });
      const uvProbe = await probeViaQAAgent(
        c,
        "/slack/events",
        "POST",
        {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": ts0,
          "X-Slack-Signature": await sign(ts0, uvBody),
        },
        uvBody,
      );
      const uvJson = probeJson(uvProbe.text);
      const verificationOk = uvProbe.status === 200 && uvJson?.challenge === challenge;

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
      const evProbe = await probeViaQAAgent(
        c,
        "/slack/events",
        "POST",
        {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": evTs,
          "X-Slack-Signature": await sign(evTs, evBody),
        },
        evBody,
      );
      const eventAccepted = evProbe.status === 200;
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

  /**
   * Test the /webhooks/* inbound ingestion for real: GitHub `ping` and the
   * Slack legacy message path, each signed with the provider's REAL secret
   * (server-side only) and verified by recording on the host instance, which
   * the dashboard reads via GET /api/dashboard/webhooks?provider=<p> — the
   * same endpoint the Webhooks tab uses.
   *
   * Stripe is deliberately NOT fired: processWebhookEvent (src/agent.ts) runs
   * payment fulfilment (handleStripeWebhook) for EVERY Stripe payload before
   * recording, and no inert event type exists — so the stripe leg reports
   * testable:false instead of firing.
   */
  app.post("/api/dashboard/qa/webhooks-test", requireAuth, async (c: any) => {
    try {
      const marker = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      async function recordedEvents(provider: string): Promise<any[]> {
        const probe = await probeViaQAAgent(
          c,
          `/api/dashboard/webhooks?provider=${provider}`,
          "GET",
          { "X-API-Key": c.env.DASHBOARD_API_KEY },
        );
        const json = probeJson(probe.text);
        return Array.isArray(json?.events) ? json.events : [];
      }
      const containsMarker = (events: any[]): boolean =>
        events.some((e) => JSON.stringify(e?.payload ?? e).includes(marker));

      const legs: any[] = [];

      // GitHub: signed `ping` event — recorded without action.
      {
        const secret = String(c.env.GITHUB_WEBHOOK_SECRET ?? "").trim();
        if (!secret) {
          legs.push({ provider: "github", configured: false });
        } else {
          const raw = JSON.stringify(buildGitHubPingPayload(marker));
          const probe = await probeViaQAAgent(
            c,
            "/webhooks/github",
            "POST",
            {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": await githubSignature(secret, raw),
              // Unique per run: the handler dedupes deliveries and a replayed id returns 409.
              "X-GitHub-Delivery": `qa-${marker}`,
            },
            raw,
          );
          const recorded = probe.status === 200 ? containsMarker(await recordedEvents("github")) : false;
          legs.push({
            provider: "github",
            configured: true,
            signatureAccepted: probe.status === 200,
            httpStatus: probe.status,
            recorded,
            ok: probe.status === 200 && recorded,
          });
        }
      }

      // Stripe: deliberately not fired (see route comment).
      legs.push({
        provider: "stripe",
        configured: String(c.env.STRIPE_WEBHOOK_SECRET ?? "").trim().length > 0,
        testable: false,
        reason:
          "Every Stripe payload is run through payment fulfilment (handleStripeWebhook, " +
          "src/agent.ts) before recording — there is no inert event type, so this leg is " +
          "deliberately not fired rather than risk a fulfilment path.",
      });

      // Slack legacy (/webhooks/slack): url_verification round trip + synthetic message event.
      {
        const secret = String(c.env.SLACK_WEBHOOK_SECRET ?? "").trim();
        if (!secret) {
          legs.push({ provider: "slack-legacy", configured: false });
        } else {
          const uvChallenge = `qa-${marker}`;
          const uvBody = JSON.stringify({ type: "url_verification", challenge: uvChallenge });
          const uvTs = String(Math.floor(Date.now() / 1000));
          const uvProbe = await probeViaQAAgent(
            c,
            "/webhooks/slack",
            "POST",
            {
              "Content-Type": "application/json",
              "X-Slack-Request-Timestamp": uvTs,
              "X-Slack-Signature": await slackSignature(secret, uvTs, uvBody),
            },
            uvBody,
          );
          const uvJson = probeJson(uvProbe.text);
          const urlVerificationOk = uvProbe.status === 200 && uvJson?.challenge === uvChallenge;

          const raw = JSON.stringify(buildSlackLegacyTestPayload(marker));
          const ts = String(Math.floor(Date.now() / 1000));
          const probe = await probeViaQAAgent(
            c,
            "/webhooks/slack",
            "POST",
            {
              "Content-Type": "application/json",
              "X-Slack-Request-Timestamp": ts,
              "X-Slack-Signature": await slackSignature(secret, ts, raw),
            },
            raw,
          );
          const recorded = probe.status === 200 ? containsMarker(await recordedEvents("slack")) : false;
          legs.push({
            provider: "slack-legacy",
            configured: true,
            urlVerificationOk,
            signatureAccepted: probe.status === 200,
            httpStatus: probe.status,
            recorded,
            ok: urlVerificationOk && probe.status === 200 && recorded,
          });
        }
      }

      const fireable = legs.filter((l) => l.provider !== "stripe");
      const ok = fireable.every((l) => l.configured === false || l.ok);
      const configured = fireable.some((l) => l.configured !== false);
      return c.json({
        ok,
        configured,
        legs,
        note:
          "The GitHub ping and the Slack legacy event are inert by construction: both record into " +
          "host webhook events without triggering any real-world action. Side effects of a passing " +
          "run, reported honestly: one AI insight call per event, a 'Webhook received' Slack notice " +
          "if SLACK_WEBHOOK_URL is set, and possibly an email if WEBHOOK_NOTIFY_EMAIL is set. " +
          "The slack-legacy event also passes through handleSlackEvent (like /slack/events), which " +
          "attempts a bot auto-reply to the clearly-fake channel — that fails harmlessly and does not " +
          "affect recording.",
      });
    } catch (err) {
      return c.json(
        { ok: false, ...errorBody("INTERNAL"), detail: String(err) },
        500,
      );
    }
  });

  /**
   * Probe the MCP auth posture for real: two UNAUTHENTICATED calls to
   * POST /mcp — tools/list and a write-class tools/call naming a nonexistent
   * goal id (inert even if it ever executed). The expected outcomes come from
   * mcpUnauthExpectations() (the configured MCP_AUTH_MODE); pass means the
   * observed statuses match the expected ones. This locks in the issue-#239
   * guard: in "none" mode the write call MUST be 401 even though reads serve.
   */
  app.post("/api/dashboard/qa/mcp-auth-probe", requireAuth, async (c: any) => {
    try {
      const mode = String(c.env.MCP_AUTH_MODE ?? "").trim().toLowerCase() || "(unset)";
      const expected = mcpUnauthExpectations(c.env.MCP_AUTH_MODE, {
        staticToken: String(c.env.MCP_AUTH_TOKEN ?? ""),
        githubOrg: String(c.env.MCP_GITHUB_ORG ?? ""),
        jwtSecret: String(c.env.MCP_JWT_SECRET ?? ""),
      });
      async function mcpProbeStatus(body: any): Promise<number> {
        const p = await probeViaQAAgent(
          c,
          "/mcp",
          "POST",
          {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          JSON.stringify(body),
        );
        return p.status;
      }
      const listStatus = await mcpProbeStatus({
        jsonrpc: "2.0",
        id: "qa-mcp-probe-list",
        method: "tools/list",
        params: {},
      });
      // cfpay_scheduled_delete is write-class (WRITE_TOOLS, src/mcp-jwt.ts); the
      // id names nothing, so the call is inert even if it ever executed — and in
      // "none" mode the guard refuses it before any handler runs.
      const writeStatus = await mcpProbeStatus({
        jsonrpc: "2.0",
        id: "qa-mcp-probe-write",
        method: "tools/call",
        params: { name: "cfpay_scheduled_delete", arguments: { id: "qa-mcp-probe-nonexistent" } },
      });
      if ("misconfigured" in expected) {
        const pass = listStatus === 503 && writeStatus === 503;
        return c.json({
          ok: false,
          mode,
          misconfigured: true,
          expectedList: 503,
          expectedWrite: 503,
          listStatus,
          writeStatus,
          pass,
          note: "MCP_AUTH_MODE is not a recognised mode; the server fails closed with 503 on every /mcp call.",
        });
      }
      const pass = listStatus === expected.listStatus && writeStatus === expected.writeStatus;
      return c.json({
        ok: pass,
        mode,
        expectedList: expected.listStatus,
        expectedWrite: expected.writeStatus,
        listStatus,
        writeStatus,
        pass,
        note: "Unauthenticated probes. The write-class call names a nonexistent goal id and is inert even if it ever executed.",
      });
    } catch (err) {
      return c.json(
        { ok: false, ...errorBody("INTERNAL"), detail: String(err) },
        500,
      );
    }
  });

  /**
   * Probe the dashboard search path for real: POST /api/dashboard/search with
   * a fixed query and the server-side dashboard key, plus the search agent's
   * own snapshot. No fabrication — whatever the agent reports is the result
   * (today: SEARCH_NOT_CONFIGURED until the AI Search instance exists).
   */
  app.post("/api/dashboard/qa/search-probe", requireAuth, async (c: any) => {
    try {
      const summary = (await a2aRead(c, "search", "search.summary")) as any;
      const probe = await probeViaQAAgent(
        c,
        "/api/dashboard/search",
        "POST",
        {
          "Content-Type": "application/json",
          "X-API-Key": c.env.DASHBOARD_API_KEY,
        },
        JSON.stringify({ query: "autopilot", mode: "query", limit: 3 }),
      );
      const json = probeJson(probe.text);
      const error = json?.error ?? null;
      return c.json({
        ok: probe.status === 200 && !error,
        httpStatus: probe.status,
        configured: summary?.configured ?? null,
        instance: summary?.instance ?? null,
        query: json?.query ?? null,
        chunkCount: Array.isArray(json?.chunks) ? json.chunks.length : null,
        error,
        note: "Whatever the agent reports is the result — no fabricated answer.",
      });
    } catch (err) {
      return c.json(
        { ok: false, ...errorBody("INTERNAL"), detail: String(err) },
        500,
      );
    }
  });
}
