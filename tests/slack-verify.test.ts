/**
 * Tests for the single-owner Slack v0 signature verifier (src/slack-verify.ts).
 *
 * Issue #269, cluster C1: two copies of the verifier existed —
 *  - src/slack.ts `verifySlackSignature` (no timestamp freshness), used by
 *    /slack/events, and
 *  - src/webhooks.ts `verifySlack` (300s replay window), used by
 *    /webhooks/slack.
 * Characterization (pre-extraction) pinned the divergence: a correctly-signed
 * request with a >300s-old timestamp passed /slack/events. This file now
 * asserts the unified contract: both paths reject stale and future
 * timestamps. The /webhooks/slack behavior is unchanged.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../src/slack-verify";
import { verifyAndParseWebhook } from "../src/webhooks";

const SECRET = "slack-signing-secret-for-tests";

function sign(secret: string, timestamp: string, body: string): string {
  const v0 = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${v0}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const body = JSON.stringify({ type: "event_callback" });

describe("verifySlackSignature — unified contract (src/slack-verify.ts)", () => {
  it("accepts a valid fresh signature", async () => {
    const ts = String(nowSec());
    expect(await verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body))).toBe(true);
  });

  it("accepts a signature within the default 300s window", async () => {
    const ts = String(nowSec() - 100);
    expect(await verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body))).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const ts = String(nowSec());
    expect(await verifySlackSignature(SECRET, ts, body + "x", sign(SECRET, ts, body))).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const ts = String(nowSec());
    expect(await verifySlackSignature("wrong-secret", ts, body, sign(SECRET, ts, body))).toBe(false);
  });

  it("rejects a blank secret (fail closed)", async () => {
    const ts = String(nowSec());
    expect(await verifySlackSignature("   ", ts, body, sign(SECRET, ts, body))).toBe(false);
    expect(await verifySlackSignature("", ts, body, sign(SECRET, ts, body))).toBe(false);
    expect(await verifySlackSignature(undefined, ts, body, sign(SECRET, ts, body))).toBe(false);
  });

  it("rejects a missing timestamp or signature (fail closed)", async () => {
    const ts = String(nowSec());
    const sig = sign(SECRET, ts, body);
    expect(await verifySlackSignature(SECRET, null, body, sig)).toBe(false);
    expect(await verifySlackSignature(SECRET, ts, body, null)).toBe(false);
    expect(await verifySlackSignature(SECRET, "", body, sig)).toBe(false);
  });

  it("rejects malformed signatures", async () => {
    const ts = String(nowSec());
    const sig = sign(SECRET, ts, body);
    expect(await verifySlackSignature(SECRET, ts, body, "v0=short")).toBe(false);
    expect(await verifySlackSignature(SECRET, ts, body, sig.slice(3))).toBe(false); // no v0= prefix
    expect(await verifySlackSignature(SECRET, ts, body, "")).toBe(false);
  });

  // ---- the C1 behavior change: the Events API path now enforces freshness ----
  it("rejects a correctly-signed but 400s-stale timestamp", async () => {
    const staleTs = String(nowSec() - 400);
    expect(await verifySlackSignature(SECRET, staleTs, body, sign(SECRET, staleTs, body))).toBe(false);
  });

  it("rejects a correctly-signed timestamp 400s in the future", async () => {
    const futureTs = String(nowSec() + 400);
    expect(await verifySlackSignature(SECRET, futureTs, body, sign(SECRET, futureTs, body))).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    expect(await verifySlackSignature(SECRET, "not-a-number", body, sign(SECRET, "not-a-number", body))).toBe(false);
  });

  it("honors a custom tolerance window", async () => {
    const ts = String(nowSec() - 400);
    expect(await verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body), 600)).toBe(true);
    expect(await verifySlackSignature(SECRET, ts, body, sign(SECRET, ts, body), 300)).toBe(false);
  });
});

function post(path: string, body: string, headers: Record<string, string>): Request {
  return new Request("https://pay.openaimp.com" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("/webhooks/slack end-to-end (canonical verifier via verifyAndParseWebhook)", () => {
  const env = { SLACK_WEBHOOK_SECRET: SECRET };

  it("accepts a valid fresh signature", async () => {
    const ts = String(nowSec());
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", body, {
        "X-Slack-Signature": sign(SECRET, ts, body),
        "X-Slack-Request-Timestamp": ts,
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.provider).toBe("slack");
  });

  it("rejects a correctly-signed but 400s-stale timestamp", async () => {
    const staleTs = String(nowSec() - 400);
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", body, {
        "X-Slack-Signature": sign(SECRET, staleTs, body),
        "X-Slack-Request-Timestamp": staleTs,
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("rejects when the webhook secret is not configured", async () => {
    const ts = String(nowSec());
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", body, {
        "X-Slack-Signature": sign(SECRET, ts, body),
        "X-Slack-Request-Timestamp": ts,
      }),
      {},
    );
    expect(res).toBeNull();
  });
});
