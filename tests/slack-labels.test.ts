import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSlackRecord } from "../src/slack-record";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("buildSlackRecord (issue #262)", () => {
  it("defaults preserve the legacy record shape", () => {
    const r = buildSlackRecord({ user: "u1", channel: "c1", text: "hello world" });
    expect(r.from).toBe("slack:u1");
    expect(r.to).toBe("slack:c1");
    expect(r.subject).toBe("hello world");
    expect(r.body).toBe("hello world");
    expect(r.direction).toBe("inbound");
    expect(r.paid).toBe(false);
    // Omitted labels are absent, never undefined keys: exact legacy shape.
    expect("via" in r).toBe(false);
    expect("mechanism" in r).toBe(false);
    expect("aiResponse" in r).toBe(false);
  });

  it("labels an outbound A2A bot post", () => {
    const r = buildSlackRecord({
      user: "bot",
      channel: "C123",
      text: "hi",
      direction: "outbound",
      via: "a2a",
      mechanism: "bot",
    });
    expect(r.direction).toBe("outbound");
    expect(r.via).toBe("a2a");
    expect(r.mechanism).toBe("bot");
    expect(r.to).toBe("slack:C123");
  });

  it("records the webhook path's unknown channel honestly, never invented", () => {
    const r = buildSlackRecord({
      user: "webhook",
      channel: "",
      text: "hi",
      direction: "outbound",
      via: "a2a",
      mechanism: "webhook",
    });
    expect(r.to).toBe("slack:");
    expect(r.mechanism).toBe("webhook");
  });

  it("labels an inbound events-API message with its AI response", () => {
    const r = buildSlackRecord({
      user: "U9",
      channel: "C9",
      text: "ping",
      aiResponse: "pong",
      direction: "inbound",
      via: "events",
    });
    expect(r.via).toBe("events");
    expect(r.aiResponse).toBe("pong");
    expect(r.direction).toBe("inbound");
    expect("mechanism" in r).toBe(false);
  });

  it("labels a dashboard notifySlack send", () => {
    const r = buildSlackRecord({
      user: "webhook",
      channel: "webhook",
      text: "test",
      direction: "outbound",
      via: "dashboard",
      mechanism: "webhook",
    });
    expect(r.via).toBe("dashboard");
    expect(r.from).toBe("slack:webhook");
  });

  it("truncates the subject to 50 chars", () => {
    const r = buildSlackRecord({ user: "u", channel: "c", text: "x".repeat(100) });
    expect(r.subject).toHaveLength(50);
    expect(r.body).toHaveLength(100);
  });
});

describe("label wiring pins (issue #262)", () => {
  it("SlackVia covers the five transports and EmailRecord carries the optional facets", () => {
    const types = src("src/types.ts");
    expect(types).toContain(
      'export type SlackVia = "events" | "webhook" | "a2a" | "socket" | "dashboard";',
    );
    expect(types).toContain('export type SlackMechanism = "bot" | "webhook";');
    expect(types).toContain("via?: SlackVia;");
    expect(types).toContain("mechanism?: SlackMechanism;");
  });

  it("recordMessage accepts optional labels and the post handler records both send paths", () => {
    const agent = src("src/slack-agent.ts");
    expect(agent).toContain("labels?: {");
    // Both slack.post send paths record through recordOutboundPost with the
    // actual mechanism; the helper stamps via "a2a" and the mechanism through.
    expect(agent).toContain('via: "a2a"');
    expect(agent).toContain("private recordOutboundPost(");
    expect(agent).toContain('this.recordOutboundPost(postText, channel, "bot")');
    expect(agent).toContain('this.recordOutboundPost(postText, "", "webhook")');
    expect(agent).toContain('user: mechanism === "bot" ? "bot" : "webhook"');
    expect(agent).toContain("this.recordLocal(");
  });

  it("slack.list passes labels through (they are not stripped by the trim)", () => {
    const agent = src("src/slack-agent.ts");
    // The trim removes only body/aiResponse; direction/via/mechanism ride in ...rest.
    expect(agent).toContain("({ body, aiResponse, ...rest })");
  });

  it("the host threads the transport into handleSlackEvent and mirrors by shared id", () => {
    const host = src("src/agent.ts");
    expect(host).toContain('async handleSlackEvent(event: SlackEvent, via: SlackVia = "events")');
    expect(host).toContain('await this.handleSlackEvent(event, "socket")');
    // The mirror lives in slack-mirror.ts (agent.ts is at the push ceiling):
    // same record object in, shared id out, so the feed merge dedups.
    expect(host).toContain("await mirrorToSlackAgent(this.env, emailRecord);");
    const mirror = src("src/slack-mirror.ts");
    expect(mirror).toContain('getAgentByName((env as any).SLACK_AGENT as any, "slack")');
    expect(mirror).toContain("id: record.id");
  });

  it("notifySlack mirrors successful sends into SlackAgent history via the API route", () => {
    const api = src("src/api.ts");
    expect(api).toContain("if (result.success) await recordNotifySlackToAgent(c.env, body.message);");
    const mirror = src("src/slack-mirror.ts");
    expect(mirror).toContain('via: "dashboard"');
    expect(mirror).toContain('mechanism: "webhook"');
    expect(mirror).toContain('await stub.recordMessage("webhook", "webhook", message');
  });

  it("the dashboard feed merges both histories and dedups by id", () => {
    const api = src("src/api.ts");
    expect(api).toContain("SlackAgent's own history");
    expect(api).toContain("sstub.listMessages(100)");
    expect(api).toContain("!seen.has(m.id)");
  });

  it("buildSlackRecord accepts an id override for mirror dedup", () => {
    const r = buildSlackRecord({ id: "fixed-1", user: "u", channel: "c", text: "t" });
    expect(r.id).toBe("fixed-1");
  });

  it("the dashboard Slack feed renders via/mechanism chips with a legacy fallback", () => {
    const html = src("public/index.html");
    expect(html).toContain("${m.via ?");
    expect(html).toContain("${m.mechanism ?");
    expect(html).toContain(">legacy</span>");
  });
});
