/**
 * Tests for the R0 loop-metrics summary surface (issue #241 R0.2,
 * child issue #326): the identity.loopMetrics operation on the host
 * (cfmail) A2A surface.
 *
 * The op's semantics are the pair { text, data } the host handler
 * returns: data is the caller's tenant ledger from readLoopMetrics
 * (seeded here through the real appendAccounting write path into the
 * FakeDb, exactly like the R0.1 tests), text is
 * renderLoopMetricsSummary over that ledger — loopMetricsReply is the
 * exact composition the handler returns, so these tests exercise the
 * full op modulo the one RPC hop to IdentityAgent. The handler wiring
 * itself (host case, tenant source, catalog/MCP/orchestrator pins) is
 * asserted at the end, following the fleet's source-pin precedent.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ensureIdentitySchema,
  appendAccounting,
  type AccountingInput,
} from "../src/identity-core";
import {
  loopMetricsReply,
  readLoopMetrics,
  renderLoopMetricsSummary,
} from "../src/r0-metrics-core";
import { A2A_OPS } from "../src/a2a-ops";
import { MCP_AGENT_TOOLS, mcpToolName } from "../src/mcp-agent-tools";
import { OPERATION_CATALOG } from "../src/orchestrate";
import { makeDb } from "./identity-fake-db";

const T0 = Date.parse("2026-10-19T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600000;

function freshDb() {
  const db = makeDb();
  ensureIdentitySchema(db);
  return db;
}

let corrSeq = 0;
function seed(
  db: ReturnType<typeof freshDb>,
  overrides: Partial<AccountingInput> & { operation: string; ts: string },
): void {
  appendAccounting(db, [
    {
      level: "info",
      tenantId: "t1",
      userId: "u1",
      correlationId: `corr-${++corrSeq}`,
      outcome: "ok",
      ...overrides,
    },
  ]);
}

/** The op as the host handler composes it, for one tenant. */
function opReply(db: ReturnType<typeof freshDb>, tenantId: string) {
  return loopMetricsReply(readLoopMetrics(db, { tenantId }));
}

describe("identity.loopMetrics reply over a seeded stream", () => {
  function seededDb() {
    const db = freshDb();
    // qa.qaCheck: 3 ok + 1 error -> 75% success.
    seed(db, { operation: "qa.qaCheck", ts: iso(T0), outcome: "ok" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + HOUR), outcome: "ok" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + 2 * HOUR), outcome: "ok" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + 3 * HOUR), outcome: "error" });
    // slack.post: three same-code failures inside the window -> recurrence.
    // (AccountingInput.detail is the raw value; appendAccounting stringifies it.)
    seed(db, { operation: "slack.post", ts: iso(T0), outcome: "error", detail: { code: "UPSTREAM_ERROR" } });
    seed(db, { operation: "slack.post", ts: iso(T0 + HOUR), outcome: "error", detail: { code: "UPSTREAM_ERROR" } });
    seed(db, { operation: "slack.post", ts: iso(T0 + 2 * HOUR), outcome: "error", detail: { code: "UPSTREAM_ERROR" } });
    // authz.check: denied only — counted, never an attempt.
    seed(db, { operation: "authz.check", ts: iso(T0), outcome: "denied" });
    return db;
  }

  it("returns the ledger as structured data with correct aggregates", () => {
    const { data } = opReply(seededDb(), "t1");
    expect(data.tenantId).toBe("t1");
    expect(data.eventCount).toBe(8);
    expect(data.fromTs).toBe(iso(T0));
    expect(data.toTs).toBe(iso(T0 + 3 * HOUR));
    expect(data.truncated).toBe(false);

    const qa = data.operations.find((o) => o.operation === "qa.qaCheck")!;
    expect(qa.successes).toBe(3);
    expect(qa.failures).toBe(1);
    expect(qa.successRate).toBeCloseTo(0.75);

    const slack = data.operations.find((o) => o.operation === "slack.post")!;
    expect(slack.failures).toBe(3);
    expect(slack.successRate).toBe(0);

    expect(data.recurrences).toHaveLength(1);
    expect(data.recurrences[0].signature).toBe("slack.post::UPSTREAM_ERROR");
    expect(data.recurrences[0].maxInWindow).toBe(3);

    // Coverage travels with the data: unrecorded loops are present,
    // typed, and carry no invented metrics.
    expect(data.unrecordedLoops.map((l) => l.loop)).toEqual([
      "self-heal-fixer",
      "post-deploy-smoke",
    ]);
    expect(data.unrecordedLoops.every((l) => l.recording === "not_yet_recorded")).toBe(true);
  });

  it("renders the key figures, the recurrence, and the honest gaps as text", () => {
    const { text } = opReply(seededDb(), "t1");
    expect(text).toContain("Loop metrics (R0) for tenant t1: 8 events");
    expect(text).toContain("qa.qaCheck: 4 runs — 75% success (3 ok, 1 failed, 0 denied, 0 skipped)");
    expect(text).toContain("last failure");
    expect(text).toContain("qa.qaCheck::unclassified");
    // slack.post failed every attempt: the reliability verdict shows.
    expect(text).toContain("slack.post: 3 runs — 0% success");
    expect(text).toContain("UNRELIABLE");
    // The recurrence is named with its signature and window.
    expect(text).toContain("Recurring failures:");
    expect(text).toContain("slack.post::UPSTREAM_ERROR: 3 failures, up to 3 within 1d");
    // Cycle time is stated as unavailable — the stream records no
    // durations today, and the summary must not invent any.
    expect(text).toContain("cycle time unavailable (no durations recorded)");
    expect(text).not.toContain("p50");
    // Unrecorded loops are named as not yet recorded.
    expect(text).toContain("Not yet recorded");
    expect(text).toContain("self-heal-fixer");
    expect(text).toContain("post-deploy-smoke");
  });

  it("shows cycle time only when a producer actually recorded durations", () => {
    const db = freshDb();
    seed(db, { operation: "a.b", ts: iso(T0), outcome: "ok", detail: { durationMs: 100 } });
    seed(db, { operation: "a.b", ts: iso(T0 + HOUR), outcome: "ok", detail: { durationMs: 300 } });
    const { text, data } = opReply(db, "t1");
    expect(data.operations[0].cycleTime.available).toBe(true);
    expect(text).toContain("cycle time p50 100ms, mean 200ms over 2 samples");
    expect(text).not.toContain("cycle time unavailable");
  });

  it("flags a truncated read as a lower bound", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      seed(db, { operation: "bulk.op", ts: iso(T0 + i * 1000), outcome: "ok" });
    }
    const ledger = readLoopMetrics(db, { tenantId: "t1", maxEvents: 5 });
    expect(ledger.truncated).toBe(true);
    expect(renderLoopMetricsSummary(ledger)).toContain("lower bound");
  });
});

