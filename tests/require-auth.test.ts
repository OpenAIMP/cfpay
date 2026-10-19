/**
 * Tests for the P2 requireAuth branch logic (issue #252):
 * API-key branch unchanged, app-session branch with CSRF posture,
 * legacy cookie branch preserved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decideAuth,
  csrfCheckPasses,
  hostOfHeader,
} from "../src/require-auth";
import { APP_SESSION_COOKIE, type IdentityBackend } from "../src/auth";
import type { Env } from "../src/types";

const ENV = { DASHBOARD_API_KEY: "test-dashboard-key" } as Env;

function req(
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Request {
  return new Request(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
  });
}

function fakeBackend(userId: string | null): IdentityBackend {
  return {
    loginComplete: async () => {
      throw new Error("not used");
    },
    validateSession: async () =>
      userId
        ? {
            session: { id: "s1" },
            user: { id: userId, primaryEmail: "user@example.com" },
          }
        : null,
    revokeSession: async () => true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hostOfHeader", () => {
  it("extracts the host lowercased", () => {
    expect(hostOfHeader("https://Pay.OpenAIMP.com/x")).toBe("pay.openaimp.com");
  });
  it("returns empty for missing or unparseable values", () => {
    expect(hostOfHeader(null)).toBe("");
    expect(hostOfHeader(undefined)).toBe("");
    expect(hostOfHeader("not a url")).toBe("");
  });
});

describe("decideAuth — API key branch (unchanged)", () => {
  it("accepts the dashboard key as the operator", async () => {
    const d = await decideAuth(
      req("https://pay.openaimp.com/api/x", {
        headers: { "X-API-Key": "test-dashboard-key" },
      }),
      ENV,
    );
    expect(d).toEqual({ kind: "operator", userId: "operator", tenantId: "operator" });
  });

  it("rejects a wrong key with no session", async () => {
    const d = await decideAuth(
      req("https://pay.openaimp.com/api/x", {
        headers: { "X-API-Key": "wrong" },
      }),
      ENV,
    );
    expect(d.kind).toBe("none");
  });

  it("does not apply CSRF to the API-key path even on POST without Origin", async () => {
    const d = await decideAuth(
      req("https://pay.openaimp.com/api/x", {
        method: "POST",
        headers: { "X-API-Key": "test-dashboard-key" },
      }),
      ENV,
    );
    expect(d.kind).toBe("operator");
    expect(d.csrfFailed).toBeUndefined();
  });
});

describe("decideAuth — app session branch", () => {
  const sessionReq = (init?: { method?: string; headers?: Record<string, string> }) =>
    req("https://pay.openaimp.com/api/dashboard/identity/activity", {
      ...init,
      headers: { Cookie: `${APP_SESSION_COOKIE}=sess_abc123`, ...(init?.headers ?? {}) },
    });

  it("resolves a valid session to the user's tenant", async () => {
    const d = await decideAuth(sessionReq(), ENV, {
      sessionBackend: fakeBackend("usr_9f3a"),
    });
    expect(d.kind).toBe("session");
    expect(d.userId).toBe("usr_9f3a");
    expect(d.tenantId).toBe("usr_9f3a");
    expect(d.csrfFailed).toBeUndefined();
  });

  it("returns none for an invalid session", async () => {
    const d = await decideAuth(sessionReq(), ENV, {
      sessionBackend: fakeBackend(null),
    });
    expect(d.kind).toBe("none");
  });

  it("flags csrfFailed on a session POST with no Origin/Referer", async () => {
    const d = await decideAuth(sessionReq({ method: "POST" }), ENV, {
      sessionBackend: fakeBackend("usr_9f3a"),
    });
    expect(d.kind).toBe("session");
    expect(d.csrfFailed).toBe(true);
  });

  it("passes CSRF with a matching Origin", async () => {
    const d = await decideAuth(
      sessionReq({ method: "POST", headers: { Origin: "https://pay.openaimp.com" } }),
      ENV,
      { sessionBackend: fakeBackend("usr_9f3a") },
    );
    expect(d.csrfFailed).toBeUndefined();
  });

  it("passes CSRF with a matching Referer when Origin mismatches", async () => {
    const d = await decideAuth(
      sessionReq({
        method: "DELETE",
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://pay.openaimp.com/dash",
        },
      }),
      ENV,
      { sessionBackend: fakeBackend("usr_9f3a") },
    );
    expect(d.csrfFailed).toBeUndefined();
  });

  it("flags csrfFailed when both Origin and Referer mismatch", async () => {
    const d = await decideAuth(
      sessionReq({
        method: "POST",
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://evil.example.com/x",
        },
      }),
      ENV,
      { sessionBackend: fakeBackend("usr_9f3a") },
    );
    expect(d.csrfFailed).toBe(true);
  });
});

describe("decideAuth — legacy branch", () => {
  it("keeps the gh_access_token branch working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("api.github.com/user")) {
          return {
            ok: true,
            json: async () => ({ id: 42, login: "legacy-user", name: null, avatar_url: null }),
          } as Response;
        }
        throw new Error("unexpected fetch " + String(url));
      }),
    );
    const d = await decideAuth(
      req("https://pay.openaimp.com/api/x", {
        headers: { Cookie: "gh_access_token=ghp_legacy123" },
      }),
      ENV,
    );
    expect(d.kind).toBe("oauth-legacy");
    expect(d.userId).toBe("legacy:legacy-user");
  });
});

describe("csrfCheckPasses", () => {
  it("passes safe methods without headers", () => {
    expect(csrfCheckPasses(req("https://pay.openaimp.com/api/x"))).toBe(true);
  });
  it("fails mutations with no Origin/Referer", () => {
    expect(csrfCheckPasses(req("https://pay.openaimp.com/api/x", { method: "PUT" }))).toBe(false);
  });
});
