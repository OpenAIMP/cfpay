/**
 * Evidence record store (cfpay #245).
 *
 * Host-owned persistence for test-harness evidence records: one row per
 * recommendation, JSON body, newest-first list, prune cap. Same shape as
 * HuntStore (src/opportunity-hunt.ts). The store is SDK-free apart from
 * the ambient SqlStorage type (type-only, erased at runtime — safe to
 * import from unit tests the way HuntStore is).
 */

import type { EvidenceRecord } from "./test-harness/evidence";

export const EVIDENCE_MAX_KEPT = 50;

export class EvidenceStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS evidence_records (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  save(rec: EvidenceRecord): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO evidence_records (id, created_at, data) VALUES (?, ?, ?)",
      rec.recommendationId,
      rec.issuedAt,
      JSON.stringify(rec),
    );
    this.sql.exec(
      "DELETE FROM evidence_records WHERE id NOT IN (SELECT id FROM evidence_records ORDER BY created_at DESC LIMIT ?)",
      EVIDENCE_MAX_KEPT,
    );
  }

  get(id: string): EvidenceRecord | null {
    const rows = [
      ...this.sql.exec(
        "SELECT data FROM evidence_records WHERE id = ? LIMIT 1",
        id,
      ),
    ];
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].data as string) as EvidenceRecord;
    } catch {
      return null;
    }
  }

  list(): EvidenceRecord[] {
    const rows = [
      ...this.sql.exec(
        "SELECT data FROM evidence_records ORDER BY created_at DESC LIMIT ?",
        EVIDENCE_MAX_KEPT,
      ),
    ];
    const out: EvidenceRecord[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data as string) as EvidenceRecord);
      } catch {
        // Skip a corrupt row rather than failing the list.
      }
    }
    return out;
  }
}
