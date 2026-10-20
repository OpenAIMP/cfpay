/**
 * Tests for issue #241 R0.3 (child issue #327): the accounting sink
 * persistence fix + the in-Worker loop producers.
 *
 * Three layers, matching how the code is built:
 * 1. Sink persistence, through the real appendAccounting/queryAccounting
 *    write+read path into the in-memory FakeDb (the same seam the
 *    R0.1/R0.2 tests use). The headline assertions bite against the
 *    pre-#327 sink: it dropped errorCode/durationMs at the store
 *    boundary, so the fields came back null and failures grouped under
 *    "unclassified" with no cycle-time samples.
 * 2. The legacy-schema upgrade against a real SQLite database
 *    (node:sqlite): a store created with the pre-#327 DDL gains the
 *    two columns additively, its old rows intact and still readable.
 *    Skipped only if the runtime lacks the builtin.
 * 3. The producer seam (src/loop-accounting.ts, SDK-free): event shape,
 *    exactly-one-event emission through the aspect feed, and the
 *    end-to-end path producer → store → ledger → summary. The four
 *    agent seams themselves can't be imported in Vitest (the Think SDK
 *    chain pulls `cloudflare:` modules — the known repo constraint),
 *    so their wiring is pinned by source assertions, per repo practice.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureIdentitySchema,
  appendAccounting,
  queryAccounting,
  type AccountingInput,
  type SqlDb,
} from "../src/identity-core";
import {
  aggregateLoopMetrics,
  loopOutcomeFromRow,
  readLoopMetrics,
  renderLoopMetricsSummary,
  UNRECORDED_LOOPS,
} from "../src/r0-metrics-core";
import {
  buildLoopOutcomeEvent,
  emitLoopOutcome,
  errorCodeOf,
} from "../src/loop-accounting";
import {
  setAspectEventSink,
  setAccountingSink,
  type AspectEvent,
} from "../src/aspect-logging";
import { makeDb } from "./identity-fake-db";

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
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

/* --------------------- 1. sink persistence (FakeDb) --------------------- */

