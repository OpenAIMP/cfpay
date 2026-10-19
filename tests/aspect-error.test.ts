import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ERROR_CODES,
  errorBody,
  errorStatus,
  mapUnknownError,
} from "../src/errors";
import {
  a2aErrorResponse,
  beginA2AAspect,
  classifyA2AError,
  classifyApiError,
  tagErrorCode,
  withCallableAspect,
  withWorkflowStepAspect,
} from "../src/aspect-error";
import {
  setAspectEventSink,
  type AspectEvent,
} from "../src/aspect-logging";
import { CapabilityExecutor } from "../src/a2a";
import { withTracePart } from "../src/aspect-logging";

// Issue #252 (design §2.1): the error aspect is the single classification
// path. Wire behavior is byte-identical to the per-branch code it replaces;
// a diff test pins this for every catalog code.

let captured: AspectEvent[];
beforeEach(() => {
  captured = [];
  setAspectEventSink((e) => captured.push(e));
});
afterEach(() => setAspectEventSink(null));

describe("byte-identical error bodies", () => {
  const cases: [string, unknown][] = [
    ["AiError 4006 quota", new Error("AiError: 4006 daily free allocation")],
    ["AiError 3043", new Error("AiError: 3043 internal")],
    ["timeout", new Error("request timed out after 30s")],
    ["unknown", new Error("something completely unexpected")],
    ["non-error", "plain string failure"],
    ["null", null],
  ];

  for (const [label, err] of cases) {
    it(`a2aErrorResponse matches the old inline construction (${label})`, async () => {
      const code = mapUnknownError(err);
      const legacy = new Response(JSON.stringify(errorBody(code)), {
        status: errorStatus(code),
        headers: { "Content-Type": "application/json" },
      });
      const via = a2aErrorResponse(err);
      expect(via.status).toBe(legacy.status);
      expect(await via.text()).toBe(await legacy.text());
      expect(via.headers.get("Content-Type")).toBe(
        legacy.headers.get("Content-Type"),
      );
    });
  }

  it("honors tagged codes through the classifier for every catalog code", () => {
    // tagErrorCode + classifyApiError round-trips every code: the aspect's
    // single classification path. (a2aErrorResponse itself is the
    // byte-identical legacy construction and deliberately ignores .code,
    // exactly like the per-branch code it replaces.)
    for (const code of ERROR_CODES) {
      expect(classifyApiError(tagErrorCode(new Error("x"), code))).toBe(code);
      expect(classifyA2AError(tagErrorCode(new Error("x"), code))).toBe(code);
    }
  });
});

describe("classification", () => {
  it("an Error carrying a known code keeps it (API lane)", () => {
    const err = new Error("timed out");
    (err as { code?: string }).code = "NOT_FOUND";
    expect(classifyApiError(err)).toBe("NOT_FOUND");
  });

  it("an Error carrying a known code keeps it (A2A lane)", () => {
    const err = new Error("quota exceeded badly");
    (err as { code?: string }).code = "CONFLICT";
    expect(classifyA2AError(err)).toBe("CONFLICT");
  });

  it("falls through to the lane mappers otherwise", () => {
    expect(classifyApiError(new Error("timed out"))).toBe("UPSTREAM_TIMEOUT");
    expect(classifyA2AError("unknown_operation")).toBe("BAD_REQUEST");
    expect(classifyA2AError(new Error("AiError: 4006"))).toBe("AI_QUOTA_EXHAUSTED");
  });

  it("tagErrorCode attaches the code and rethrows the same object", () => {
    const err = new Error("boom");
    const tagged = tagErrorCode(err, "CONFLICT");
    expect(tagged).toBe(err);
    expect((err as { code?: string }).code).toBe("CONFLICT");
  });
});

describe("A2A dispatch aspect", () => {
  const env = {};

  it("respond emits an ok event and stamps the header", () => {
    const aspect = beginA2AAspect(env, "corr-a", { agent: "slack" });
    const res = aspect.respond(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(res.headers.get("X-Correlation-Id")).toBe("corr-a");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agent: "slack",
      operation: "a2a.dispatch",
      correlationId: "corr-a",
      outcome: "ok",
    });
    expect(aspect.trace).toEqual({
      correlationId: "corr-a",
      tenantId: "operator",
      userId: "operator",
    });
  });

  it("fail classifies, emits the code, and returns the catalog body", async () => {
    const aspect = beginA2AAspect(env, "corr-b", { agent: "payments" });
    const res = aspect.fail(new Error("AiError: 4006 out of neurons"));
    expect(res.status).toBe(503); // AI_QUOTA_EXHAUSTED per the catalog
    expect(res.headers.get("X-Correlation-Id")).toBe("corr-b");
    const body = await res.json();
    expect(body.code).toBe("AI_QUOTA_EXHAUSTED");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      outcome: "error",
      errorCode: "AI_QUOTA_EXHAUSTED",
    });
  });

  it("is silent behind the kill flag", () => {
    const aspect = beginA2AAspect({ LOG_ASPECTS: "0" }, "corr-c", { agent: "qa" });
    aspect.respond(new Response("ok"));
    aspect.fail(new Error("x"));
    expect(captured).toHaveLength(0);
  });
});