describe("identity.loopMetrics honesty + tenant isolation", () => {
  it("empty stream: 'no outcomes recorded yet', no operations, coverage still named", () => {
    const { text, data } = opReply(freshDb(), "t1");
    expect(data.eventCount).toBe(0);
    expect(data.operations).toEqual([]);
    expect(text).toContain("no outcomes recorded yet");
    expect(text).toContain("self-heal-fixer");
    expect(text).not.toContain("success (");
  });

  it("each tenant sees only its own ledger — in data and in text", () => {
    const db = freshDb();
    seed(db, { operation: "qa.qaCheck", ts: iso(T0), outcome: "ok", tenantId: "t1", userId: "u1" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + HOUR), outcome: "ok", tenantId: "t1", userId: "u1" });
    seed(db, { operation: "secret.op", ts: iso(T0), outcome: "error", tenantId: "t2", userId: "u2" });
    seed(db, { operation: "secret.op", ts: iso(T0 + HOUR), outcome: "error", tenantId: "t2", userId: "u2" });

    const t1 = opReply(db, "t1");
    expect(t1.data.eventCount).toBe(2);
    expect(t1.data.operations.map((o) => o.operation)).toEqual(["qa.qaCheck"]);
    expect(t1.data.operations.every((o) => o.tenantId === "t1")).toBe(true);
    expect(t1.text).not.toContain("secret.op");
    expect(t1.text).toContain("100% success");

    const t2 = opReply(db, "t2");
    expect(t2.data.eventCount).toBe(2);
    expect(t2.data.operations.map((o) => o.operation)).toEqual(["secret.op"]);
    expect(t2.text).not.toContain("qa.qaCheck");
    // t2's recurrence is its own; it never borrows t1's events.
    expect(t2.data.recurrences).toHaveLength(1);
    expect(t1.data.recurrences).toHaveLength(0);
  });
});

describe("identity.loopMetrics surface wiring", () => {
  it("is registered in the A2A catalog on the host surface as a read op", () => {
    const spec = A2A_OPS.cfmail.find((o) => o.operation === "identity.loopMetrics");
    expect(spec).toBeDefined();
    expect(spec!.access).toBe("read");
    expect(spec!.inputs.map((i) => i.name)).toEqual(["from", "to"]);
    expect(spec!.inputs.every((i) => !i.required)).toBe(true);
  });

  it("has an MCP tool per the #173 guard, named by the fleet convention", () => {
    const tool = MCP_AGENT_TOOLS.find((t) => t.operation === "identity.loopMetrics");
    expect(tool).toBeDefined();
    expect(tool!.agent).toBe("cfmail");
    expect(tool!.binding).toBe("CfmailAgent");
    expect(tool!.access).toBe("read");
    expect(tool!.tool).toBe("cfpay_cfmail_identity_loop_metrics");
    expect(mcpToolName("cfmail", "identity.loopMetrics")).toBe("cfpay_cfmail_identity_loop_metrics");
  });

  it("is plannable: the orchestrator catalog's host entry lists it", () => {
    const host = OPERATION_CATALOG.find((e) => e.agent === "host")!;
    expect(host.operations).toContain("identity.loopMetrics");
  });

  it("the host handler routes the op and derives the tenant from its instance, never from args", () => {
    const agent = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
    const start = agent.indexOf('case "identity.loopMetrics"');
    expect(start).toBeGreaterThan(-1);
    const block = agent.slice(start, start + 1600);
    // The tenant comes from the serving instance's own name...
    expect(block).toContain("ownTenantId(this.ctx.id.name)");
    // ...is passed to the identity singleton's #325 callable...
    expect(block).toContain("identityStub(this.env)");
    expect(block).toContain(".loopMetrics({");
    // ...and the reply is the core's { text, data } composition.
    expect(block).toContain("loopMetricsReply(ledger)");
    // The tenant is never read out of the caller's arguments.
    expect(block).not.toContain("args.tenant");
    // The op is advertised in the handler's unknown-operation list.
    expect(agent).toContain('"desk.autopilot", "identity.loopMetrics"');
  });

  it("IdentityAgent gained no A2A surface of its own (RPC-only by design)", () => {
    const identity = readFileSync(new URL("../src/identity-agent.ts", import.meta.url), "utf-8");
    expect(identity).not.toContain("handleA2A");
    expect(identity).toContain("async loopMetrics(");
  });
});
