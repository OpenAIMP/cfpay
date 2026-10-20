import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_AGENT_TOOLS, MCP_WRITE_TOOL_NAMES, mcpToolName } from "../src/mcp-agent-tools";
import { WRITE_TOOLS } from "../src/mcp-jwt";
import { OPERATION_CATALOG } from "../src/orchestrate";

const read = (p: string) => readFileSync(p, "utf8");

describe("MCP agent tools (issue #173)", () => {
  it("names tools cfpay_<agent>_<operation>, dropping a repeated agent prefix", () => {
    expect(mcpToolName("email", "email.send")).toBe("cfpay_email_send");
    expect(mcpToolName("payments", "ledger.summary")).toBe("cfpay_payments_ledger_summary");
    expect(mcpToolName("cfmail", "chat.summary")).toBe("cfpay_cfmail_chat_summary");
    expect(mcpToolName("chat", "chat.summary")).toBe("cfpay_chat_summary");
    expect(mcpToolName("email", "email.sendWithAttachments")).toBe("cfpay_email_send_with_attachments");
    expect(mcpToolName("scheduled", "scheduled.setEnabled")).toBe("cfpay_scheduled_set_enabled");
    expect(mcpToolName("cfmail", "desk.hunt")).toBe("cfpay_cfmail_desk_hunt");
    expect(mcpToolName("cfmail", "desk.autopilot")).toBe("cfpay_cfmail_desk_autopilot");
  });

  it("has unique tool names and unique (agent, operation) pairs", () => {
    expect(new Set(MCP_AGENT_TOOLS.map((t) => t.tool)).size).toBe(MCP_AGENT_TOOLS.length);
    expect(new Set(MCP_AGENT_TOOLS.map((t) => `${t.agent}:${t.operation}`)).size).toBe(MCP_AGENT_TOOLS.length);
    expect(MCP_AGENT_TOOLS.length).toBe(63); // +2 desk ops (#242 P0), +6 autopilot (#242 P1), +1 slack.postFile (#331), +1 identity.loopMetrics (#326)
  });

  it("classifies writes; the JWT write set is built from the same table", () => {
    expect(MCP_WRITE_TOOL_NAMES).toContain("cfpay_email_send");
    expect(MCP_WRITE_TOOL_NAMES).toContain("cfpay_scheduled_delete");
    expect(MCP_WRITE_TOOL_NAMES).toContain("cfpay_orchestrator_run");
    expect(MCP_WRITE_TOOL_NAMES).not.toContain("cfpay_qa_summary");
    expect(MCP_WRITE_TOOL_NAMES).not.toContain("cfpay_qa_check"); // action class, not write
    expect([...WRITE_TOOLS].sort()).toEqual([...MCP_WRITE_TOOL_NAMES].sort());
    for (const name of MCP_WRITE_TOOL_NAMES) {
      expect(MCP_AGENT_TOOLS.find((t) => t.tool === name)?.access).toBe("write");
    }
  });

  it("classifies the desk analysis ops as action, not write (#242 P0)", () => {
    // desk.hunt / desk.autopilot run heavyweight analysis but place no orders and
    // send nothing - the qa.* precedent (action), not the write class.
    for (const op of ["desk.hunt", "desk.autopilot"]) {
      const spec = MCP_AGENT_TOOLS.find((t) => t.operation === op);
      expect(spec, `spec for ${op}`).toBeDefined();
      expect(spec?.agent).toBe("cfmail");
      expect(spec?.access).toBe("action");
    }
    expect(MCP_WRITE_TOOL_NAMES).not.toContain("cfpay_cfmail_desk_hunt");
    expect(MCP_WRITE_TOOL_NAMES).not.toContain("cfpay_cfmail_desk_autopilot");
  });

  it("COVERAGE GUARD: every A2A operation in every agent source has an MCP tool", () => {
    const covered = new Set(MCP_AGENT_TOOLS.map((t) => t.operation));
    const opPattern = /"(chat|email|ledger|payments|payment|checkout|webhook|slack|qa|voice|search|scheduled|orchestrator|desk)\.[A-Za-z_]+"/g;
    const agentFiles = [
      "src/agent.ts",
      "src/email-agent.ts",
      "src/payments-agent.ts",
      "src/webhook-agent.ts",
      "src/slack-agent.ts",
      "src/qa-agent.ts",
      "src/chat-agent.ts",
      "src/voice-agent.ts",
      "src/search-agent.ts",
      "src/orchestrator-agent.ts",
      "src/scheduled-agent.ts",
      "src/autopilot-agent.ts",
    ];
    const found = new Set<string>();
    for (const f of agentFiles) {
      for (const m of read(f).matchAll(opPattern)) found.add(m[0].slice(1, -1));
    }
    expect(found.size).toBeGreaterThan(40);
    for (const op of found) expect(covered, `operation ${op} has no MCP tool`).toContain(op);
  });

  it("COVERAGE GUARD: every orchestrator-catalog operation has an MCP tool", () => {
    const covered = new Set(MCP_AGENT_TOOLS.map((t) => t.operation));
    for (const entry of OPERATION_CATALOG) {
      for (const op of entry.operations) expect(covered, `catalog operation ${op} has no MCP tool`).toContain(op);
    }
  });

  it("COVERAGE GUARD: the README matrix names every agent", () => {
    const readme = read("README.md");
    for (const agent of new Set(MCP_AGENT_TOOLS.map((t) => t.agent))) {
      expect(readme, `README matrix is missing ${agent}`).toContain(`| ${agent}`);
    }
  });
});
