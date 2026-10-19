/**
 * Issue #269, remainder: the four C2 exceptions migrate onto the routed
 * owner via an explicit single-model chain in RoutingOptions. These tests
 * pin the contract:
 *
 * - `chain` overrides the task's catalogue chain — the caller's model
 *   choice is a selection, never silently substituted.
 * - The retry/terminal policy applies to the explicit chain: transient
 *   errors retry on the same model, 4006 is terminal.
 * - An explicit chain naming anything outside the catalogue throws
 *   instead of silently substituting.
 * - `routedCompletion` returns the raw envelope (downstream parsing is
 *   the caller's); `budgetSynthesis` inherits the policy through it.
 */
import { describe, expect, it } from "vitest";
import {
  chainForTask,
  catalogueModelIds,
  routedCompletion,
  runRouted,
  RoutingExhaustedError,
  isQuotaError,
} from "../src/model-routing";
import { budgetSynthesis, readCompletion } from "../src/models";

const NO_SLEEP = { sleep: async () => {} };
const QUOTA = () => new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
const TRANSIENT = () => new Error("AiError: 3043: internal server error");

function scriptedRun(handler: (model: string, callIndex: number) => unknown) {
  const calls: string[] = [];
  return {
    calls,
    run: async (model: string) => {
      const i = calls.length;
      calls.push(model);
      return handler(model, i);
    },
  };
}

describe("runRouted explicit chain (269 remainder)", () => {
  const chosen = chainForTask("chat")[0];

  it("uses exactly the caller's chain, not the task chain", async () => {
    const other = chainForTask("chat")[1];
    const { calls, run } = scriptedRun(() => ({ ok: true }));
    const out = await runRouted("chat", run, { chain: [other], ...NO_SLEEP });
    expect(calls).toEqual([other]);
    expect(out.modelUsed).toBe(other);
  });

  it("retries a transient error on the SAME model with a single-model chain", async () => {
    const { calls, run } = scriptedRun((_, i) => {
      if (i === 0) throw TRANSIENT();
      return { ok: true };
    });
    const out = await runRouted("chat", run, { chain: [chosen], ...NO_SLEEP });
    expect(calls).toEqual([chosen, chosen]);
    expect(out.modelUsed).toBe(chosen);
    expect(out.attempts).toBe(2);
  });

  it("4006 is terminal on an explicit chain: one attempt, no substitution", async () => {
    const { calls, run } = scriptedRun(() => {
      throw QUOTA();
    });
    await expect(runRouted("chat", run, { chain: [chosen], ...NO_SLEEP })).rejects.toThrow();
    expect(calls).toEqual([chosen]);
    // The thrown error is the quota error itself, not a wrapped exhaustion.
    try {
      await runRouted("chat", run, { chain: [chosen], ...NO_SLEEP });
      expect.unreachable();
    } catch (err) {
      expect(isQuotaError(err)).toBe(true);
      expect(err).not.toBeInstanceOf(RoutingExhaustedError);
    }
  });

  it("throws on an explicit chain naming a model outside the catalogue", async () => {
    const { run } = scriptedRun(() => ({ ok: true }));
    await expect(
      runRouted("chat", run, { chain: ["not-a-real-model"], ...NO_SLEEP }),
    ).rejects.toThrow(/outside the catalogue/);
  });

  it("sanity: the chain-integrity helper sees the catalogue ids", () => {
    expect(catalogueModelIds()).toContain(chosen);
  });
});

describe("routedCompletion (269 remainder)", () => {
  const chosen = chainForTask("chat")[0];

  it("returns the raw envelope unchanged with the explicit chain applied", async () => {
    const envelope = { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1 } };
    const seen: string[] = [];
    const out = await routedCompletion(
      {
        run: async (model: never, input: never) => {
          seen.push(String(model));
          return envelope;
        },
      },
      [{ role: "user", content: "hi" }],
      128,
      { chain: [chosen], ...NO_SLEEP },
    );
    expect(seen).toEqual([chosen]);
    expect(out.raw).toBe(envelope);
    expect(out.modelUsed).toBe(chosen);
    // The raw envelope still parses with the caller's reader.
    expect(readCompletion(out.raw).text).toBe("hi");
  });
});

describe("budgetSynthesis via the routed owner (269 remainder)", () => {
  const chosen = chainForTask("chat")[0];
  const envelope = () => ({
    choices: [{ message: { content: "verdict: n/a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  it("retries a transient on the caller's model before synthesizing", async () => {
    const seen: string[] = [];
    const synth = await budgetSynthesis(
      {
        run: async (model: never) => {
          seen.push(String(model));
          if (seen.length === 1) throw TRANSIENT();
          return envelope();
        },
      } as never,
      chosen,
      [{ role: "user", content: "q" }],
      null,
    );
    expect(seen).toEqual([chosen, chosen]);
    expect(synth?.text).toContain("verdict");
  });

  it("4006 still resolves to null (the caller's fallback), not a throw", async () => {
    const synth = await budgetSynthesis(
      {
        run: async () => {
          throw QUOTA();
        },
      } as never,
      chosen,
      [{ role: "user", content: "q" }],
      null,
    );
    expect(synth).toBeNull();
  });

  it("does not substitute a different model for the caller's choice", async () => {
    const seen: string[] = [];
    await budgetSynthesis(
      {
        run: async (model: never) => {
          seen.push(String(model));
          return envelope();
        },
      } as never,
      chosen,
      [{ role: "user", content: "q" }],
      null,
    );
    expect(seen).toEqual([chosen]);
  });
});
