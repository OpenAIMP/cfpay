/**
 * Funding ledger core (issue #242 P3.1, #331) — pure, SDK-free.
 *
 * Brokerage funding movements (deposits into / withdrawals out of the
 * Public account) are recorded in PaymentsAgent's ledger, attributed
 * to the AutopilotAgent objective. This module owns the shapes and the
 * arithmetic; PaymentsAgent owns the storage, the host owns the Public
 * read, and AutopilotAgent owns the attribution. Single owner per
 * concern (#246 taxonomy): nothing here touches a Durable Object, the
 * network, or a payment rail.
 *
 * Honesty rules, mirroring src/public-data.ts:
 *   - A movement exists only when the read surface reported one with
 *     a source reference, a parseable amount, a determinable
 *     direction, and a parseable timestamp. Anything less is skipped,
 *     never repaired or invented.
 *   - Recording is idempotent on the source reference: re-reading the
 *     same account history records nothing twice.
 *   - Recording moves NO money. There is no execution path in this
 *     module or its callers' funding paths: no payment processing, no
 *     checkout, no transfer initiation — ledger entries only.
 */

/** One funding movement as read from the account's Public surface. */
export interface FundingMovement {
  /** The source system's own id for this movement (dedupe key). */
  sourceRef: string;
  direction: "deposit" | "withdrawal";
  /** Positive amount in `currency` units (direction carries the sign). */
  amount: number;
  currency: string;
  /** ISO-8601 timestamp of the movement, as reported by the source. */
  ts: string;
  description: string | null;
}

/** Objective linkage stamped on every recorded movement. */
export interface FundingAttribution {
  /** Tenant the movement is attributed under (#252: records are tenant-scoped). */
  tenantId: string;
  /** The objective row id inside the tenant's AutopilotAgent. */
  objectiveId: string;
  /** The objective's goal text at recording time (the human linkage). */
  goal: string;
}

/** A movement as stored in PaymentsAgent's funding ledger. */
export interface FundingRecord extends FundingMovement {
  attribution: FundingAttribution;
  /** ISO-8601 timestamp of when the record was written to the ledger. */
  recordedAt: string;
}

/** Aggregated funding position for one tenant, from recorded movements. */
export interface FundingPosition {
  tenantId: string;
  /** False when nothing has been recorded — an explicit zero state, not an error. */
  recorded: boolean;
  count: number;
  totalDeposits: number;
  totalWithdrawals: number;
  /** totalDeposits - totalWithdrawals, rounded to cents. */
  net: number;
  lastMovementAt: string | null;
}

const REF_FIELDS = [
  "id",
  "transferId",
  "transfer_id",
  "transactionId",
  "transaction_id",
  "reference",
  "externalId",
  "external_id",
];
const AMOUNT_FIELDS = ["amount", "amountUsd", "amount_usd", "netAmount", "grossAmount", "value", "total"];
const DATE_FIELDS = [
  "createdAt",
  "created_at",
  "settledAt",
  "settled_at",
  "postedAt",
  "posted_at",
  "timestamp",
  "date",
  "time",
  "datetime",
];
const TYPE_FIELDS = ["direction", "side", "type", "kind", "category", "activityType", "activity_type"];
const CURRENCY_FIELDS = ["currency", "currencyCode", "currency_code", "ccy"];
const DESC_FIELDS = ["description", "memo", "note", "name", "title"];

