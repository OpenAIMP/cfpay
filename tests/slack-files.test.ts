import { describe, expect, it } from "vitest";
import { postFilesToSlack } from "../src/slack-files";

const PNG_B64 = "aVBORw0KGgo="; // 8 bytes once decoded

function fakeSlackFetch(calls: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push(u.split("?")[0]);
    if (u.includes("chat.postMessage")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("files.getUploadURLExternal")) {
      return new Response(
        JSON.stringify({ ok: true, upload_url: "https://files.slack.test/upload/1", file_id: "F123" }),
        { status: 200 },
      );
    }
    if (u.includes("files.slack.test")) {
      return new Response("ok", { status: 200 });
    }
    if (u.includes("files.completeUploadExternal")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("postFilesToSlack", () => {
  it("reports unconfigured when the channel is not set", async () => {
    const res = await postFilesToSlack(
      { SLACK_BOT_TOKEN: "x" },
      "header",
      [{ filename: "a.png", contentB64: PNG_B64 }],
      (async () => new Response()) as never,
    );
    expect(res.configured).toBe(false);
    expect(res.posted).toBe(0);
  });

  it("uploads each file through the three-step flow", async () => {
    const calls: string[] = [];
    const res = await postFilesToSlack(
      { SLACK_BOT_TOKEN: "x", SLACK_QA_CHANNEL_ID: "C123" },
      "header",
      [
        { filename: "a.png", contentB64: PNG_B64 },
        { filename: "b.pdf", contentB64: PNG_B64 },
      ],
      fakeSlackFetch(calls) as never,
    );
    expect(res.configured).toBe(true);
    expect(res.posted).toBe(2);
    expect(calls.filter((c) => c.includes("getUploadURLExternal"))).toHaveLength(2);
    expect(calls.filter((c) => c.includes("completeUploadExternal"))).toHaveLength(2);
  });

  it("counts failures honestly without throwing", async () => {
    const failing = async (): Promise<Response> => new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 200 });
    const res = await postFilesToSlack(
      { SLACK_BOT_TOKEN: "x", SLACK_QA_CHANNEL_ID: "C123" },
      "header",
      [{ filename: "a.png", contentB64: PNG_B64 }],
      failing as never,
    );
    expect(res.configured).toBe(true);
    expect(res.posted).toBe(0);
    expect(res.error).toBeTruthy();
  });
});