describe("callable aspect", () => {
  const env = {};

  it("passes results through and emits ok", async () => {
    const stub = { doThing: async (x: number) => x * 2, name: "stub" };
    const wrapped = withCallableAspect(stub, { agent: "qa", env });
    expect(await wrapped.doThing(21)).toBe(42);
    expect(wrapped.name).toBe("stub");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agent: "qa",
      operation: "qa.doThing",
      outcome: "ok",
    });
  });

  it("rethrows the same error with the code attached and emits error", async () => {
    const boom = new Error("request timed out");
    const stub = {
      doThing: async () => {
        throw boom;
      },
    };
    const wrapped = withCallableAspect(stub, { agent: "qa", env });
    await expect(wrapped.doThing()).rejects.toBe(boom);
    expect((boom as { code?: string }).code).toBe("UPSTREAM_TIMEOUT");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      outcome: "error",
      errorCode: "UPSTREAM_TIMEOUT",
    });
  });
});
describe("multi-hop correlation (design §2.3)", () => {
  const bus = () => ({ publish() {}, finished() {} });

  it("one correlationId spans a two-agent in-process run; the trace never reaches the prompt", async () => {
    const seenByB: unknown[] = [];
    const capB = {
      card: () => ({}),
      handle: async (message: { parts?: unknown[] }, _ctx: unknown) => {
        seenByB.push(message.parts);
        return { text: "b-ok", data: { ok: true } };
      },
    };
    const capA = {
      card: () => ({}),
      handle: async (_message: unknown, context: { trace: { correlationId: string } }) => {
        // A dispatches to B in-process, forwarding the trace it received.
        const body = withTracePart(
          {
            params: {
              message: {
                kind: "message",
                role: "user",
                parts: [{ kind: "text", text: "do work" }],
              },
            },
          },
          {
            correlationId: context.trace.correlationId,
            tenantId: "operator",
            userId: "operator",
          },
        );
        const execB = new CapabilityExecutor(capB as never, "b", {});
        await execB.execute(
          {
            taskId: "t2",
            contextId: "c2",
            userMessage: (body as { params: { message: unknown } }).params.message,
          } as never,
          bus() as never,
        );
        return { text: "a-ok", data: { ok: true } };
      },
    };

    const execA = new CapabilityExecutor(capA as never, "a", {});
    const inbound = withTracePart(
      {
        params: {
          message: {
            kind: "message",
            role: "user",
            parts: [{ kind: "text", text: "start" }],
          },
        },
      },
      { correlationId: "corr-multi", tenantId: "operator", userId: "operator" },
    );
    await execA.execute(
      {
        taskId: "t1",
        contextId: "c1",
        userMessage: (inbound as { params: { message: unknown } }).params.message,
      } as never,
      bus() as never,
    );

    const ids = captured.map((e) => e.correlationId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(["corr-multi"]));
    expect(captured.map((e) => e.agent).sort()).toEqual(["a", "b"]);
    // The trace part was stripped before B's capability saw the message.
    expect(seenByB).toHaveLength(1);
    expect(
      (seenByB[0] as { kind: string; data?: unknown }[]).some(
        (p) => p.kind === "data" && typeof p.data === "object" && p.data !== null && "_trace" in p.data,
      ),
    ).toBe(false);
  });

  it("an execution without an inbound trace mints one", async () => {
    const cap = {
      card: () => ({}),
      handle: async () => ({ text: "ok", data: { ok: true } }),
    };
    await new CapabilityExecutor(cap as never, "solo", {}).execute(
      {
        taskId: "t",
        contextId: "c",
        userMessage: { kind: "message", parts: [{ kind: "text", text: "hi" }] },
      } as never,
      bus() as never,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("workflow step aspect", () => {
  it("records and never retries: the throw propagates", async () => {
    const boom = new Error("AiError: 4006");
    await expect(
      withWorkflowStepAspect(
        async () => {
          throw boom;
        },
        { agent: "trade-workflow", operation: "workflow.step.x", correlationId: "c", env: {} },
      ),
    ).rejects.toBe(boom);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      operation: "workflow.step.x",
      outcome: "error",
      errorCode: "AI_QUOTA_EXHAUSTED",
    });
  });

  it("emits ok on success", async () => {
    const out = await withWorkflowStepAspect(async () => 7, {
      agent: "trade-workflow",
      operation: "workflow.step.y",
      correlationId: "c",
      env: {},
    });
    expect(out).toBe(7);
    expect(captured[0].outcome).toBe("ok");
  });
});
