/**
 * Unit tests for webhook signature verification (src/webhooks.ts).
 *
 * These cover the pure verification paths: HMAC validation per provider and
 * the timestamp replay windows for Stripe/Slack. GitHub signs no timestamp,
 * so its replay protection (X-GitHub-Delivery dedup) lives in the agent's
 * Durable Object state and is intentionally not covered here.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAndParseWebhook } from "../src/webhooks";

const GITHUB_SECRET = "test-github-secret";
const STRIPE_SECRET = "whsec_test";
const SLACK_SECRET = "test-slack-signing-secret";

function post(path: string, body: string, headers: Record<string, string>): Request {
  return new Request("https://pay.openaimp.com" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function githubSignature(body: string): string {
  return "sha256=" + createHmac("sha256", GITHUB_SECRET).update(body).digest("hex");
}

function stripeSignature(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function slackSignature(secret: string, body: string, timestamp: string): string {
  const v0 = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${v0}`;
}

const env = {
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  SLACK_WEBHOOK_SECRET: SLACK_SECRET,
  SLACK_SIGNING_SECRET: SLACK_SECRET,
};

describe("verifyAndParseWebhook — GitHub", () => {
  const payload = JSON.stringify({ repository: { full_name: "OpenAIMP/cfpay" } });

  it("accepts a valid signature and derives the agent name", async () => {
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", payload, {
        "X-Hub-Signature-256": githubSignature(payload),
        "X-GitHub-Delivery": "delivery-1",
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.provider).toBe("github");
    expect(res!.agentName).toBe("openaimp-cfpay");
    expect(res!.deliveryId).toBe("delivery-1");
  });

  it("rejects a forged signature", async () => {
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", payload, {
        "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
        "X-GitHub-Delivery": "delivery-2",
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("rejects a malformed signature header", async () => {
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", payload, {
        "X-Hub-Signature-256": "not-a-valid-header",
        "X-GitHub-Delivery": "delivery-3",
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("fails closed when X-GitHub-Delivery is missing", async () => {
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", payload, {
        "X-Hub-Signature-256": githubSignature(payload),
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("fails closed when the secret is unconfigured", async () => {
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", payload, {
        "X-Hub-Signature-256": githubSignature(payload),
        "X-GitHub-Delivery": "delivery-4",
      }),
      {},
    );
    expect(res).toBeNull();
  });

  it("rejects a payload without a repository", async () => {
    const body = JSON.stringify({ zen: "hello" });
    const res = await verifyAndParseWebhook(
      post("/webhooks/github", body, {
        "X-Hub-Signature-256": githubSignature(body),
        "X-GitHub-Delivery": "delivery-5",
      }),
      env,
    );
    expect(res).toBeNull();
  });
});

describe("verifyAndParseWebhook — Stripe replay window", () => {
  const body = JSON.stringify({ id: "evt_1", data: { object: { customer: "cus_1" } } });

  it("accepts a fresh signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await verifyAndParseWebhook(
      post("/webhooks/stripe", body, {
        "Stripe-Signature": stripeSignature(STRIPE_SECRET, body, ts),
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.provider).toBe("stripe");
    expect(res!.agentName).toBe("stripe-cus-1"); // "_" is sanitized to "-"
  });

  it("rejects a stale timestamp (replay)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const res = await verifyAndParseWebhook(
      post("/webhooks/stripe", body, {
        "Stripe-Signature": stripeSignature(STRIPE_SECRET, body, ts),
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("rejects a future timestamp outside tolerance", async () => {
    const ts = Math.floor(Date.now() / 1000) + 3600;
    const res = await verifyAndParseWebhook(
      post("/webhooks/stripe", body, {
        "Stripe-Signature": stripeSignature(STRIPE_SECRET, body, ts),
      }),
      env,
    );
    expect(res).toBeNull();
  });
});

describe("verifyAndParseWebhook — Slack replay window", () => {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event: { channel: "C1", text: "hello", user: "U1" },
  });

  it("accepts a fresh signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", body, {
        "X-Slack-Signature": slackSignature(SLACK_SECRET, body, ts),
        "X-Slack-Request-Timestamp": ts,
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.provider).toBe("slack");
  });

  it("rejects a stale timestamp (replay)", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", body, {
        "X-Slack-Signature": slackSignature(SLACK_SECRET, body, ts),
        "X-Slack-Request-Timestamp": ts,
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it("rejects a signature computed over a tampered body", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const tampered = body.replace("hello", "goodbye");
    const res = await verifyAndParseWebhook(
      post("/webhooks/slack", tampered, {
        "X-Slack-Signature": slackSignature(SLACK_SECRET, body, ts),
        "X-Slack-Request-Timestamp": ts,
      }),
      env,
    );
    expect(res).toBeNull();
  });
});
