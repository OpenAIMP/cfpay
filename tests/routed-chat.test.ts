/**
 * Characterization of the cluster-C2 contract (issue #269): the chat
 * tool-turn's primary-with-tools -> degrade-without-tools policy, as
 * implemented by routedToolTurn in src/routed-chat.ts.
 *
 * The KEY behavior changes these tests pin (vs the old hand-rolled
 * fallback in src/agent.ts):
 *  - 4006 (account-level neuron quota) is terminal: it throws
 *    immediately and the no-tools fallback is NEVER attempted, because
 *    every model fails the quota identically.
 *  - Fallback models come from the models.json "chat" chain, not from a
 *    hardcoded model id.
 *  - Non-retryable provider errors surface instead of degrading
 *    silently (the old code degraded on ANY primary error).
 */
import { describe, expect, it } from "vitest";
import { routedToolTurn, type AiRunner } from "../src/routed-chat";
import { chainForTask } from "../src/model-routing";

interface Call {
  model: string;
  input: any;
}

function scriptedAi(handler: (model: string, input: any, callIndex: number) => unknown): {
  ai: AiRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    ai: {
      run: async (model: never, input: never) => {
        const callIndex = calls.length;
        calls.push({ model: String(model), input });
        return handler(String(model), input, callIndex);
      },
    },
  };
}

const QUOTA = () =>
  new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
const TRANSIENT = () => new Error("AiError: 3043: internal server error");

const MESSAGES = [{ role: "user", content: "hi" }];
const TOOLS = [{ type: "function", function: { name: "email" } }];
const NO_SLEEP = { sleep: async () => {} };

describe("routedToolTurn (269 C2)", () => {
  it("primary succeeds first try: with tools, not degraded", async () => {
    const { ai, calls } = scriptedAi(() => ({ response: "hello" }));
    const out = await routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP);
    expect(out.completion.text).toBe("hello");
    expect(out.degraded).toBe(false);
    expect(out.modelUsed).toBe(chainForTask("chat")[0]);
    expect(out.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.tools).toBe(TOOLS);
    expect(calls[0].input.max_tokens).toBe(2048);
  });

  it("transient failure retries the same model before succeeding", async () => {
    let n = 0;
    const { ai, calls } = scriptedAi(() => {
      n++;
      if (n === 1) throw TRANSIENT();
      return { response: "recovered" };
    });
    const out = await routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP);
    expect(out.completion.text).toBe("recovered");
    expect(out.degraded).toBe(false);
    expect(out.attempts).toBe(2);
    expect(calls[0].model).toBe(calls[1].model);
  });

  it("4006 is terminal: throws immediately, fallback never attempted", async () => {
    const { ai, calls } = scriptedAi(() => {
      throw QUOTA();
    });
    await expect(routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP)).rejects.toThrow(/4006/);
    // Exactly one attempt: no retry, no chain fall-through, no fallback leg.
    expect(calls).toHaveLength(1);
  });

  it("non-retryable errors surface without degrading", async () => {
    const { ai, calls } = scriptedAi(() => {
      throw new TypeError("prompt validation failed");
    });
    await expect(routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP)).rejects.toThrow(
      /prompt validation failed/,
    );
    expect(calls).toHaveLength(1);
  });

  it("exhausted chain degrades to a no-tools call with trimmed text", async () => {
    const { ai, calls } = scriptedAi((_model, input) => {
      if (!("tools" in input)) return { response: "  plain fallback  " };
      throw TRANSIENT();
    });
    const out = await routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP);
    expect(out.degraded).toBe(true);
    // readCompletion does not trim; the caller trims, exactly as the old
    // agent.ts call site did (readCompletion(fallback).text.trim()).
    expect(out.completion.text).toBe("  plain fallback  ");
    // The degradation leg reuses the chat chain (catalogue), not a hardcoded id.
    expect(out.modelUsed).toBe(chainForTask("chat")[0]);
    const fallbackCall = calls[calls.length - 1];
    expect("tools" in fallbackCall.input).toBe(false);
    expect("max_tokens" in fallbackCall.input).toBe(false);
    expect(fallbackCall.input.messages).toBe(MESSAGES);
  });

  it("4006 inside the fallback propagates instead of looping", async () => {
    const { ai } = scriptedAi((_model, input) => {
      if (!("tools" in input)) throw QUOTA();
      throw TRANSIENT();
    });
    await expect(routedToolTurn(ai, MESSAGES, TOOLS, 2048, NO_SLEEP)).rejects.toThrow(/4006/);
  });
});
