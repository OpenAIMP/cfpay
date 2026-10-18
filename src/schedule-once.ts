/**
 * One-shot schedule time parsing (issue #232).
 *
 * Pure and SDK-free so vitest covers it. A one-shot goal fires
 * exactly once at an explicit time; the ScheduledAgent arms it as a
 * native Agents SDK schedule with a Date. Accepted inputs:
 *   - an ISO-8601 timestamp ("2026-10-20T13:00:00Z")
 *   - a relative offset from now ("+90s", "+2m", "+1h", "+3d")
 * The time must be in the future (at least ~1s out, so the alarm
 * can arm) and at most one year out - a one-shot further away than
 * that is a recurring goal wearing a costume.
 */

export const MAX_ONCE_HORIZON_MS = 366 * 24 * 3600 * 1000;

export type OneShotParse =
  | { ok: true; at: number }
  | { ok: false; error: "invalid_once_time" | "once_time_not_future" | "once_time_too_far" };

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 3600 * 1000,
  d: 24 * 3600 * 1000,
};

export function parseOneShotWhen(input: string, nowMs: number): OneShotParse {
  const text = (input ?? "").trim();
  if (!text) return { ok: false, error: "invalid_once_time" };
  let at: number;
  const rel = /^\+(\d+)([smhd])$/.exec(text);
  if (rel) {
    at = nowMs + Number(rel[1]) * UNIT_MS[rel[2]];
  } else {
    at = Date.parse(text);
    if (!Number.isFinite(at)) return { ok: false, error: "invalid_once_time" };
  }
  if (at <= nowMs + 1000) return { ok: false, error: "once_time_not_future" };
  if (at > nowMs + MAX_ONCE_HORIZON_MS) return { ok: false, error: "once_time_too_far" };
  return { ok: true, at };
}

/** Epoch ms for a delay in seconds, validated the same way. */
export function oneShotFromDelay(delaySeconds: number, nowMs: number): OneShotParse {
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    return { ok: false, error: "invalid_once_time" };
  }
  return parseOneShotWhen(`+${Math.floor(delaySeconds)}s`, nowMs);
}
