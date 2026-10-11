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
