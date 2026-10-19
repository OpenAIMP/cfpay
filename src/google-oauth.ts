/**
 * Google OAuth id_token verification (issue #252 P2).
 *
 * SDK-free: uses WebCrypto only. Verifies an RS256 id_token from Google's
 * OAuth 2.0 / OpenID Connect endpoint against Google's published JWKS.
 *
 * Never logs the token. Throws Error with a clear message on any failure;
 * callers map failures to a 502.
 */

export interface GoogleIdClaims {
  sub: string;
  email?: string;
  name?: string;
}

interface GoogleCertsResponse {
  keys: Array<{
    kid?: string;
    kty?: string;
    alg?: string;
    use?: string;
    n?: string;
    e?: string;
    [k: string]: unknown;
  }>;
}

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CERTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const ACCEPTED_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

let certsCache: { fetchedAt: number; keys: GoogleCertsResponse["keys"] } | null = null;

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getCerts(fetchImpl: typeof fetch): Promise<GoogleCertsResponse["keys"]> {
  const now = Date.now();
  if (certsCache && now - certsCache.fetchedAt < CERTS_CACHE_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google certs (HTTP ${res.status})`);
  const body = (await res.json()) as GoogleCertsResponse;
  if (!Array.isArray(body.keys)) throw new Error("Google certs response has no keys array");
  certsCache = { fetchedAt: now, keys: body.keys };
  return body.keys;
}

/**
 * Verify a Google id_token and return its claims.
 *
 * Checks: RS256 signature against Google's published JWKS (kid lookup),
 * aud === clientId, iss in the accepted Google issuers, exp > now, sub present.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  opts?: { nowSec?: number; fetchImpl?: typeof fetch },
): Promise<GoogleIdClaims> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid id_token: expected 3 segments");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; aud?: string; iss?: string; exp?: number; email?: string; name?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  } catch {
    throw new Error("Invalid id_token: header is not valid base64url JSON");
  }
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new Error("Invalid id_token: payload is not valid base64url JSON");
  }

  if (header.alg !== "RS256") throw new Error(`Invalid id_token: unexpected alg ${header.alg ?? "missing"}`);
  if (!header.kid) throw new Error("Invalid id_token: missing kid");

  const keys = await getCerts(fetchImpl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`Invalid id_token: unknown kid ${header.kid}`);
  if (!jwk.n || !jwk.e) throw new Error("Invalid id_token: JWK is missing n or e");

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (e) {
    throw new Error(`Invalid id_token: cannot import JWK (${e instanceof Error ? e.message : "unknown"})`);
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) throw new Error("Invalid id_token: signature verification failed");

  if (payload.aud !== clientId) throw new Error("Invalid id_token: aud mismatch");
  if (!payload.iss || !ACCEPTED_ISSUERS.has(payload.iss)) {
    throw new Error(`Invalid id_token: unexpected iss ${payload.iss ?? "missing"}`);
  }
  if (typeof payload.exp !== "number" || !(payload.exp > nowSec)) {
    throw new Error("Invalid id_token: token is expired");
  }
  if (!payload.sub) throw new Error("Invalid id_token: missing sub");

  const claims: GoogleIdClaims = { sub: payload.sub };
  if (typeof payload.email === "string") claims.email = payload.email;
  if (typeof payload.name === "string") claims.name = payload.name;
  return claims;
}

/** Test seam: clear the in-module JWKS cache. */
export function clearGoogleCertsCacheForTests(): void {
  certsCache = null;
}
