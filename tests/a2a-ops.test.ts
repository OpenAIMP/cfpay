/**
 * Pinned invariants for the self-describing agent cards (issue #258).
 *
 * The operations table in src/a2a-ops.ts is the single source of truth
 * for what every A2A surface supports. These tests keep it honest:
 *  - every probed surface has operations and vice versa,
 *  - the operation set per agent equals the MCP spec's implemented
 *    operation set (aliases mapped explicitly),
 *  - every op is well-formed (summary, access class, unique names,
 *    well-formed inputs),
 *  - every card builder emits exactly its table rows,
 *  - the dashboard tester and dispatch route are wired in.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { A2A_OPS, A2A_SURFACE_RPC, type A2aSurfaceKey } from "../src/a2a-ops";
import { A2A_FLEET } from "../src/a2a";
import { A2A_ENDPOINTS } from "../src/a2a-test";
import { MCP_AGENT_TOOLS } from "../src/mcp-agent-tools";

/** Surface key for a probe entry (webhook's key is singular, its path is not). */
function endpointKey(ep: { rpc: string }): string {
  const seg = ep.rpc.replace(/^\/a2a\/?/, "");
  if (seg === "") return "cfmail";
  if (seg === "webhooks") return "webhook";
  return seg;
}

/** MCP spec operations that are A2A dispatch aliases, not separate operations. */
const OP_ALIASES: Record<string, string> = {
  "slack.notify": "slack.post",
  "slack.send": "slack.post",
};

describe("A2A operations table", () => {
  it("covers every probed surface, and every table key is probed", () => {
    const probed = new Set(A2A_ENDPOINTS.map(endpointKey));
    const tabled = new Set(Object.keys(A2A_OPS));
    for (const k of probed) expect(tabled.has(k), `surface ${k} missing from A2A_OPS`).toBe(true);
    for (const k of tabled) expect(probed.has(k), `A2A_OPS key ${k} has no probe`).toBe(true);
    for (const k of tabled) {
      expect(A2A_OPS[k as A2aSurfaceKey].length, `surface ${k}`).toBeGreaterThan(0);
    }
  });

  it("matches the fleet's surface keys", () => {
    const fleet = new Set(A2A_FLEET.map((f) => f.agent));
    const tabled = new Set(Object.keys(A2A_OPS));
    expect(tabled).toEqual(fleet);
  });

  it("operation set per agent equals the MCP spec's implemented set", () => {
    const byAgent = new Map<string, Set<string>>();
    for (const t of MCP_AGENT_TOOLS) {
      const op = OP_ALIASES[t.operation] ?? t.operation;
      if (!byAgent.has(t.agent)) byAgent.set(t.agent, new Set());
      byAgent.get(t.agent)!.add(op);
    }
    for (const [agent, ops] of byAgent) {
      const tabled = new Set((A2A_OPS as Record<string, { operation: string }[]>)[agent].map((o) => o.operation));
      expect([...tabled].sort(), `agent ${agent}`).toEqual([...ops].sort());
    }
  });

  it("access classes match the MCP spec", () => {
    const specAccess = new Map<string, string>();
    for (const t of MCP_AGENT_TOOLS) {
      const op = OP_ALIASES[t.operation] ?? t.operation;
      // Aliases share their target's access; first write wins for the set.
      if (!specAccess.has(`${t.agent}.${op}`)) specAccess.set(`${t.agent}.${op}`, t.access);
    }
    for (const key of Object.keys(A2A_OPS)) {
      for (const op of A2A_OPS[key as A2aSurfaceKey]) {
        expect(op.access, `${key}.${op.operation}`).toBe(specAccess.get(`${key}.${op.operation}`));
      }
    }
  });

  it("every op is well-formed", () => {
    const accesses = new Set(["read", "write", "action"]);
    const types = new Set(["string", "number", "boolean", "json"]);
    for (const key of Object.keys(A2A_OPS)) {
      const ops = A2A_OPS[key as A2aSurfaceKey];
      const names = ops.map((o) => o.operation);
      expect(new Set(names).size, `${key}: duplicate operation names`).toBe(names.length);
      for (const op of ops) {
        expect(op.summary?.trim().length, `${key}.${op.operation}: summary`).toBeGreaterThan(0);
        expect(accesses.has(op.access), `${key}.${op.operation}: access`).toBe(true);
        const inputNames = op.inputs.map((i) => i.name);
        expect(new Set(inputNames).size, `${key}.${op.operation}: duplicate input names`).toBe(inputNames.length);
        for (const input of op.inputs) {
          expect(types.has(input.type), `${key}.${op.operation}.${input.name}: type`).toBe(true);
          expect(typeof input.required, `${key}.${op.operation}.${input.name}: required`).toBe("boolean");
        }
      }
    }
  });
});

describe("self-describing cards", () => {
  it("every card builder emits exactly its operations table rows", () => {
    for (const f of A2A_FLEET) {
      const card = f.card("https://card.test") as unknown as { operations?: unknown };
      expect(card.operations, `${f.agent} card operations`).toEqual(
        A2A_OPS[f.agent as A2aSurfaceKey],
      );
    }
  });

  it("dispatch paths match the fleet's routed paths", () => {
    for (const f of A2A_FLEET) {
      expect(A2A_SURFACE_RPC[f.agent as A2aSurfaceKey], f.agent).toBe(f.rpcPath);
    }
  });
});

describe("tester wiring", () => {
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf-8");
  const apiTs = readFileSync(new URL("../src/api.ts", import.meta.url), "utf-8");
  const a2aDispatchTs = readFileSync(new URL("../src/a2a-dispatch.ts", import.meta.url), "utf-8");
  const a2aTestTs = readFileSync(new URL("../src/a2a-test.ts", import.meta.url), "utf-8");

  it("the dashboard loads the A2A tester script", () => {
    expect(indexHtml).toContain('<script src="/a2a-tester.js"></script>');
  });

  it("the dashboard API registers the dispatch route", () => {
    expect(apiTs).toContain('registerA2ADispatch(app, requireAuth);');
    expect(a2aDispatchTs).toContain('"/api/dashboard/a2a/dispatch"');
  });

  it("the endpoint probe asserts declared operations", () => {
    expect(a2aTestTs).toContain("no operations declared");
  });
});
