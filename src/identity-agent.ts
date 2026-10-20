/**
 * IdentityAgent — issue #252 P2 (IAAA Identity). The identity Durable
 * Object: user registry, OAuth identity anchors, opaque session tokens,
 * FGA authorization tuples, and the append-only accounting store.
 *
 * This agent has no model loop, so it extends plain Agent (not Think).
 * All logic lives in the SDK-free src/identity-core.ts; this module is the
 * thin Worker-only wrapper adapting ctx.storage.sql to the SqlDb
 * interface. The schema is ensured lazily in each callable (cheap,
 * idempotent) so the first call after a migration is safe.
 */

import { Agent, callable } from "agents";
import type { Env } from "./types";
import { readLoopMetrics } from "./r0-metrics-core";
import {
  ensureIdentitySchema,
  loginComplete,
  validateSessionToken,
  rotateSessionToken,
  revokeSessionToken,
  revokeAllUserSessions,
  checkTuple,
  addTuple,
  listTuplesForObject,
  seedOperatorTuples,
  appendAccounting,
  queryAccounting,
  myActivity,
  runRetentionPurge,
  type SqlDb,
  type UserRecord,
  type AccountingInput,
} from "./identity-core";

export class IdentityAgent extends Agent<Env> {
  /** Adapt Durable Object SQL storage to the SDK-free SqlDb interface. */
  private idb(): SqlDb {
    const sql = this.ctx.storage.sql;
    return {
      run: (stmt: string, ...params: unknown[]): void => {
        sql.exec(stmt, ...params);
      },
      all: <T = Record<string, unknown>>(stmt: string, ...params: unknown[]): T[] => {
        return Array.from(sql.exec(stmt, ...params)) as unknown as T[];
      },
    };
  }

  private ensureSchema(): void {
    ensureIdentitySchema(this.idb());
  }

  @callable()
  async loginComplete(
    provider: string,
    subject: string,
    profile: { login?: string | null; email?: string | null; name?: string | null },
  ) {
    this.ensureSchema();
    return loginComplete(this.idb(), provider, subject, profile);
  }

  @callable()
  async validateSession(token: string) {
    this.ensureSchema();
    return validateSessionToken(this.idb(), token);
  }

  @callable()
  async rotateSession(token: string) {
    this.ensureSchema();
    return rotateSessionToken(this.idb(), token);
  }

  @callable()
  async revokeSession(token: string) {
    this.ensureSchema();
    return revokeSessionToken(this.idb(), token);
  }

  @callable()
  async revokeAllSessions(userId: string) {
    this.ensureSchema();
    return revokeAllUserSessions(this.idb(), userId);
  }

  @callable()
  async getUser(userId: string): Promise<UserRecord | null> {
    this.ensureSchema();
    const rows = this.idb().all<UserRecord>(
      `SELECT id, primary_email AS primaryEmail, created_at AS createdAt, last_seen_at AS lastSeenAt FROM users WHERE id = ?`,
      userId,
    );
    return rows[0] ?? null;
  }

  @callable()
  async check(
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ): Promise<boolean> {
    this.ensureSchema();
    return checkTuple(this.idb(), subjectType, subjectId, relation, objectType, objectId);
  }

  @callable()
  async addTuple(
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ): Promise<void> {
    this.ensureSchema();
    addTuple(this.idb(), subjectType, subjectId, relation, objectType, objectId);
  }

  /**
   * List every tuple on one object (issue #252 P3). The trade-approval
   * workflow's integrity check uses this: execution requires an approver
   * tuple on the proposal, regardless of which subject holds it.
   */
  @callable()
  async tuplesForObject(objectType: string, objectId: string) {
    this.ensureSchema();
    return listTuplesForObject(this.idb(), objectType, objectId);
  }

  @callable()
  async seedOperator(operatorUserId: string | null): Promise<void> {
    this.ensureSchema();
    seedOperatorTuples(this.idb(), operatorUserId);
  }

  @callable()
  async recordAccounting(events: AccountingInput[]): Promise<number> {
    this.ensureSchema();
    return appendAccounting(this.idb(), events);
  }

  @callable()
  async queryAccounting(filters: {
    tenantId?: string;
    userId?: string;
    eventClass?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    this.ensureSchema();
    return queryAccounting(this.idb(), filters);
  }

  @callable()
  async myActivity(userId: string, opts?: { limit?: number; eventClass?: string }) {
    this.ensureSchema();
    return myActivity(this.idb(), userId, opts);
  }

  /**
   * R0 loop-metrics ledger (issue #241 R0.1 / #325): per-operation
   * success/failure aggregation + recurrence detection over this DO's
   * accounting stream, for one tenant. Read-only; all logic lives in
   * the SDK-free src/r0-metrics-core.ts. The readable summary surface
   * built on this is #326.
   */
  @callable()
  async loopMetrics(opts: {
    tenantId: string;
    from?: string;
    to?: string;
    windowMs?: number;
    minOccurrences?: number;
  }) {
    this.ensureSchema();
    return readLoopMetrics(this.idb(), opts);
  }

  @callable()
  async runRetentionPurge() {
    this.ensureSchema();
    return runRetentionPurge(this.idb());
  }
}
