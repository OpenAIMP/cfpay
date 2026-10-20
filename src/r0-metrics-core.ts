/**
 * R0 loop-metrics ledger — issue #241 R0.1 (child issue #325).
 *
 * R0 is Instrumentation: before the system may diagnose or modify itself
 * (R1+), its loops' outcomes must be countable from a durable record.
 * That record already exists — the #252 accounting stream
 * (`accounting_events` in IdentityAgent, written by the aspect sink).
 * This module is the ledger over it: pure, SDK-free aggregation logic
 * plus one thin read seam (`readLoopMetrics`) that pages the existing
 * identity-core `queryAccounting` path. No new table, no new DO, no new
 * binding. The readable summary surface is sibling issue #326; producer
 * wiring for loops outside the stream is R0.3 (#327).
 *
 * What the accounting stream does and does not carry (verified against
 * src/aspect-logging.ts, src/aspect-error.ts and src/identity-core.ts —
 * read this before trusting any number the ledger produces):
 *
 * - CARRIES, per event: operation, ts (the event's completion time),
 *   level, tenant_id, user_id, correlation_id, outcome
 *   ("ok" | "error" | "denied" | "skipped"), auth_decision (JSON),
 *   scope_used, detail (JSON, redacted at emission).
 * - DOES NOT CARRY as columns: `durationMs` and `errorCode`. The
 *   AspectEvent has both at emission time, but `appendAccounting`
 *   persists neither — they are dropped at the store boundary.
 *   `errorCode` survives only opportunistically: the API seam's catch
 *   path stores the thrown error in `detail`, and a catalog error's
 *   enumerable `code` property survives redaction, so SOME failure rows
 *   carry `detail.code`. The ledger extracts it best-effort and says so
 *   (see failureSignatureFor); failures without it group under
 *   "unclassified" rather than being silently dropped or invented.
 * - CYCLE TIME: with one timestamp per event and durationMs dropped,
 *   true per-operation cycle time is NOT computable from the persisted
 *   stream today. `durationMs` is therefore extracted only when a
 *   producer actually recorded it inside `detail` (none does yet), and
 *   CycleTimeStats reports `available: false, samples: 0` otherwise.
 *   Persisting durationMs at the sink is a producer-side fix for R0.3 —
 *   the ledger never fabricates it.
 *
 * Tenant scoping is structural, not a filter callers must remember:
 * metrics are grouped per (tenantId, operation), the seam always queries
 * with a tenantId, and `aggregateLoopMetrics` re-filters rows to the
 * requested tenant before grouping, so one tenant's events can never
 * aggregate into another tenant's numbers even if handed unfiltered rows.
 */

import {
  queryAccounting,
  type AccountingRow,
  type SqlDb,
} from "./identity-core";

/* ------------------------------ records --------------------------------- */

export type LoopResult = "success" | "failure" | "denied" | "skipped" | "other";

/**
 * One loop outcome, derived 1:1 from one accounting event row. In R0 a
 * loop is identified by the operation its outcomes are recorded under —
 * the stream's only unit of outcome — so `loop` is the operation name;
 * multi-step loops appear as their step operations, and `operationClass`
 * (the prefix before the first ".", mirroring queryAccounting's
 * eventClass) gives the loop-family grouping.
 */
export interface LoopOutcomeRecord {
  loop: string;
  operation: string;
  operationClass: string;
  ts: string;
  /** The stream's raw outcome string, preserved for audit. */
  outcome: string;
  result: LoopResult;
  correlationId: string;
  tenantId: string;
  userId: string;
  level: string;
  /** Only when a producer recorded it inside detail; null otherwise. */
  durationMs: number | null;
  /** Best-effort from detail.code; null when the row carries none. */
  errorCode: string | null;
  /** Failures only: `${operation}::${errorCode ?? "unclassified"}`. */
  failureSignature: string | null;
}

/** Class of an operation: "qa.qaCheck" -> "qa"; names without a dotted
 *  prefix (e.g. "GET /api/...") are their own class. */
export function operationClassOf(operation: string): string {
  const m = operation.match(/^([A-Za-z][A-Za-z0-9_-]*)\./);
  return m ? m[1] : operation;
}

/**
 * The failure signature recurrence detection groups by. The error code
 * is best-effort: the stream persists it only inside detail JSON when a
 * producer put it there (see module header), so failures without one
 * share the explicit "unclassified" bucket — visible in the output,
 * never silently merged into a named code.
 */
export function failureSignatureFor(operation: string, errorCode: string | null): string {
  return `${operation}::${errorCode ?? "unclassified"}`;
}

