/**
 * Pinned invariants for the QA capability tests (issue #260).
 *
 * The Slack capability tests exercise paths no A2A endpoint covers:
 * inbound event signature verification + recording at POST /slack/events,
 * and the file-post path in src/slack-files.ts. These tests pin:
 *  - slackSignature() implements Slack's v0 HMAC scheme exactly, checked
 *    against an INDEPENDENT computation (node:crypto, not WebCrypto), so
 *    a prefix/format/encoding bug is caught rather than echoed,
 *  - the synthetic event body is exactly the shape handleSlackWebhook
 *    (src/index.ts) accepts and records: event_callback with a message
 *    event, no bot_id, non-empty text,
 *  - the routes are registered in src/api.ts and the Capability Tests
 *    card is wired into public/a2a-tester.js.
 *
 * The end-to-end proof of the scheme (signed payload accepted, wrong
 * scheme 401) happens live in production, not here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  slackSignature,
  buildSlackTestEvent,
  QA_TEST_CHANNEL,
  QA_TEST_USER,
} from "../src/qa-capability-tests";

describe("slackSignature (Slack v0 scheme)", () => {
  it("matches an independent node:crypto HMAC-SHA256 computation", async () => {
    const secret = "8f742231b10e8888abcd99yyyzzz85a5";
    const timestamp = "1531420618";
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595u9gCsqWOUv6aE8yX0eh",
    });
    const expected =
      "v0=" +
      createHmac("sha256", secret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest("hex");
    await expect(slackSignature(secret, timestamp, rawBody)).resolves.toBe(expected);
  });

  it("produces the v0= prefix and a 64-hex-char digest", async () => {
    const sig = await slackSignature("secret", "1700000000", "{}");
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("changes when any of secret, timestamp, or body changes", async () => {
    const a = await slackSignature("s", "1", "b");
    const b = await slackSignature("s2", "1", "b");
    const c = await slackSignature("s", "2", "b");
    const d = await slackSignature("s", "1", "b2");
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("buildSlackTestEvent (shape the handler records)", () => {
  it("builds an event_callback message event with no bot_id and non-empty text", () => {
    const evt = buildSlackTestEvent(
      QA_TEST_CHANNEL,
      QA_TEST_USER,
      "[QA capability test] synthetic Slack event 2026-01-01T00:00:00.000Z",
      "1767225600.000001",
    );
    // parseSlackEvent (src/slack.ts) requires type === "event_callback" with an event object.
    expect(evt.type).toBe("event_callback");
    expect(evt.event.type).toBe("message");
    // handleSlackWebhook (src/index.ts) skips bot_id and text-less events.
    expect("bot_id" in evt.event).toBe(false);
    expect(evt.event.text.length).toBeGreaterThan(0);
    expect(evt.event.channel).toBe(QA_TEST_CHANNEL);
    expect(evt.event.user).toBe(QA_TEST_USER);
    expect(evt.event.ts).toBe("1767225600.000001");
  });

  it("uses a clearly-synthetic channel id, never a real channel", () => {
    expect(QA_TEST_CHANNEL).toMatch(/^CQATEST/);
    expect(QA_TEST_USER).toMatch(/^UQATEST/);
  });
});

describe("wiring", () => {
  const apiSrc = readFileSync("src/api.ts", "utf8");
  const testerSrc = readFileSync("public/a2a-tester.js", "utf8");

  it("registers the capability test routes in src/api.ts", () => {
    expect(apiSrc).toContain('import { registerCapabilityTests } from "./qa-capability-tests";');
    expect(apiSrc).toContain("registerCapabilityTests(app, requireAuth);");
  });

  it("wires both routes in the module", () => {
    const modSrc = readFileSync("src/qa-capability-tests.ts", "utf8");
    expect(modSrc).toContain('app.post("/api/dashboard/qa/slack-events-test"');
    expect(modSrc).toContain('app.post("/api/dashboard/qa/slack-file-test"');
  });

  it("builds the Capability Tests card in the QA tab", () => {
    expect(testerSrc).toContain("Capability Tests");
    expect(testerSrc).toContain("cap-events");
    expect(testerSrc).toContain("/api/dashboard/qa/slack-events-test");
    expect(testerSrc).toContain("/api/dashboard/qa/slack-file-test");
  });
});
