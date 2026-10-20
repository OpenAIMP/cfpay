/**
 * Identity core — issue #252 P2 (IAAA Identity: Identification,
 * Authentication, Authorization, Accounting).
 *
 * SDK-free pure logic over a minimal SQL interface (SqlDb), so Vitest can
 * import this module directly. The Durable Object wrapper lives in
 * src/identity-agent.ts, which adapts ctx.storage.sql to SqlDb.
 *
 * Design notes:
 * - The identity ANCHOR is (provider, provider_subject). Email is never the
 *   lookup key: two logins with different emails but the same provider
 *   subject are the same user; the same email under two providers is two
 *   users until explicitly linked.
 * - tenant = user 1:1 for v1 (tenant id = user id), except the
 *   pseudo-identity "operator" whose tenant is "operator".
 * - Sessions are opaque bearer tokens; only the SHA-256 hash is stored.
 *   Dashboard sessions: 24h sliding, 7-day absolute (owner-adopted §8).
 * - Accounting is append-only. Retention: 30d hot (detail PII-purged past
 *   the hot window), 90d cold (rows deleted). The purge accounts itself.
 * - Authorization is FGA tuples: deny-by-default, exact-match check.
 *
 * MockSqlStorage limitation: never use INSERT OR REPLACE; the core uses
 * DELETE+INSERT or INSERT OR IGNORE only.
 */

