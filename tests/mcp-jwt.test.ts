import { describe, expect, it } from "vitest";
import {
  issueToken,
  looksLikeJwt,
  requiredScopesForCall,
  verifyToken,
  TokenVerifyError,
} from "../src/mcp-jwt";

const SECRET = "<redacted>";
const ISSUER = "https://pay.openaimp.com";
const AUDIENCE = "mcp://cfpay";

async function mint(scopes: Parameters<typeof issueToken>[1]["scopes"], expiresInSec = 3600) {
  return issueToken(SECRET, {
    subject: "test-client",
    scopes,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresInSec,
  });
}

describe("scoped MCP JWTs (issue #214)", () => {
  it("round-trips: issue then verify, scopes readable", async () => {
    const { token, claims, expiresAt } = await mint(["mcp:tools:list", "mcp:tools:call"]);
    expect(looksLikeJwt(token)).toBe(true);
    expect(claims.sub).toBe("test-client");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const verified = await verifyToken(SECRET, token, { issuer: ISSUER, audience: AUDIENCE });
    expect(verified.hasScope("mcp:tools:call")).toBe(true);
    expect(verified.hasScope("mcp:tools:write")).toBe(false);
    expect(verified.hasAnyScope("mcp:tools:write", "mcp:tools:call")).toBe(true);
  });

  it("rejects a tampered payload and a wrong secret", async () => {
    const { token } = await mint(["mcp:read"]);
    const [h, , sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", iss: ISSUER, aud: AUDIENCE, exp: 9999999999, iat: 1, scope: ["mcp:tools:write"] }),
    ).toString("base64url");
    await expect(verifyToken(SECRET, `${h}.${forgedPayload}.${sig}`)).rejects.toMatchObject({
      code: "TOKEN_INVALID_SIGNATURE",
    });
    await expect(verifyToken("a-different-secret", token)).rejects.toMatchObject({
      code: "TOKEN_INVALID_SIGNATURE",
    });
  });

  it("rejects expired tokens, wrong audiences, and non-HS256 headers", async () => {
    const { token } = await mint(["mcp:read"], -120);
    await expect(verifyToken(SECRET, token)).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    const fresh = await mint(["mcp:read"]);
    await expect(verifyToken(SECRET, fresh.token, { audience: "mcp://other" })).rejects.toMatchObject({
      code: "AUDIENCE_MISMATCH",
    });
    await expect(verifyToken(SECRET, fresh.token, { issuer: "https://elsewhere.example" })).rejects.toMatchObject({
      code: "ISSUER_MISMATCH",
    });
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const [, payload, sig] = fresh.token.split(".");
    await expect(verifyToken(SECRET, `${noneHeader}.${payload}.${sig}`)).rejects.toBeInstanceOf(TokenVerifyError);
  });

  it("maps calls to required scopes: read satisfies list+call, write stands alone", () => {
    expect(requiredScopesForCall("tools/list")).toEqual(["mcp:tools:list", "mcp:tools:call", "mcp:read"]);
    expect(requiredScopesForCall("tools/call", "cfmail_recent_emails")).toEqual(["mcp:tools:call", "mcp:read"]);
    expect(requiredScopesForCall("initialize")).toBeNull();
    expect(requiredScopesForCall("resources/list")).toBeNull();
  });

  it("looksLikeJwt is a strict shape check", () => {
    expect(looksLikeJwt("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeJwt("ghp_not-a-jwt")).toBe(false);
    expect(looksLikeJwt("aaa.bbb")).toBe(false);
    expect(looksLikeJwt("aaa.b b.ccc")).toBe(false);
  });
});
