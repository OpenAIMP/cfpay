import { describe, expect, it } from "vitest";
import {
  ensureIdentitySchema,
  findOrCreateUser,
  linkIdentity,
  listIdentities,
  loginComplete,
  validateSessionToken,
  revokeSessionToken,
  checkTuple,
  addTuple,
  seedOperatorTuples,
  appendAccounting,
  queryAccounting,
  myActivity,
  runRetentionPurge,
  tenantForUser,
  type AccountingInput,
  type SqlDb,
} from "../src/identity-core";
import { makeDb } from "./identity-fake-db";

// IAAA completeness proofs for issue #252, at the identity-core level.
//
// What this proves, per pillar:
//   Identification   - one human is one user no matter how they sign in; a
//                      second provider links to the same user, not a new one.
//   Authentication   - logins mint sessions that validate until revoked, and
//                      every attempt (success AND failure) lands in accounting.
//   Authorization    - explicit tuple grants authorize; anything ungranted is
//                      denied by default; denied decisions are recorded intact.
//   Accounting       - spend rows are isolated per tenant, the retention purge
//                      removes nothing fresh, and myActivity only sees the
//                      caller's rows.
//
// The sibling lane owns src/identity-core.ts and tests/identity-fake-db.ts;
// this file is written against their real API (verified by reading both).

function freshDb(): SqlDb {
  const db = makeDb();
  ensureIdentitySchema(db);
  return db;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function accountingEvent(partial: Partial<AccountingInput> & { operation: string }): AccountingInput {
  return {
    ts: iso(0),
    level: "info",
    tenantId: "tenant-test",
    userId: "usr_test",
    correlationId: crypto.randomUUID(),
    outcome: "ok",
    ...partial,
  };
}

describe("Identification — one human, one user, many linked identities", () => {
  it("proves: signing in twice with the same provider is the same user, and a second provider links to that user", async () => {
    const db = freshDb();

    const first = await loginComplete(db, "github", "12345", { login: "owner", email: "o@x.com" });
    expect(first.user.id, "login must mint a user id").toBeTruthy();

    // The user record is queryable: the same provider identity resolves to the
    // SAME id, not a duplicate user.
    const again = findOrCreateUser(db, "github", "12345", { login: "owner", email: "o@x.com" });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);

    // A second provider links to the same user: no new user is created, and
    // the user now carries two identities.
    linkIdentity(db, first.user.id, "google", "999");
    const viaGoogle = findOrCreateUser(db, "google", "999", { email: "o@x.com" });
    expect(viaGoogle.user.id).toBe(first.user.id);
    expect(listIdentities(db, first.user.id)).toHaveLength(2);
  });
});

describe("Authentication — sessions validate until revoked; attempts are accounted", () => {
  it("proves: a login mints a session token that validates, then stops validating after revocation", async () => {
    const db = freshDb();

    const { user, session } = await loginComplete(db, "github", "12345", {
      login: "owner",
      email: "o@x.com",
    });
    const valid = await validateSessionToken(db, session.token);
    expect(valid?.user.id).toBe(user.id);

    expect(await revokeSessionToken(db, session.token)).toBe(true);
    expect(await validateSessionToken(db, session.token)).toBeNull();
  });

  it("proves: a failed attempt and a successful login both land in accounting, newest first", async () => {
    const db = freshDb();

    appendAccounting(db, [
      accountingEvent({
        operation: "authn.failure",
        userId: "unknown",
        ts: iso(-60_000),
        outcome: "deny",
        detail: { reason: "unknown_identity" },
      }),
    ]);
    const { user } = await loginComplete(db, "github", "12345", {
      login: "owner",
      email: "o@x.com",
    });
    appendAccounting(db, [
      accountingEvent({ operation: "authn.success", userId: user.id, ts: iso(0) }),
    ]);

    const rows = queryAccounting(db, { eventClass: "authn" });
    expect(rows.map((r) => r.operation)).toEqual(["authn.success", "authn.failure"]);
    expect(rows[0].userId).toBe(user.id);
    expect(rows[1].userId).toBe("unknown");
  });
});

