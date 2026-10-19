/**
 * Single-owner HMAC sign/verify primitives (issue #269, cluster C5).
 *
 * Before this module, `src/mcp-jwt.ts` and `src/mcp-oauth-server.ts` each
 * hand-rolled their own HMAC key import + sign, and neither shared the
 * constant-time comparison discipline of the webhook verification path.
 * This module is the ONLY implementation of HMAC key import, signing, and
 * verification for auth-token use: MCP scoped-JWT issuance/verification
 * (`src/mcp-jwt.ts`) and the MCP OAuth server state blobs
 * (`src/mcp-oauth-server.ts`) both delegate to it.
 *
 * Fold-ins (issue #269, remainder): the webhook signature verifiers now
 * delegate here too — `src/webhooks.ts` (GitHub/Stripe HMAC sign and the
 * hex-signature comparison) and the bearer-token comparison
 * (`src/mcp-auth.ts` `timingSafeStringEqual`, via UTF-8 bytes). Only
 * `src/slack-verify.ts` keeps its own v0 verifier: it is C1 territory
 * with a replay-window policy that belongs to the Slack path.
 *
 * Contract notes (byte-identical behavior vs the two copies this replaces):
 *  - `importHmacKey` imports key material verbatim (UTF-8 for strings) —
 *    callers apply their own domain separation. In particular
 *    `mcp-oauth-server` prefixes its secret with `"cfmail-oauth|"`; that
 *    prefixing stays in the caller so issued state tokens keep the exact
 *    signatures they had before.
 *  - Keys are imported with `["sign", "verify"]` usages, exactly as both
 *    copies did, so `verifyHmac` works on every key this module mints.
 *  - `verifyHmac` never throws on a bad signature: it returns false.
 *  - `timingSafeEqual` compares bytes with an XOR-accumulate loop (no
 *    early exit), after a length check — the same discipline the webhook
 *    path uses.
 *
 * SDK-free: only WebCrypto. Importable from unit tests.
 */
export type HmacHash = "SHA-256" | "SHA-384" | "SHA-512";

/**
 * Import raw key material as an HMAC CryptoKey. Strings are UTF-8 encoded.
 * Both previous copies used SHA-256; other hashes are exposed for future
 * callers, but the default keeps every existing token byte-identical.
 */
export async function importHmacKey(keyMaterial: string | Uint8Array, hash: HmacHash = "SHA-256"): Promise<CryptoKey> {
  const raw = typeof keyMaterial === "string" ? new TextEncoder().encode(keyMaterial) : keyMaterial;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash }, false, ["sign", "verify"]);
}

/** HMAC-sign data; returns the raw signature bytes. */
export async function signHmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/**
 * Verify an HMAC signature in constant time (via WebCrypto's own verify,
 * which runs in constant time for HMAC). Never throws: a malformed or
 * mismatched signature returns false.
 */
export async function verifyHmac(key: CryptoKey, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", key, signature, data);
  } catch {
    return false;
  }
}

/**
 * Constant-time byte comparison. Length mismatch returns false up front
 * (lengths are not secret for the signatures this guards); the byte loop
 * itself never exits early.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