describe("sink persistence fix (#327)", () => {
  it("persists errorCode and durationMs through the real write/read path", () => {
    const db = freshDb();
    seed(db, {
      operation: "autopilot.cycle",
      ts: iso(T0),
      outcome: "error",
      errorCode: "HUNT_FAILED",
      durationMs: 4200,
    });
    const rows = queryAccounting(db, { tenantId: "t1" });
    expect(rows).toHaveLength(1);
    // The pre-#327 sink returned both as absent/null here.
    expect(rows[0].errorCode).toBe("HUNT_FAILED");
    expect(rows[0].durationMs).toBe(4200);

    const rec = loopOutcomeFromRow(rows[0]);
    expect(rec.errorCode).toBe("HUNT_FAILED");
    expect(rec.failureSignature).toBe("autopilot.cycle::HUNT_FAILED");
    expect(rec.durationMs).toBe(4200);
  });

  it("gives the ledger real failure signatures and cycle-time samples", () => {
    const db = freshDb();
    seed(db, { operation: "autopilot.cycle", ts: iso(T0), outcome: "ok", durationMs: 1000 });
    seed(db, { operation: "autopilot.cycle", ts: iso(T0 + HOUR), outcome: "error", errorCode: "HUNT_FAILED", durationMs: 3000 });
    seed(db, { operation: "autopilot.cycle", ts: iso(T0 + 2 * HOUR), outcome: "error", errorCode: "HUNT_FAILED", durationMs: 2000 });

    const { operations, recurrences } = aggregateLoopMetrics(
      queryAccounting(db, { tenantId: "t1", limit: 100 }),
    );
    const cycle = operations.find((o) => o.operation === "autopilot.cycle")!;
    expect(cycle.cycleTime).toEqual({
      available: true,
      samples: 3,
      meanMs: 2000,
      p50Ms: 2000,
      maxMs: 3000,
    });
    expect(cycle.lastFailureSignature).toBe("autopilot.cycle::HUNT_FAILED");
    expect(recurrences).toHaveLength(1);
    expect(recurrences[0].signature).toBe("autopilot.cycle::HUNT_FAILED");
  });

  it("rows written without the fields still read as unclassified / no duration", () => {
    const db = freshDb();
    seed(db, { operation: "api.op", ts: iso(T0), outcome: "error" });
    const rows = queryAccounting(db, { tenantId: "t1" });
    expect(rows[0].errorCode).toBeNull();
    expect(rows[0].durationMs).toBeNull();
    const rec = loopOutcomeFromRow(rows[0]);
    expect(rec.errorCode).toBeNull();
    expect(rec.durationMs).toBeNull();
    expect(rec.failureSignature).toBe("api.op::unclassified");
  });

  it("keeps the detail fallback for pre-#327 rows, with the column winning when both exist", () => {
    const db = freshDb();
    // Pre-#327 shape: code/duration only inside detail.
    seed(db, {
      operation: "api.op",
      ts: iso(T0),
      outcome: "error",
      detail: { code: "DETAIL_CODE", durationMs: 55 },
    });
    // Post-#327 shape: columns set; a stale detail code must not win.
    seed(db, {
      operation: "api.op",
      ts: iso(T0 + HOUR),
      outcome: "error",
      errorCode: "COLUMN_CODE",
      durationMs: 77,
      detail: { code: "DETAIL_CODE", durationMs: 55 },
    });
    const rows = queryAccounting(db, { tenantId: "t1", limit: 100 });
    const byTs = new Map(rows.map((r) => [r.ts, loopOutcomeFromRow(r)]));
    expect(byTs.get(iso(T0))!.errorCode).toBe("DETAIL_CODE");
    expect(byTs.get(iso(T0))!.durationMs).toBe(55);
    expect(byTs.get(iso(T0 + HOUR))!.errorCode).toBe("COLUMN_CODE");
    expect(byTs.get(iso(T0 + HOUR))!.durationMs).toBe(77);
  });

  it("refuses insane durations at the write boundary (negative / NaN become null)", () => {
    const db = freshDb();
    seed(db, { operation: "a.b", ts: iso(T0), outcome: "ok", durationMs: -5 });
    seed(db, { operation: "a.b", ts: iso(T0 + HOUR), outcome: "ok", durationMs: Number.NaN });
    seed(db, { operation: "a.b", ts: iso(T0 + 2 * HOUR), outcome: "ok", errorCode: "" });
    const rows = queryAccounting(db, { tenantId: "t1", limit: 100 });
    expect(rows.every((r) => r.durationMs === null)).toBe(true);
    expect(rows.every((r) => r.errorCode === null)).toBe(true);
  });

  it("the summary now reports cycle times for producers that record durations", () => {
    const db = freshDb();
    seed(db, { operation: "qa.suite", ts: iso(T0), outcome: "ok", durationMs: 100 });
    seed(db, { operation: "qa.suite", ts: iso(T0 + HOUR), outcome: "ok", durationMs: 300 });
    const ledger = readLoopMetrics(db, { tenantId: "t1" });
    const text = renderLoopMetricsSummary(ledger);
    expect(text).toContain("qa.suite: 2 runs");
    expect(text).toContain("cycle time p50 100ms, mean 200ms over 2 samples");
    expect(text).not.toContain("cycle time unavailable");
  });
});

/* ----------------- 2. legacy schema upgrade (real SQLite) ---------------- */

const require = createRequire(import.meta.url);
let DatabaseSync: (typeof import("node:sqlite"))["DatabaseSync"] | null = null;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

/** The pre-#327 accounting_events DDL, verbatim shape (11 columns). */
const LEGACY_DDL = `CREATE TABLE accounting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT, ts TEXT, level TEXT, tenant_id TEXT, user_id TEXT,
  correlation_id TEXT, outcome TEXT, auth_decision TEXT, scope_used TEXT,
  detail TEXT
)`;

function sqliteAdapter(raw: InstanceType<NonNullable<typeof DatabaseSync>>): SqlDb {
  return {
    run: (sql: string, ...params: unknown[]) => {
      raw.prepare(sql).run(...(params as never[]));
    },
    all: <T>(sql: string, ...params: unknown[]) =>
      raw.prepare(sql).all(...(params as never[])) as T[],
  };
}

