/**
 * Semantic memory over Cloudflare Vectorize (issue #215; bundle
 * 206 adapted).
 *
 * Agents remember finished work as embedded text -
 * `task -> outcome [entities]` - in the `cfpay-memory` Vectorize
 * index, and recall the closest matches before planning. Embeddings
 * come from Workers AI `@cf/baai/bge-small-en-v1.5` (384 dims).
 *
 * Ships DARK, like the SearchAgent did: every entry point checks
 * for the VECTORIZE binding first and reports not-configured
 * instead of throwing, so the module is safe to wire before the
 * owner creates the index in the Cloudflare dashboard (Vectorize
 * -> Create index: name `cfpay-memory`, 384 dimensions, cosine).
 * A metadata filter on agentId needs a metadata index in
 * production; recall tries the filtered query and falls back to an
 * unfiltered query + client-side filter, so it works either way.
 *
 * Dropped from the bundle draft: its compaction job. Vectorize
 * exposes no way to enumerate an index, so "summarize everything
 * older than 30 days" cannot be implemented honestly against this
 * API; retention is forget(id) plus the index's own lifecycle.
 */

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const VECTORIZE_INDEX_NAME = "cfpay-memory";
export const MEMORY_CHUNK_CHARS = 1200;
export const DEFAULT_TOP_K = 5;

export interface AgentMemoryEvent {
  agentId: string;
  task: string;
  outcome: string;
  entities?: string[];
  /** Free-form kind, e.g. "job" | "payment" | "qa" - stored as metadata. */
  type?: string;
}

export interface RecalledMemory {
  id: string;
  text: string;
  agentId?: string;
  type?: string;
  timestamp?: number;
  score: number;
}

export interface VectorMemoryEnv {
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

interface VectorizeIndexLike {
  insert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  query(
    vector: number[],
    options?: { topK?: number; returnMetadata?: boolean | "all"; filter?: Record<string, unknown> },
  ): Promise<{ matches: VectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** The rendered memory text for an event (what gets embedded and stored). */
export function memoryText(event: AgentMemoryEvent): string {
  const entities = event.entities?.length ? ` [${event.entities.join(", ")}]` : "";
  return `${event.task} -> ${event.outcome}${entities}`;
}

/** Deterministic sentence-aware chunking for long texts. */
export function chunkText(text: string, maxChars: number = MEMORY_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class VectorMemory {
  constructor(private env: VectorMemoryEnv) {}

  /** True when both the binding and the AI binding are present. */
  configured(): boolean {
    return Boolean(this.env.VECTORIZE && this.env.AI);
  }

  private index(): VectorizeIndexLike {
    return this.env.VECTORIZE as unknown as VectorizeIndexLike;
  }

  private async embed(text: string): Promise<number[]> {
    const res = (await this.env.AI!.run(EMBEDDING_MODEL as never, { text: [text] } as never)) as {
      data?: number[][];
    };
    const vector = res?.data?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Embedding model returned no vector.");
    }
    return vector;
  }

  /**
   * Remember one event. Returns { configured: false } - and does
   * nothing - when the index is not wired yet.
   */
  async remember(event: AgentMemoryEvent): Promise<{ configured: boolean; id?: string; chunks?: number }> {
    if (!this.configured()) return { configured: false };
    const text = memoryText(event);
    const chunks = chunkText(text);
    const baseId = crypto.randomUUID();
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      vectors.push({
        id: chunks.length === 1 ? baseId : `${baseId}-${i}`,
        values: await this.embed(chunks[i]),
        metadata: {
          agentId: event.agentId,
          type: event.type ?? "event",
          timestamp: Date.now(),
          text: chunks[i],
          chunk: i,
          chunks: chunks.length,
        },
      });
    }
    await this.index().insert(vectors);
    return { configured: true, id: baseId, chunks: chunks.length };
  }

  /**
   * Recall the closest memories for a query, optionally restricted
   * to one agent. Empty when unconfigured - callers degrade to
   * their non-semantic path.
   */
  async recall(
    query: string,
    options: { agentId?: string; topK?: number } = {},
  ): Promise<{ configured: boolean; memories: RecalledMemory[] }> {
    if (!this.configured()) return { configured: false, memories: [] };
    const topK = options.topK ?? DEFAULT_TOP_K;
    const vector = await this.embed(query);
    let matches: VectorizeMatch[];
    if (options.agentId) {
      try {
        const filtered = await this.index().query(vector, {
          topK,
          returnMetadata: "all",
          filter: { agentId: { $eq: options.agentId } },
        });
        matches = filtered.matches;
      } catch {
        const unfiltered = await this.index().query(vector, { topK: topK * 3, returnMetadata: "all" });
        matches = unfiltered.matches
          .filter((m) => m.metadata?.agentId === options.agentId)
          .slice(0, topK);
      }
    } else {
      const res = await this.index().query(vector, { topK, returnMetadata: "all" });
      matches = res.matches;
    }
    return {
      configured: true,
      memories: matches.map((m) => ({
        id: m.id,
        text: String(m.metadata?.text ?? ""),
        agentId: m.metadata?.agentId ? String(m.metadata.agentId) : undefined,
        type: m.metadata?.type ? String(m.metadata.type) : undefined,
        timestamp: typeof m.metadata?.timestamp === "number" ? m.metadata.timestamp : undefined,
        score: m.score,
      })),
    };
  }

  /** Forget one memory by its base id (chunked ids share the prefix). */
  async forget(id: string): Promise<{ configured: boolean }> {
    if (!this.configured()) return { configured: false };
    await this.index().deleteByIds([id]);
    return { configured: true };
  }
}

export function createVectorMemory(env: VectorMemoryEnv): VectorMemory {
  return new VectorMemory(env);
}
