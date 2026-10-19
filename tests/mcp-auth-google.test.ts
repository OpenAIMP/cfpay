import { describe, expect, it, afterEach } from "vitest";
import { resolveMcpAuthMode, authorizeMcpRequest } from "../src/mcp-auth";

// Google-credential lane for the /mcp gate (issue #252).
//
// Contract under test (implemented by the sibling lane in src/mcp-auth.ts):
//   - MCP_AUTH_MODE gains "google": only a Google-validated credential is
//     accepted; GitHub tokens, static tokens and scoped JWTs are NOT.
//   - The bearer token is validated against Google's tokeninfo endpoint.
//     A 200 with an aud is authorized; an hd mismatch against
//     MCP_GOOGLE_HOSTED_DOMAIN is refused; any transport failure fails closed.
//   - verifyGoogleToken stays module-private (like verifyGitHubToken), so this
//     file tests the lane through authorizeMcpRequest with global fetch mocked.
//
// If this file fails on `resolveMcpAuthMode("google")` or on 503s from
// authorizeMcpRequest, the google lane has not landed yet - the failures are
// the contract, not the test.

const GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function rpcRequest(method: string, bearer?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("https://pay.openaimp.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
}

const envWith = (vars: Record<string, string>) => vars as never;
const googleEnv = (extra: Record<string, string> = {}) =>
  envWith({ MCP_AUTH_MODE: "google", GOOGLE_CLIENT_ID, ...extra });

// --- fetch mock plumbing -------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace global fetch; returns the list of URLs it was called with. */
function mockFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

function tokeninfo(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- mode resolution -----------------------------------------------------

describe("resolveMcpAuthMode google", () => {
  it('resolves "google"', () => {
    expect(resolveMcpAuthMode("google")).toBe("google");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveMcpAuthMode(" Google ")).toBe("google");
    expect(resolveMcpAuthMode("GOOGLE")).toBe("google");
  });

  it("leaves the other modes untouched", () => {
    expect(resolveMcpAuthMode("either")).toBe("either");
    expect(resolveMcpAuthMode("static")).toBe("static");
    expect(resolveMcpAuthMode("github")).toBe("github");
    expect(resolveMcpAuthMode("jwt")).toBe("jwt");
    expect(resolveMcpAuthMode("none")).toBe("none");
    expect(resolveMcpAuthMode(undefined)).toBe("either");
    expect(resolveMcpAuthMode("open")).toBeNull();
  });
});

// --- google lane through authorizeMcpRequest -------------------------------

describe("authorizeMcpRequest google mode", () => {
  it("(a) tokeninfo 200 with aud authorizes the request", async () => {
    const calls = mockFetch(() =>
      tokeninfo(200, { aud: GOOGLE_CLIENT_ID, sub: "123", email: "op@x.com" }),
    );
    const res = await authorizeMcpRequest(rpcRequest("tools/list", "goog-access-token"), googleEnv());
    expect(res).toBeNull();
    expect(calls.some((u) => u.includes("googleapis.com"))).toBe(true);
  });

  it("(a2) a matching hosted domain authorizes when MCP_GOOGLE_HOSTED_DOMAIN is set", async () => {
    mockFetch(() =>
      tokeninfo(200, { aud: GOOGLE_CLIENT_ID, hd: "example.com", email: "op@example.com" }),
    );
    const res = await authorizeMcpRequest(
      rpcRequest("tools/list", "goog-access-token-2"),
      googleEnv({ MCP_GOOGLE_HOSTED_DOMAIN: "example.com" }),
    );
    expect(res).toBeNull();
  });

  it("(b) an hd mismatch against MCP_GOOGLE_HOSTED_DOMAIN is refused", async () => {
    mockFetch(() =>
      tokeninfo(200, { aud: GOOGLE_CLIENT_ID, hd: "attacker.com", email: "op@attacker.com" }),
    );
    const res = await authorizeMcpRequest(
      rpcRequest("tools/list", "goog-access-token-3"),
      googleEnv({ MCP_GOOGLE_HOSTED_DOMAIN: "example.com" }),
    );
    expect(res?.status).toBe(401);
  });

  it("(c) tokeninfo non-ok refuses the request", async () => {
    mockFetch(() => tokeninfo(401, { error: "invalid_token" }));
    const res = await authorizeMcpRequest(rpcRequest("tools/list", "bogus-token"), googleEnv());
    expect(res?.status).toBe(401);
  });

  it("(d) Google being unreachable fails closed", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    const res = await authorizeMcpRequest(rpcRequest("tools/list", "goog-access-token-4"), googleEnv());
    expect(res?.status).toBe(401);
  });

  it("(e) a GitHub-shaped token is not accepted in google mode", async () => {
    const calls = mockFetch(() => tokeninfo(401, { error: "invalid_token" }));
    const githubShaped = "ghp_" + "x".repeat(24);
    const res = await authorizeMcpRequest(rpcRequest("tools/list", githubShaped), googleEnv());
    expect(res?.status).toBe(401);
    // It went down the Google path (tokeninfo), never the GitHub /user path.
    expect(calls.some((u) => u.includes("googleapis.com"))).toBe(true);
    expect(calls.some((u) => u.includes("api.github.com"))).toBe(false);
  });

  it("refuses unauthenticated non-handshake calls in google mode", async () => {
    mockFetch(() => tokeninfo(200, { aud: GOOGLE_CLIENT_ID }));
    const res = await authorizeMcpRequest(rpcRequest("tools/list"), googleEnv());
    expect(res?.status).toBe(401);
  });
});

// --- no regression on the existing lanes -----------------------------------

describe("existing modes are unaffected", () => {
  it('(f) mode "either" still accepts a valid static token', async () => {
    const env = envWith({ MCP_AUTH_MODE: "either", MCP_AUTH_TOKEN: "static-secret" });
    const res = await authorizeMcpRequest(rpcRequest("tools/list", "static-secret"), env);
    expect(res).toBeNull();
  });
});
