/**
 * Tests for src/r0-metrics-core.ts (issue #241 R0.1, child issue #325).
 *
 * The core is SDK-free and imports directly. Rows are seeded through the
 * real identity-core write path (appendAccounting) into the in-memory
 * FakeDb, so the seam tests exercise the same SQL the IdentityAgent DO
 * runs. Timestamps are fixed constants — no wall clock anywhere.
 */

import { describe, expect, it } from "vitest";
import {
  ensureIdentitySchema,
  appendAccounting,
  queryAccounting,
  type AccountingInput,
  type AccountingRow,
} from "../src/identity-core";
import {
  aggregateLoopMetrics,
  buildLoopMetricsLedger,
  failureSignatureFor,
  isUnreliable,
  loopOutcomeFromRow,
  operationClassOf,
  readLoopMetrics,
  UNRECORDED_LOOPS,
} from "../src/r0-metrics-core";
import { makeDb } from "./identity-fake-db";

const T0 = Date.parse("2026-10-19T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600000;
const DAY = 86400000;

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

function row(overrides: Partial<AccountingRow> & { operation: string }): AccountingRow {
  return {
    id: 1,
    ts: iso(T0),
    level: "info",
    tenantId: "t1",
    userId: "u1",
    correlationId: "c-x",
    outcome: "ok",
    authDecision: null,
    scopeUsed: null,
    detail: null,
    errorCode: null,
    durationMs: null,
    ...overrides,
  };
}

describe("loopOutcomeFromRow", () => {
  it("maps the stream's outcomes onto ledger results", () => {
    expect(loopOutcomeFromRow(row({ operation: "a.b", outcome: "ok" })).result).toBe("success");
    expect(loopOutcomeFromRow(row({ operation: "a.b", outcome: "error" })).result).toBe("failure");
    expect(loopOutcomeFromRow(row({ operation: "a.b", outcome: "denied" })).result).toBe("denied");
    expect(loopOutcomeFromRow(row({ operation: "a.b", outcome: "skipped" })).result).toBe("skipped");
    // An outcome the taxonomy doesn't know is "other" — never a success.
    expect(loopOutcomeFromRow(row({ operation: "a.b", outcome: "mystery" })).result).toBe("other");
  });

  it("extracts errorCode and durationMs from detail only when actually present", () => {
    const withDetail = loopOutcomeFromRow(
      row({
        operation: "api.op",
        outcome: "error",
        detail: JSON.stringify({ code: "RATE_LIMITED", durationMs: 42 }),
      }),
    );
    expect(withDetail.errorCode).toBe("RATE_LIMITED");
    expect(withDetail.durationMs).toBe(42);
    expect(withDetail.failureSignature).toBe("api.op::RATE_LIMITED");

    // A row carrying neither (e.g. written before #327 persisted the
    // columns, with no detail either): both come back null and the
    // failure lands in the explicit "unclassified" signature bucket.
    const bare = loopOutcomeFromRow(row({ operation: "api.op", outcome: "error" }));
    expect(bare.errorCode).toBeNull();
    expect(bare.durationMs).toBeNull();
    expect(bare.failureSignature).toBe("api.op::unclassified");
  });

  it("derives the operation class like queryAccounting's eventClass", () => {
    expect(operationClassOf("authn.success")).toBe("authn");
    expect(operationClassOf("qa.qaCheck")).toBe("qa");
    expect(operationClassOf("GET /api/dashboard/x")).toBe("GET /api/dashboard/x");
    expect(failureSignatureFor("a.b", null)).toBe("a.b::unclassified");
  });
});

describe("aggregateLoopMetrics", () => {
  it("computes per-operation success/failure counts and rates", () => {
    const rows = [
      row({ operation: "qa.qaCheck", outcome: "ok" }),
      row({ operation: "qa.qaCheck", outcome: "ok" }),
      row({ operation: "qa.qaCheck", outcome: "ok" }),
      row({ operation: "qa.qaCheck", outcome: "error" }),
      row({ operation: "email.send", outcome: "ok" }),
      row({ operation: "email.send", outcome: "ok" }),
      row({ operation: "authz.check", outcome: "denied" }),
    ];
    const { operations } = aggregateLoopMetrics(rows);
    const qa = operations.find((o) => o.operation === "qa.qaCheck")!;
    expect(qa.runs).toBe(4);
    expect(qa.attempts).toBe(4);
    expect(qa.successes).toBe(3);
    expect(qa.failures).toBe(1);
    expect(qa.successRate).toBeCloseTo(0.75);
    expect(qa.failureRate).toBeCloseTo(0.25);
    expect(isUnreliable(qa)).toBe(false);

    const email = operations.find((o) => o.operation === "email.send")!;
    expect(email.successRate).toBe(1);

    // Denied is not an attempt: no rate, never "unreliable".
    const authz = operations.find((o) => o.operation === "authz.check")!;
    expect(authz.denied).toBe(1);
    expect(authz.attempts).toBe(0);
    expect(authz.successRate).toBeNull();
    expect(isUnreliable(authz)).toBe(false);
  });

  it("flags unreliability with the #207 semantics (half of 2+ attempts failed)", () => {
    const rows = [
      row({ operation: "flaky.op", outcome: "error" }),
      row({ operation: "flaky.op", outcome: "error" }),
      row({ operation: "flaky.op", outcome: "ok" }),
      row({ operation: "once.op", outcome: "error" }),
    ];
    const { operations } = aggregateLoopMetrics(rows);
    expect(isUnreliable(operations.find((o) => o.operation === "flaky.op")!)).toBe(true);
    // A single failed attempt is a failure, not a reliability verdict.
    expect(isUnreliable(operations.find((o) => o.operation === "once.op")!)).toBe(false);
  });

  it("aggregates operations it has never seen — there is no registry gate", () => {
    const rows = [row({ operation: "brand.newOp", outcome: "mystery" })];
    const { operations } = aggregateLoopMetrics(rows);
    expect(operations).toHaveLength(1);
    expect(operations[0].operation).toBe("brand.newOp");
    expect(operations[0].runs).toBe(1);
    expect(operations[0].other).toBe(1);
    expect(operations[0].attempts).toBe(0);
    expect(operations[0].successRate).toBeNull();
  });

  it("never aggregates one tenant's events into another's, even from mixed rows", () => {
    const rows = [
      row({ operation: "qa.qaCheck", tenantId: "t1", outcome: "ok" }),
      row({ operation: "qa.qaCheck", tenantId: "t1", outcome: "ok" }),
      row({ operation: "qa.qaCheck", tenantId: "t2", outcome: "error" }),
      row({ operation: "qa.qaCheck", tenantId: "t2", outcome: "error" }),
      row({ operation: "qa.qaCheck", tenantId: "t2", outcome: "error" }),
    ];
    const t1 = aggregateLoopMetrics(rows, { tenantId: "t1" });
    expect(t1.operations).toHaveLength(1);
    expect(t1.operations[0].tenantId).toBe("t1");
    expect(t1.operations[0].runs).toBe(2);
    expect(t1.operations[0].failures).toBe(0);
    expect(t1.operations[0].successRate).toBe(1);

    // Unscoped aggregation still keeps tenants in separate entries.
    const all = aggregateLoopMetrics(rows);
    expect(all.operations).toHaveLength(2);
    expect(all.operations.find((o) => o.tenantId === "t2")!.failures).toBe(3);
  });
});

describe("recurrence detection", () => {
  const fail = (
    ts: number,
    detail?: unknown,
    tenantId = "t1",
    correlationId = `c-${ts}`,
  ): AccountingRow =>
    row({
      operation: "slack.post",
      outcome: "error",
      ts: iso(ts),
      tenantId,
      correlationId,
      detail: detail === undefined ? null : JSON.stringify(detail),
    });

  it("detects the same operation+signature recurring inside the window", () => {
    const rows = [
      fail(T0, { code: "UPSTREAM_ERROR" }, "t1", "c-a"),
      fail(T0 + HOUR, { code: "UPSTREAM_ERROR" }, "t1", "c-b"),
      fail(T0 + 2 * HOUR, { code: "UPSTREAM_ERROR" }, "t1", "c-c"),
    ];
    const { recurrences } = aggregateLoopMetrics(rows);
    expect(recurrences).toHaveLength(1);
    expect(recurrences[0].signature).toBe("slack.post::UPSTREAM_ERROR");
    expect(recurrences[0].occurrences).toBe(3);
    expect(recurrences[0].maxInWindow).toBe(3);
    expect(recurrences[0].windowMs).toBe(DAY);
    expect(recurrences[0].correlationIds).toEqual(["c-a", "c-b", "c-c"]);
    expect(recurrences[0].firstTs).toBe(iso(T0));
    expect(recurrences[0].lastTs).toBe(iso(T0 + 2 * HOUR));
  });

  it("does not recur when failures are spread beyond the window", () => {
    const rows = [fail(T0), fail(T0 + DAY + HOUR), fail(T0 + 2 * DAY + 2 * HOUR)];
    expect(aggregateLoopMetrics(rows).recurrences).toHaveLength(0);
    // The same rows DO recur under a window that actually contains them.
    const wide = aggregateLoopMetrics(rows, { windowMs: 3 * DAY });
    expect(wide.recurrences).toHaveLength(1);
    expect(wide.recurrences[0].maxInWindow).toBe(3);
  });

  it("keeps different failure signatures separate", () => {
    const rows = [
      fail(T0, { code: "A" }),
      fail(T0 + HOUR, { code: "B" }),
      fail(T0 + 2 * HOUR, undefined),
    ];
    // A, B and unclassified are three distinct signatures of one each:
    // nothing recurs, and nothing was merged to manufacture a recurrence.
    expect(aggregateLoopMetrics(rows).recurrences).toHaveLength(0);
  });

  it("respects minOccurrences", () => {
    const rows = [fail(T0, { code: "A" }), fail(T0 + HOUR, { code: "A" })];
    expect(aggregateLoopMetrics(rows).recurrences).toHaveLength(1);
    expect(aggregateLoopMetrics(rows, { minOccurrences: 3 }).recurrences).toHaveLength(0);
  });

  it("does not combine two tenants' failures into a recurrence", () => {
    const rows = [
      fail(T0, { code: "A" }, "t1"),
      fail(T0 + HOUR, { code: "A" }, "t2"),
    ];
    expect(aggregateLoopMetrics(rows, { tenantId: "t1" }).recurrences).toHaveLength(0);
    expect(aggregateLoopMetrics(rows).recurrences).toHaveLength(0);
  });
});

describe("cycle time honesty", () => {
  it("reports unavailable when the stream carried no durations (the normal case)", () => {
    const rows = [row({ operation: "a.b", outcome: "ok" }), row({ operation: "a.b", outcome: "ok" })];
    const { operations } = aggregateLoopMetrics(rows);
    expect(operations[0].cycleTime).toEqual({
      available: false,
      samples: 0,
      meanMs: null,
      p50Ms: null,
      maxMs: null,
    });
  });

  it("computes stats only over durations a producer actually recorded in detail", () => {
    const rows = [
      row({ operation: "a.b", outcome: "ok", detail: JSON.stringify({ durationMs: 100 }) }),
      row({ operation: "a.b", outcome: "ok", detail: JSON.stringify({ durationMs: 300 }) }),
      row({ operation: "a.b", outcome: "ok" }), // no duration: not a sample
    ];
    const { operations } = aggregateLoopMetrics(rows);
    expect(operations[0].cycleTime).toEqual({
      available: true,
      samples: 2,
      meanMs: 200,
      p50Ms: 100,
      maxMs: 300,
    });
  });
});

describe("ledger + coverage", () => {
  it("empty stream: no operations, no recurrences, unrecorded loops still named", () => {
    const ledger = buildLoopMetricsLedger([], { tenantId: "t1" });
    expect(ledger.eventCount).toBe(0);
    expect(ledger.operations).toEqual([]);
    expect(ledger.recurrences).toEqual([]);
    expect(ledger.fromTs).toBeNull();
    expect(ledger.toTs).toBeNull();
    expect(ledger.truncated).toBe(false);
    // The self-heal loop exists even though the stream can't see it:
    // it is listed as an explicit not-yet-recorded category, not omitted.
    const selfHeal = ledger.unrecordedLoops.find((l) => l.loop === "self-heal-fixer");
    expect(selfHeal).toBeDefined();
    expect(selfHeal!.recording).toBe("not_yet_recorded");
    expect(UNRECORDED_LOOPS.every((l) => l.recording === "not_yet_recorded")).toBe(true);
  });
});

describe("readLoopMetrics seam", () => {
  it("reads through the identity store path, scoped to the tenant", () => {
    const db = freshDb();
    seed(db, { operation: "qa.qaCheck", ts: iso(T0), outcome: "ok" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + HOUR), outcome: "error" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + 2 * HOUR), outcome: "ok" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0), tenantId: "t2", outcome: "error" });
    seed(db, { operation: "qa.qaCheck", ts: iso(T0 + HOUR), tenantId: "t2", outcome: "error" });

    const ledger = readLoopMetrics(db, { tenantId: "t1" });
    expect(ledger.tenantId).toBe("t1");
    expect(ledger.eventCount).toBe(3);
    const qa = ledger.operations.find((o) => o.operation === "qa.qaCheck")!;
    expect(qa.tenantId).toBe("t1");
    expect(qa.successes).toBe(2);
    expect(qa.failures).toBe(1);
    expect(qa.successRate).toBeCloseTo(2 / 3);
    // t2's two same-signature failures must not leak into t1's ledger.
    expect(ledger.recurrences).toHaveLength(0);

    const t2 = readLoopMetrics(db, { tenantId: "t2" });
    expect(t2.eventCount).toBe(2);
    expect(t2.recurrences).toHaveLength(1);
  });

  it("honors the from/to window", () => {
    const db = freshDb();
    seed(db, { operation: "a.b", ts: iso(T0), outcome: "ok" });
    seed(db, { operation: "a.b", ts: iso(T0 + 10 * DAY), outcome: "ok" });
    const ledger = readLoopMetrics(db, {
      tenantId: "t1",
      from: iso(T0 + DAY),
      to: iso(T0 + 20 * DAY),
    });
    expect(ledger.eventCount).toBe(1);
    expect(ledger.fromTs).toBe(iso(T0 + 10 * DAY));
  });

  it("pages past the 1000-row queryAccounting cap without double-counting", () => {
    const db = freshDb();
    for (let i = 0; i < 1001; i++) {
      seed(db, { operation: "bulk.op", ts: iso(T0 + i * 1000), outcome: "ok" });
    }
    const ledger = readLoopMetrics(db, { tenantId: "t1" });
    expect(ledger.eventCount).toBe(1001);
    expect(ledger.truncated).toBe(false);
    expect(ledger.operations[0].runs).toBe(1001);
    // Sanity: the raw store agrees on the row count.
    expect(queryAccounting(db, { tenantId: "t1", limit: 1000 })).toHaveLength(1000);
  });

  it("flags truncation honestly when the event cap cuts the read", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      seed(db, { operation: "bulk.op", ts: iso(T0 + i * 1000), outcome: "ok" });
    }
    const ledger = readLoopMetrics(db, { tenantId: "t1", maxEvents: 5 });
    expect(ledger.eventCount).toBe(5);
    expect(ledger.truncated).toBe(true);
  });
});
