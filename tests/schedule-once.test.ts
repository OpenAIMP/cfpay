import { describe, expect, it } from "vitest";
import { oneShotFromDelay, parseOneShotWhen } from "../src/schedule-once";

const NOW = Date.parse("2026-10-17T12:00:00Z");

describe("one-shot time parsing (issue #232)", () => {
  it("accepts an ISO timestamp in the future", () => {
    expect(parseOneShotWhen("2026-10-17T13:30:00Z", NOW)).toEqual({
      ok: true,
      at: Date.parse("2026-10-17T13:30:00Z"),
    });
  });

  it("accepts relative offsets in s/m/h/d", () => {
    expect(parseOneShotWhen("+90s", NOW)).toEqual({ ok: true, at: NOW + 90_000 });
    expect(parseOneShotWhen("+2m", NOW)).toEqual({ ok: true, at: NOW + 120_000 });
    expect(parseOneShotWhen("+1h", NOW)).toEqual({ ok: true, at: NOW + 3_600_000 });
    expect(parseOneShotWhen("+3d", NOW)).toEqual({ ok: true, at: NOW + 3 * 86_400_000 });
  });

  it("rejects the past, the immediate present, and garbage", () => {
    expect(parseOneShotWhen("2026-10-17T11:00:00Z", NOW)).toEqual({ ok: false, error: "once_time_not_future" });
    expect(parseOneShotWhen("2026-10-17T12:00:00Z", NOW)).toEqual({ ok: false, error: "once_time_not_future" });
    expect(parseOneShotWhen("tomorrow-ish", NOW)).toEqual({ ok: false, error: "invalid_once_time" });
    expect(parseOneShotWhen("", NOW)).toEqual({ ok: false, error: "invalid_once_time" });
    expect(parseOneShotWhen("+5w", NOW)).toEqual({ ok: false, error: "invalid_once_time" });
  });

  it("rejects times more than a year out", () => {
    expect(parseOneShotWhen("2028-01-01T00:00:00Z", NOW).ok).toBe(false);
    expect(parseOneShotWhen("+400d", NOW)).toEqual({ ok: false, error: "once_time_too_far" });
  });

  it("delay seconds ride the same validation", () => {
    expect(oneShotFromDelay(120, NOW)).toEqual({ ok: true, at: NOW + 120_000 });
    expect(oneShotFromDelay(0, NOW).ok).toBe(false);
    expect(oneShotFromDelay(-5, NOW).ok).toBe(false);
  });
});
