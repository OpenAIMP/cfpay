/**
 * Characterization tests for the shared HMAC helper (issue #269, cluster C5).
 *
 * `src/crypto-hmac.ts` unifies the HMAC key-import + sign/verify that
 * `src/mcp-jwt.ts` and `src/mcp-oauth-server.ts` each hand-rolled. These
 * tests pin the contract: standard HMAC-SHA256 (RFC 4231 vector),
 * sign->verify round trips, tamper/wrong-key rejection, never-throw verify,
 * and the constant-time compare discipline.
 */
import { describe, expect, it } from "vitest";
import { importHmacKey, signHmac, timingSafeEqual, verifyHmac } from "../src/crypto-hmac";

const te = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("crypto-hmac (269 C5)", () => {
  it("produces the RFC 4231 HMAC-SHA256 test vector (case 1)", async () => {
    // key = 0x0b * 20, data = "Hi There"
    const key = await importHmacKey(new Uint8Array(20).fill(0x0b));
    const sig = await signHmac(key, te.encode("Hi There"));
    expect(hex(sig)).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("round-trips: sign then verify is true", async () => {
    const key = await importHmacKey("round-trip-key");
    const data = te.encode("the quick brown fox");
    expect(await verifyHmac(key, data, await signHmac(key, data))).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const key = await importHmacKey("round-trip-key");
    const sig = await signHmac(key, te.encode("original payload"));
    expect(await verifyHmac(key, te.encode("tampered payload"), sig)).toBe(false);
  });

  it("rejects the wrong key", async () => {
    const k1 = await importHmacKey("key-one");
    const k2 = await importHmacKey("key-two");
    const sig = await signHmac(k1, te.encode("data"));
    expect(await verifyHmac(k2, te.encode("data"), sig)).toBe(false);
  });

  it("never throws on malformed signatures", async () => {
    const key = await importHmacKey("key");
    const data = te.encode("data");
    await expect(verifyHmac(key, data, new Uint8Array(0))).resolves.toBe(false);
    await expect(verifyHmac(key, data, new Uint8Array([1, 2, 3]))).resolves.toBe(false);
    await expect(verifyHmac(key, data, new Uint8Array(64))).resolves.toBe(false);
  });

  it("string and Uint8Array key material produce identical signatures", async () => {
    const fromStr = await importHmacKey("same-material");
    const fromBytes = await importHmacKey(te.encode("same-material"));
    const data = te.encode("data");
    expect(hex(await signHmac(fromStr, data))).toBe(hex(await signHmac(fromBytes, data)));
  });

  it("oauth-server scheme round-trips (domain-separated key, b64url envelope)", async () => {
    // Mirrors src/mcp-oauth-server.ts's signing scheme exactly: the
    // "cfmail-oauth|" prefix is domain separation applied by the caller,
    // not the helper, so issued state tokens keep byte-identical signatures.
    const key = await importHmacKey("cfmail-oauth|" + "oauth-key");
    const body = b64url(te.encode(JSON.stringify({ t: "access", sc: "mcp:read" })));
    const token = body + "." + b64url(await signHmac(key, te.encode(body)));

    const cut = token.lastIndexOf(".");
    const sigBytes = fromB64url(token.slice(cut + 1));
    expect(await verifyHmac(key, te.encode(token.slice(0, cut)), sigBytes)).toBe(true);
    // Tampered body fails.
    expect(await verifyHmac(key, te.encode(token.slice(0, cut) + "x"), sigBytes)).toBe(false);
  });

  describe("timingSafeEqual", () => {
    it("equal arrays compare true", () => {
      expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    });
    it("same-length differing arrays compare false", () => {
      expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    });
    it("different lengths compare false", () => {
      expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    });
    it("empty arrays compare true", () => {
      expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    });
  });
});
