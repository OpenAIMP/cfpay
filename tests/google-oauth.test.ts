/**
 * Unit tests for src/google-oauth.ts verifyGoogleIdToken.
 *
 * Generates a real RSA key pair with WebCrypto, builds a self-signed JWKS,
 * and crafts id_tokens (valid / wrong aud / expired / bad signature /
 * unknown kid). No network: the certs fetch is mocked via fetchImpl.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  verifyGoogleIdToken,
  clearGoogleCertsCacheForTests,
} from "../src/google-oauth";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const NOW_SEC = 1_760_000_000;

function b64u(input: Uint8Array): string {
  let binary = "";
  for (const b of input) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64uJson(obj: unknown): string {
  return b64u(new TextEncoder().encode(JSON.stringify(obj)));
}

interface Fixture {
  signingKey: CryptoKey;
  jwk: JsonWebKey;
  fetchImpl: typeof fetch;
  sign: (claims: Record<string, unknown>, kid?: string, alg?: string) => Promise<string>;
}

async function makeFixture(): Promise<Fixture> {
  clearGoogleCertsCacheForTests();
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  jwk.kid = "test-kid";
  jwk.alg = "RS256";

  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  const sign = async (claims: Record<string, unknown>, kid = "test-kid", alg = "RS256") => {
    const headerB64 = b64uJson({ alg, kid, typ: "JWT" });
    const payloadB64 = b64uJson(claims);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
    return `${headerB64}.${payloadB64}.${b64u(new Uint8Array(sig))}`;
  };

  return { signingKey: privateKey, jwk, fetchImpl, sign };
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "12345",
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: NOW_SEC + 3600,
    iat: NOW_SEC,
    email: "user@example.com",
    name: "Test User",
    ...overrides,
  };
}

describe("verifyGoogleIdToken", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await makeFixture();
  });

  it("accepts a valid token and returns claims", async () => {
    const token = await f.sign(validClaims());
    const claims = await verifyGoogleIdToken(token, CLIENT_ID, {
      nowSec: NOW_SEC,
      fetchImpl: f.fetchImpl,
    });
    expect(claims).toMatchObject({
      sub: "12345",
      email: "user@example.com",
      name: "Test User",
    });
  });

  it("rejects a wrong aud", async () => {
    const token = await f.sign(validClaims({ aud: "other-client" }));
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/aud/);
  });

  it("rejects an expired token", async () => {
    const token = await f.sign(validClaims({ exp: NOW_SEC - 10 }));
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a bad signature", async () => {
    const token = await f.sign(validClaims());
    const tampered = token.slice(0, -4) + "AAAA";
    await expect(
      verifyGoogleIdToken(tampered, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects an unknown kid", async () => {
    const token = await f.sign(validClaims(), "no-such-kid");
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/kid/);
  });

  it("rejects an unexpected issuer", async () => {
    const token = await f.sign(validClaims({ iss: "https://evil.example.com" }));
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/iss/);
  });

  it("accepts the accounts.google.com issuer form", async () => {
    const token = await f.sign(validClaims({ iss: "accounts.google.com" }));
    const claims = await verifyGoogleIdToken(token, CLIENT_ID, {
      nowSec: NOW_SEC,
      fetchImpl: f.fetchImpl,
    });
    expect(claims.sub).toBe("12345");
  });

  it("rejects a missing sub", async () => {
    const claims = validClaims() as Record<string, unknown>;
    delete claims.sub;
    const token = await f.sign(claims);
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/sub/);
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyGoogleIdToken("not-a-jwt", CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: f.fetchImpl }),
    ).rejects.toThrow();
  });

  it("works without optional claims (email/name)", async () => {
    const claims = validClaims() as Record<string, unknown>;
    delete claims.email;
    delete claims.name;
    const token = await f.sign(claims);
    const out = await verifyGoogleIdToken(token, CLIENT_ID, {
      nowSec: NOW_SEC,
      fetchImpl: f.fetchImpl,
    });
    expect(out.sub).toBe("12345");
    expect(out.email).toBeUndefined();
    expect(out.name).toBeUndefined();
  });

  it("caches the JWKS (fetch called once for two verifications)", async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ keys: [f.jwk] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const token = await f.sign(validClaims());
    await verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: counting });
    await verifyGoogleIdToken(token, CLIENT_ID, { nowSec: NOW_SEC, fetchImpl: counting });
    expect(calls).toBe(1);
  });
});
