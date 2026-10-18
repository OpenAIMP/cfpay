/**
 * Unit tests for the issue-#264 fix: dashboard API routes delegate their
 * HTTP self-probe legs to QAAgent's qaHttpProbe (the Durable Object
 * context), because the plain fetch-handler context cannot self-fetch the
 * Worker's own domain in production (Cloudflare 522).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qaProbePathAllowed } from "../src/a2a-test";

describe("qaProbePathAllowed (the probe's anti-proxy allowlist)", () => {
  it("allows the QA-probed own-origin paths", () => {
    for (const p of [
      "/a2a", // the host dispatch path (A2A_SURFACE_RPC.cfmail)
      "/a2a/slack",
      "/slack/events",
      "/webhooks/github",
      "/webhooks/slack",
      "/mcp",
      "/api/dashboard/search",
      "/api/dashboard/webhooks?provider=github",
      "/api/dashboard/a2a/dispatch",
    ]) {
      expect(qaProbePathAllowed(p)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const p of [
      "",
      "/",
      "/api/public/chat",
      "/api/dashboard", // prefix without the trailing slash is not a probed path
      "/slack/events-evil",
      "/mcp/tools",
      "/webhooks",
      "https://pay.openaimp.com/a2a/slack", // absolute URLs are never paths
      "//a2a/slack",
    ]) {
      expect(qaProbePathAllowed(p)).toBe(false);
    }
  });
});

describe("wiring: HTTP probe legs originate from QAAgent, not fetch handlers", () => {
  const dispatchSrc = readFileSync("src/a2a-dispatch.ts", "utf8");
  const capSrc = readFileSync("src/qa-capability-tests.ts", "utf8");
  const qaSrc = readFileSync("src/qa-agent.ts", "utf8");

  it("the A2A dispatch route delegates to the QAAgent probe", () => {
    expect(dispatchSrc).toContain("probeViaQAAgent");
    expect(dispatchSrc).toContain("qaHttpProbe");
    expect(dispatchSrc).not.toMatch(/await fetch\(/);
  });

  it("the capability routes delegate every own-origin leg to the QAAgent probe", () => {
    expect(capSrc).toContain("probeViaQAAgent");
    // No own-origin fetches remain: the only fetch target left is Slack's
    // external API (the file test), which is out of scope for this rule.
    expect(capSrc).not.toMatch(/fetch\(`\$\{origin\}/);
    expect(capSrc).not.toMatch(/await fetch\(/);
  });

  it("QAAgent exposes the thin qaHttpProbe callable delegating to probeOwnOrigin", () => {
    expect(qaSrc).toContain("qaHttpProbe");
    expect(qaSrc).toContain("probeOwnOrigin");
  });
});
