/**
 * Model catalogue and tool-call normalisation.
 *
 * Two separate concerns that both belong to "talking to the model correctly":
 *
 *   1. Which model to use. The catalogue lives in models.json so it can be
 *      changed without touching code. Selection order is: the user's stored
 *      choice, then defaultModel, then the first entry.
 *
 *   2. Normalising tool calls. This is the bug that made the tools look broken.
 *      Workers AI models answer tool calls in one of two shapes:
 *
 *        legacy     {name, arguments}
 *        current    {id, type:"function", function:{name, arguments}}
 *
 *      We declared the result as `any`, so the legacy shape compiled and ran.
 *      Reading `.id` gave "", and echoing the raw array back as `tool_calls`
 *      produced:
 *
 *        AiError 8007: 6 validation errors -
 *        ChatCompletionMessageFunctionToolCallParam.id: Field required
 *        ChatCompletionMessageFunctionToolCallParam.function: Field required
 *        ChatCompletionMessageFunctionToolCallParam.type: Field required
 *
 *      So tool use failed at the point of *continuing* the conversation, not at
 *      the call itself: the first assistant turn worked, then the follow-up
 *      request was rejected. Everything is normalised to the current shape here,
 *      once, rather than being handled at each call site.
 */

import catalogue from "./models.json";

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
  functionCalling?: boolean;
}

interface Catalogue {
  defaultModel: string;
  models: ModelInfo[];
}

const CATALOGUE = catalogue as Catalogue;

export function listModels(): ModelInfo[] {
  return CATALOGUE.models;
}

/** The configured default, falling back to the first entry if it is missing. */
export function defaultModelId(): string {
  const configured = CATALOGUE.defaultModel;
  if (configured && CATALOGUE.models.some((m) => m.id === configured)) return configured;
  return CATALOGUE.models[0]?.id ?? "";
}

/**
 * Resolve a requested model id to a usable one.
 *
 * An unknown id is not an error: it falls back to the default, so a stale stored
 * choice or a hand-edited config cannot break the tab.
 */
export function resolveModelId(requested?: string | null): string {
  const wanted = (requested ?? "").trim();
  if (wanted && CATALOGUE.models.some((m) => m.id === wanted)) return wanted;
  return defaultModelId();
}

/**
 * The context window configured for a model, or null when the catalogue does
 * not say. Callers sizing a request against a model need this: the Public.com
 * tool definitions alone measure ~22k tokens, which a 24k-context model
 * cannot hold alongside the question, the tool results and an answer.
 */
export function contextWindowFor(modelId: string): number | null {
  const info = CATALOGUE.models.find((m) => m.id === modelId);
  return typeof info?.contextWindow === "number" ? info.contextWindow : null;
}

/* ------------------------------- pricing -------------------------------- */

/**
 * What one question cost, from the token usage the model reports.
 *
 * Rates live in models.json per million tokens, so this is computed from the
 * configured prices rather than assumed. A model with no configured price
 * returns nulls for the cost fields rather than a misleading zero.
 */
export interface UsageCost {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
}

export function computeCost(modelId: string, usage: unknown): UsageCost | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as any;
  const promptTokens = Number(u.prompt_tokens ?? 0);
  const completionTokens = Number(u.completion_tokens ?? 0);
  const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;

  const info = CATALOGUE.models.find((m) => m.id === modelId);
  const inRate = typeof info?.inputPerMTok === "number" ? info.inputPerMTok : null;
  const outRate = typeof info?.outputPerMTok === "number" ? info.outputPerMTok : null;

  const inputCost = inRate === null ? null : (promptTokens / 1e6) * inRate;
  const outputCost = outRate === null ? null : (completionTokens / 1e6) * outRate;
  const totalCost =
    inputCost === null || outputCost === null ? null : inputCost + outputCost;

  return { promptTokens, completionTokens, totalTokens, inputCost, outputCost, totalCost };
}

/* ------------------------- response envelopes ---------------------------- */

/**
 * Workers AI returns one of two envelopes, and which one depends on the model.
 *
 *   legacy      { response, tool_calls, usage }          llama-3.3-70b
 *   chat        { choices[0].message{content, tool_calls}, usage }
 *                                                        gpt-oss, glm, most newer
 *
 * This was the cause of a silent regression: the code read .response and
 * .tool_calls at the top level, which only the older models populate. Switching
 * the default to gpt-oss-120b produced undefined for both, so no tools were
 * called and the answer came back empty - with no error, because reading a
 * missing property is not an error.
 *
 * Normalising here means the caller never has to know which model answered.
 */
export interface NormalisedCompletion {
  text: string;
  toolCalls: unknown;
  usage: unknown;
  finishReason: string;
  /** Which envelope the model used, so a bare reply can be told from an empty one. */
  envelope: "legacy" | "chat" | "unknown";
}

export function readCompletion(raw: any): NormalisedCompletion {
  if (!raw || typeof raw !== "object") {
    return { text: "", toolCalls: undefined, usage: undefined, finishReason: "", envelope: "unknown" };
  }

  // Chat-completions envelope. Keyed on the presence of choices, not on the
  // absence of response, because llama-3.3-70b returns both and the legacy fields
  // are the populated ones there.
  if (Array.isArray(raw.choices) && raw.choices.length > 0) {
    const choice = raw.choices[0] ?? {};
    const message = choice.message ?? {};
    const text = typeof message.content === "string" ? message.content : "";
    if (message.tool_calls !== undefined || raw.tool_calls === undefined) {
      return {
        text,
        toolCalls: message.tool_calls,
        usage: raw.usage,
        finishReason: String(choice.finish_reason ?? ""),
        envelope: "chat",
      };
    }
  }

  return {
    text: typeof raw.response === "string" ? raw.response : "",
    toolCalls: raw.tool_calls,
    usage: raw.usage,
    finishReason: "",
    envelope: "legacy",
  };
}

/* --------------------------- tool-call shapes ---------------------------- */

/** A tool call in the shape the chat-completions API requires. */
export interface NormalisedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Coerce whatever the model returned into the required shape.
 *
 * Accepts the legacy {name, arguments}, the current
 * {id, type, function:{name, arguments}}, and anything with a nested
 * `function` for robustness. Arguments are always emitted as a string, since
 * that is what the API expects; a non-string is JSON-encoded.
 */
export function normaliseToolCalls(raw: unknown): NormalisedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalisedToolCall[] = [];

  raw.forEach((call: any, index: number) => {
    if (!call || typeof call !== "object") return;

    const fn = call.function && typeof call.function === "object" ? call.function : undefined;
    const name = String(fn?.name ?? call.name ?? "").trim();
    if (!name) return;

    const rawArgs = fn?.arguments ?? call.arguments ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});

    out.push({
      // Some models omit the id entirely. Synthesising one keeps the follow-up
      // request valid, and the tool message below echoes the same value, so the
      // pairing still lines up.
      id: String(call.id ?? `call_${index}_${name}`),
      type: "function",
      function: { name, arguments: args },
    });
  });

  return out;
}
