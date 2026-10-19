/**
 * In-memory SqlDb fake for tests/identity-core.test.ts.
 *
 * Supports exactly the SQL src/identity-core.ts emits: CREATE TABLE IF NOT
 * EXISTS / CREATE INDEX IF NOT EXISTS (schema registration + no-op),
 * INSERT / INSERT OR IGNORE with a ?-param column list, SELECT with simple
 * WHERE conjunctions (col = ?, col = <literal>, col IS [NOT] NULL,
 * col LIKE ?, col </<=/>/>= ?), one parenthesized OR group, ORDER BY and
 * LIMIT ?, plus UPDATE ... SET ... WHERE and DELETE FROM ... WHERE.
 *
 * Anything unrecognized throws so query/coverage gaps surface loudly.
 */

import type { SqlDb } from "../src/identity-core";

type Row = Record<string, unknown>;

interface TableDef {
  columns: string[];
  pk: string[];
  unique: string[];
  autoInc: string | null;
  rows: Row[];
  nextAuto: number;
}

interface Ctx {
  params: unknown[];
  i: number;
}

function compareOp(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "=":
      return left === right;
    case "<>":
    case "!=":
      return left !== right;
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    default:
      throw new Error(`fake-db: unsupported operator ${op}`);
  }
}

type Pred = (row: Row, ctx: Ctx) => boolean;

function compileAtom(src: string): Pred {
  let m: RegExpMatchArray | null;
  if ((m = src.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i))) {
    const col = m[1];
    return (row) => row[col] !== null && row[col] !== undefined;
  }
  if ((m = src.match(/^(\w+)\s+IS\s+NULL$/i))) {
    const col = m[1];
    return (row) => row[col] === null || row[col] === undefined;
  }
  if ((m = src.match(/^(\w+)\s+LIKE\s+\?$/i))) {
    const col = m[1];
    return (row, ctx) => {
      const p = String(ctx.params[ctx.i++]);
      if (!p.endsWith("%")) throw new Error(`fake-db: only prefix LIKE supported: ${src}`);
      return String(row[col]).startsWith(p.slice(0, -1));
    };
  }
  if ((m = src.match(/^(\w+)\s*(=|<>|!=|<=|>=|<|>)\s*\?$/))) {
    const col = m[1];
    const op = m[2];
    return (row, ctx) => compareOp(op, row[col], ctx.params[ctx.i++]);
  }
  if ((m = src.match(/^(\w+)\s*=\s*(-?\d+)$/))) {
    const col = m[1];
    const v = Number(m[2]);
    return (row) => row[col] === v;
  }
  if ((m = src.match(/^(\w+)\s*=\s*'((?:[^']|'')*)'$/))) {
    const col = m[1];
    const v = m[2].replace(/''/g, "'");
    return (row) => row[col] === v;
  }
  throw new Error(`fake-db: unrecognized condition atom: ${src}`);
}

