/**
 * Single-owner Slack v0 signature verification (issue #269, cluster C1).
 *
 * Slack signs `X-Slack-Signature` as `v0=<hex>` where the hex is HMAC-SHA256
 * over `v0:<timestamp>:<rawBody>`. This module is the ONLY implementation of
 * that check: it is used by both the Events API (`/slack/events`, index.ts)
 * and the dashboard webhook route (`/webhooks/slack`, webhooks.ts).
 *
 * The unified contract is the stricter of the two copies it replaced:
 *  - fail closed on a missing or blank signing secret (a blank secret would
 *    otherwise degrade to an HMAC keyed on "", which anyone can compute),
 *  - fail closed on a missing timestamp or signature,
 *  - reject signatures that are not `v0=<64 hex chars>`,
 *  - enforce a timestamp replay window (default 300s, Slack's own guidance),
 *    rejecting both stale AND future timestamps,
 *  - constant-time comparison of the computed digest.
 *
 * SDK-free: only WebCrypto. Importable from unit tests.
 */
export async function verifySlackSignature(
  signingSecret: string | undefined | null,
  timestamp: string | null,
  body: string,
  signature: string | null,
  toleranceSeconds = 300,
): Promise<boolean> {
  // Fail closed: an absent or blank secret means the request cannot be
  // authenticated, so never derive a key from it.
  if (!signingSecret || !signingSecret.trim() || !signature || !timestamp) {
    return false;
  }

  // Replay protection — Slack timestamps are seconds since epoch. Both stale
  // and future timestamps are rejected: the Events API copy this replaces
  // enforced no freshness at all, which allowed captured payloads to replay.
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(age) || Math.abs(age) > toleranceSeconds) return false;

  // Header format is "v0=<hex>"; the digest itself is hex only, so the prefix
  // must be stripped before comparing.
  if (!/^v0=[0-9a-f]{64}$/i.test(signature)) return false;
  const hex = signature.slice(3);

  const sigBase = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBase));
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison.
  if (computed.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hex.charCodeAt(i);
  }
  return diff === 0;
}
