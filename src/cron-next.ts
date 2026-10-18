/**
 * Cron VALIDATION for the ScheduledAgent (issues #213, #226).
 *
 * Execution scheduling belongs to the Agents SDK's native
 * scheduler (this.schedule with a cron string; the SDK parses
 * with cron-schedule and wakes the agent on a Durable Object
 * alarm). This module is only the bouncer at the door: it expands
 * @daily-style aliases and rejects malformed expressions before
 * they reach the SDK, so the API can answer with a named error
 * instead of a framework throw. It deliberately contains no
 * next-run math of its own anymore - one cron engine, theirs.
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
