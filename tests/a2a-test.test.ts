import { describe, expect, it } from "vitest";
import { A2A_ENDPOINTS, composeA2AEmail, testA2AEndpoint } from "../src/a2a-test";

const EP = A2A_ENDPOINTS.find((e) => e.rpc === "/a2a/qa")!;

function fakeFetch(behavior: { cardStatus?: number; unauthStatus?: number; dispatchStatus?: number; replyText?: string }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith("agent-card.json")) {
      return new Response(JSON.stringify({ name: "CFmail QA Agent" }), { status: behavior.cardStatus ?? 200 });
    }
    const authed = !!(init?.headers as Record<string, string> | undefined)?.Authorization;
    if (!authed) return new Response("unauthorized", { status: behavior.unauthStatus ?? 401 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "a2a-test",
        result: {
          kind: "message",
          parts: [{ kind: "text", text: behavior.replyText ?? "QA status." }],
        },
      }),
      { status: behavior.dispatchStatus ?? 200 },
    );
  };
}

describe("testA2AEndpoint", () => {
  it("passes a healthy surface: card, 401, snapshot reply", async () => {
    const row = await testA2AEndpoint("https://x.test", "key", EP, fakeFetch({}) as never);
    expect(row.ok).toBe(true);
    expect(row.cardName).toBe("CFmail QA Agent");
    expect(row.unauthStatus).toBe(401);
    expect(row.reply).toContain("QA status.");
  });
  it("fails the row when the unauthenticated dispatch is not refused", async () => {
    const row = await testA2AEndpoint("https://x.test", "key", EP, fakeFetch({ unauthStatus: 200 }) as never);
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/expected 401, got 200/);
  });
  it("fails the row when the dispatch returns no reply text", async () => {
    const row = await testA2AEndpoint("https://x.test", "key", EP, fakeFetch({ replyText: "" }) as never);
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/dispatch/);
  });
});

describe("composeA2AEmail", () => {
  it("summarizes pass and fail honestly", async () => {
    const good = await testA2AEndpoint("https://x.test", "key", EP, fakeFetch({}) as never);
    const bad = await testA2AEndpoint("https://x.test", "key", EP, fakeFetch({ cardStatus: 404 }) as never);
    const passMail = composeA2AEmail([good]);
    expect(passMail.allOk).toBe(true);
    expect(passMail.subject).toContain("PASS");
    const failMail = composeA2AEmail([good, bad]);
    expect(failMail.allOk).toBe(false);
    expect(failMail.subject).toContain("1/2");
    expect(failMail.body).toContain("FAIL");
  });
});
