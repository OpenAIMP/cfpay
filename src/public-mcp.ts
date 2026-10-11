/**
 * Public.com MCP client.
 *
 * Public.com exposes a remote MCP server at https://mcp.public.com/mcp. It is
 * OAuth-protected: every method, including tools/list, returns 401 with
 * WWW-Authenticate pointing at its protected-resource metadata, so nothing but
 * the handshake is reachable without a token.
 *
 * Two things about their authorization server shape this file:
 *
 *   1. It advertises no registration_endpoint, so there is no Dynamic Client
 *      Registration. A client_id must be obtained from Public.com out of band
 *      and supplied as PUBLIC_CLIENT_ID.
 *   2. It supports PKCE S256 and token_endpoint_auth_method "none", so this is a
 *      public-client flow: no secret is required, and none is sent unless
 *      PUBLIC_CLIENT_SECRET is explicitly configured (their metadata also lists
 *      client_secret_basic for confidential clients).
 *
 * Discovery values were read from
 *   /.well-known/oauth-protected-resource
 *   <authorization_server>/.well-known/oauth-authorization-server
 * and are held in constants rather than fetched per request, so a request never
 * depends on a second network hop.
 */

import type { Env } from "./types";

/** Remote MCP endpoint. */
export const PUBLIC_MCP_URL = "https://mcp.public.com/mcp";

/** Protected-resource metadata for the endpoint above. */
export const PUBLIC_RESOURCE_METADATA_URL =
  "https://mcp.public.com/.well-known/oauth-protected-resource";

/** Public.com's authorization server, from authorization_servers[0]. */
export const PUBLIC_AS_BASE =
  "https://prod-api.154310543964.hellopublic.com/userapiauthservice/oauth2";

export const PUBLIC_AUTHORIZE_URL = PUBLIC_AS_BASE + "/authorize";
export const PUBLIC_TOKEN_URL = PUBLIC_AS_BASE + "/token";
export const PUBLIC_REVOKE_URL = PUBLIC_AS_BASE + "/revoke";

/**
 * Scopes requested by default.
 *
 * marketdata and trading.read are enough to research and rank instruments.
 * trading.write is deliberately NOT included: it permits placing orders, and
 * nothing in this feature needs it. Add it to PUBLIC_SCOPES only if you
 * actually intend the agent to trade.
 */
export const PUBLIC_DEFAULT_SCOPES = "marketdata trading.read";

/** True when Public.com can be used at all. Without a client_id it cannot. */
export function publicConfigured(env: Env): boolean {
  return Boolean((env as any).PUBLIC_CLIENT_ID);
}

export function publicScopes(env: Env): string {
  return ((env as any).PUBLIC_SCOPES || "").trim() || PUBLIC_DEFAULT_SCOPES;
}

export function publicRedirectUri(env: Env, origin: string): string {
  return ((env as any).PUBLIC_REDIRECT_URI || "").trim() || origin + "/api/public/callback";
}

/* ------------------------------- PKCE ---------------------------------- */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Build the URL the browser is sent to in order to authorize. */
export function buildAuthorizeUrl(
  env: Env,
  origin: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(PUBLIC_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String((env as any).PUBLIC_CLIENT_ID));
  url.searchParams.set("redirect_uri", publicRedirectUri(env, origin));
  url.searchParams.set("scope", publicScopes(env));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/* ---------------------------- token exchange ---------------------------- */

export interface PublicTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at: number;
  scope?: string;
}

function basicAuth(env: Env): Record<string, string> {
  const id = String((env as any).PUBLIC_CLIENT_ID || "");
  const secret = String((env as any).PUBLIC_CLIENT_SECRET || "");
  if (!secret) return {};
  return { Authorization: "Basic " + btoa(id + ":" + secret) };
}

function toTokens(payload: any): PublicTokens {
  if (!payload?.access_token) throw new Error("token response had no access_token");
  const ttl = Number(payload.expires_in) || 3600;
  return {
    access_token: String(payload.access_token),
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : undefined,
    expires_at: Date.now() + ttl * 1000,
    scope: payload.scope ? String(payload.scope) : undefined,
  };
}