describe.skipIf(!DatabaseSync)("legacy schema upgrade (#327)", () => {
  it("adds the columns to a pre-#327 store additively; old rows stay readable", () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(LEGACY_DDL);
    raw
      .prepare(
        `INSERT INTO accounting_events (operation, ts, level, tenant_id, user_id, correlation_id, outcome, auth_decision, scope_used, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("slack.post", iso(T0), "error", "t1", "u1", "corr-legacy", "error", null, null, null);

    const db = sqliteAdapter(raw);
    // The upgrade runs inside the normal schema path — and is idempotent.
    ensureIdentitySchema(db);
    ensureIdentitySchema(db);

    seed(db, {
      operation: "autopilot.cycle",
      ts: iso(T0 + HOUR),
      outcome: "error",
      errorCode: "HUNT_FAILED",
      durationMs: 1500,
    });

    const rows = queryAccounting(db, { tenantId: "t1", limit: 100 });
    expect(rows).toHaveLength(2);
    const legacy = rows.find((r) => r.correlationId === "corr-legacy")!;
    expect(legacy.operation).toBe("slack.post");
    expect(legacy.errorCode).toBeNull();
    expect(legacy.durationMs).toBeNull();
    expect(loopOutcomeFromRow(legacy).failureSignature).toBe("slack.post::unclassified");

    const fresh = rows.find((r) => r.operation === "autopilot.cycle")!;
    expect(fresh.errorCode).toBe("HUNT_FAILED");
    expect(fresh.durationMs).toBe(1500);
    raw.close();
  });
});

/* ------------------------- 3. the producer seam ------------------------- */

describe("loop outcome seam (src/loop-accounting.ts)", () => {
  afterEach(() => {
    setAspectEventSink(null);
    setAccountingSink(null);
  });

  it("builds events in the stream's shape, with level by outcome", () => {
    const ok = buildLoopOutcomeEvent({
      agent: "autopilot",
      operation: "autopilot.cycle",
      tenantId: "operator",
      outcome: "ok",
      durationMs: 123.6,
      correlationId: "corr-fixed",
      detail: { cycleId: "cycle-1", status: "completed" },
    });
    expect(ok.v).toBe(1);
    expect(ok.level).toBe("info");
    expect(ok.agent).toBe("autopilot");
    expect(ok.operation).toBe("autopilot.cycle");
    expect(ok.tenantId).toBe("operator");
    // tenant = user 1:1 (identity-core): the user mirrors the tenant.
    expect(ok.userId).toBe("operator");
    expect(ok.durationMs).toBe(124);
    expect(ok.outcome).toBe("ok");
    expect(ok.errorCode).toBeUndefined();
    expect(ok.correlationId).toBe("corr-fixed");

    const err = buildLoopOutcomeEvent({
      agent: "qa",
      operation: "qa.suite",
      tenantId: "operator",
      outcome: "error",
      durationMs: -3,
      errorCode: "QA_CHECKS_FAILED",
    });
    expect(err.level).toBe("error");
    expect(err.durationMs).toBe(0); // clamped, never negative
    expect(err.errorCode).toBe("QA_CHECKS_FAILED");
    expect(err.correlationId).toBeTruthy(); // minted when not supplied

    const skipped = buildLoopOutcomeEvent({
      agent: "autopilot",
      operation: "autopilot.cycle",
      tenantId: "operator",
      outcome: "skipped",
      durationMs: 0,
    });
    expect(skipped.level).toBe("info");
    expect(skipped.outcome).toBe("skipped");
  });

  it("emits exactly one event per outcome, into both the transport and accounting feeds", () => {
    const transport: AspectEvent[] = [];
    const accounting: AspectEvent[] = [];
    setAspectEventSink((e) => transport.push(e));
    setAccountingSink((e) => accounting.push(e));

    emitLoopOutcome({
      agent: "scheduled",
      operation: "scheduled.firing",
      tenantId: "t9",
      outcome: "error",
      durationMs: 250,
      errorCode: "DISPATCH_FAILED",
      detail: { goalId: "g1", kind: "cron", jobId: null, status: "error: boom" },
    });

    expect(transport).toHaveLength(1);
    expect(accounting).toHaveLength(1);
    expect(accounting[0]).toBe(transport[0]);
    expect(accounting[0].operation).toBe("scheduled.firing");
    expect(accounting[0].errorCode).toBe("DISPATCH_FAILED");
    expect(accounting[0].durationMs).toBe(250);
  });

  it("flows end to end: producer events land in the store and the ledger counts them", () => {
    const db = freshDb();
    const accounting: AspectEvent[] = [];
    setAspectEventSink(() => {});
    setAccountingSink((e) => accounting.push(e));

    emitLoopOutcome({
      agent: "orchestrator",
      operation: "orchestrator.plan",
      tenantId: "t1",
      outcome: "error",
      durationMs: 5000,
      errorCode: "PLAN_PARTIAL",
      detail: { jobId: "job-1", mode: "supervise", status: "partial", revisions: 2, stepsTotal: 4, stepsOk: 3, stepsFailed: 1, stepsSkipped: 0 },
    });
    emitLoopOutcome({
      agent: "orchestrator",
      operation: "orchestrator.plan",
      tenantId: "t1",
      outcome: "ok",
      durationMs: 1000,
      detail: { jobId: "job-2", mode: "plan", status: "done", revisions: 0, stepsTotal: 2, stepsOk: 2, stepsFailed: 0, stepsSkipped: 0 },
    });
    expect(accounting).toHaveLength(2);

    // The sink's store copy is appendAccounting over the same events.
    appendAccounting(db, accounting as unknown as AccountingInput[]);
    const ledger = readLoopMetrics(db, { tenantId: "t1" });
    const plan = ledger.operations.find((o) => o.operation === "orchestrator.plan")!;
    expect(plan.runs).toBe(2);
    expect(plan.successes).toBe(1);
    expect(plan.failures).toBe(1);
    expect(plan.lastFailureSignature).toBe("orchestrator.plan::PLAN_PARTIAL");
    expect(plan.cycleTime.available).toBe(true);
    expect(plan.cycleTime.samples).toBe(2);
    expect(renderLoopMetricsSummary(ledger)).toContain("orchestrator.plan: 2 runs");
  });

  it("errorCodeOf keeps a thrown value's catalog code, else the fallback", () => {
    const coded = new Error("boom") as Error & { code?: string };
    coded.code = "RATE_LIMITED";
    expect(errorCodeOf(coded, "FALLBACK")).toBe("RATE_LIMITED");
    expect(errorCodeOf(new Error("boom"), "FALLBACK")).toBe("FALLBACK");
    expect(errorCodeOf("not an error", "FALLBACK")).toBe("FALLBACK");
    expect(errorCodeOf(null, "FALLBACK")).toBe("FALLBACK");
  });
});

/* --------------------------- 4. coverage --------------------------- */

describe("coverage after #327", () => {
  it("UNRECORDED_LOOPS holds only the two loops that run outside the Worker", () => {
    expect(UNRECORDED_LOOPS.map((l) => l.loop)).toEqual([
      "self-heal-fixer",
      "post-deploy-smoke",
    ]);
    for (const l of UNRECORDED_LOOPS) {
      expect(l.recording).toBe("not_yet_recorded");
      expect(`${l.producer} ${l.note}`).toContain("outside the Worker");
    }
  });
});

/* --------------------- 5. agent seam wiring pins --------------------- */

function srcOf(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf-8");
}

describe("producer wiring in the agent seams", () => {
  it("orchestrator: every terminal state of orchestrateRun emits orchestrator.plan once", () => {
    const src = srcOf("orchestrator-agent.ts");
    expect(src.match(/operation: "orchestrator\.plan"/g)).toHaveLength(3);
    expect(src).toContain('errorCode: "MISSING_GOAL"');
    expect(src).toContain('errorCodeOf(err, "PLANNING_FAILED")');
    expect(src).toContain('"PLAN_PARTIAL"');
    expect(src).toContain('"PLAN_FAILED"');
    // Plan-revision counts ride in the detail of the completion event.
    expect(src).toContain("revisions,");
    expect(src).toContain("stepsTotal: outcomes.length");
    expect(src).toContain("ownTenantId(this.ctx.id.name)");
  });

  it("autopilot: cycle completion and the no-objective skip both emit autopilot.cycle", () => {
    const src = srcOf("autopilot-agent.ts");
    expect(src.match(/operation: "autopilot\.cycle"/g)).toHaveLength(2);
    expect(src).toContain('outcome: "skipped"');
    expect(src).toContain('errorCode: "HUNT_FAILED"');
    expect(src).toContain("durationMs: finishedAt - startedAt");
  });

  it("scheduled: dispatchAndRecord emits scheduled.firing once per firing", () => {
    const src = srcOf("scheduled-agent.ts");
    expect(src.match(/operation: "scheduled\.firing"/g)).toHaveLength(1);
    expect(src).toContain('"NO_JOB_ID"');
    expect(src).toContain('"DISPATCH_FAILED"');
    expect(src).toContain("detail: { goalId: row.id, kind: row.kind, jobId, status }");
  });

  it("qa: qaFullSuite emits qa.suite at its verdict and at its exception exit", () => {
    const src = srcOf("qa-agent.ts");
    expect(src.match(/operation: "qa\.suite"/g)).toHaveLength(2);
    expect(src).toContain('errorCode: "QA_CHECKS_FAILED"');
    expect(src).toContain('errorCodeOf(err, "QA_SUITE_ERROR")');
    expect(src).toContain("checksTotal: checks.length");
  });
});
