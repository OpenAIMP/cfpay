// Shaping for AI Search responses (issue #170), kept pure and
// SDK-free so vitest can cover it. The binding's responses are
// typed (AiSearchSearchResponse / AiSearchChatCompletionsResponse),
// but the agent normalizes them into one small shape for the
// dashboard, A2A callers, and host dispatch: a query echo, the
// answer when the call generated one, and the retrieved chunks
// trimmed to what a reader needs (text, score, source key).

export interface SearchChunk {
  text: string;
  score: number;
  source: string;
}

export interface SearchOutcome {
  query: string;
  answer?: string;
  chunks: SearchChunk[];
}

function shapeChunks(raw: unknown): SearchChunk[] {
  const chunks = (raw as { chunks?: unknown[] } | null)?.chunks;
  if (!Array.isArray(chunks)) return [];
  return chunks
    .filter((c) => c && typeof (c as { text?: unknown }).text === "string")
    .map((c) => {
      const chunk = c as { text: string; score?: unknown; item?: { key?: unknown } };
      return {
        text: chunk.text,
        score: typeof chunk.score === "number" ? chunk.score : 0,
        source: typeof chunk.item?.key === "string" ? chunk.item.key : "",
      };
    });
}

/** instance.search(...) -> normalized chunks. */
export function normalizeSearch(raw: unknown, query: string): SearchOutcome {
  return { query, chunks: shapeChunks(raw) };
}

/** instance.chatCompletions(...) -> answer + the chunks it used. */
export function normalizeAnswer(raw: unknown, query: string): SearchOutcome {
  const choices = (raw as { choices?: { message?: { content?: unknown } }[] } | null)?.choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : undefined;
  return {
    query,
    answer: typeof content === "string" ? content : undefined,
    chunks: shapeChunks(raw),
  };
}
