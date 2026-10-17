/**
 * Persistent browser profile storage + session access (issue #102).
 * One Browser Run session is kept in the agent's SQL storage so its
 * cookies/storage survive across runs; audit and investigate runs opt
 * into it per call. The platform caps idle keep_alive at 600s, so
 * "persistent" means alive and reused while runs keep it warm - not a
 * permanent profile. SDK imports are dynamic so unit tests can import
 * the storage pieces without the agents runtime.
 */

export interface SqlLike {
  exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
}

const DDL =
  "CREATE TABLE IF NOT EXISTS browser_profile (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT NOT NULL, created_at TEXT NOT NULL)";

export function profileRowGet(sql: SqlLike): { sessionId: string; createdAt: string } | null {
  try {
    sql.exec(DDL);
    const rows = sql.exec("SELECT session_id, created_at FROM browser_profile WHERE id = 1").toArray();
    const id = rows[0]?.session_id;
    return typeof id === "string" && id
      ? { sessionId: id, createdAt: typeof rows[0]?.created_at === "string" ? (rows[0].created_at as string) : "" }
      : null;
  } catch {
    return null;
  }
}

export function profileRowSet(sql: SqlLike, sessionId: string, createdAt: string): void {
  try {
    sql.exec(DDL);
    sql.exec("INSERT OR REPLACE INTO browser_profile (id, session_id, created_at) VALUES (1, ?, ?)", sessionId, createdAt);
  } catch {
    /* best-effort */
  }
}

export function profileRowClear(sql: SqlLike): void {
  try {
    sql.exec("DELETE FROM browser_profile WHERE id = 1");
  } catch {
    /* best-effort */
  }
}

/** Is the stored session still alive upstream? */
export async function profileSessionAlive(browser: unknown, sessionId: string): Promise<boolean> {
  try {
    const { listBrowserTargets } = await import("agents/browser");
    await listBrowserTargets(browser as never, sessionId);
    return true;
  } catch {
    return false;
  }
}

/** Connect to the stored session without deleting it on close. */
export async function openProfileConnection(browser: unknown, sql: SqlLike): Promise<unknown | null> {
  const row = profileRowGet(sql);
  if (!row) return null;
  try {
    const { connectBrowserSession } = await import("agents/browser");
    return await connectBrowserSession(browser as never, row.sessionId);
  } catch {
    return null;
  }
}
