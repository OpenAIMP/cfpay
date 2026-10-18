import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  A2A_FLEET,
  A2A_FLEET_INDEX_PATH,
  fleetCardIndex,
} from "../src/a2a";
import { A2A_ENDPOINTS } from "../src/a2a-test";

const ORIGIN = "https://pay.openaimp.com";

describe("fleet card index (issue #254)", () => {
  const index = fleetCardIndex(ORIGIN);

  it("is served at the well-known fleet path", () => {
    expect(A2A_FLEET_INDEX_PATH).toBe("/.well-known/agent-cards.json");
  });

  it("enumerates all twelve agents with unique keys and URLs", () => {
    expect(index.agents).toHaveLength(12);
    expect(new Set(index.agents.map((a) => a.agent)).size).toBe(12);
    expect(new Set(index.agents.map((a) => a.url)).size).toBe(12);
    expect(new Set(index.agents.map((a) => a.cardUrl)).size).toBe(12);
  });

  it("every entry is generated from its own card (no drift by construction)", () => {
    for (const f of A2A_FLEET) {
      const entry = index.agents.find((a) => a.agent === f.agent);
      const card = f.card(ORIGIN);
      expect(entry, f.agent).toBeDefined();
      expect(entry!.name).toBe(card.name);
      expect(entry!.description).toBe(card.description);
      expect(entry!.url).toBe(card.url);
      expect(entry!.url).toBe(ORIGIN + f.rpcPath);
      expect(entry!.cardUrl).toBe(ORIGIN + f.cardPath);
      expect(entry!.protocolVersion).toBe(card.protocolVersion);
      expect(entry!.skills).toEqual((card.skills || []).map((s) => s.id));
    }
  });

  it("covers exactly the QAAgent probe surfaces (A2A_ENDPOINTS)", () => {
    const indexRpc = index.agents.map((a) => a.url.slice(ORIGIN.length)).sort();
    const probeRpc = A2A_ENDPOINTS.map((e) => e.rpc).sort();
    expect(indexRpc).toEqual(probeRpc);
    const indexCards = index.agents.map((a) => a.cardUrl.slice(ORIGIN.length)).sort();
    const probeCards = A2A_ENDPOINTS.map((e) => e.card).sort();
    expect(indexCards).toEqual(probeCards);
  });

  it("is routed publicly in index.ts and published in the README", () => {
    const indexTs = readFileSync("src/index.ts", "utf8");
    expect(indexTs).toContain("A2A_FLEET_INDEX_PATH");
    expect(indexTs).toContain("fleetCardIndex(url.origin)");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("/.well-known/agent-cards.json");
  });
});
