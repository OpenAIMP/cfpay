import { describe, expect, it } from "vitest";
import { profileRowClear, profileRowGet, profileRowSet, type SqlLike } from "../src/browser-profile";

// Minimal in-memory stand-in for the DO SQL storage the module targets.
function fakeSql(): SqlLike {
  let row: { session_id: string; created_at: string } | null = null;
  return {
    exec(query: string, ...params: unknown[]) {
      if (query.startsWith("SELECT")) {
        return { toArray: () => (row ? [{ ...row }] : []) };
      }
      if (query.startsWith("INSERT")) {
        row = { session_id: String(params[0]), created_at: String(params[1]) };
        return { toArray: () => [] };
      }
      if (query.startsWith("DELETE")) {
        row = null;
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
}

describe("browser profile storage (issue #102)", () => {
  it("round-trips a stored session and clears it", () => {
    const sql = fakeSql();
    expect(profileRowGet(sql)).toBeNull();
    profileRowSet(sql, "sess-123", "2026-10-17T00:00:00.000Z");
    expect(profileRowGet(sql)).toEqual({ sessionId: "sess-123", createdAt: "2026-10-17T00:00:00.000Z" });
    profileRowSet(sql, "sess-456", "2026-10-17T01:00:00.000Z");
    expect(profileRowGet(sql)?.sessionId).toBe("sess-456");
    profileRowClear(sql);
    expect(profileRowGet(sql)).toBeNull();
  });

  it("survives a broken store without throwing", () => {
    const broken: SqlLike = {
      exec() {
        throw new Error("no storage");
      },
    };
    expect(profileRowGet(broken)).toBeNull();
    expect(() => profileRowSet(broken, "x", "y")).not.toThrow();
    expect(() => profileRowClear(broken)).not.toThrow();
  });
});
