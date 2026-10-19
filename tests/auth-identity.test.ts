/**
 * Unit tests for the #252 P2 dashboard OAuth rewrite (src/auth.ts).
 *
 * Uses fake IdentityBackend objects — never the real IdentityAgent stub.
 * Network-touching paths (GitHub/Google code exchange) are not exercised;
 * the failure paths covered here (state mismatch, missing code, provider
 * misconfiguration) return before any network call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APP_SESSION_COOKIE,
  buildCookie,
  clearCookie,
  getCookie,
  getOAuthUserFromRequest,
  getSessionUserFromRequest,
  handleAuthCallback,
  handleAuthLogin,
  handleAuthMe,
  handleAuthLogout,
  handleGoogleAuthLogin,
  type IdentityBackend,
} from "../src/auth";
import { setAspectEventSink } from "../src/aspect-logging";

const env: any = {};

function req(url: string, cookieHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  return new Request(url, { headers });
}

function fakeBackend(overrides?: Partial<IdentityBackend>): IdentityBackend {
  return {
    loginComplete: async (provider, subject, profile) => ({
      user: { id: "user-1", primaryEmail: profile.email ?? null, createdAt: "2026-10-18T00:00:00Z", lastSeenAt: "2026-10-18T00:00:00Z" },
      created: false,
      session: { token: "opaque-session-token" },
    }),
    validateSession: async (token) =>
      token === "good-token"
        ? {
            session: { token },
            user: { id: "user-1", primaryEmail: "u@example.com", createdAt: "2026-10-18T00:00:00Z" },
          }
        : null,
    revokeSession: async () => ({ ok: true }),
    ...overrides,
  };
}

const emitted: any[] = [];
beforeEach(() => {
  emitted.length = 0;
  setAspectEventSink((e) => emitted.push(e));
});
afterEach(() => {
  setAspectEventSink(null);
});

describe("cookie helpers", () => {
  it("round-trips a value through Set-Cookie and the Cookie header", () => {
    const setCookie = buildCookie("app_session", "tok 123;=", { maxAge: 86400, secure: true });
    expect(setCookie).toContain("Max-Age=86400");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    const r = req("https://x.test/auth/me", "app_session=" + encodeURIComponent("tok 123;="));
    expect(getCookie(r, "app_session")).toBe("tok 123;=");
  });

  it("clearCookie zeroes the cookie", () => {
    expect(clearCookie("app_session", false)).toContain("Max-Age=0");
  });

  it("getCookie returns null when absent", () => {
    expect(getCookie(req("https://x.test/"), "app_session")).toBeNull();
  });

  it("APP_SESSION_COOKIE is app_session", () => {
    expect(APP_SESSION_COOKIE).toBe("app_session");
  });
});

describe("handleAuthLogin (GitHub)", () => {
  it("503s when GitHub OAuth is not configured", () => {
    const res = handleAuthLogin(req("https://x.test/auth/login"), {});
    expect(res.status).toBe(503);
  });

  it("redirects to github.com with a 10-minute state cookie", () => {
    const res = handleAuthLogin(req("https://x.test/auth/login"), { GH_CLIENT_ID: "cid" } as any);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.hostname).toBe("github.com");
    expect(location.searchParams.get("client_id")).toBe("cid");
    expect(location.searchParams.get("state")).toBeTruthy();
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("gh_oauth_state=");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Secure");
  });
});

describe("handleAuthCallback (GitHub)", () => {
  it("400s on state mismatch without touching the network", async () => {
    const r = req("https://x.test/auth/callback?code=c&state=wrong", "gh_oauth_state=expected");
    const res = await handleAuthCallback(r, env, fakeBackend());
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid OAuth state");
    // accounting event emitted
    expect(emitted.some((e) => e.operation === "authn.failure" && e.detail?.reason === "invalid_state")).toBe(true);
  });

  it("400s when the code is missing", async () => {
    const r = req("https://x.test/auth/callback?state=s", "gh_oauth_state=s");
    const res = await handleAuthCallback(r, env, fakeBackend());
    expect(res.status).toBe(400);
  });

  it("400s when the state cookie is missing", async () => {
    const r = req("https://x.test/auth/callback?code=c&state=s");
    const res = await handleAuthCallback(r, env, fakeBackend());
    expect(res.status).toBe(400);
  });

  it("400s on a provider error param", async () => {
    const r = req("https://x.test/auth/callback?error=access_denied");
    const res = await handleAuthCallback(r, env, fakeBackend());
    expect(res.status).toBe(400);
  });

  it("clears the state cookie on every failure path", async () => {
    const r = req("https://x.test/auth/callback?code=c&state=s", "gh_oauth_state=s");
    const res = await handleAuthCallback(r, env, fakeBackend());
    const headers = new Headers(res.headers);
    const setCookies = (headers as any).getSetCookie?.() ?? [headers.get("Set-Cookie")];
    expect(setCookies.some((c: string) => c.includes("gh_oauth_state=") && c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("handleGoogleAuthLogin", () => {
  it("503s when GOOGLE_CLIENT_ID is absent", () => {
    const res = handleGoogleAuthLogin(req("https://x.test/auth/google/login"), {});
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects to accounts.google.com with state cookie when configured", () => {
    const res = handleGoogleAuthLogin(req("https://x.test/auth/google/login"), {
      GOOGLE_CLIENT_ID: "google-cid",
    } as any);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.hostname).toBe("accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("google-cid");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe("https://x.test/auth/google/callback");
    expect(res.headers.get("Set-Cookie")!).toContain("go_oauth_state=");
  });
});

describe("getSessionUserFromRequest", () => {
  const backend = fakeBackend();

  it("resolves a valid session token to the session user", async () => {
    const r = req("https://x.test/", "app_session=good-token");
    const user = await getSessionUserFromRequest(r, env, backend);
    expect(user).toMatchObject({
      userId: "user-1",
      tenantId: "user-1",
      kind: "session",
      primaryEmail: "u@example.com",
    });
    expect(Array.isArray(user!.providers)).toBe(true);
  });

  it("returns null for an invalid token", async () => {
    const r = req("https://x.test/", "app_session=bad-token");
    expect(await getSessionUserFromRequest(r, env, backend)).toBeNull();
  });

  it("returns null when the cookie is missing", async () => {
    expect(await getSessionUserFromRequest(req("https://x.test/"), env, backend)).toBeNull();
  });

  it("returns null when the backend throws", async () => {
    const throwing = fakeBackend({ validateSession: async () => { throw new Error("boom"); } });
    const r = req("https://x.test/", "app_session=good-token");
    expect(await getSessionUserFromRequest(r, env, throwing)).toBeNull();
  });
});

describe("handleAuthMe", () => {
  const backend = fakeBackend();

  it("returns 200 with the user record for a valid app session", async () => {
    const r = req("https://x.test/auth/me", "app_session=good-token");
    const res = await handleAuthMe(r, env, backend);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "user-1",
      tenantId: "user-1",
      primaryEmail: "u@example.com",
    });
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it("401s and clears a stale app_session cookie for an invalid token", async () => {
    const r = req("https://x.test/auth/me", "app_session=bad-token");
    const res = await handleAuthMe(r, env, backend);
    expect(res.status).toBe(401);
    const headers = new Headers(res.headers);
    const setCookies = (headers as any).getSetCookie?.() ?? [headers.get("Set-Cookie")];
    expect(setCookies.some((c: string) => c.includes("app_session=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("401s with no session and no legacy cookie", async () => {
    const res = await handleAuthMe(req("https://x.test/auth/me"), env, backend);
    expect(res.status).toBe(401);
  });

  it("DEPRECATED legacy branch: no legacy cookie -> still 401", async () => {
    // getOAuthUserFromRequest is preserved for the legacy branch.
    expect(await getOAuthUserFromRequest(req("https://x.test/"))).toBeNull();
  });
});

describe("handleAuthLogout", () => {
  it("revokes the session, emits session.revoke, and clears cookies with 204", async () => {
    const revoked: string[] = [];
    const backend = fakeBackend({ revokeSession: async (t) => { revoked.push(t); return { ok: true }; } });
    const r = req("https://x.test/auth/logout", "app_session=good-token");
    const res = await handleAuthLogout(r, env, backend);
    expect(res.status).toBe(204);
    expect(revoked).toEqual(["good-token"]);
    expect(emitted.some((e) => e.operation === "session.revoke")).toBe(true);
    const headers = new Headers(res.headers);
    const setCookies: string[] = (headers as any).getSetCookie?.() ?? [headers.get("Set-Cookie")];
    expect(setCookies.some((c: string) => c.includes("app_session=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("204s without revoke when no session cookie is present", async () => {
    const backend = fakeBackend({ revokeSession: vi.fn() });
    const res = await handleAuthLogout(req("https://x.test/auth/logout"), env, backend);
    expect(res.status).toBe(204);
    expect(backend.revokeSession).not.toHaveBeenCalled();
  });
});

describe("legacy getOAuthUserFromRequest", () => {
  it("is exported and returns null with no legacy cookie", async () => {
    expect(await getOAuthUserFromRequest(req("https://x.test/"))).toBeNull();
  });
});
