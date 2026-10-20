/**
 * Characterization tests for issue #335 (MCP/A2A spec drift).
 *
 * The MCP tool spec (src/mcp-agent-tools.ts) advertised three fields the
 * handlers silently ignored: email.send's `html`/`from`, orchestrator.jobs'
 * `limit`, and chat.send's `question`. src/mcp.ts dispatches every MCP tool
 * through the owning agent's own A2A handler with the declared fields in the
 * data part, so honoring a field in the handler fixes both surfaces at once.
 *
 * Seams: the catalogs (a2a-ops, mcp-agent-tools, agent-tool-schemas) are pure
 * modules and are asserted behaviorally. EmailAgent, OrchestratorAgent and
 * the host are Think classes that cannot be imported in Vitest (the
 * `cloudflare:` protocol), so handler honoring is pinned by source
 * assertion - the repo's established seam for these classes (see
 * tests/wiring.test.ts and tests/attachments.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { A2A_OPS } from "../src/a2a-ops";
import { MCP_AGENT_TOOLS } from "../src/mcp-agent-tools";
import { orchestratorAgentToolSchema } from "../src/agent-tool-schemas";

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

describe("the two published catalogs agree on the #335 fields", () => {
  it("email.send advertises html/from in the A2A catalog, as the MCP spec does", () => {
    expect(mcpFields("email.send")).toEqual(["to", "subject", "body", "html", "from"]);
    expect(a2aInputs("email", "email.send")).toEqual(["to", "subject", "body", "html", "from"]);
  });

  it("email.sendWithAttachments advertises html/from in both catalogs", () => {
    expect(mcpFields("email.sendWithAttachments")).toContain("html");
    expect(mcpFields("email.sendWithAttachments")).toContain("from");
    const inputs = a2aInputs("email", "email.sendWithAttachments");
    expect(inputs).toContain("html");
    expect(inputs).toContain("from");
    expect(inputs).toContain("attachments");
  });

  it("chat.send advertises question alongside message in both catalogs", () => {
    expect(mcpFields("chat.send")).toEqual(["message", "question"]);
    const inputs = a2aInputs("cfmail", "chat.send");
    expect(inputs).toContain("message");
    expect(inputs).toContain("question");
  });

  it("orchestrator.jobs advertises limit in both catalogs", () => {
    expect(mcpFields("orchestrator.jobs")).toEqual(["limit"]);
    expect(a2aInputs("orchestrator", "orchestrator.jobs")).toEqual(["limit"]);
  });

  it("the host orchestrator tool schema carries limit too", () => {
    expect(
      (orchestratorAgentToolSchema.properties as Record<string, unknown>).limit,
    ).toBeDefined();
  });
});

describe("handlers honor the advertised fields (#335)", () => {
  const emailAgent = read("src/email-agent.ts");
  const host = read("src/agent.ts");
  const orchestrator = read("src/orchestrator-agent.ts");

  it("email.send passes html/from from the operation args to the send", () => {
    const sendBlock = block(emailAgent, 'case "email.send":', 'case "email.sendWithAttachments":');
    expect(sendBlock).toContain("html: args.html !== undefined ? String(args.html) : undefined");
    expect(sendBlock).toContain("from: args.from !== undefined ? String(args.from) : undefined");
  });

  it("email.sendWithAttachments passes html/from the same way", () => {
    const attBlock = block(emailAgent, 'case "email.sendWithAttachments":', "default:");
    expect(attBlock).toContain("html: args.html !== undefined ? String(args.html) : undefined");
    expect(attBlock).toContain("from: args.from !== undefined ? String(args.from) : undefined");
    expect(attBlock).toContain("attachments: args.attachments");
  });

  it("the send itself carries html to the binding and defaults the sender", () => {
    // The end of the path: sendThroughAgent spreads html into the EMAIL send
    // only when present (absent html = the pre-#335 plain-text behavior), and
    // an absent/blank from falls back to the agent's own address.
    const send = block(emailAgent, "async sendThroughAgent", "/* -------------------------------- A2A");
    expect(send).toContain("...(input?.html ? { html: String(input.html) } : {})");
    expect(send).toContain("|| `agent@${this.env.EMAIL_DOMAIN}`");
  });

  it("the host's email tool dispatch passes html/from through as well", () => {
    const toolBlock = block(host, 'case "email.send":', "default:");
    expect(toolBlock).toContain("html: args.html !== undefined ? String(args.html) : undefined");
    expect(toolBlock).toContain("from: args.from !== undefined ? String(args.from) : undefined");
  });

  it("the host email tool schema advertises html/from", () => {
    const schema = block(host, '  email: {\n    type: "object",', 'required: ["request"]');
    expect(schema).toContain("html:");
    expect(schema).toContain("from:");
  });

  it("chat.send reads question: message, then question, then the text part", () => {
    const chatBlock = block(host, 'case "chat.send": {', 'case "desk.hunt"');
    expect(chatBlock).toContain("String(args.message || args.question || text || \"\")");
  });

  it("orchestrator.jobs honors limit with default 10 and no hardcoded call left", () => {
    const jobsBlock = block(orchestrator, 'if (op === "orchestrator.jobs") {', 'if (op && op !== "orchestrator.summary")');
    expect(jobsBlock).toContain("Number(args.limit) > 0 ? Number(args.limit) : 10");
    expect(jobsBlock).toContain("this.orchestrateJobs(limit)");
    expect(orchestrator).not.toContain("orchestrateJobs(10)");
  });

  it("orchestrateJobs keeps its [1, 50] clamp, which bounds the honored limit", () => {
    const jobs = block(orchestrator, "async orchestrateJobs", "async orchestrateJob(");
    expect(jobs).toContain("Math.min(Math.max(limit, 1), 50)");
  });
});
