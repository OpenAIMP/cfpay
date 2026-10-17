import { describe, expect, it } from "vitest";
import { normalizeAnswer, normalizeSearch } from "../src/search-results";

const RAW_SEARCH = {
  search_query: "how are trades approved",
  chunks: [
    { id: "1", type: "text", score: 0.91, text: "Proposals wait for approval.", item: { key: "readme/trading" } },
    { id: "2", type: "text", score: 0.5, text: "Second chunk.", item: { key: "docs/flow" } },
    { id: "3", type: "text", score: 0.4, item: { key: "no-text" } },
  ],
};

describe("search result shaping", () => {
  it("normalizes search chunks, dropping textless ones", () => {
    const out = normalizeSearch(RAW_SEARCH, "how are trades approved");
    expect(out.query).toBe("how are trades approved");
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[0]).toEqual({ text: "Proposals wait for approval.", score: 0.91, source: "readme/trading" });
  });

  it("extracts the chat completion answer with its chunks", () => {
    const out = normalizeAnswer(
      { choices: [{ message: { role: "assistant", content: "They are approved in the dashboard." } }], chunks: RAW_SEARCH.chunks },
      "how are trades approved",
    );
    expect(out.answer).toBe("They are approved in the dashboard.");
    expect(out.chunks).toHaveLength(2);
  });

  it("tolerates empty and malformed responses", () => {
    expect(normalizeSearch(null, "q").chunks).toEqual([]);
    expect(normalizeAnswer({}, "q").answer).toBeUndefined();
    expect(normalizeAnswer({ choices: [] }, "q").chunks).toEqual([]);
  });
});
