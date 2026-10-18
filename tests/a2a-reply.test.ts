import { describe, expect, it } from "vitest";
import {
  a2aReplyFromOutcome,
  createA2ATransport,
  handleCollecting,
  scheduledCard,
} from "../src/a2a";

// Runtime pins for the in-process A2A dispatch contract. The
// envelope/stream shapes below were verified against the real
// transport: reading outcome.result.parts directly (the old code
// in the orchestrator, the scheduler, and MCP) silently yields
// empty text and no data, because the reply Message lives one
// envelope deeper and the data part only travels as an event.

function fakeSql() {
  const rows = new Map<string, string>();
  return {
    exec(query: string, ...params: unknown[]) {
      if (query.includes("INSERT OR REPLACE INTO a2a_tasks")) {
        rows.set(String(params[0]), String(params[1]));
        return Object.assign([], { columnNames: [] });
      }
      if (query.includes("SELECT data FROM a2a_tasks")) {
        const data = rows.get(String(params[0]));
        return Object.assign(data ? [{ data }] : [], { columnNames: ["data"] });
      }
      return Object.assign([], { columnNames: [] });
    },
  };
}

function body(method: string, operation: string) {
  return {
    jsonrpc: "2.0",
    id: `test-${method}`,
    method,
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: `test-${Date.now()}`,
        parts: [{ kind: "data", data: { operation } }],
      },
    },
  };
}

describe("a2aReplyFromOutcome", () => {
  it("round-trips text AND data through message/stream + handleCollecting", async () => {
    const capability = {
      card: scheduledCard,
      handle: async () => ({ text: "three goals, one due", data: { ok: true, goals: 3 } }),
    };
    const { transport } = createA2ATransport(
      fakeSql() as never,
      "https://test.internal",
      scheduledCard("https://test.internal"),
      capability as never,
    );
    const outcome = await handleCollecting(transport, body("message/stream", "scheduled.summary"));
    expect(outcome.streamed).toBe(true);
    const reply = a2aReplyFromOutcome(outcome);
    expect(reply.text).toBe("three goals, one due");
    expect(reply.data).toEqual({ ok: true, goals: 3 });
  });

  it("reads the text from a message/send outcome (data does not survive that mode)", async () => {
    const capability = {
      card: scheduledCard,
      handle: async () => ({ text: "snapshot text", data: { ok: true } }),
    };
    const { transport } = createA2ATransport(
      fakeSql() as never,
      "https://test.internal",
      scheduledCard("https://test.internal"),
      capability as never,
    );
    const outcome = await handleCollecting(transport, body("message/send", "scheduled.summary"));
    expect(outcome.streamed).toBe(false);
    const reply = a2aReplyFromOutcome(outcome);
    expect(reply.text).toBe("snapshot text");
    expect(reply.data).toBeUndefined();
  });

  it("failure data carries the error-catalog code through the stream (issue #209)", async () => {
    const capability = {
      card: scheduledCard,
      handle: async () => ({
        text: "Unknown operation: scheduled.bogus",
        data: { ok: false, error: "unknown_operation" },
      }),
    };
    const { transport } = createA2ATransport(
      fakeSql() as never,
      "https://test.internal",
      scheduledCard("https://test.internal"),
      capability as never,
    );
    const outcome = await handleCollecting(transport, body("message/stream", "scheduled.bogus"));
    const reply = a2aReplyFromOutcome(outcome);
    expect(reply.text).toContain("Unknown operation");
    expect(reply.data).toEqual({ ok: false, error: "unknown_operation", code: "BAD_REQUEST" });
  });

  it("tolerates empty and Task-shaped outcomes without throwing", () => {
    expect(a2aReplyFromOutcome(undefined)).toEqual({ text: "", data: undefined });
    expect(a2aReplyFromOutcome({})).toEqual({ text: "", data: undefined });
    expect(
      a2aReplyFromOutcome({ result: { jsonrpc: "2.0", result: { kind: "task", id: "t1" } } }),
    ).toEqual({ text: "", data: undefined });
  });
});