export interface SqlDb {
  run(sql: string, ...params: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

export interface UserRecord {
  id: string;
  primaryEmail: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  absoluteExpiry: string;
  rotatedAt: string | null;
  revoked: number;
}

export interface AccountingRow {
  id: number;
  operation: string;
  ts: string;
  level: string;
  tenantId: string;
  userId: string;
  correlationId: string;
  outcome: string;
  authDecision: string | null;
  scopeUsed: string | null;
  detail: string | null;
  /** R0.3 (#327): the emitted error code, persisted as its own column.
   *  Null on rows written before #327 (the reader falls back to detail). */
  errorCode: string | null;
  /** R0.3 (#327): the emitted duration in ms, persisted as its own
   *  column. Null on rows written before #327. */
  durationMs: number | null;
}

export interface AccountingInput {
  operation: string;
  ts: string;
  level?: string;
  tenantId: string;
  userId: string;
  correlationId: string;
  outcome?: string;
  authDecision?: unknown;
  scopeUsed?: string;
  detail?: unknown;
  /** R0.3 (#327): catalog error code at emission (AspectEvent.errorCode). */
  errorCode?: string | null;
  /** R0.3 (#327): measured duration at emission (AspectEvent.durationMs). */
  durationMs?: number | null;
}

export interface PurgeReport {
  strippedDetail: number;
  deletedEvents: number;
  deletedSessions: number;
}

/** Dashboard session: 24h sliding window (owner-adopted §8 defaults). */
export const SESSION_SLIDING_MS = 86400000;
/** Dashboard session: 7-day absolute ceiling (owner-adopted §8 defaults). */
export const SESSION_ABSOLUTE_MS = 604800000;
/** Accounting hot window: detail (may carry PII) stripped past this. */
export const ACCOUNTING_HOT_DAYS = 30;
/** Accounting cold window: rows deleted past this. */
export const ACCOUNTING_COLD_DAYS = 90;

const USER_COLUMNS =
  `id, primary_email AS primaryEmail, created_at AS createdAt, last_seen_at AS lastSeenAt`;
const SESSION_COLUMNS =
  `id, user_id AS userId, token_hash AS tokenHash, created_at AS createdAt, ` +
  `expires_at AS expiresAt, absolute_expiry AS absoluteExpiry, rotated_at AS rotatedAt, revoked`;
const ACCOUNTING_COLUMNS =
  `id, operation, ts, level, tenant_id AS tenantId, user_id AS userId, ` +
  `correlation_id AS correlationId, outcome, auth_decision AS authDecision, ` +
  `scope_used AS scopeUsed, detail, error_code AS errorCode, duration_ms AS durationMs`;

export function ensureIdentitySchema(db: SqlDb): void {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    primary_email TEXT,
    created_at TEXT,
    last_seen_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS identities (
    user_id TEXT,
    provider TEXT,
    provider_subject TEXT,
    login TEXT,
    linked_at TEXT,
    PRIMARY KEY (provider, provider_subject)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    token_hash TEXT UNIQUE,
    created_at TEXT,
    expires_at TEXT,
    absolute_expiry TEXT,
    rotated_at TEXT,
    revoked INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS fga_tuples (
    subject_type TEXT,
    subject_id TEXT,
    relation TEXT,
    object_type TEXT,
    object_id TEXT,
    created_at TEXT,
    PRIMARY KEY (subject_type, subject_id, relation, object_type, object_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS accounting_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT,
    ts TEXT,
    level TEXT,
    tenant_id TEXT,
    user_id TEXT,
    correlation_id TEXT,
    outcome TEXT,
    auth_decision TEXT,
    scope_used TEXT,
    detail TEXT,
    error_code TEXT,
    duration_ms REAL
  )`);
  // R0.3 (#327) additive upgrade: stores created before the error_code /
  // duration_ms columns existed keep their table (CREATE IF NOT EXISTS is
  // a no-op there), so add the columns explicitly. A duplicate-column
  // error means the upgrade already landed — that is the only failure
  // mode swallowed, and the columns' presence is proven by the write
  // path below on every append.
  for (const ddl of [
    `ALTER TABLE accounting_events ADD COLUMN error_code TEXT`,
    `ALTER TABLE accounting_events ADD COLUMN duration_ms REAL`,
  ]) {
    try {
      db.run(ddl);
    } catch {
      /* column already present */
    }
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_accounting_tenant_ts ON accounting_events (tenant_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_accounting_user_ts ON accounting_events (user_id, ts)`);
}

/** tenant = user 1:1 for v1, except the pseudo-identity "operator". */
export function tenantForUser(userId: string): string {
  return userId === "operator" ? "operator" : userId;
}

/** SHA-256 hex of a bearer token. Only the hash is ever stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mintSessionToken(): string {
  return "sess_" + crypto.randomUUID().replace(/-/g, "");
}

function scalarCount(db: SqlDb, sql: string, ...params: unknown[]): number {
  const rows = db.all<{ n: number }>(sql, ...params);
  return Number(rows[0]?.n ?? 0);
}

function getUserRow(db: SqlDb, userId: string): UserRecord | null {
  const rows = db.all<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId);
  return rows[0] ?? null;
}

/**
 * Find the user anchored at (provider, subject), or create one.
 * The identity anchor is (provider, provider_subject) — email is NEVER the
 * key, so an email change on the same provider subject does not fork.
 */
export function findOrCreateUser(
  db: SqlDb,
  provider: string,
  subject: string,
  profile: { login?: string | null; email?: string | null; name?: string | null },
  nowMs: number = Date.now(),
): { user: UserRecord; created: boolean } {
  const nowIso = new Date(nowMs).toISOString();
  const linked = db.all<{ user_id: string }>(
    `SELECT user_id FROM identities WHERE provider = ? AND provider_subject = ?`,
    provider,
    subject,
  );
  if (linked.length > 0) {
    const userId = linked[0].user_id;
    const existing = getUserRow(db, userId);
    if (existing) {
      const email = profile.email ?? null;
      db.run(`UPDATE users SET last_seen_at = ? WHERE id = ?`, nowIso, userId);
      existing.lastSeenAt = nowIso;
      if (email !== null && email !== existing.primaryEmail) {
        db.run(`UPDATE users SET primary_email = ? WHERE id = ?`, email, userId);
        existing.primaryEmail = email;
      }
      return { user: existing, created: false };
    }
    // Identity row points at a missing user row (should not happen):
    // repair by recreating the user under the same id.
    const repaired: UserRecord = {
      id: userId,
      primaryEmail: profile.email ?? null,
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };
    db.run(
      `INSERT OR IGNORE INTO users (id, primary_email, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      repaired.id,
      repaired.primaryEmail,
      repaired.createdAt,
      repaired.lastSeenAt,
    );
    return { user: repaired, created: false };
  }
  const user: UserRecord = {
    id: "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    primaryEmail: profile.email ?? null,
    createdAt: nowIso,
    lastSeenAt: nowIso,
  };
  db.run(
    `INSERT INTO users (id, primary_email, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
    user.id,
    user.primaryEmail,
    user.createdAt,
    user.lastSeenAt,
  );
  db.run(
    `INSERT OR IGNORE INTO identities (user_id, provider, provider_subject, login, linked_at) VALUES (?, ?, ?, ?, ?)`,
    user.id,
    provider,
    subject,
    profile.login ?? null,
    nowIso,
  );
  return { user, created: true };
}

/**
 * Explicitly link a second (provider, subject) identity to an existing
 * user. Signed-in-only enforcement is the caller's job.
 */
export function linkIdentity(
  db: SqlDb,
  userId: string,
  provider: string,
  subject: string,
  login?: string | null,
  nowMs: number = Date.now(),
): void {
  db.run(
    `INSERT OR IGNORE INTO identities (user_id, provider, provider_subject, login, linked_at) VALUES (?, ?, ?, ?, ?)`,
    userId,
    provider,
    subject,
    login ?? null,
    new Date(nowMs).toISOString(),
  );
}

export function listIdentities(
  db: SqlDb,
  userId: string,
): { provider: string; subject: string; login: string | null }[] {
  return db.all<{ provider: string; subject: string; login: string | null }>(
    `SELECT provider, provider_subject AS subject, login FROM identities WHERE user_id = ?`,
    userId,
  );
}

function mintSessionRow(
  db: SqlDb,
  userId: string,
  tokenHash: string,
  nowMs: number,
): SessionRecord {
  const nowIso = new Date(nowMs).toISOString();
  const record: SessionRecord = {
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    createdAt: nowIso,
    expiresAt: new Date(nowMs + SESSION_SLIDING_MS).toISOString(),
    absoluteExpiry: new Date(nowMs + SESSION_ABSOLUTE_MS).toISOString(),
    rotatedAt: null,
    revoked: 0,
  };
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, absolute_expiry, rotated_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.userId,
    record.tokenHash,
    record.createdAt,
    record.expiresAt,
    record.absoluteExpiry,
    record.rotatedAt,
    record.revoked,
  );
  return record;
}

/**
 * Complete a login: find-or-create the user, seed the tenant tuple for a
 * brand-new user, and mint an opaque bearer session token.
 */
export async function loginComplete(
  db: SqlDb,
  provider: string,
  subject: string,
  profile: { login?: string | null; email?: string | null; name?: string | null },
  opts?: { nowMs?: number },
): Promise<{ user: UserRecord; created: boolean; session: { token: string; record: SessionRecord } }> {
  const nowMs = opts?.nowMs ?? Date.now();
  const { user, created } = findOrCreateUser(db, provider, subject, profile, nowMs);
  if (created) {
    addTuple(db, "user", user.id, "owner", "tenant", user.id, nowMs);
  }
  const token = mintSessionToken();
  const record = mintSessionRow(db, user.id, await hashToken(token), nowMs);
  return { user, created, session: { token, record } };
}

/**
 * Validate a bearer token. Never throws on bad input — returns null for
 * unknown, revoked, or expired tokens. On success the sliding window
 * renews (capped at the absolute expiry).
 */
export async function validateSessionToken(
  db: SqlDb,
  token: string,
  opts?: { nowMs?: number },
): Promise<{ session: SessionRecord; user: UserRecord } | null> {
  try {
    if (typeof token !== "string" || token.length === 0) return null;
    const nowMs = opts?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows = db.all<SessionRecord>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`,
      await hashToken(token),
    );
    const session = rows[0];
    if (!session) return null;
    if (session.revoked) return null;
    if (session.expiresAt <= nowIso) return null;
    if (session.absoluteExpiry <= nowIso) return null;
    const absoluteMs = Date.parse(session.absoluteExpiry);
    const capped = Math.min(nowMs + SESSION_SLIDING_MS, absoluteMs);
    if (capped > Date.parse(session.expiresAt)) {
      const renewed = new Date(capped).toISOString();
      db.run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, renewed, session.id);
      session.expiresAt = renewed;
    }
    const user = getUserRow(db, session.userId);
    if (!user) return null;
    return { session, user };
  } catch {
    return null;
  }
}

/**
 * Rotate a session: validate the old token, revoke it (rotated_at set),
 * and mint a fresh token for the same user.
 */
export async function rotateSessionToken(
  db: SqlDb,
  token: string,
  opts?: { nowMs?: number },
): Promise<{ token: string; session: SessionRecord } | null> {
  try {
    const nowMs = opts?.nowMs ?? Date.now();
    const validated = await validateSessionToken(db, token, { nowMs });
    if (!validated) return null;
    const newToken = mintSessionToken();
    const record = mintSessionRow(db, validated.user.id, await hashToken(newToken), nowMs);
    db.run(
      `UPDATE sessions SET revoked = 1, rotated_at = ? WHERE id = ?`,
      new Date(nowMs).toISOString(),
      validated.session.id,
    );
    return { token: newToken, session: record };
  } catch {
    return null;
  }
}

/** Revoke one session token. Returns true when a session row existed. */
export async function revokeSessionToken(
  db: SqlDb,
  token: string,
  opts?: { nowMs?: number },
): Promise<boolean> {
  try {
    if (typeof token !== "string" || token.length === 0) return false;
    void (opts?.nowMs ?? Date.now());
    const rows = db.all<{ id: string; revoked: number }>(
      `SELECT id, revoked FROM sessions WHERE token_hash = ?`,
      await hashToken(token),
    );
    if (rows.length === 0) return false;
    if (!rows[0].revoked) {
      db.run(`UPDATE sessions SET revoked = 1 WHERE id = ?`, rows[0].id);
    }
    return true;
  } catch {
    return false;
  }
}

/** Revoke every live session of a user. Returns the number revoked. */
export async function revokeAllUserSessions(
  db: SqlDb,
  userId: string,
  opts?: { nowMs?: number },
): Promise<number> {
  try {
    void (opts?.nowMs ?? Date.now());
    const n = scalarCount(
      db,
      `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked = 0`,
      userId,
    );
    if (n > 0) {
      db.run(`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0`, userId);
    }
    return n;
  } catch {
    return 0;
  }
}

/** FGA check: exact tuple match; deny-by-default (false when absent). */
export function checkTuple(
  db: SqlDb,
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
): boolean {
  const rows = db.all(
    `SELECT 1 FROM fga_tuples WHERE subject_type = ? AND subject_id = ? AND relation = ? AND object_type = ? AND object_id = ?`,
    subjectType,
    subjectId,
    relation,
    objectType,
    objectId,
  );
  return rows.length > 0;
}

/** FGA write: idempotent (INSERT OR IGNORE on the full-tuple PK). */
export function addTuple(
  db: SqlDb,
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
  nowMs: number = Date.now(),
): void {
  db.run(
    `INSERT OR IGNORE INTO fga_tuples (subject_type, subject_id, relation, object_type, object_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    subjectType,
    subjectId,
    relation,
    objectType,
    objectId,
    new Date(nowMs).toISOString(),
  );
}

/**
 * Seed the operator's tuples. The pseudo-identity ("identity","operator")
 * always owns the operator tenant; when a concrete operator user id is
 * known it is also granted ownership.
 */
export function seedOperatorTuples(
  db: SqlDb,
  operatorUserId: string | null,
  nowMs: number = Date.now(),
): void {
  addTuple(db, "identity", "operator", "owner", "tenant", "operator", nowMs);
  if (operatorUserId) {
    addTuple(db, "user", operatorUserId, "owner", "tenant", "operator", nowMs);
  }
}

/**
 * Append accounting events. Append-only: no UPDATE/DELETE of events
 * happens anywhere except the retention purge. authDecision and detail
 * are JSON-stringified (detail may be null). Returns the count written.
 */
export function appendAccounting(
  db: SqlDb,
  events: AccountingInput[],
  nowMs: number = Date.now(),
): number {
  void nowMs;
  let written = 0;
  for (const e of events) {
    db.run(
      `INSERT INTO accounting_events (operation, ts, level, tenant_id, user_id, correlation_id, outcome, auth_decision, scope_used, detail, error_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.operation,
      e.ts,
      e.level ?? "info",
      e.tenantId,
      e.userId,
      e.correlationId,
      e.outcome ?? "ok",
      e.authDecision === undefined ? null : JSON.stringify(e.authDecision),
      e.scopeUsed ?? null,
      e.detail === undefined || e.detail === null ? null : JSON.stringify(e.detail),
      // R0.3 (#327): the sink-side persistence fix — before this, the
      // AspectEvent's errorCode/durationMs were dropped at this boundary
      // even though every producer set them. Only sane values persist:
      // a non-empty string code, a finite non-negative duration.
      typeof e.errorCode === "string" && e.errorCode ? e.errorCode : null,
      typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0
        ? e.durationMs
        : null,
    );
    written++;
  }
  return written;
}

interface AccountingFilters {
  tenantId?: string;
  userId?: string;
  /** Matches the operation prefix before "." (e.g. "authn" matches "authn.success"). */
  eventClass?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * Query accounting events, newest first. Default limit 100, max 1000.
 */
export function queryAccounting(db: SqlDb, filters: AccountingFilters): AccountingRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.tenantId !== undefined) {
    where.push(`tenant_id = ?`);
    params.push(filters.tenantId);
  }
  if (filters.userId !== undefined) {
    where.push(`user_id = ?`);
    params.push(filters.userId);
  }
  if (filters.eventClass !== undefined) {
    where.push(`(operation = ? OR operation LIKE ?)`);
    params.push(filters.eventClass, `${filters.eventClass}.%`);
  }
  if (filters.from !== undefined) {
    where.push(`ts >= ?`);
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    where.push(`ts <= ?`);
    params.push(filters.to);
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  params.push(limit);
  const sql =
    `SELECT ${ACCOUNTING_COLUMNS} FROM accounting_events` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ts DESC, id DESC LIMIT ?`;
  return db.all<AccountingRow>(sql, ...params);
}

/** A user's own accounting records only. */
export function myActivity(
  db: SqlDb,
  userId: string,
  opts?: { limit?: number; eventClass?: string },
): AccountingRow[] {
  return queryAccounting(db, {
    userId,
    limit: opts?.limit,
    eventClass: opts?.eventClass,
  });
}

/**
 * Retention purge (§8): (a) strip detail (PII) from events older than
 * hotDays; (b) delete events older than coldDays; (c) delete revoked or
 * expired sessions older than coldDays; (d) account the purge itself with
 * an "accounting.purge" row so the purge is itself accounted.
 */
export function runRetentionPurge(
  db: SqlDb,
  opts?: { nowMs?: number; hotDays?: number; coldDays?: number },
): PurgeReport {
  const nowMs = opts?.nowMs ?? Date.now();
  const hotDays = opts?.hotDays ?? ACCOUNTING_HOT_DAYS;
  const coldDays = opts?.coldDays ?? ACCOUNTING_COLD_DAYS;
  const nowIso = new Date(nowMs).toISOString();
  const hotCutoff = new Date(nowMs - hotDays * 86400000).toISOString();
  const coldCutoff = new Date(nowMs - coldDays * 86400000).toISOString();

  const strippedDetail = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM accounting_events WHERE ts < ? AND detail IS NOT NULL`,
    hotCutoff,
  );
  db.run(
    `UPDATE accounting_events SET detail = NULL WHERE ts < ? AND detail IS NOT NULL`,
    hotCutoff,
  );

  const deletedEvents = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM accounting_events WHERE ts < ?`,
    coldCutoff,
  );
  db.run(`DELETE FROM accounting_events WHERE ts < ?`, coldCutoff);

  const deletedSessions = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM sessions WHERE (revoked = 1 OR expires_at < ? OR absolute_expiry < ?) AND created_at < ?`,
    nowIso,
    nowIso,
    coldCutoff,
  );
  db.run(
    `DELETE FROM sessions WHERE (revoked = 1 OR expires_at < ? OR absolute_expiry < ?) AND created_at < ?`,
    nowIso,
    nowIso,
    coldCutoff,
  );

  const report: PurgeReport = { strippedDetail, deletedEvents, deletedSessions };
  appendAccounting(
    db,
    [
      {
        operation: "accounting.purge",
        ts: nowIso,
        level: "info",
        tenantId: "operator",
        userId: "operator",
        correlationId: crypto.randomUUID(),
        outcome: "ok",
        detail: report,
      },
    ],
    nowMs,
  );
  return report;
}

export interface FgaTupleView {
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}

/**
 * List every tuple on one object. The trade-approval workflow uses this
 * for its integrity check: execution requires an approver tuple to exist
 * for the proposal, no matter which subject holds it (the route that
 * seeded it already verified tenant ownership).
 */
export function listTuplesForObject(
  db: SqlDb,
  objectType: string,
  objectId: string,
): FgaTupleView[] {
  return db.all<FgaTupleView>(
    `SELECT subject_type AS subjectType, subject_id AS subjectId, relation, ` +
      `object_type AS objectType, object_id AS objectId FROM fga_tuples ` +
      `WHERE object_type = ? AND object_id = ?`,
    objectType,
    objectId,
  );
}
