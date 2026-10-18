/**
 * Model routing with fallback (issue #212; bundle 205 adapted and
 * corrected for this deployment).
 *
 * Tasks route over an ordered chain of models drawn ONLY from the
 * repo's catalogue (src/models.json - the owner's catalogue; a test
 * fails if a chain names anything outside it). A call that fails
 * with a TRANSIENT provider error retries once on the same model,
 * then falls to the next in the chain.
 *
 * The correction that matters: **4006 is terminal, not retryable.**
 * It is the account-level daily neuron quota - every model on the
 * account fails identically, so a fallback chain cannot succeed and
 * must not pretend otherwise. The quota error surfaces immediately,
 * where the error catalog (issue #209) renders it as
 * AI_QUOTA_EXHAUSTED. Retryable means: 3043 (transient provider
 * error), timeouts, and capacity / rate-limit signals. Unknown
 * errors are NOT retried or fallen through - they are real bugs or
 * bad requests, and multiplying them across models only multiplies
 * latency.
 */

import modelsJson from "./models.json";

export type ModelTask = "plan" | "supervise" | "synthesize" | "chat" | "classify";

/** Ordered fallback chains per task, strongest-fit first. */
export const MODEL_CHAINS: Record<ModelTask, string[]> = {
  // Planning carries the run; start with the strongest reasoner.
  plan: [
    "@cf/openai/gpt-oss-120b",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/nvidia/nemotron-3-120b-a12b",
  ],
  // Verdicts are small JSON; a mid model leads, the strongest backs up.
  supervise: ["@cf/openai/gpt-oss-20b", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/openai/gpt-oss-120b"],
  // Summaries are prose over known content.
  synthesize: [
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/openai/gpt-oss-20b",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ],
  chat: ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-4-scout-17b-16e-instruct"],
  classify: [
    "@cf/zai-org/glm-4.7-flash",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/openai/gpt-oss-20b",
  ],
};

/** Every id the catalogue offers (for the chain-integrity test). */
export function catalogueModelIds(): string[] {
  return (modelsJson.models as { id: string }[]).map((m) => m.id);
}

export function chainForTask(task: ModelTask): string[] {
  return [...new Set(MODEL_CHAINS[task] ?? MODEL_CHAINS.chat)];
}

const QUOTA_PATTERNS = [/4006/, /neurons/, /free allocation/, /daily.*quota/, /quota exceeded/];
const RETRYABLE_PATTERNS = [
  /3043/,
  /rate limit/,
  /too many requests/,
  /\b429\b/,
  /\b503\b/,
  /capacity/,
  /overloaded/,
  /temporarily unavailable/,
  /model is busy/,
  /timeout/,
  /timed out/,
  /deadline/,
];

/**
 * Classify a model-call failure. Quota is checked FIRST and wins
 * over every retryable pattern: a quota message that also mentions
 * limits is still terminal.
 */
export function isRetryableAiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  if (QUOTA_PATTERNS.some((re) => re.test(text))) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(text));
}

/** True when the failure is the account-level neuron quota (4006 class). */
export function isQuotaError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return QUOTA_PATTERNS.some((re) => re.test(text));
}

export class RoutingExhaustedError extends Error {
  readonly task: ModelTask;
  readonly attemptedModels: string[];
  readonly lastError: unknown;

  constructor(task: ModelTask, attemptedModels: string[], lastError: unknown) {
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Model routing exhausted for ${task} (${attemptedModels.join(" -> ")}): ${last}`);
    this.name = "RoutingExhaustedError";
    this.task = task;
    this.attemptedModels = attemptedModels;
    this.lastError = lastError;
  }
}

export interface RoutedResult<T> {
  result: T;
  modelUsed: string;
  attempts: number;
  attemptedModels: string[];
}

export interface RoutingOptions {
  /** Retries per model before falling through (default 1). */
  retriesPerModel?: number;
  /** Backoff base in ms (default 250, doubling per retry). */
  backoffBaseMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `run` against the task's chain. `run` receives the model id
 * and performs the actual call. Non-retryable errors (including the
 * 4006 quota) throw immediately - no retry, no fall-through.
 */
export async function runRouted<T>(
  task: ModelTask,
  run: (modelId: string) => Promise<T>,
  options: RoutingOptions = {},
): Promise<RoutedResult<T>> {
  const chain = chainForTask(task);
  const retries = options.retriesPerModel ?? 1;
  const backoffBase = options.backoffBaseMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attemptedModels: string[] = [];
  let attempts = 0;
  let lastError: unknown;

  for (const modelId of chain) {
    attemptedModels.push(modelId);
    for (let retry = 0; retry <= retries; retry++) {
      attempts++;
      try {
        const result = await run(modelId);
        return { result, modelUsed: modelId, attempts, attemptedModels };
      } catch (err) {
        lastError = err;
        if (!isRetryableAiError(err)) throw err;
        if (retry < retries) {
          await sleep(backoffBase * 2 ** retry);
          continue;
        }
        await sleep(backoffBase);
      }
    }
  }
  throw new RoutingExhaustedError(task, attemptedModels, lastError);
}
