/**
 * Characterization tests for issue #352 (MCP/A2A spec drift, part 2).
 *
 * Three fields were advertised in the MCP spec (src/mcp-agent-tools.ts)
 * with no input in the A2A catalog (src/a2a-ops.ts). The audit found a
 * different reality per field, so each got a different resolution:
 *
 * - desk.autopilot `question`: the handler already honored it
 *   (src/desk-ops.ts resolves goal -> question -> text part); only the
 *   A2A catalog failed to advertise it. Catalog aligned up.
 * - qa.ux_audit `url`: the handler read only `spec`. It now honors `url`
 *   as a single-page shorthand (the audit target when no spec is given;
 *   added to the spec's pages otherwise), and the catalog advertises it.
 * - qa.browser_profile `profile`: there is nothing to honor - QAAgent
 *   keeps exactly ONE persistent browser profile per instance, with no
 *   name. The MCP declaration itself was the error and was corrected
 *   (field removed, with the reason recorded in src/mcp-agent-tools.ts).
 *
 * Seams: the catalogs are pure modules and are asserted behaviorally.
 * The handlers live in Think classes that cannot be imported in Vitest
 * (the `cloudflare:` protocol), so handler honoring is pinned by source
 * assertion - the repo's established seam for these classes (see
 * tests/spec-drift-335.test.ts and tests/wiring.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { A2A_OPS } from "../src/a2a-ops";
import { MCP_AGENT_TOOLS, MCP_FIELDS } from "../src/mcp-agent-tools";
import { qaAgentToolSchema } from "../src/agent-tool-schemas";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const a2aInputs = (surface: string, operation: string): string[] => {
  const op = (A2A_OPS as Record<string, { operation: string; inputs: { name: string }[] }[]>)[
    surface
  ]?.find((o) => o.operation === operation);
  if (!op) throw new Error(`no A2A op ${operation} on surface ${surface}`);
  return op.inputs.map((i) => i.name);
};

const mcpFields = (operation: string): string[] => {
  const spec = MCP_AGENT_TOOLS.find((t) => t.operation === operation);
  if (!spec) throw new Error(`no MCP spec for ${operation}`);
  return spec.fields;
};

/** Slice of `src` from `startMarker` up to (not including) `endMarker`. */
const block = (src: string, startMarker: string, endMarker: string): string => {
  const start = src.indexOf(startMarker);
  expect(start, `marker found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `end marker found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("the two published catalogs agree on the #352 fields", () => {
  it("desk.autopilot advertises question in the A2A catalog, as the MCP spec does", () => {
    expect(mcpFields("desk.autopilot")).toEqual(["goal", "question"]);
    const inputs = a2aInputs("cfmail", "desk.autopilot");
    expect(inputs).toContain("goal");
    expect(inputs).toContain("question");
  });

  it("qa.ux_audit advertises url alongside spec in both catalogs", () => {
    expect(mcpFields("qa.ux_audit")).toEqual(["url", "spec"]);
    const inputs = a2aInputs("qa", "qa.ux_audit");
    expect([...inputs].sort()).toEqual(["spec", "url"]);
  });

  it("qa.browser_profile advertises only action in both catalogs (the profile field was the drift)", () => {
    expect(mcpFields("qa.browser_profile")).toEqual(["action"]);
    expect(a2aInputs("qa", "qa.browser_profile")).toEqual(["action"]);
    // The false field definition is gone too, so no future spec can
    // re-advertise a browser profile name by referencing it.
    expect((MCP_FIELDS as Record<string, unknown>).profile).toBeUndefined();
  });

  it("the host qa tool schema describes url as the qa.ux_audit shorthand", () => {
    const url = (qaAgentToolSchema.properties as Record<string, { description?: string }>).url;
    expect(url?.description).toContain("qa.ux_audit");
  });
});

describe("handlers honor (or honestly refuse) the #352 fields", () => {
  const qaAgent = read("src/qa-agent.ts");
  const deskOps = read("src/desk-ops.ts");

  it("desk.autopilot resolves goal, then question, then the text part", () => {
    const autopilot = block(deskOps, "export async function deskAutopilot", "\n}\n");
    expect(autopilot).toContain('String(args.goal || args.question || text || "").trim()');
  });

  it("qa.ux_audit merges args.url into the effective spec instead of dropping it", () => {
    const ux = block(qaAgent, 'case "qa.ux_audit": {', 'case "qa.investigate": {');
    // url is read from the args...
    expect(ux).toContain('typeof args.url === "string" && args.url ? args.url : null');
    // ...and joins the page list (never duplicated) before validation.
    expect(ux).toContain("if (!pages.some((p) => pageUrlOf(p) === urlArg)) pages.push(urlArg);");
    expect(ux).toContain("spec = { ...(rawSpec ?? {}), pages } as UxAuditSpec;");
    // The merged spec still flows through the same http(s) page check.
    expect(ux).toContain("specPages.every((p) => /^https?:\\/\\//.test(pageUrlOf(p)))");
    expect(ux).toContain("this.qaUxAuditUrl(spec)");
  });

  it("qa.browser_profile reads action only - no profile name exists to read", () => {
    const prof = block(qaAgent, 'case "qa.browser_profile": {', "default:");
    expect(prof).toContain('typeof args.action === "string" ? args.action : "status"');
    expect(prof).not.toContain("args.profile");
    expect(prof).toContain("this.qaBrowserProfile(");
  });

  it("qaBrowserProfile manages the single stored profile row (no name parameter)", () => {
    const fn = block(qaAgent, "async qaBrowserProfile(", "  /**\n   * A2A endpoint test email");
    expect(fn).toContain("const row = this.profileRow();");
    expect(fn).not.toContain("profileName");
  });
});
