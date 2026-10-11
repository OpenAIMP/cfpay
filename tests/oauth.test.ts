/**
 * Unit tests for OAuth helpers:
 * - PKCE code_challenge validation (src/mcp-oauth-server.ts, L7)
 * - MCP_AUTH_MODE resolution (src/mcp-auth.ts)
 */
import { describe, it, expect } from "vitest";
import { isValidCodeChallenge } from "../src/mcp-oauth-server";
import { resolveMcpAuthMode } from "../src/mcp-auth";

describe("isValidCodeChallenge (RFC 7636 §4.1)", () => {
  it("accepts a 43-char S256 challenge", () => {
    expect(isValidCodeChallenge("a".repeat(43))).toBe(true);
    // RFC 7636 Appendix B example challenge (43 chars).
    expect(isValidCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(true);
  });

  it("accepts the full 43–128 range", () => {
    expect(isValidCodeChallenge("A".repeat(128))).toBe(true);
    expect(isValidCodeChallenge("9-_".repeat(43).slice(0, 100))).toBe(true);
  });

  it("rejects too-short and too-long values", () => {
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(129))).toBe(false);
    expect(isValidCodeChallenge("")).toBe(false);
  });

  it("rejects characters outside the unreserved set", () => {
    expect(isValidCodeChallenge("a".repeat(42) + "!")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(42) + "+")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(42) + " ")).toBe(false);
  });
});

describe("resolveMcpAuthMode", () => {
  it("resolves known modes case-insensitively", () => {
    expect(resolveMcpAuthMode("static")).toBe("static");
    expect(resolveMcpAuthMode("github")).toBe("github");
    expect(resolveMcpAuthMode("either")).toBe("either");
    expect(resolveMcpAuthMode("none")).toBe("none");
    expect(resolveMcpAuthMode("  STATIC  ")).toBe("static");
  });

  it("defaults to either when unset or blank", () => {
    expect(resolveMcpAuthMode(undefined)).toBe("either");
    expect(resolveMcpAuthMode("")).toBe("either");
    expect(resolveMcpAuthMode("   ")).toBe("either");
  });

  it("returns null for unrecognised values (fail closed)", () => {
    expect(resolveMcpAuthMode("bogus")).toBeNull();
    expect(resolveMcpAuthMode("oauth")).toBeNull();
  });
});
