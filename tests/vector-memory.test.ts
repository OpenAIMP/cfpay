import { describe, expect, it } from "vitest";
import { chunkText, createVectorMemory, memoryText, type VectorMemoryEnv } from "../src/vector-memory";

/** Fake Workers AI: every text embeds to the same fixed 4-d vector. */
const fakeAi = {
  run: async (_model: unknown, input: { text: string[] }) => ({
    data: input.text.map(() => [0.1, 0.2, 0.3, 0.4]),
    shape: [input.text.length, 4],
  }),
} as unknown as Ai;

/** In-memory Vectorize stand-in, with a switch to make filtered queries fail. */
function fakeIndex(opts: { failFiltered?: boolean } = {}) {
  const store = new Map<string, { values: number[]; metadata?: Record<string, unknown> }>();
  return {
    store,
    insert: async (vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) => {
      for (const v of vectors) store.set(v.id, v);
      return { count: vectors.length };
    },
    query: async (_vector: number[], options?: { topK?: number; filter?: Record<string, unknown> }) => {
      if (options?.filter && opts.failFiltered) throw new Error("metadata index missing");
      let rows = [...store.entries()].map(([id, v]) => ({ id, score: 0.9, metadata: v.metadata }));
      if (options?.filter) {
        const want = (options.filter.agentId as { $eq?: string })?.$eq;
        rows = rows.filter((r) => r.metadata?.agentId === want);
      }
      return { matches: rows.slice(0, options?.topK ?? 5) };
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) store.delete(id);
      return { count: ids.length };
    },
  };
}

describe("vector memory (issue #215)", () => {
  it("is honestly unconfigured without the binding - and does nothing", async () => {
    const memory = createVectorMemory({ AI: fakeAi } as VectorMemoryEnv);
    expect(memory.configured()).toBe(false);
    expect(await memory.remember({ agentId: "orchestrator", task: "t", outcome: "o" })).toEqual({
      configured: false,
    });
    expect(await memory.recall("anything")).toEqual({ configured: false, memories: [] });
  });

  it("renders the memory text the bundle specified", () => {
    expect(memoryText({ agentId: "qa", task: "check the dashboard", outcome: "2 findings" })).toBe(
      "check the dashboard -> 2 findings",
    );
    expect(
      memoryText({ agentId: "qa", task: "pay invoice", outcome: "sent", entities: ["stripe", "inv-9"] }),
    ).toBe("pay invoice -> sent [stripe, inv-9]");
  });

  it("remembers and recalls with metadata, filtered by agent", async () => {
    const index = fakeIndex();
    const memory = createVectorMemory({ AI: fakeAi, VECTORIZE: index as never } as VectorMemoryEnv);
    expect(memory.configured()).toBe(true);
    const saved = await memory.remember({
      agentId: "orchestrator",
      type: "job",
      task: "Summarize the state of qa, search, and slack",
      outcome: "done: all three reported",
    });
    expect(saved.configured).toBe(true);
    expect(saved.chunks).toBe(1);
    await memory.remember({ agentId: "qa", task: "audit", outcome: "clean" });

    const all = await memory.recall("state of the agents");
    expect(all.memories.length).toBe(2);
    const onlyOrch = await memory.recall("state", { agentId: "orchestrator" });
    expect(onlyOrch.memories.length).toBe(1);
    expect(onlyOrch.memories[0].text).toContain("Summarize the state");
    expect(onlyOrch.memories[0].type).toBe("job");
  });

  it("falls back to unfiltered + client-side filter when the metadata index is missing", async () => {
    const index = fakeIndex({ failFiltered: true });
    const memory = createVectorMemory({ AI: fakeAi, VECTORIZE: index as never } as VectorMemoryEnv);
    await memory.remember({ agentId: "orchestrator", task: "goal a", outcome: "done" });
    await memory.remember({ agentId: "qa", task: "goal b", outcome: "done" });
    const res = await memory.recall("goal", { agentId: "orchestrator" });
    expect(res.memories.length).toBe(1);
    expect(res.memories[0].agentId).toBe("orchestrator");
  });

  it("chunks long texts deterministically and forgets by id", async () => {
    const long = "Sentence one is here. ".repeat(120).trim();
    const chunks = chunkText(long, 200);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 201)).toBe(true);
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("   ")).toEqual([]);

    const index = fakeIndex();
    const memory = createVectorMemory({ AI: fakeAi, VECTORIZE: index as never } as VectorMemoryEnv);
    const saved = await memory.remember({ agentId: "orchestrator", task: long, outcome: "done" });
    expect(saved.chunks).toBe(chunkText(memoryText({ agentId: "orchestrator", task: long, outcome: "done" })).length);
    await memory.forget(saved.id!);
    expect(index.store.has(saved.id!)).toBe(false);
  });
});