function compileWhere(src: string): Pred {
  const groups: Pred[] = [];
  // Parenthesized OR groups become single synthetic predicates. Loops are
  // deliberately non-short-circuit so every ? param is always consumed, in
  // order, keeping param accounting exact for every row.
  const flattened = src.replace(/\(([^()]+)\)/g, (_whole, inner: string) => {
    const parts = String(inner)
      .split(/\s+OR\s+/i)
      .map((p) => compileAtom(p.trim()));
    const idx = groups.length;
    groups.push((row, ctx) => {
      let ok = false;
      for (const p of parts) ok = p(row, ctx) || ok;
      return ok;
    });
    return `__G${idx}__`;
  });
  const atoms = flattened
    .split(/\s+AND\s+/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const preds: Pred[] = atoms.map((a) => {
    const gm = a.match(/^__G(\d+)__$/);
    if (gm) return groups[Number(gm[1])];
    return compileAtom(a);
  });
  return (row, ctx) => {
    let ok = true;
    for (const p of preds) ok = p(row, ctx) && ok;
    return ok;
  };
}

function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Count ? placeholders outside string literals (our SQL has none). */
function placeholderCount(src: string): number {
  return src.split("").filter((c) => c === "?").length;
}

export class FakeDb implements SqlDb {
  private tables = new Map<string, TableDef>();

  private table(name: string): TableDef {
    const t = this.tables.get(name);
    if (!t) throw new Error(`fake-db: no such table: ${name}`);
    return t;
  }

  run(sql: string, ...params: unknown[]): void {
    const s = sql.replace(/\s+/g, " ").trim();
    let m: RegExpMatchArray | null;
    if (/^CREATE TABLE IF NOT EXISTS/i.test(s)) {
      this.createTable(s);
      return;
    }
    if (/^CREATE INDEX IF NOT EXISTS/i.test(s)) {
      return; // no-op: indexes don't affect fake query results
    }
    if (
      (m = s.match(/^INSERT(\s+OR\s+IGNORE)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/i))
    ) {
      this.insert(m[2], m[1] !== undefined && /IGNORE/i.test(m[1]), m[3], m[4], params);
      return;
    }
    if ((m = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i))) {
      this.update(m[1], m[2], m[3], params);
      return;
    }
    if ((m = s.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i))) {
      this.deleteFrom(m[1], m[2], params);
      return;
    }
    throw new Error(`fake-db: unrecognized statement: ${sql}`);
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const s = sql.replace(/\s+/g, " ").trim();
    const m = s.match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+\?)?$/i,
    );
    if (!m) throw new Error(`fake-db: unrecognized SELECT: ${sql}`);
    const [, colSpec, tableName, whereSrc, orderSrc] = m;
    const hasLimit = /\s+LIMIT\s+\?$/i.test(s);
    const expected =
      (whereSrc ? placeholderCount(whereSrc) : 0) + (hasLimit ? 1 : 0);
    if (params.length !== expected) {
      throw new Error(
        `fake-db: SELECT param count mismatch (want ${expected}, got ${params.length}): ${sql}`,
      );
    }
    const t = this.table(tableName);
    let rows = t.rows;
    if (whereSrc) {
      const pred = compileWhere(whereSrc);
      // Fresh param cursor per row: every row must see the same params.
      rows = rows.filter((r) => pred(r, { params, i: 0 }));
    }
    const countAlias = colSpec.trim().match(/^COUNT\(\*\)\s+AS\s+(\w+)$/i);
    if (countAlias) {
      return [{ [countAlias[1]]: rows.length }] as T[];
    }
    if (orderSrc) {
      const keys = orderSrc.split(",").map((k) => {
        const km = k.trim().match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
        if (!km) throw new Error(`fake-db: bad ORDER BY: ${orderSrc}`);
        return { col: km[1], desc: (km[2] ?? "ASC").toUpperCase() === "DESC" };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, desc } of keys) {
          const av = a[col];
          const bv = b[col];
          if (av === bv) continue;
          const c = (av as number) < (bv as number) ? -1 : 1;
          return desc ? -c : c;
        }
        return 0;
      });
    }
    if (hasLimit) {
      const lp = params[params.length - 1];
      if (typeof lp !== "number") throw new Error(`fake-db: LIMIT param must be a number`);
      rows = rows.slice(0, lp);
    }
    const cols = splitTopLevel(colSpec);
    return rows.map((r) => this.project(r, cols)) as T[];
  }

  /* ------------------------------ internals ----------------------------- */

  private createTable(s: string): void {
    const m = s.match(/^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*)\)$/i);
    if (!m) throw new Error(`fake-db: bad CREATE TABLE: ${s}`);
    const def: TableDef = {
      columns: [],
      pk: [],
      unique: [],
      autoInc: null,
      rows: [],
      nextAuto: 1,
    };
    for (const part of splitTopLevel(m[2])) {
      const pkTable = part.match(/^PRIMARY KEY\s*\(([^)]+)\)$/i);
      if (pkTable) {
        def.pk = pkTable[1].split(",").map((c) => c.trim());
        continue;
      }
      const name = part.split(/\s+/)[0];
      def.columns.push(name);
      if (/PRIMARY KEY/i.test(part)) def.pk.push(name);
      if (/AUTOINCREMENT/i.test(part)) def.autoInc = name;
      if (/\bUNIQUE\b/i.test(part) && !/PRIMARY KEY/i.test(part)) def.unique.push(name);
    }
    this.tables.set(m[1], def);
  }

  private insert(
    tableName: string,
    orIgnore: boolean,
    colSpec: string,
    valSpec: string,
    params: unknown[],
  ): void {
    const t = this.table(tableName);
    const cols = splitTopLevel(colSpec);
    const vals = splitTopLevel(valSpec);
    if (vals.some((v) => v !== "?")) throw new Error(`fake-db: only ? VALUES supported`);
    if (cols.length !== params.length) {
      throw new Error(
        `fake-db: INSERT param count mismatch (${cols.length} cols, ${params.length} params)`,
      );
    }
    const row: Row = {};
    for (const c of t.columns) row[c] = null;
    cols.forEach((c, i) => {
      row[c] = params[i];
    });
    if (t.autoInc && !cols.includes(t.autoInc)) {
      row[t.autoInc] = t.nextAuto++;
    }
    if (orIgnore) {
      const pkHit = t.pk.length > 0 && t.rows.some((r) => t.pk.every((c) => r[c] === row[c]));
      const uniqHit = t.unique.some(
        (c) =>
          row[c] !== null && row[c] !== undefined && t.rows.some((r) => r[c] === row[c]),
      );
      if (pkHit || uniqHit) return;
    }
    t.rows.push(row);
  }

  private update(tableName: string, setSrc: string, whereSrc: string, params: unknown[]): void {
    const t = this.table(tableName);
    const assignments = splitTopLevel(setSrc).map((a) => {
      const m = a.match(/^(\w+)\s*=\s*(\?|NULL|-?\d+)$/i);
      if (!m) throw new Error(`fake-db: bad SET assignment: ${a}`);
      const raw = m[2];
      return {
        col: m[1],
        kind: raw === "?" ? "param" : raw.toUpperCase() === "NULL" ? "null" : "literal",
        raw,
      } as const;
    });
    const setCount = assignments.filter((a) => a.kind === "param").length;
    const whereCount = placeholderCount(whereSrc);
    if (params.length !== setCount + whereCount) {
      throw new Error(`fake-db: UPDATE param count mismatch: ${setSrc} / ${whereSrc}`);
    }
    const setParams = params.slice(0, setCount);
    const whereParams = params.slice(setCount);
    const pred = compileWhere(whereSrc);
    for (const row of t.rows) {
      const w: Ctx = { params: whereParams, i: 0 };
      if (!pred(row, w)) continue;
      const sc: Ctx = { params: setParams, i: 0 };
      for (const a of assignments) {
        if (a.kind === "null") row[a.col] = null;
        else if (a.kind === "literal") row[a.col] = Number(a.raw);
        else row[a.col] = sc.params[sc.i++];
      }
    }
  }

  private deleteFrom(tableName: string, whereSrc: string, params: unknown[]): void {
    const t = this.table(tableName);
    if (params.length !== placeholderCount(whereSrc)) {
      throw new Error(`fake-db: DELETE param count mismatch: ${whereSrc}`);
    }
    const pred = compileWhere(whereSrc);
    t.rows = t.rows.filter((row) => {
      const ctx: Ctx = { params, i: 0 };
      return !pred(row, ctx);
    });
  }

  private project(row: Row, cols: string[]): Row {
    if (cols.length === 1 && cols[0] === "*") return { ...row };
    const out: Row = {};
    for (const c of cols) {
      const m = c.match(/^(\w+)\s+AS\s+(\w+)$/i);
      if (m) {
        out[m[2]] = row[m[1]];
        continue;
      }
      if (c === "1") {
        out["1"] = 1;
        continue;
      }
      const cm = c.match(/^(\w+)$/);
      if (!cm) throw new Error(`fake-db: bad SELECT column: ${c}`);
      out[cm[1]] = row[cm[1]];
    }
    return out;
  }
}

/** Fresh empty fake, ready for ensureIdentitySchema. */
export function makeDb(): FakeDb {
  return new FakeDb();
}