function parseDetail(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resultForOutcome(outcome: string): LoopResult {
  switch (outcome) {
    case "ok":
      return "success";
    case "error":
      return "failure";
    case "denied":
      return "denied";
    case "skipped":
      return "skipped";
    default:
      return "other";
  }
}

/** Derive the loop-outcome record for one accounting event row. */
export function loopOutcomeFromRow(row: AccountingRow): LoopOutcomeRecord {
  const detail = parseDetail(row.detail);
  const rawCode = detail?.code;
  const errorCode = typeof rawCode === "string" && rawCode ? rawCode : null;
  const rawDuration = detail?.durationMs;
  const durationMs =
    typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0
      ? rawDuration
      : null;
  const result = resultForOutcome(row.outcome);
  return {
    loop: row.operation,
    operation: row.operation,
    operationClass: operationClassOf(row.operation),
    ts: row.ts,
    outcome: row.outcome,
    result,
    correlationId: row.correlationId,
    tenantId: row.tenantId,
    userId: row.userId,
    level: row.level,
    durationMs,
    errorCode,
    failureSignature:
      result === "failure" ? failureSignatureFor(row.operation, errorCode) : null,
  };
}

/* ----------------------------- aggregation ------------------------------ */

export interface CycleTimeStats {
  /** False when no event for the operation carried a duration — the
   *  normal case for today's stream (see module header). */
  available: boolean;
  samples: number;
  meanMs: number | null;
  /** Nearest-rank p50. */
  p50Ms: number | null;
  maxMs: number | null;
}

export interface OperationMetrics {
  loop: string;
  operation: string;
  operationClass: string;
  tenantId: string;
  /** Every recorded event for this operation, all outcomes. */
  runs: number;
  /** successes + failures — the reliability denominator (#207 semantics). */
  attempts: number;
  successes: number;
  failures: number;
  denied: number;
  skipped: number;
  other: number;
  /** successes / attempts; null when there were no attempts. */
  successRate: number | null;
  /** failures / attempts; null when there were no attempts. */
  failureRate: number | null;
  firstTs: string | null;
  lastTs: string | null;
  lastFailureTs: string | null;
  lastFailureSignature: string | null;
  cycleTime: CycleTimeStats;
}

/**
 * Reliability verdict with the OrchestratorAgent #207 semantics
 * (orchestrate.ts isUnreliableOp): at least half of the last attempts
 * (2+) failed. Denied/skipped outcomes are not attempts and never make
 * an operation "unreliable" — a denied authz is the system working.
 */
export function isUnreliable(m: OperationMetrics): boolean {
  return m.attempts >= 2 && m.failures > 0 && m.failures / m.attempts >= 0.5;
}

export interface Recurrence {
  signature: string;
  operation: string;
  tenantId: string;
  /** Total failures carrying this signature in the input. */
  occurrences: number;
  /** Most failures of this signature inside any single window. */
  maxInWindow: number;
  windowMs: number;
  firstTs: string;
  lastTs: string;
  /** Correlation ids of the failures in the densest window (max 3). */
  correlationIds: string[];
}

export interface AggregateOpts {
  /** When set, rows of any other tenant are excluded before grouping. */
  tenantId?: string;
  /** Recurrence window: failures closer together than this can recur. */
  windowMs?: number;
  /** Failures of one signature inside one window that count as recurrence. */
  minOccurrences?: number;
}

/** Default recurrence window: 24h, matching the loops' daily cadence. */
export const DEFAULT_RECURRENCE_WINDOW_MS = 86400000;
export const DEFAULT_RECURRENCE_MIN_OCCURRENCES = 2;

function cycleTimeFor(records: LoopOutcomeRecord[]): CycleTimeStats {
  const durations = records
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return { available: false, samples: 0, meanMs: null, p50Ms: null, maxMs: null };
  }
  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    available: true,
    samples: durations.length,
    meanMs: sum / durations.length,
    p50Ms: durations[Math.ceil(0.5 * durations.length) - 1],
    maxMs: durations[durations.length - 1],
  };
}

function metricsFor(
  tenantId: string,
  operation: string,
  records: LoopOutcomeRecord[],
): OperationMetrics {
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let successes = 0;
  let failures = 0;
  let denied = 0;
  let skipped = 0;
  let other = 0;
  let lastFailure: LoopOutcomeRecord | null = null;
  for (const r of sorted) {
    switch (r.result) {
      case "success":
        successes++;
        break;
      case "failure":
        failures++;
        lastFailure = r;
        break;
      case "denied":
        denied++;
        break;
      case "skipped":
        skipped++;
        break;
      default:
        other++;
    }
  }
  const attempts = successes + failures;
  return {
    loop: operation,
    operation,
    operationClass: operationClassOf(operation),
    tenantId,
    runs: sorted.length,
    attempts,
    successes,
    failures,
    denied,
    skipped,
    other,
    successRate: attempts > 0 ? successes / attempts : null,
    failureRate: attempts > 0 ? failures / attempts : null,
    firstTs: sorted.length ? sorted[0].ts : null,
    lastTs: sorted.length ? sorted[sorted.length - 1].ts : null,
    lastFailureTs: lastFailure?.ts ?? null,
    lastFailureSignature: lastFailure?.failureSignature ?? null,
    cycleTime: cycleTimeFor(sorted),
  };
}

