/**
 * One tool-calling model turn through the shared routing policy
 * (issue #269, cluster C2).
 *
 * The chat tool loops in src/agent.ts used to hand-roll this: call the
 * default model with tools, and on ANY error fall back to a hardcoded
 * llama-3.1-8b WITHOUT tools. That fallback is now owned here:
 *
 * - The primary call runs the "chat" chain from src/models.json WITH
 *   tools (retry once per model on transient provider errors).
 * - When the chain is exhausted by transient errors, the turn degrades
 *   to a plain-text call WITHOUT tools over the same chain. The
 *   deliberate degradation (a failed tool round answers in plain text
 *   rather than with a different set of capabilities) is preserved;
 *   only the model selection moves from a hardcoded id to the
 *   catalogue chains.
 * - The account-level neuron quota (4006) is TERMINAL: it throws
 *   immediately and is never degraded around, because every model on
 *   the account fails it identically. Callers surface it through the
 *   error catalog (AI_QUOTA_EXHAUSTED) instead of burning fallback
 *   attempts.
 * - Non-retryable provider errors (bad requests, validation failures)
 *   also throw: they are the caller's bug, not a model outage, and
 *   multiplying them across models only multiplies latency.
 *
 * Prompts, parameters and response parsing are the caller's: this
 * module only owns model selection and the fallback policy.
 */

import { isQuotaError, runRouted, RoutingExhaustedError, type RoutingOptions } from "./model-routing";
import { readCompletion, type NormalisedCompletion } from "./models";

/** Minimal Workers AI surface, so tests can inject a scripted fake. */
export interface AiRunner {
  run: (model: never, input: never) => Promise<unknown>;
}

export interface RoutedToolTurn {
  completion: NormalisedCompletion;
  modelUsed: string;
  /** True when the answer came from the no-tools degradation leg. */
  degraded: boolean;
  /** Attempts on the leg that produced the answer. */
  attempts: number;
}

export async function routedToolTurn(
  ai: AiRunner,
  messages: unknown[],
  tools: unknown[],
  maxTokens: number,
  options: RoutingOptions = {},
): Promise<RoutedToolTurn> {
  const primary = await runRouted(
    "chat",
    async (modelId) => {
      const raw = await ai.run(modelId as never, {
        messages,
        tools,
        max_tokens: maxTokens,
      } as never);
      return readCompletion(raw);
    },
    options,
  ).catch((modelError: unknown) => {
    // Quota is terminal: the fallback would fail identically, so it is
    // never attempted. The caller maps this to AI_QUOTA_EXHAUSTED.
    if (isQuotaError(modelError)) throw modelError;
    // Anything the router did not exhaust on transient errors is a real
    // bug or bad request: surface it instead of degrading silently.
    if (!(modelError instanceof RoutingExhaustedError)) throw modelError;
    return null;
  });
  if (primary) {
    return {
      completion: primary.result,
      modelUsed: primary.modelUsed,
      degraded: false,
      attempts: primary.attempts,
    };
  }
  console.warn("Primary model chain exhausted mid-turn; degrading to plain text without tools.");
  const degraded = await runRouted(
    "chat",
    async (modelId) => {
      const raw = await ai.run(modelId as never, { messages } as never);
      return readCompletion(raw);
    },
    options,
  );
  return {
    completion: degraded.result,
    modelUsed: degraded.modelUsed,
    degraded: true,
    attempts: degraded.attempts,
  };
}
