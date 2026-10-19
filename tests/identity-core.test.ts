/**
 * Tests for src/identity-core.ts (issue #252 P2, IAAA Identity).
 *
 * Runs against the in-memory FakeDb (tests/identity-fake-db.ts); the core
 * module is SDK-free so it imports directly. Time is injected via nowMs
 * everywhere the core accepts it, so sliding/absolute windows and the
 * retention purge are deterministic.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  SESSION_SLIDING_MS,
  SESSION_ABSOLUTE_MS,
  ACCOUNTING_HOT_DAYS,
  ACCOUNTING_COLD_DAYS,
  ensureIdentitySchema,
  tenantForUser,
  findOrCreateUser,
  linkIdentity,
  listIdentities,
  loginComplete,
  hashToken,
  validateSessionToken,
  rotateSessionToken,
  revokeSessionToken,
  revokeAllUserSessions,
  checkTuple,
  addTuple,
  seedOperatorTuples,
  appendAccounting,
  queryAccounting,
  myActivity,
  runRetentionPurge,
  type AccountingInput,
} from "../src/identity-core";
import { makeDb } from "./identity-fake-db";

const T0 = Date.parse("2026-10-18T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600000;
const DAY = 86400000;

function freshDb() {
  const db = makeDb();
  ensureIdentitySchema(db);
  return db;
}

function seedEvent(
  db: ReturnType<typeof freshDb>,
  overrides: Partial<AccountingInput> & { operation: string; ts: string },
): void {
  appendAccounting(db, [
    {
      level: "info",
      tenantId: "t1",
      userId: "u1",
      correlationId: "c1",
      outcome: "ok",
      ...overrides,
    },
  ]);
}

describe("constants and tenancy", () => {
  it("adopts the owner-approved session and retention windows", () => {
    expect(SESSION_SLIDING_MS).toBe(86400000);
    expect(SESSION_ABSOLUTE_MS).toBe(604800000);
    expect(ACCOUNTING_HOT_DAYS).toBe(30);
    expect(ACCOUNTING_COLD_DAYS).toBe(90);
  });

  it("tenantForUser maps 1:1 except the operator pseudo-identity", () => {
    expect(tenantForUser("usr_abc123")).toBe("usr_abc123");
    expect(tenantForUser("operator")).toBe("operator");
  });
});

describe("findOrCreateUser", () => {
  it("creates a new user anchored at (provider, subject)", async () => {
    const db = freshDb();
    const { user, created } = findOrCreateUser(
      db,
      "github",
      "123",
      { login: "octo", email: "a@example.com", name: "A" },
      T0,
    );
    expect(created).toBe(true);
    expect(user.id).toMatch(/^usr_[0-9a-f]{8}$/);
    expect(user.primaryEmail).toBe("a@example.com");
    expect(user.createdAt).toBe(iso(T0));
    expect(user.lastSeenAt).toBe(iso(T0));
  });

  it("returns the same user for the same provider+subject (no fork)", () => {
    const db = freshDb();
    const first = findOrCreateUser(db, "github", "123", { email: "a@example.com" }, T0);
    const second = findOrCreateUser(db, "github", "123", { email: "a@example.com" }, T0 + HOUR);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.lastSeenAt).toBe(iso(T0 + HOUR));
  });

  it("an email change on the same provider subject does not fork the user", () => {
    const db = freshDb();
    const first = findOrCreateUser(db, "google", "g-1", { email: "old@example.com" }, T0);
    const second = findOrCreateUser(
      db,
      "google",
      "g-1",
      { email: "new@example.com" },
      T0 + HOUR,
    );
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.primaryEmail).toBe("new@example.com");
  });

  it("the same email under a different provider is a different user (email never the key)", () => {
    const db = freshDb();
    const a = findOrCreateUser(db, "github", "123", { email: "same@example.com" }, T0);
    const b = findOrCreateUser(db, "google", "456", { email: "same@example.com" }, T0);
    expect(b.created).toBe(true);
    expect(b.user.id).not.toBe(a.user.id);
  });
});

describe("linkIdentity / listIdentities", () => {
  it("explicitly links a second provider to the same user", () => {
    const db = freshDb();
    const { user } = findOrCreateUser(db, "github", "123", { login: "octo" }, T0);
    linkIdentity(db, user.id, "google", "g-9", "octo@gmail", T0 + HOUR);
    const ids = listIdentities(db, user.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContainEqual({ provider: "github", subject: "123", login: "octo" });
    expect(ids).toContainEqual({ provider: "google", subject: "g-9", login: "octo@gmail" });
  });

  it("a linked identity resolves to the original user on next login", () => {
    const db = freshDb();
    const { user } = findOrCreateUser(db, "github", "123", {}, T0);
    linkIdentity(db, user.id, "google", "g-9", null, T0);
    const again = findOrCreateUser(db, "google", "g-9", {}, T0 + HOUR);
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(user.id);
  });

  it("linking is idempotent", () => {
    const db = freshDb();
    const { user } = findOrCreateUser(db, "github", "123", {}, T0);
    linkIdentity(db, user.id, "google", "g-9", null, T0);
    linkIdentity(db, user.id, "google", "g-9", null, T0);
    expect(listIdentities(db, user.id)).toHaveLength(2);
  });
});

describe("loginComplete and sessions", () => {
  it("mints an opaque token and stores only its SHA-256 hash", async () => {
    const db = freshDb();
    const { user, created, session } = await loginComplete(
      db,
      "github",
      "123",
      { email: "a@example.com" },
      { nowMs: T0 },
    );
    expect(created).toBe(true);
    expect(session.token).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(session.record.tokenHash).toBe(await hashToken(session.token));
    expect(session.record.tokenHash).not.toContain(session.token);
    expect(session.record.userId).toBe(user.id);
    expect(session.record.expiresAt).toBe(iso(T0 + SESSION_SLIDING_MS));
    expect(session.record.absoluteExpiry).toBe(iso(T0 + SESSION_ABSOLUTE_MS));
    expect(session.record.revoked).toBe(0);
    expect(session.record.rotatedAt).toBeNull();
  });

  it("seeds the tenant tuple for a new user", async () => {
    const db = freshDb();
    const { user } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    expect(checkTuple(db, "user", user.id, "owner", "tenant", user.id)).toBe(true);
  });

  it("validateSessionToken returns the session and user for a live token", async () => {
    const db = freshDb();
    const { user, session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    const v = await validateSessionToken(db, session.token, { nowMs: T0 + HOUR });
    expect(v).not.toBeNull();
    expect(v!.session.id).toBe(session.record.id);
    expect(v!.user.id).toBe(user.id);
  });

  it("rejects unknown, empty, and non-string tokens without throwing", async () => {
    const db = freshDb();
    expect(await validateSessionToken(db, "sess_nope", { nowMs: T0 })).toBeNull();
    expect(await validateSessionToken(db, "", { nowMs: T0 })).toBeNull();
    expect(await validateSessionToken(db, null as unknown as string, { nowMs: T0 })).toBeNull();
    expect(await validateSessionToken(db, 42 as unknown as string, { nowMs: T0 })).toBeNull();
  });

  it("slides the expiry forward on use within the window", async () => {
    const db = freshDb();
    const { session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    const v = await validateSessionToken(db, session.token, { nowMs: T0 + 23 * HOUR });
    expect(v).not.toBeNull();
    expect(v!.session.expiresAt).toBe(iso(T0 + 23 * HOUR + SESSION_SLIDING_MS));
  });

  it("returns null after 24h of idle (no sliding renewal)", async () => {
    const db = freshDb();
    const { session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    // Last use at T0; idle past the 24h sliding window.
    expect(
      await validateSessionToken(db, session.token, { nowMs: T0 + 24 * HOUR + 1 }),
    ).toBeNull();
  });

  it("caps the sliding renewal at the 7-day absolute expiry", async () => {
    const db = freshDb();
    const { session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    // Keep the session alive with use inside every 24h sliding window. The
    // final use at 150h would renew to 174h, past the 168h absolute ceiling.
    let v = null;
    for (const h of [23, 46, 69, 92, 115, 138, 150]) {
      v = await validateSessionToken(db, session.token, { nowMs: T0 + h * HOUR });
      expect(v).not.toBeNull();
    }
    expect(v!.session.expiresAt).toBe(iso(T0 + SESSION_ABSOLUTE_MS));
  });

  it("returns null past the 7-day absolute expiry even with recent use", async () => {
    const db = freshDb();
    const { session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    expect(
      await validateSessionToken(db, session.token, { nowMs: T0 + 7 * DAY + 1000 }),
    ).toBeNull();
  });
});

describe("rotation and revocation", () => {
  it("rotates: old token dies, new token works for the same user", async () => {
    const db = freshDb();
    const { user, session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    const rotated = await rotateSessionToken(db, session.token, { nowMs: T0 + HOUR });
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(session.token);
    expect(rotated!.session.userId).toBe(user.id);
    expect(
      await validateSessionToken(db, session.token, { nowMs: T0 + 2 * HOUR }),
    ).toBeNull();
    const v = await validateSessionToken(db, rotated!.token, { nowMs: T0 + 2 * HOUR });
    expect(v).not.toBeNull();
    expect(v!.user.id).toBe(user.id);
  });

  it("rotation fails on an unknown token", async () => {
    const db = freshDb();
    expect(await rotateSessionToken(db, "sess_nope", { nowMs: T0 })).toBeNull();
  });

  it("revocation kills the token and reports existence", async () => {
    const db = freshDb();
    const { session } = await loginComplete(db, "github", "123", {}, { nowMs: T0 });
    expect(await revokeSessionToken(db, session.token)).toBe(true);
    expect(await validateSessionToken(db, session.token, { nowMs: T0 + HOUR })).toBeNull();
    expect(await revokeSessionToken(db, "sess_unknown")).toBe(false);
  });

  it("revokeAllUserSessions revokes every live session and returns the count", async () => {
    const db = freshDb();
    const a = await loginComplete(db, "github", "a", {}, { nowMs: T0 });
    const b = await loginComplete(db, "github", "a", {}, { nowMs: T0 + HOUR });
    await loginComplete(db, "github", "b", {}, { nowMs: T0 });
    // Revoke one of a's sessions first so only live ones count.
    await revokeSessionToken(db, a.session.token);
    const n = await revokeAllUserSessions(db, a.user.id);
    expect(n).toBe(1);
    expect(await validateSessionToken(db, b.session.token, { nowMs: T0 + 2 * HOUR })).toBeNull();
    expect(await revokeAllUserSessions(db, a.user.id)).toBe(0);
  });
});

describe("FGA tuples", () => {
  it("denies by default and allows after addTuple", () => {
    const db = freshDb();
    expect(checkTuple(db, "user", "u1", "owner", "tenant", "u1")).toBe(false);
    addTuple(db, "user", "u1", "owner", "tenant", "u1", T0);
    expect(checkTuple(db, "user", "u1", "owner", "tenant", "u1")).toBe(true);
    // Near misses still deny.
    expect(checkTuple(db, "user", "u1", "viewer", "tenant", "u1")).toBe(false);
    expect(checkTuple(db, "user", "u1", "owner", "tenant", "u2")).toBe(false);
  });

  it("addTuple is idempotent", () => {
    const db = freshDb();
    addTuple(db, "user", "u1", "owner", "tenant", "u1", T0);
    addTuple(db, "user", "u1", "owner", "tenant", "u1", T0);
    expect(checkTuple(db, "user", "u1", "owner", "tenant", "u1")).toBe(true);
  });

  it("seedOperatorTuples always seeds the pseudo-identity tuple", () => {
    const db = freshDb();
    seedOperatorTuples(db, null, T0);
    expect(checkTuple(db, "identity", "operator", "owner", "tenant", "operator")).toBe(true);
    expect(checkTuple(db, "user", "u9", "owner", "tenant", "operator")).toBe(false);
  });

  it("seedOperatorTuples also grants a concrete operator user id", () => {
    const db = freshDb();
    seedOperatorTuples(db, "usr_op1", T0);
    expect(checkTuple(db, "identity", "operator", "owner", "tenant", "operator")).toBe(true);
    expect(checkTuple(db, "user", "usr_op1", "owner", "tenant", "operator")).toBe(true);
  });
});

describe("accounting", () => {
  it("appends events and returns the count written", () => {
    const db = freshDb();
    const n = appendAccounting(db, [
      {
        operation: "authn.success",
        ts: iso(T0),
        tenantId: "u1",
        userId: "u1",
        correlationId: "c1",
        detail: { provider: "github" },
      },
      {
        operation: "authz.deny",
        ts: iso(T0 + 1),
        level: "warn",
        tenantId: "u1",
        userId: "u1",
        correlationId: "c2",
        outcome: "denied",
        authDecision: { relation: "owner", object: "tenant:u1", allow: false },
        scopeUsed: "desk.read",
      },
    ]);
    expect(n).toBe(2);
    const rows = queryAccounting(db, {});
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.operation === "authn.success")!;
    expect(first.level).toBe("info"); // default
    expect(first.outcome).toBe("ok"); // default
    expect(first.detail).toBe(JSON.stringify({ provider: "github" }));
    const deny = rows.find((r) => r.operation === "authz.deny")!;
    expect(JSON.parse(deny.authDecision!)).toEqual({
      relation: "owner",
      object: "tenant:u1",
      allow: false,
    });
    expect(deny.scopeUsed).toBe("desk.read");
  });

  it("returns rows newest first", () => {
    const db = freshDb();
    seedEvent(db, { operation: "a.one", ts: iso(T0) });
    seedEvent(db, { operation: "a.two", ts: iso(T0 + 1000) });
    seedEvent(db, { operation: "a.three", ts: iso(T0 + 2000) });
    const ops = queryAccounting(db, {}).map((r) => r.operation);
    expect(ops).toEqual(["a.three", "a.two", "a.one"]);
  });

  it("filters by tenant, user, eventClass prefix, and time range", () => {
    const db = freshDb();
    appendAccounting(db, [
      { operation: "authn.success", ts: iso(T0), tenantId: "t1", userId: "u1", correlationId: "c1" },
      { operation: "authn.failure", ts: iso(T0 + 1), tenantId: "t1", userId: "u2", correlationId: "c2" },
      { operation: "session.mint", ts: iso(T0 + 2), tenantId: "t2", userId: "u1", correlationId: "c3" },
      { operation: "ai.spend", ts: iso(T0 + 3), tenantId: "t1", userId: "u1", correlationId: "c4" },
    ]);
    expect(queryAccounting(db, { tenantId: "t1" })).toHaveLength(3);
    expect(queryAccounting(db, { userId: "u2" })).toHaveLength(1);
    expect(queryAccounting(db, { eventClass: "authn" })).toHaveLength(2);
    expect(queryAccounting(db, { eventClass: "authn.success" })).toHaveLength(1);
    expect(
      queryAccounting(db, { from: iso(T0 + 1), to: iso(T0 + 2) }),
    ).toHaveLength(2);
    expect(queryAccounting(db, { tenantId: "t1", eventClass: "ai" })).toHaveLength(1);
  });

  it("enforces the default and max limits", () => {
    const db = freshDb();
    for (let i = 0; i < 120; i++) {
      seedEvent(db, { operation: `e.${i}`, ts: iso(T0 + i) });
    }
    expect(queryAccounting(db, {})).toHaveLength(100);
    expect(queryAccounting(db, { limit: 5 })).toHaveLength(5);
    expect(queryAccounting(db, { limit: 5000 })).toHaveLength(120);
  });

  it("myActivity returns only the caller's own records", () => {
    const db = freshDb();
    appendAccounting(db, [
      { operation: "authn.success", ts: iso(T0), tenantId: "u1", userId: "u1", correlationId: "c1" },
      { operation: "authn.success", ts: iso(T0 + 1), tenantId: "u2", userId: "u2", correlationId: "c2" },
      { operation: "session.mint", ts: iso(T0 + 2), tenantId: "u1", userId: "u1", correlationId: "c3" },
    ]);
    const mine = myActivity(db, "u1");
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.userId === "u1")).toBe(true);
    expect(myActivity(db, "u1", { eventClass: "session" })).toHaveLength(1);
  });
});

describe("runRetentionPurge", () => {
  function seedPurgeScenario(db: ReturnType<typeof freshDb>) {
    const old = T0 - 100 * DAY;
    const warm = T0 - 40 * DAY;
    const fresh = T0 - 10 * DAY;
    // detail-carrying events: old (cold), warm (hot-expired), fresh (hot)
    seedEvent(db, { operation: "authn.success", ts: iso(old), detail: { pii: "old" } });
    seedEvent(db, { operation: "authn.success", ts: iso(warm), detail: { pii: "warm" } });
    seedEvent(db, { operation: "authn.success", ts: iso(fresh), detail: { pii: "fresh" } });
    seedEvent(db, { operation: "authn.success", ts: iso(fresh + 1) }); // no detail
    // sessions: old revoked (purged), old live (kept — not revoked/expired),
    // recent revoked (kept — younger than cold window)
    const mk = async (loginMs: number, revoke: boolean) => {
      const { session } = await loginComplete(db, "github", `s-${loginMs}-${revoke}`, {}, { nowMs: loginMs });
      if (revoke) await revokeSessionToken(db, session.token);
      return session;
    };
    return mk;
  }

  it("strips detail past 30d, deletes events past 90d, deletes old dead sessions, and accounts itself", async () => {
    const db = freshDb();
    const mk = seedPurgeScenario(db);
    const oldRevoked = await mk(T0 - 100 * DAY, true);
    await mk(T0 - 100 * DAY, false); // old but live: expiresAt slides from its own era...
    const recentRevoked = await mk(T0 - 10 * DAY, true);

    const report = runRetentionPurge(db, { nowMs: T0 });
    expect(report.strippedDetail).toBe(2); // old + warm details stripped
    expect(report.deletedEvents).toBe(1); // the 100d event
    // old revoked + recent revoked? No: recent revoked is 10d old (< 90d) → kept.
    // The old live session: created 100d ago and (its expiry was T0-100d+24h)
    // is expired → deleted.
    expect(report.deletedSessions).toBe(2);

    // Warm (40d) event survives with detail stripped; fresh keeps detail.
    const warm = queryAccounting(db, { from: iso(T0 - 41 * DAY), to: iso(T0 - 39 * DAY) });
    expect(warm).toHaveLength(1);
    expect(warm[0].detail).toBeNull();
    const freshRows = queryAccounting(db, { from: iso(T0 - 11 * DAY) });
    const freshDetail = freshRows.find((r) => r.detail !== null && r.operation !== "accounting.purge");
    expect(freshDetail).toBeDefined();
    expect(JSON.parse(freshDetail!.detail!)).toEqual({ pii: "fresh" });

    // Old dead sessions are gone; recent revoked session survives.
    expect(
      db.all(`SELECT id FROM sessions WHERE id = ?`, oldRevoked.record.id),
    ).toHaveLength(0);
    expect(
      db.all(`SELECT id FROM sessions WHERE id = ?`, recentRevoked.record.id),
    ).toHaveLength(1);

    // The purge accounts itself: an accounting.purge row from operator.
    const purgeRows = queryAccounting(db, { eventClass: "accounting" });
    expect(purgeRows).toHaveLength(1);
    expect(purgeRows[0].operation).toBe("accounting.purge");
    expect(purgeRows[0].userId).toBe("operator");
    expect(purgeRows[0].tenantId).toBe("operator");
    expect(JSON.parse(purgeRows[0].detail!)).toEqual(report);
  });

  it("is a no-op on an empty store except for its own accounting row", () => {
    const db = freshDb();
    const report = runRetentionPurge(db, { nowMs: T0 });
    expect(report).toEqual({ strippedDetail: 0, deletedEvents: 0, deletedSessions: 0 });
    expect(queryAccounting(db, {})).toHaveLength(1);
  });

  it("honors custom hot/cold windows", () => {
    const db = freshDb();
    seedEvent(db, { operation: "authn.success", ts: iso(T0 - 5 * DAY), detail: { pii: "x" } });
    const report = runRetentionPurge(db, { nowMs: T0, hotDays: 1, coldDays: 10 });
    expect(report.strippedDetail).toBe(1);
    expect(report.deletedEvents).toBe(0);
  });
});
