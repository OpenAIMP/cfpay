/**
 * Public.com hosted MCP client.
 *
 * The endpoint is https://mcp.public.com/mcp. Every method, including
 * tools/list, returns 401 with a WWW-Authenticate challenge until a credential
 * is presented, so nothing is reachable unauthenticated.
 *
 * Credential: either an OAuth access token (see public-oauth.ts - the user
 * clicks "Connect Public", signs in on Public's own page, and the token set is
 * held server-side on the agent instance) or a personal access token pasted by
 * the user. Public.com publishes no RFC 7591 registration endpoint, so the
 * OAuth client identifies via a Client ID Metadata Document instead.
 *
 * Neither credential is ever returned to the browser or logged.
 */

import type { Env } from "./types";

export const PUBLIC_MCP_URL = "https://mcp.public.com/mcp";

/* -------------------------------- calls --------------------------------- */

function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // Streamable HTTP may answer as SSE; take the first JSON data frame.
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
 * on initialize and expect it echoed back.
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
    throw new Error(
      "Public.com " +
        method +
        " failed (" +
        res.status +
        ")" +
        (res.status === 401 ? ": the access token was rejected." : ": " + text.slice(0, 180)),
    );
  }
  if (!text.trim()) return null;

  const parsed = parseRpcBody(text);
  if (parsed?.error) {
    throw new Error("Public.com " + method + " error: " + JSON.stringify(parsed.error).slice(0, 200));
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

/* ------------------------------- guards --------------------------------- */

/**
 * Parse tool arguments that arrived as a JSON string. Returns {} on malformed
 * input rather than throwing: a model emitting bad arguments should surface a
 * tool error, not break the request.
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
 * negative could place a real trade. Read verbs win, so get_order_history and
 * list_orders are not treated as order-placing.
 *
 * Set PUBLIC_ALLOW_TRADING=true to bypass, which is the only way an
 * order-placing tool is ever called from this dashboard.
 */
export function isOrderPlacingTool(name: string): boolean {
  const n = name.toLowerCase();
  if (/(search|list|get|quote|price|history|research|find|screen|rank|compare|chart|lookup|info)/.test(n)) {
    return false;
  }
  return /(place|submit|create|new|cancel|replace|modify|amend|buy|sell|trade|order|exercise|close|execute)/.test(n);
}