function strField(rec: Record<string, unknown>, fields: string[]): string {
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function numField(rec: Record<string, unknown>, fields: string[]): number | null {
  for (const f of fields) {
    const v = rec[f];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isoDate(rec: Record<string, unknown>): string | null {
  for (const f of DATE_FIELDS) {
    const v = rec[f];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      const d = new Date(v < 1e12 ? v * 1000 : v);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    if (typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

type Direction = FundingMovement["direction"];

function directionOf(rec: Record<string, unknown>, signedAmount: number): Direction | null {
  const hints = TYPE_FIELDS.map((f) => strField(rec, [f]).toLowerCase()).filter(Boolean);
  // The free-text description is a weaker hint than a typed field, but
  // it is where several activity feeds carry the only direction word.
  const desc = strField(rec, DESC_FIELDS).toLowerCase();
  const all = [...hints, desc];
  for (const h of all) {
    if (/withdraw|debit|outgoing|ach_out|money_out|cash_out/.test(h)) return "withdrawal";
    if (/deposit|credit|incoming|ach_in|money_in|cash_in|funding/.test(h)) return "deposit";
  }
  for (const h of hints) {
    if (h === "in" || h === "inbound") return "deposit";
    if (h === "out" || h === "outbound") return "withdrawal";
  }
  if (signedAmount < 0) return "withdrawal";
  if (signedAmount > 0) return "deposit";
  return null;
}

function movementFromRow(row: unknown): FundingMovement | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  const sourceRef = strField(rec, REF_FIELDS);
  if (!sourceRef) return null;
  const signed = numField(rec, AMOUNT_FIELDS);
  if (signed === null || signed === 0) return null;
  const direction = directionOf(rec, signed);
  if (!direction) return null;
  const ts = isoDate(rec);
  if (!ts) return null;
  return {
    sourceRef,
    direction,
    amount: Math.round(Math.abs(signed) * 100) / 100,
    currency: (strField(rec, CURRENCY_FIELDS) || "USD").toUpperCase(),
    ts,
    description: strField(rec, DESC_FIELDS) || null,
  };
}

/**
 * Funding movements from a Public activity/transfers tool result. The
 * tool's payload shape is not published, so extraction is liberal the
 * way extractPositions is: walk the payload, score each array by how
 * many rows parse as movements, and take the best one. Duplicated
 * source references inside one payload are read once.
 */
export function extractFundingMovements(result: unknown): FundingMovement[] {
  let best: FundingMovement[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const parsed = v.map(movementFromRow).filter((m): m is FundingMovement => m !== null);
      if (parsed.length > best.length) best = parsed;
      for (const el of v) walk(el, depth + 1);
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, depth + 1);
  };
  walk(result, 0);
  const seen = new Set<string>();
  return best.filter((m) => (seen.has(m.sourceRef) ? false : (seen.add(m.sourceRef), true)));
}

/** Stamp movements with their objective attribution for the ledger. */
export function buildFundingRecords(
  movements: FundingMovement[],
  attribution: FundingAttribution,
  recordedAt: string,
): FundingRecord[] {
  return movements.map((m) => ({ ...m, attribution: { ...attribution }, recordedAt }));
}

/** Minimal shape check for a record offered to the ledger. */
export function isValidFundingRecord(r: unknown): r is FundingRecord {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  const attr = rec.attribution as Record<string, unknown> | undefined;
  return (
    typeof rec.sourceRef === "string" &&
    rec.sourceRef.length > 0 &&
    (rec.direction === "deposit" || rec.direction === "withdrawal") &&
    typeof rec.amount === "number" &&
    Number.isFinite(rec.amount) &&
    rec.amount > 0 &&
    typeof rec.currency === "string" &&
    rec.currency.length > 0 &&
    typeof rec.ts === "string" &&
    rec.ts.length > 0 &&
    !!attr &&
    typeof attr.tenantId === "string" &&
    attr.tenantId.length > 0 &&
    typeof attr.objectiveId === "string" &&
    attr.objectiveId.length > 0 &&
    typeof attr.goal === "string"
  );
}

/**
 * Merge incoming records into the stored ledger, idempotently: a
 * record whose source reference is already stored (or repeated inside
 * the incoming batch) is skipped, so re-syncing the same account
 * history records nothing twice. The ledger is bounded like the
 * payments ledger — the newest `cap` records are kept.
 */
export function mergeFundingRecords(
  existing: FundingRecord[],
  incoming: FundingRecord[],
  cap: number,
): { records: FundingRecord[]; recorded: number; skipped: number } {
  const seen = new Set(existing.map((r) => r.sourceRef));
  const added: FundingRecord[] = [];
  let skipped = 0;
  for (const rec of Array.isArray(incoming) ? incoming : []) {
    if (!isValidFundingRecord(rec) || seen.has(rec.sourceRef)) {
      skipped++;
      continue;
    }
    seen.add(rec.sourceRef);
    added.push(rec);
  }
  const records = [...existing, ...added].slice(-Math.max(cap, 0));
  return { records, recorded: added.length, skipped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The funding position for one tenant from the recorded ledger. Only
 * records attributed to `tenantId` count — another tenant's funding
 * never appears in this tenant's position, whatever store the records
 * were read from. An empty result is the explicit zero state
 * (recorded: false, totals 0), never an error.
 */
export function fundingPosition(records: FundingRecord[], tenantId: string): FundingPosition {
  const mine = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.attribution && r.attribution.tenantId === tenantId,
  );
  let deposits = 0;
  let withdrawals = 0;
  let last: string | null = null;
  for (const r of mine) {
    if (r.direction === "deposit") deposits += r.amount;
    else withdrawals += r.amount;
    if (!last || r.ts > last) last = r.ts;
  }
  return {
    tenantId,
    recorded: mine.length > 0,
    count: mine.length,
    totalDeposits: round2(deposits),
    totalWithdrawals: round2(withdrawals),
    net: round2(deposits - withdrawals),
    lastMovementAt: last,
  };
}

function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The one text rendering of a funding position, shared by the
 * autopilot funding reply and the summary so every surface reports
 * the same figures. The zero state says plainly that nothing has
 * been recorded and how a recording happens.
 */
export function renderFundingPositionText(position: FundingPosition): string {
  if (!position.recorded) {
    return "Funding: no brokerage funding movements recorded yet. autopilot.fundingSync reads the account's movements from Public and records them in the payments ledger, attributed to the objective.";
  }
  return (
    `Funding (payments ledger, attributed to the objective): ${money(position.totalDeposits)} deposited, ` +
    `${money(position.totalWithdrawals)} withdrawn, net ${money(position.net)} across ${position.count} movement(s)` +
    `${position.lastMovementAt ? `; last movement ${position.lastMovementAt}` : ""}.`
  );
}