function recurrencesFor(
  tenantId: string,
  failures: LoopOutcomeRecord[],
  windowMs: number,
  minOccurrences: number,
): Recurrence[] {
  const bySignature = new Map<string, LoopOutcomeRecord[]>();
  for (const r of failures) {
    if (!r.failureSignature) continue;
    const list = bySignature.get(r.failureSignature) ?? [];
    list.push(r);
    bySignature.set(r.failureSignature, list);
  }
  const out: Recurrence[] = [];
  for (const [signature, list] of bySignature) {
    const sorted = [...list].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const times = sorted.map((r) => Date.parse(r.ts));
    // Sliding window: for each start i, count failures with ts <= ts_i + windowMs.
    let maxInWindow = 0;
    let bestStart = 0;
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (j < i) j = i;
      while (j + 1 < sorted.length && times[j + 1] - times[i] <= windowMs) j++;
      if (j - i + 1 > maxInWindow) {
        maxInWindow = j - i + 1;
        bestStart = i;
      }
    }
    if (maxInWindow < minOccurrences) continue;
    out.push({
      signature,
      operation: sorted[0].operation,
      tenantId,
      occurrences: sorted.length,
      maxInWindow,
      windowMs,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      correlationIds: sorted
        .slice(bestStart, bestStart + maxInWindow)
        .slice(0, 3)
        .map((r) => r.correlationId),
    });
  }
  return out.sort(
    (a, b) => b.maxInWindow - a.maxInWindow || (a.signature < b.signature ? -1 : 1),
  );
}

/**
 * Aggregate accounting rows into per-operation metrics + recurrences.
 * Pure: rows are mapped to records, never mutated. Grouping is always
 * per (tenantId, operation); when opts.tenantId is set, other tenants'
 * rows are excluded first (see the tenant-scoping note in the header).
 */
