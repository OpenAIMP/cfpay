/**
 * Scoped JWTs for the MCP endpoint (issue #214; bundle 201 adapted).
 *
 * HS256 over WebCrypto - no dependencies, Workers-native. Tokens
 * are minted by the owner (POST /api/dashboard/mcp/tokens, behind
 * the dashboard key) with an explicit scope set and a short life,
 * and verified in src/mcp-auth.ts as the "jwt" credential path
 * (accepted in "either" and "jwt" modes, only when MCP_JWT_SECRET
 * is configured - set via CICD like every Worker secret).
 *
 * Why this exists alongside the built-in OAuth server: that server
 * issues a single fixed scope (mcp:read) with no picker and no
 * per-call enforcement. These tokens carry the scope set chosen at
 * issuance, and mcp-auth enforces it per JSON-RPC method: listing
 * tools needs mcp:tools:list, calling one needs mcp:tools:call
 * (mcp:read, the OAuth scope, satisfies both for today's read-only
 * tools), and write tools - when they land - will need
 * mcp:tools:write, which is deliberately NOT implied by the others.
 *
 * Deliberate omissions (from the bundle's draft, dropped on
 * review): no query-string token transport (URLs get logged), no
 * default issuer baked into the code (issuer/audience come from
 * the caller/env), no revocation list in this phase - short
 * expiries are the control.
 */

import { importHmacKey, signHmac, timingSafeEqual } from "./crypto-hmac";

