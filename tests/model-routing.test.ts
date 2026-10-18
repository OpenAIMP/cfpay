import { describe, expect, it } from "vitest";
import {
  catalogueModelIds,
  chainForTask,
  isQuotaError,
  isRetryableAiError,
  runRouted,
  RoutingExhaustedError,
  MODEL_CHAINS,
  type ModelTask,
} from "../src/model-routing";

const noSleep = async () => {};

describe("model routing chains (issue #212)", () => {
  it("every chain names only models from the repo catalogue", () => {
    const catalogue = new Set(catalogueModelIds());
    expect(catalogue.size).toBeGreaterThanOrEqual(8);
    for (const [task, chain] of Object.entries(MODEL_CHAINS)) {
      expect(chain.length, task).toBeGreaterThanOrEqual(2);
      for (const id of chain) expect(catalogue.has(id), `${task}: ${id}`).toBe(true);
    }
  });

  it("chains are deduplicated and task-shaped", () => {
    for (const task of Object.keys(MODEL_CHAINS) as ModelTask[]) {
      const chain = chainForTask(task);
      expect(new Set(chain).size).toBe(chain.length);
    }
    expect(chainForTask("plan")[0]).toBe("@cf/openai/gpt-oss-120b");
    expect(chainForTask("classify")[0]).toBe("@cf/zai-org/glm-4.7-flash");
  });
});

describe("error classification - the 4006 correction", () => {
  it("4006 quota is TERMINAL even though it mentions limits", () => {
    const quota = new Error(
      "AiError: 4006: you have used up your daily free allocation of 10,000 neurons. To continue, you can upgrade to the Paid plan.",
    );
    expect(isQuotaError(quota)).toBe(true);
    expect(isRetryableAiError(quota)).toBe(false);
    expect(isRetryableAiError(new Error("daily quota exceeded"))).toBe(false);
  });

  it("3043, timeouts and capacity signals are retryable", () => {
    expect(isRetryableAiError(new Error("AiError: 3043: internal server error"))).toBe(true);
    expect(isRetryableAiError(new Error("Request timed out after 30000ms"))).toBe(true);
    expect(isRetryableAiError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableAiError(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("unknown errors are not retryable", () => {
    expect(isRetryableAiError(new Error("TypeError: cannot read properties"))).toBe(false);
    expect(isRetryableAiError(new Error("invalid prompt schema"))).toBe(false);
  });
});

describe("runRouted", () => {
  it("falls through to the next model on a transient failure", async () => {
    const tried: string[] = [];
    const out = await runRouted(
      "classify",
      async (modelId) => {
        tried.push(modelId);
        if (tried.length < 3) throw new Error("AiError: 3043: internal server error");
        return `ok via ${modelId}`;
      },
      { sleep: noSleep },
    );
    // first model: initial + 1 retry (both 3043), then the second model succeeds
    expect(out.modelUsed).toBe(chainForTask("classify")[1]);
    expect(out.result).toContain("ok via");
    expect(out.attempts).toBe(3);
    expect(out.attemptedModels).toEqual(chainForTask("classify").slice(0, 2));
  });

  it("surfaces the quota IMMEDIATELY - one attempt, no fall-through", async () => {
    let calls = 0;
    await expect(
      runRouted(
        "plan",
        async () => {
          calls++;
          throw new Error("AiError: 4006: you have used up your daily free allocation of neurons");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/4006/);
    expect(calls).toBe(1);
  });

  it("does not fall through on unknown errors", async () => {
    let calls = 0;
    await expect(
      runRouted(
        "plan",
        async () => {
          calls++;
          throw new Error("prompt validation failed");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/prompt validation failed/);
    expect(calls).toBe(1);
  });

  it("exhausts into RoutingExhaustedError naming the attempted chain", async () => {
    const err = await runRouted(
      "chat",
      async () => {
        throw new Error("AiError: 3043: internal server error");
      },
      { sleep: noSleep },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingExhaustedError);
    expect(err.attemptedModels).toEqual(chainForTask("chat"));
    expect(err.message).toContain("3043");
  });
});
