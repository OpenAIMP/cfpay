import { describe, expect, it } from "vitest";
import { normalizeCron, parseCron } from "../src/cron-next";

describe("cron validation (issues #213, #226)", () => {
  it("expands aliases and passes valid expressions through", () => {
    expect(normalizeCron("@daily")).toBe("0 0 * * *");
    expect(normalizeCron("@hourly")).toBe("0 * * * *");
    expect(normalizeCron("*/15 9-17 * * 1-5")).toBe("*/15 9-17 * * 1-5");
    expect(normalizeCron("0 12 1,15 * *")).toBe("0 12 1,15 * *");
  });

  it("rejects malformed expressions", () => {
    expect(normalizeCron("not a cron")).toBeNull();
    expect(normalizeCron("61 * * * *")).toBeNull();
    expect(normalizeCron("* * * *")).toBeNull();
    expect(normalizeCron("0 0 * * 8")).toBeNull();
    expect(normalizeCron("")).toBeNull();
    expect(normalizeCron("@sometimes")).toBeNull();
  });

  it("parses fields with steps, ranges, lists - and 7 as Sunday", () => {
    const f = parseCron("*/15 9-17 1,15 * 7");
    expect(f).not.toBeNull();
    expect([...f!.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(f!.hour.has(9) && f!.hour.has(17) && !f!.hour.has(18)).toBe(true);
    expect(f!.dom.has(1) && f!.dom.has(15)).toBe(true);
    expect(f!.dow.has(0)).toBe(true);
    expect(f!.dowRestricted).toBe(true);
    expect(parseCron("0 0 * * *")!.domRestricted).toBe(false);
  });
});
