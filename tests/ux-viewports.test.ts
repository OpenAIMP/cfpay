import { describe, expect, it } from "vitest";
import { viewportListOf, type UxAuditSpec } from "../src/ux-audit-spec";

const spec = (over: Partial<UxAuditSpec>): UxAuditSpec => ({ url: "https://a.example/", ...over });

describe("viewportListOf (issue #102 multi-viewport)", () => {
  it("defaults to one un-emulated pass", () => {
    expect(viewportListOf(spec({}))).toEqual([{ name: "default" }]);
    expect(viewportListOf(spec({ viewports: [] }))).toEqual([{ name: "default" }]);
  });

  it("keeps valid viewports, clamped to the sane range", () => {
    expect(
      viewportListOf(spec({ viewports: [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 900 }] })),
    ).toEqual([
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1440, height: 900 },
    ]);
    // Out-of-range sizes are dropped, not clamped into nonsense.
    expect(viewportListOf(spec({ viewports: [{ name: "tiny", width: 100, height: 100 }] }))).toEqual([{ name: "default" }]);
    expect(viewportListOf(spec({ viewports: [{ name: "huge", width: 4000, height: 900 }] }))).toEqual([{ name: "default" }]);
  });

  it("caps at three, dedupes names, and sanitizes them", () => {
    const out = viewportListOf(
      spec({
        viewports: [
          { name: "a b!", width: 400, height: 800 },
          { name: "ab", width: 500, height: 800 },
          { name: "c", width: 600, height: 800 },
          { name: "d", width: 700, height: 800 },
        ],
      }),
    );
    expect(out.map((v) => v.name)).toEqual(["ab", "c", "d"]);
  });
});