export function aggregateLoopMetrics(
  rows: AccountingRow[],
  opts: AggregateOpts = {},
): { operations: OperationMetrics[]; recurrences: Recurrence[] } {
  const windowMs = opts.windowMs ?? DEFAULT_RECURRENCE_WINDOW_MS;
  const minOccurrences = opts.minOccurrences ?? DEFAULT_RECURRENCE_MIN_OCCURRENCES;
  const scoped = opts.tenantId
    ? rows.filter((r) => r.tenantId === opts.tenantId)
    : rows;
  const records = scoped.map(loopOutcomeFromRow);

  const groups = new Map<string, LoopOutcomeRecord[]>();
  for (const r of records) {
    const key = `${r.tenantId}\u0000${r.operation}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const operations: OperationMetrics[] = [];
  const recurrences: Recurrence[] = [];
  for (const list of groups.values()) {
    const metrics = metricsFor(list[0].tenantId, list[0].operation, list);
    operations.push(metrics);
    recurrences.push(
      ...recurrencesFor(
        metrics.tenantId,
        list.filter((r) => r.result === "failure"),
        windowMs,
        minOccurrences,
      ),
    );
  }
  operations.sort(
    (a, b) =>
      b.failures - a.failures ||
      b.runs - a.runs ||
      (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0),
  );
  recurrences.sort(
    (a, b) => b.maxInWindow - a.maxInWindow || (a.signature < b.signature ? -1 : 1),
  );
  return { operations, recurrences };
}

/* --------------------- coverage: unrecorded loops ----------------------- */

export type LoopRecording = "recorded" | "not_yet_recorded";

/**
 * A loop whose outcomes exist but do NOT flow through the accounting
 * stream. These are named, typed coverage entries — the ledger surfaces
 * them with recording: "not_yet_recorded" and NO metrics, rather than
 * silently omitting the loop (which would read as "the loop is fine" or
 * "the loop does not exist" — both false). R0.3 (#327) wires producers
 * for them; until then this list is the honest boundary of R0's vision.
 */
export interface LoopCoverage {
  loop: string;
  /** Where the loop's outcomes are actually produced today. */
  producer: string;
  recording: LoopRecording;
  note: string;
}

export const UNRECORDED_LOOPS: LoopCoverage[] = [
  {
    loop: "self-heal-fixer",
    producer: "GitHub-side QA self-heal fixer (fixer cron + watch hook)",
    recording: "not_yet_recorded",
    note:
      "Fix attempts, merges and verdicts live in GitHub issues, PRs and " +
      "check runs; nothing emits accounting events for them, so the " +
      "ledger cannot count this loop's outcomes yet. R0.3 (#327) wires " +
      "a producer.",
  },
  {
    loop: "post-deploy-smoke",
    producer: "GitHub Actions qa-smoke job (scripts/qa-smoke.mjs)",
    recording: "not_yet_recorded",
    note:
      "Smoke section verdicts surface as [QA self-heal] issues on " +
      "GitHub, not as accounting events. The smoke run's own section " +
      "outcomes are invisible to this ledger until R0.3 (#327) wires " +
      "a producer.",
  },
];

/* ------------------------------- ledger --------------------------------- */

export interface LoopMetricsLedger {
  /** The tenant this ledger was built for; null only for an unscoped
   *  pure aggregation over explicitly mixed rows (tests/tools). */
  tenantId: string | null;
  /** Accounting events that fed this ledger. */
  eventCount: number;
  fromTs: string | null;
  toTs: string | null;
  /** True when the read seam stopped at its event cap with more rows
   *  remaining — the numbers are then a lower bound, stated, not hidden. */
  truncated: boolean;
  operations: OperationMetrics[];
  recurrences: Recurrence[];
  /** Loops with no accounting-stream presence, named rather than omitted. */
  unrecordedLoops: LoopCoverage[];
}

/** Build a ledger from already-read rows (pure; see readLoopMetrics for
 *  the store-backed seam). */
export function buildLoopMetricsLedger(
  rows: AccountingRow[],
  opts: AggregateOpts & { truncated?: boolean } = {},
): LoopMetricsLedger {
  const { operations, recurrences } = aggregateLoopMetrics(rows, opts);
  const scoped = opts.tenantId
    ? rows.filter((r) => r.tenantId === opts.tenantId)
    : rows;
  const times = scoped.map((r) => r.ts).sort();
  return {
    tenantId: opts.tenantId ?? null,
    eventCount: scoped.length,
    fromTs: times.length ? times[0] : null,
    toTs: times.length ? times[times.length - 1] : null,
    truncated: opts.truncated ?? false,
    operations,
    recurrences,
    unrecordedLoops: UNRECORDED_LOOPS,
  };
}

/* ------------------------------ read seam ------------------------------- */

/** queryAccounting caps a single read at 1000 rows; the seam pages. */
const PAGE_SIZE = 1000;
/** Hard cap on events per ledger read (10 pages). Past it, truncated. */
export const MAX_LEDGER_EVENTS = 10000;

export interface ReadLoopMetricsOpts extends AggregateOpts {
  tenantId: string;
  from?: string;
  to?: string;
  maxEvents?: number;
}

/**
 * The thin query seam: read one tenant's accounting events through the
 * existing identity-store path (identity-core queryAccounting over the
 * caller's SqlDb — inside IdentityAgent that is the DO's own storage)
 * and aggregate them into the ledger. Pages by narrowing `to` to the
 * oldest timestamp seen, de-duplicating by row id (queryAccounting's
 * `to` is inclusive and timestamps can tie). No new table, no new SQL
 * surface beyond the existing query path.
 */
export function readLoopMetrics(db: SqlDb, opts: ReadLoopMetricsOpts): LoopMetricsLedger {
  const maxEvents = opts.maxEvents ?? MAX_LEDGER_EVENTS;
  const seen = new Set<number>();
  const rows: AccountingRow[] = [];
  let to = opts.to;
  let truncated = false;
  for (;;) {
    const page = queryAccounting(db, {
      tenantId: opts.tenantId,
      from: opts.from,
      to,
      limit: PAGE_SIZE,
    });
    let fresh = 0;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      fresh++;
    }
    if (page.length < PAGE_SIZE) break; // stream exhausted
    if (fresh === 0) {
      // A full page with nothing new means >PAGE_SIZE rows share one
      // timestamp; paging cannot advance. State it, don't spin.
      truncated = true;
      break;
    }
    to = page[page.length - 1].ts;
    if (rows.length >= maxEvents) {
      // At the cap on a full page: one probe page decides whether
      // anything actually remains, so the flag is exact, not a guess.
      const probe = queryAccounting(db, {
        tenantId: opts.tenantId,
        from: opts.from,
        to,
        limit: PAGE_SIZE,
      });
      truncated = probe.some((r) => !seen.has(r.id));
      break;
    }
  }
  return buildLoopMetricsLedger(rows.slice(0, maxEvents), {
    tenantId: opts.tenantId,
    windowMs: opts.windowMs,
    minOccurrences: opts.minOccurrences,
    truncated: truncated || rows.length > maxEvents,
  });
}
