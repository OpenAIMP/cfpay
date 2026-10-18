import { describe, expect, it } from "vitest";
import { cronMatches, nextCronRun, normalizeCron } from "../src/cron-next";

const at = (iso: string) => new Date(iso);

describe("cron expressions (issue #213)", () => {
  it("normalizes aliases and rejects junk", () => {
    expect(normalizeCron("@daily")).toBe("0 0 * * *");
    expect(normalizeCron("@hourly")).toBe("0 * * * *");
    expect(normalizeCron("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(normalizeCron("not a cron")).toBeNull();
    expect(normalizeCron("0 9 * *")).toBeNull();
    expect(normalizeCron("61 * * * *")).toBeNull();
    expect(normalizeCron("0 9 32 * *")).toBeNull();
    expect(normalizeCron("0 9 * * 8")).toBeNull();
  });

  it("computes the next run for daily and weekday schedules", () => {
    // 2026-10-17 is a Saturday.
    expect(nextCronRun("0 9 * * *", at("2026-10-17T08:00:00Z"))?.toISOString()).toBe("2026-10-17T09:00:00.000Z");
    expect(nextCronRun("0 9 * * *", at("2026-10-17T09:00:00Z"))?.toISOString()).toBe("2026-10-18T09:00:00.000Z");
    expect(nextCronRun("0 9 * * 1-5", at("2026-10-17T10:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(nextCronRun("@weekly", at("2026-10-17T10:00:00Z"))?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  it("handles steps, lists, and ranges", () => {
    expect(nextCronRun("*/15 * * * *", at("2026-10-17T10:07:00Z"))?.toISOString()).toBe("2026-10-17T10:15:00.000Z");
    expect(nextCronRun("0 */4 * * *", at("2026-10-17T10:07:00Z"))?.toISOString()).toBe("2026-10-17T12:00:00.000Z");
    expect(nextCronRun("30 8,12 * * *", at("2026-10-17T09:00:00Z"))?.toISOString()).toBe("2026-10-17T12:30:00.000Z");
    expect(nextCronRun("0 0 1 * *", at("2026-10-17T00:00:00Z"))?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("applies classic dom/dow OR semantics when both are restricted", () => {
    // "13th of month OR Friday" - from Sat Oct 17 2026, the next hit is Fri Oct 23, before Nov 13.
    expect(nextCronRun("0 0 13 * 5", at("2026-10-17T00:00:00Z"))?.toISOString()).toBe("2026-10-23T00:00:00.000Z");
    expect(cronMatches("0 0 13 * 5", at("2026-11-13T00:00:00Z"))).toBe(true); // both
    expect(cronMatches("0 0 13 * 5", at("2026-11-14T00:00:00Z"))).toBe(false); // neither
  });

  it("treats 7 as Sunday and matches exact minutes only", () => {
    expect(cronMatches("0 12 * * 7", at("2026-10-18T12:00:00Z"))).toBe(true); // Sunday
    expect(cronMatches("0 12 * * 0", at("2026-10-18T12:00:00Z"))).toBe(true);
    expect(cronMatches("0 12 * * 0", at("2026-10-18T12:01:00Z"))).toBe(false);
  });

  it("returns null for an impossible date instead of looping forever", () => {
    expect(nextCronRun("0 0 31 2 *", at("2026-10-17T00:00:00Z"))).toBeNull();
  });
});