export const MCP_SCOPES = [
  "mcp:tools:list",
  "mcp:tools:call",
  "mcp:tools:write",
  "mcp:read",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const SCOPE_SETS: Record<"READONLY" | "STANDARD" | "FULL", McpScope[]> = {
  READONLY: ["mcp:tools:list", "mcp:read"],
  STANDARD: ["mcp:tools:list", "mcp:tools:call", "mcp:read"],
  FULL: ["mcp:tools:list", "mcp:tools:call", "mcp:tools:write", "mcp:read"],
};

/**
 * Tools that mutate state; calling one needs mcp:tools:write.
 * Built from the MCP agent-tool table (issue #173): every spec
 * classified "write" in src/mcp-agent-tools.ts lands here, so the
 * JWT gate and the tool registry can never drift apart.
 */
import { MCP_WRITE_TOOL_NAMES } from "./mcp-agent-tools";
export const WRITE_TOOLS = new Set<string>(MCP_WRITE_TOOL_NAMES);

/**
 * The scopes a JSON-RPC call requires, as an any-of list (one is
 * enough). Null = any valid token may proceed.
 */
export function requiredScopesForCall(method: string, toolName?: string): McpScope[] | null {
  if (method === "tools/list") return ["mcp:tools:list", "mcp:tools:call", "mcp:read"];
  if (method === "tools/call") {
    if (toolName && WRITE_TOOLS.has(toolName)) return ["mcp:tools:write"];
    return ["mcp:tools:call", "mcp:read"];
  }
  return null;
}

export interface McpTokenClaims {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  scope: McpScope[];
  [key: string]: unknown;
}

export type TokenVerifyErrorCode =
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID_FORMAT"
  | "TOKEN_INVALID_SIGNATURE"
  | "TOKEN_MISSING_CLAIM"
  | "TOKEN_NOT_YET_VALID"
  | "ISSUER_MISMATCH"
  | "AUDIENCE_MISMATCH";

export class TokenVerifyError extends Error {
  code: TokenVerifyErrorCode;
  constructor(code: TokenVerifyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TokenVerifyError";
  }
}

// ----- WebCrypto helpers (Workers compatible) -----

function base64UrlEncode(buf: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof buf === "string"
      ? new TextEncoder().encode(buf)
      : buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : buf;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ----- Issue / verify -----

export interface IssueTokenOptions {
  subject: string;
  scopes: McpScope[];
  issuer: string;
  audience: string;
  expiresInSec?: number; // default 3600
  /** Issue #252 P2: which tenant the token is issued for (claim "tenant_id"). */
  tenantId?: string;
}

export async function issueToken(
  secret: string,
  opts: IssueTokenOptions,
): Promise<{ token: string; claims: McpTokenClaims; expiresAt: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + (opts.expiresInSec ?? 3600);
  const claims: McpTokenClaims = {
    sub: opts.subject,
    iss: opts.issuer,
    aud: opts.audience,
    exp: expSec,
    iat: nowSec,
    jti: crypto.randomUUID(),
    scope: opts.scopes,
  };
  // Additive only: McpTokenClaims already allows the index signature, so
  // existing tokens and verifiers are untouched when tenantId is absent.
  if (opts.tenantId) claims.tenant_id = opts.tenantId;
  const header = { alg: "HS256", typ: "JWT", kid: "mcp-v1" };
  const data = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await importHmacKey(secret);
  const sig = await signHmac(key, new TextEncoder().encode(data));
  return { token: `${data}.${base64UrlEncode(sig)}`, claims, expiresAt: new Date(expSec * 1000).toISOString() };
}

export interface VerifyResult {
  claims: McpTokenClaims;
  hasScope: (scope: McpScope) => boolean;
  hasAnyScope: (...scopes: McpScope[]) => boolean;
}

/**
 * Verify a token's signature, shape, and lifetime. Issuer/audience
 * are enforced only when the caller supplies them. Throws
 * TokenVerifyError with a named code on any failure.
 */
export async function verifyToken(
  secret: string,
  token: string,
  opts?: { issuer?: string; audience?: string; leewaySec?: number },
): Promise<VerifyResult> {
  const leeway = opts?.leewaySec ?? 60;
  if (!token || typeof token !== "string") {
    throw new TokenVerifyError("TOKEN_INVALID_FORMAT", "Token must be a non-empty string");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerifyError("TOKEN_INVALID_FORMAT", "JWT must have 3 parts");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  } catch {
    throw new TokenVerifyError("TOKEN_INVALID_FORMAT", "Invalid JWT header encoding");
  }
  if (header.alg !== "HS256") {
    throw new TokenVerifyError("TOKEN_INVALID_FORMAT", `Unsupported alg ${header.alg}, expected HS256`);
  }

  const data = `${headerB64}.${payloadB64}`;
  const key = await importHmacKey(secret);
  const expected = await signHmac(key, new TextEncoder().encode(data));
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signatureB64);
  } catch {
    // base64UrlDecode throws on malformed input; the old string comparison
    // rejected those the same way — as a signature mismatch.
    throw new TokenVerifyError("TOKEN_INVALID_SIGNATURE", "Signature mismatch");
  }
  if (!timingSafeEqual(expected, provided)) {
    throw new TokenVerifyError("TOKEN_INVALID_SIGNATURE", "Signature mismatch");
  }

  let claims: McpTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new TokenVerifyError("TOKEN_INVALID_FORMAT", "Invalid payload encoding");
  }
  if (!claims.sub || !claims.exp || !claims.iat || !Array.isArray(claims.scope)) {
    throw new TokenVerifyError("TOKEN_MISSING_CLAIM", "Missing required claims: sub, exp, iat, scope");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp + leeway < nowSec) {
    throw new TokenVerifyError("TOKEN_EXPIRED", `Token expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }
  if (claims.iat - leeway > nowSec) {
    throw new TokenVerifyError("TOKEN_NOT_YET_VALID", "Token issued in the future");
  }
  if (opts?.issuer && claims.iss !== opts.issuer) {
    throw new TokenVerifyError("ISSUER_MISMATCH", `Expected issuer ${opts.issuer}, got ${claims.iss}`);
  }
  if (opts?.audience && claims.aud !== opts.audience) {
    throw new TokenVerifyError("AUDIENCE_MISMATCH", `Expected audience ${opts.audience}, got ${claims.aud}`);
  }

  const scopeSet = new Set(claims.scope);
  return {
    claims,
    hasScope: (s) => scopeSet.has(s),
    hasAnyScope: (...scopes) => scopes.some((s) => scopeSet.has(s)),
  };
}

/** Cheap shape test so non-JWT credentials never reach the verifier. */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}
