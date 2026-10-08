/**
 * Webhook signature verification for GitHub, Stripe, and Slack.
 *
 * Each provider uses a different signature scheme:
 * - GitHub: HMAC-SHA256 over raw body, header X-Hub-Signature-256, format "sha256=<hex>"
 * - Stripe: HMAC-SHA256 over "<timestamp>.<rawBody>", header Stripe-Signature, format "t=<ts>,v1=<hex>"
 * - Slack: HMAC-SHA256 over "v0:<timestamp>:<rawBody>", header X-Slack-Signature, format "v0=<hex>"
 *
 * Docs: https://developers.cloudflare.com/agents/communication-channels/webhooks/
 */

export type WebhookProvider = "github" | "stripe" | "slack";

export interface VerifiedWebhook {
  provider: WebhookProvider;
  agentName: string;
  payload: unknown;
}

/**
 * A webhook secret is only usable when it is actually configured. Verifying
 * against an unset secret would degrade to HMAC keyed on "", which anyone can
 * compute — so callers must fail closed instead.
 */
function isConfiguredSecret(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyHexSignature(secret: string, message: string, signature: string): Promise<boolean> {
  const expected = toHex(await hmacSha256(secret, message));
  // constant-time-ish comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function verifyGitHub(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const hex = signature.slice(7); // strip "sha256="
  return verifyHexSignature(secret, rawBody, hex);
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

async function verifyStripe(
  rawBody: string,
  signature: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signature) return false;

  // Parse "t=<ts>,v1=<hex>" format
  const parts = signature.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!timestampPart || !v1Part) return false;

  const timestamp = timestampPart.slice(2);
  const hex = v1Part.slice(3);

  // Replay protection — reject stale timestamps
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(age) || Math.abs(age) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  return verifyHexSignature(secret, signedPayload, hex);
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async function verifySlack(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  if (!secret) return false;

  // Replay protection
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(age) || Math.abs(age) > toleranceSeconds) return false;

  // Header format is "v0=<hex>"; the digest itself is hex only, so the prefix
  // must be stripped before comparing (as verifyGitHub does for "sha256=").
  if (!/^v0=[0-9a-f]{64}$/i.test(signature)) return false;
  const hex = signature.slice(3);

  // Slack signs "v0:<timestamp>:<rawBody>"
  const basestring = `v0:${timestamp}:${rawBody}`;
  return verifyHexSignature(secret, basestring, hex);
}

// ---------------------------------------------------------------------------
// Unified verifier + parser
// ---------------------------------------------------------------------------

/**
 * Verify and parse an incoming webhook request.
 * Derives the agent name from the authenticated payload.
 *
 * Returns null if verification fails.
 */
export async function verifyAndParseWebhook(
  request: Request,
  env: { GITHUB_WEBHOOK_SECRET?: string; STRIPE_WEBHOOK_SECRET?: string; SLACK_WEBHOOK_SECRET?: string },
): Promise<VerifiedWebhook | null> {
  const url = new URL(request.url);
  const rawBody = await request.text();

  // Route based on path
  if (url.pathname === "/webhooks/github") {
    const signature = request.headers.get("X-Hub-Signature-256");
    if (!isConfiguredSecret(env.GITHUB_WEBHOOK_SECRET)) return null;
    if (!(await verifyGitHub(rawBody, signature, env.GITHUB_WEBHOOK_SECRET))) return null;

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // Derive agent name from repository full_name (e.g. "owner/repo" → "owner-repo")
    const repo = payload?.repository?.full_name;
    if (!repo) return null;
    const agentName = repo.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return { provider: "github", agentName, payload };
  }

  if (url.pathname === "/webhooks/stripe") {
    const signature = request.headers.get("Stripe-Signature");
    if (!isConfiguredSecret(env.STRIPE_WEBHOOK_SECRET)) return null;
    if (!(await verifyStripe(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) return null;

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // Derive agent name from the Stripe customer or account ID
    const customerId = payload?.data?.object?.customer || payload?.account || payload?.id || "default";
    const agentName = String(customerId).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return { provider: "stripe", agentName, payload };
  }

  if (url.pathname === "/webhooks/slack") {
    const signature = request.headers.get("X-Slack-Signature");
    const timestamp = request.headers.get("X-Slack-Request-Timestamp");
    if (!isConfiguredSecret(env.SLACK_WEBHOOK_SECRET)) return null;
    if (!(await verifySlack(rawBody, signature, timestamp, env.SLACK_WEBHOOK_SECRET))) return null;

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // Slack URL verification challenge
    if (payload?.type === "url_verification" && payload?.challenge) {
      // Handled by caller — return a special marker
      return { provider: "slack", agentName: "_url_verification", payload };
    }

    // Derive agent name from the Slack team ID or channel ID
    const teamId = payload?.team_id || payload?.event?.channel || "default";
    const agentName = String(teamId).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return { provider: "slack", agentName, payload };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Outgoing webhook helpers
// ---------------------------------------------------------------------------

/**
 * Send a Slack incoming-webhook notification.
 */
/** Text an incoming Slack webhook always answers with. */
const SLACK_WEBHOOK_OK_BODIES = ["ok"];

/**
 * Post a message to a Slack incoming webhook.
 *
 * Slack answers 200 with a body of "ok" on success, and a non-2xx status with a
 * reason such as "invalid_token" or "no_service" on failure — so the status code
 * alone is not enough to call this successful.
 *
 * Never throws: a network failure or timeout is reported as ok:false with the
 * reason, so callers can surface something actionable.
 */
export async function sendSlackNotificationDetailed(
  webhookUrl: string,
  message: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!webhookUrl) {
    return { ok: false, detail: "SLACK_WEBHOOK_URL is not configured." };
  }

  let res: Response;
  let body: string;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    body = (await res.text()).trim();
  } catch (err) {
    return {
      ok: false,
      detail: `Could not reach Slack: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    // Slack puts the machine-readable reason in the body; keep it short.
    const reason = body.slice(0, 200);
    return {
      ok: false,
      detail: reason
        ? `Slack rejected the message (${res.status}): ${reason}`
        : `Slack rejected the message (${res.status}).`,
    };
  }

  const trimmedLower = body.toLowerCase();
  const looksOk =
    trimmedLower.length === 0 || SLACK_WEBHOOK_OK_BODIES.includes(trimmedLower);
  if (!looksOk) {
    return { ok: false, detail: `Slack returned an unexpected response: ${body.slice(0, 200)}` };
  }

  return { ok: true, detail: "" };
}

export async function sendSlackNotification(webhookUrl: string, message: string): Promise<boolean> {
  const { ok } = await sendSlackNotificationDetailed(webhookUrl, message);
  return ok;
}

/**
 * Send a signed webhook to an arbitrary URL.
 */
export async function sendSignedWebhook(
  url: string,
  payload: unknown,
  secret: string,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = toHex(await hmacSha256(secret, body));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": `sha256=${signature}`,
    },
    body,
  });
  return res.ok;
}