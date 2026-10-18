import { describe, expect, it } from "vitest";
import { authorizeMcpRequest } from "../src/mcp-auth";

// The gate in front of /mcp. Requests are fabricated; env is the
// bare minimum authorizeMcpRequest reads. The production finding
// behind the "none" cases: /mcp answered unauthenticated calls
// (mode comes from a CICD secret), which was tolerable while every
// tool was read-only and is not since issue #173 added write tools.

function rpcRequest(method: string, toolName?: string): Request {
  return new Request("https://pay.openaimp.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: toolName ? { name: toolName, arguments: {} } : {},
    }),
  });
}

const envWith = (vars: Record<string, string>) => vars as never;

describe("authorizeMcpRequest", () => {
  it('mode "none" serves reads and lists, but refuses write tool calls', async () => {
    const env = envWith({ MCP_AUTH_MODE: "none" });
    expect(await authorizeMcpRequest(rpcRequest("tools/list"), env)).toBeNull();
    expect(await authorizeMcpRequest(rpcRequest("tools/call", "cfpay_scheduled_summary"), env)).toBeNull();
    expect(await authorizeMcpRequest(rpcRequest("tools/call", "cfmail_recent_emails"), env)).toBeNull();
    const write = await authorizeMcpRequest(rpcRequest("tools/call", "cfpay_scheduled_delete"), env);
    expect(write?.status).toBe(401);
    const write2 = await authorizeMcpRequest(rpcRequest("tools/call", "cfpay_email_send"), env);
    expect(write2?.status).toBe(401);
  });

  it("fails closed when auth is on but no credential is configured", async () => {
    const res = await authorizeMcpRequest(rpcRequest("tools/list"), envWith({}));
    expect(res?.status).toBe(503);
  });

  it("refuses an unrecognised mode rather than downgrading", async () => {
    const res = await authorizeMcpRequest(rpcRequest("tools/list"), envWith({ MCP_AUTH_MODE: "open" }));
    expect(res?.status).toBe(503);
  });

  it("refuses unauthenticated non-handshake calls when a static token is configured", async () => {
    const env = envWith({ MCP_AUTH_MODE: "static", MCP_AUTH_TOKEN: "test-token" });
    const res = await authorizeMcpRequest(rpcRequest("tools/call", "cfpay_scheduled_summary"), env);
    expect(res?.status).toBe(401);
  });

  it("admits the handshake without a credential, but not tools/list", async () => {
    const env = envWith({ MCP_AUTH_MODE: "static", MCP_AUTH_TOKEN: "test-token" });
    const init = new Request("https://pay.openaimp.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(await authorizeMcpRequest(init, env)).toBeNull();
    const list = await authorizeMcpRequest(rpcRequest("tools/list"), env);
    expect(list?.status).toBe(401);
  });
});