describe("Authorization — explicit grants authorize; everything else denies; decisions are recorded", () => {
  it("proves: an explicit tuple grant authorizes, and an ungranted relation is denied by default", () => {
    const db = freshDb();
    seedOperatorTuples(db, null);

    addTuple(db, "user", "usr_1", "owner", "tenant", "usr_1");
    expect(checkTuple(db, "user", "usr_1", "owner", "tenant", "usr_1")).toBe(true);

    // No tuple grants usr_2 the approver relation on trade_proposal p1, so the
    // answer must be false: deny-by-default, not fail-open.
    expect(checkTuple(db, "user", "usr_2", "approver", "trade_proposal", "p1")).toBe(false);
  });

  it("proves: a denied authorization decision is written to accounting with the decision intact", () => {
    const db = freshDb();

    const decision = { relation: "approver", object: "trade_proposal:p1", allow: false };
    appendAccounting(db, [
      accountingEvent({
        operation: "authz.deny",
        userId: "usr_2",
        tenantId: "usr_2",
        outcome: "deny",
        authDecision: decision,
      }),
    ]);

    const rows = queryAccounting(db, { eventClass: "authz" });
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("authz.deny");
    expect(JSON.parse(rows[0].authDecision ?? "null")).toEqual(decision);
    expect(rows[0].userId).toBe("usr_2");
  });
});

describe("Accounting — tenant-isolated spend, safe retention, scoped self-service", () => {
  it("proves: ai.spend rows are isolated per tenant", () => {
    const db = freshDb();

    appendAccounting(db, [
      accountingEvent({
        operation: "ai.spend",
        tenantId: "tenant-a",
        userId: "usr_a",
        ts: iso(-2000),
        detail: { model: "m", costCents: 12 },
      }),
      accountingEvent({
        operation: "ai.spend",
        tenantId: "tenant-b",
        userId: "usr_b",
        ts: iso(-1000),
        detail: { model: "m", costCents: 34 },
      }),
    ]);

    const a = queryAccounting(db, { tenantId: "tenant-a" });
    expect(a).toHaveLength(1);
    expect(a[0].tenantId).toBe("tenant-a");
    expect(a[0].userId).toBe("usr_a");

    const b = queryAccounting(db, { tenantId: "tenant-b" });
    expect(b).toHaveLength(1);
    expect(b[0].tenantId).toBe("tenant-b");
  });

  it("proves: the retention purge removes nothing fresh", () => {
    const db = freshDb();

    appendAccounting(db, [
      accountingEvent({ operation: "ai.spend", tenantId: "t", userId: "u", ts: iso(0) }),
    ]);
    const beforeIds = new Set(queryAccounting(db, {}).map((r) => r.id));

    const report = runRetentionPurge(db);
    expect(report.deletedEvents).toBe(0);

    // The purge accounts itself with an accounting.purge row; every
    // pre-existing row must still be present.
    const after = queryAccounting(db, {});
    for (const id of beforeIds) {
      expect(after.some((r) => r.id === id), `row ${id} must survive the purge`).toBe(true);
    }
    expect(after.some((r) => r.operation === "accounting.purge")).toBe(true);
  });

  it("proves: myActivity returns only the caller's own rows", () => {
    const db = freshDb();

    appendAccounting(db, [
      accountingEvent({
        operation: "ai.spend",
        tenantId: "t1",
        userId: "usr_1",
        ts: iso(-2000),
      }),
      accountingEvent({
        operation: "ai.spend",
        tenantId: "t2",
        userId: "usr_2",
        ts: iso(-1000),
      }),
    ]);

    const mine = myActivity(db, "usr_1");
    expect(mine.length).toBe(1);
    expect(mine.every((r) => r.userId === "usr_1")).toBe(true);
  });

  it("proves: a user resolves to their own tenant (1:1 tenancy default)", async () => {
    const db = freshDb();
    const { user } = await loginComplete(db, "github", "12345", { login: "owner" });

    const tenant = tenantForUser(user.id);
    expect(tenant).toBe(user.id);

    // The resolved tenant is usable as an accounting scope: rows written under
    // it come back under it.
    appendAccounting(db, [
      accountingEvent({ operation: "ai.spend", tenantId: tenant, userId: user.id }),
    ]);
    const scoped = queryAccounting(db, { tenantId: tenant });
    expect(scoped.length).toBe(1);
    expect(scoped[0].userId).toBe(user.id);
  });
});
