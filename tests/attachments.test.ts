import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("attachment handling", () => {
  const ea = code("src/email-agent.ts");

  it("caps files, per-file size and total size", () => {
    expect(ea, "count cap").toMatch(/MAX_ATTACHMENTS\s*=\s*\d+/);
    expect(ea, "per-file cap").toMatch(/MAX_SINGLE_ATTACHMENT_BYTES\s*=/);
    expect(ea, "total cap").toMatch(/MAX_ATTACHMENT_BYTES\s*=/);
  });

  it("validates before spending a send slot", () => {
    // Refusing after a send attempt would consume quota and return an error nobody can act on.
    const prep = ea.indexOf("const prepared = this.prepareAttachments(");
    const quota = ea.indexOf("const recent = s.sendLog.filter");
    expect(prep).toBeGreaterThan(-1);
    expect(quota).toBeGreaterThan(-1);
    expect(prep, "validation must precede the quota check").toBeLessThan(quota);
  });

  it("rejects a data: prefix rather than double-encoding", () => {
    expect(ea).toMatch(/startsWith\("data:"\)/);
    expect(ea).toContain("without a data: prefix");
  });

  it("measures bytes without decoding the whole buffer", () => {
    expect(ea, "must compute byte length from base64 length").toMatch(/content\.length \* 3\) \/ 4/);
  });

  it("sends nothing when validation fails", () => {
    expect(ea).toMatch(/if \(!prepared\.ok\) \{\s*return \{ ok: false, error: prepared\.error \}/);
  });
});

describe("chat transcript export", () => {
  const ca = code("src/chat-agent.ts");

  it("is a real outbound call, not a comment", () => {
    expect(ca).toContain("async sendTranscriptByEmail(");
    expect(ca).toMatch(/await stub\.sendThroughAgent\(/);
  });

  it("encodes bytes rather than trusting btoa on text", () => {
    // btoa throws on a non-Latin character, so a transcript with an accent or an emoji
    // would fail to send. TextEncoder plus String.fromCharCode does not.
    expect(ca).toContain("new TextEncoder()");
    expect(ca).toMatch(/String\.fromCharCode\(bytes\[i\]\)/);
  });

  it("attaches the transcript rather than pasting it into the body", () => {
    expect(ca).toMatch(/attachments: \[/);
    expect(ca).toMatch(/filename: `transcript-/);
    expect(ca).toMatch(/type: "text\/plain"/);
  });

  it("reports a refusal instead of claiming success", () => {
    expect(ca).toMatch(/if \(!result\?\.ok\) \{/);
    expect(ca).toMatch(/return \{ ok: false, error: result\?\.error/);
  });

  it("requires the sender and recipient explicitly", () => {
    expect(ca).toMatch(/needs a senderId/);
    expect(ca).toMatch(/needs a recipient/);
  });
});

describe("the chat-to-email edge cannot deadlock", () => {
  it("keeps EmailAgent a sink with no return edge", () => {
    // A deadlock needs a cycle. EmailAgent reaches the EMAIL binding and its own state,
    // and no agent binding - so nothing can await-in-a-cycle through it.
    const ea = code("src/email-agent.ts");
    for (const binding of ["CfmailAgent", "CHAT_AGENT", "PAYMENTS_AGENT", "SLACK_AGENT", "WEBHOOK_AGENT", "QA_AGENT"]) {
      expect(ea, "EmailAgent must not reference " + binding).not.toContain(binding);
    }
    const imports = [...ea.matchAll(/await import\("\.\/([\w-]+)"\)/g)].map((m) => m[1]);
    expect(imports, "the only dynamic import is its own transport").toEqual(["a2a"]);
  });
});