export async function exchangeCode(
  env: Env,
  origin: string,
  code: string,
  codeVerifier: string,
): Promise<PublicTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: publicRedirectUri(env, origin),
    client_id: String((env as any).PUBLIC_CLIENT_ID),
    code_verifier: codeVerifier,
  });
  const res = await fetch(PUBLIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...basicAuth(env) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error("token exchange failed (" + res.status + "): " + text.slice(0, 200));
  return toTokens(JSON.parse(text));
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<PublicTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: String((env as any).PUBLIC_CLIENT_ID),
  });
  const res = await fetch(PUBLIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...basicAuth(env) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error("token refresh failed (" + res.status + "): " + text.slice(0, 200));
  const next = toTokens(JSON.parse(text));
  // Their refresh responses may omit a new refresh_token; keep the old one.
  if (!next.refresh_token) next.refresh_token = refreshToken;
  return next;
}

/* ------------------------------ MCP client ------------------------------ */

/** Parse either a JSON body or a Streamable-HTTP SSE body into one JSON value. */
function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      if (payload.startsWith("{")) {
        try {
          return JSON.parse(payload);
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  throw new Error("unparseable MCP response: " + trimmed.slice(0, 200));
}

export interface McpSession {
  sessionId?: string;
}

/**
 * One JSON-RPC call against Public.com's MCP endpoint.
 *
 * `sessionId` is threaded through because a Streamable-HTTP server may issue one
 * on initialize and expect it echoed back; Public.com is behind API Gateway and
 * does not appear to, but the header is harmless when it is not required.
 */
export async function mcpCall(
  accessToken: string,
  method: string,
  params: unknown,
  session: McpSession = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + accessToken,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;

  const res = await fetch(PUBLIC_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const issued = res.headers.get("mcp-session-id");
  if (issued) session.sessionId = issued;

  const text = await res.text();
  if (!res.ok) {
    throw new Error("MCP " + method + " failed (" + res.status + "): " + text.slice(0, 200));
  }
  if (!text.trim()) return null;

  const parsed = parseRpcBody(text);
  if (parsed?.error) {
    throw new Error("MCP " + method + " error: " + JSON.stringify(parsed.error).slice(0, 200));
  }
  return parsed?.result ?? null;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export async function listTools(accessToken: string, session: McpSession = {}): Promise<McpTool[]> {
  const result = await mcpCall(accessToken, "tools/list", {}, session);
  const tools = result?.tools;
  return Array.isArray(tools) ? tools : [];
}

export async function callTool(
  accessToken: string,
  name: string,
  args: unknown,
  session: McpSession = {},
): Promise<string> {
  const result = await mcpCall(accessToken, "tools/call", { name, arguments: args ?? {} }, session);
  // MCP returns content blocks; flatten the text ones for the model.
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(result ?? null).slice(0, 20000);
}

/**
 * Parse tool arguments that arrived as a JSON string. Returns {} on malformed
 * input rather than throwing: a model emitting bad arguments should surface a
 * tool error, not break the whole request.
 */
export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * True when a tool name suggests it would place or modify an order.
 *
 * Conservative by design: a false positive only refuses a read, while a false
 * negative could place a real trade. Read verbs win, so a tool named
 * get_order_history or list_orders is not treated as order-placing.
 *
 * The requested OAuth scope (trading.read) is the primary control; this is the
 * defence that does not depend on the scope having been honoured.
 */
export function isOrderPlacingTool(name: string): boolean {
  const n = name.toLowerCase();
  if (/(search|list|get|quote|price|history|research|find|screen|rank|compare|chart|lookup|info)/.test(n)) {
    return false;
  }
  return /(place|submit|create|new|cancel|replace|modify|amend|buy|sell|trade|order|exercise|close|execute)/.test(n);
}
