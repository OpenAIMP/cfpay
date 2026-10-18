/**
 * Cron expressions, parsed and evaluated in UTC (issue #213).
 *
 * A small, dependency-free 5-field cron implementation for the
 * ScheduledAgent: minute hour day-of-month month day-of-week, with
 * `*`, values, comma lists, ranges and steps, plus the usual
 * aliases (@hourly, @daily, @weekly, @monthly, @yearly). All times
 * are UTC - Workers cron triggers are UTC, and schedules stored
 * here are evaluated in UTC so a goal fires at the same wall-clock
 * moment regardless of where the dashboard is opened.
 *
 * Day semantics follow classic cron: when BOTH day-of-month and
 * day-of-week are restricted, a day matches when EITHER does; when
 * only one is restricted, that one decides.
 */

export const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = stepMatch ? max : lo;
    } else {
      const range = base.match(/^(\d+)-(\d+)$/);
      if (!range) return null;
      lo = Number(range[1]);
      hi = Number(range[2]);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse + validate a cron expression (aliases expanded). Null when invalid. */
export function parseCron(expr: string): CronFields | null {
  const expanded = CRON_ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/** The canonical (alias-expanded) form of a valid expression, else null. */
export function normalizeCron(expr: string): string | null {
  const trimmed = expr.trim().toLowerCase();
  const expanded = CRON_ALIASES[trimmed] ?? expr.trim();
  return parseCron(expanded) ? expanded : null;
}

/** Does this UTC instant match the expression? */
export function cronMatches(expr: string, date: Date): boolean {
  const f = parseCron(expr);
  if (!f) return false;
  if (!f.minute.has(date.getUTCMinutes())) return false;
  if (!f.hour.has(date.getUTCHours())) return false;
  if (!f.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = f.dom.has(date.getUTCDate());
  const dowOk = f.dow.has(date.getUTCDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/**
 * The next run strictly after `from`, minute-aligned, searching up
 * to a year ahead. Null when the expression is invalid or never
 * fires within the window.
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  if (!parseCron(expr)) return null;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
