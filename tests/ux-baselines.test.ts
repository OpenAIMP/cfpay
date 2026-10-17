import { describe, expect, it } from "vitest";
import { sha256Hex, summarizeBaselines, type BaselineResult } from "../src/ux-audit-spec";

describe("sha256Hex (issue #102 visual baselines)", () => {
  it("matches known vectors", async () => {
    // base64 of "hello"
    expect(await sha256Hex("aGVsbG8=")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    // base64 of "" hashes to the empty digest
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("summarizeBaselines", () => {
  const r = (view: string, status: BaselineResult["status"]): BaselineResult => ({ view, status });

  it("record mode reports how many were stored", () => {
    const f = summarizeBaselines([r("a", "recorded"), r("b", "recorded")], "record");
    expect(f.passed).toBe(true);
    expect(f.detail).toContain("2/2");
    const partial = summarizeBaselines([r("a", "recorded"), r("b", "unavailable")], "record");
    expect(partial.passed).toBe(false);
  });

  it("compare passes on matches, tolerates views without baselines", () => {
    const f = summarizeBaselines([r("a", "match"), r("b", "new")], "compare");
    expect(f.passed).toBe(true);
    expect(f.detail).toContain("without a baseline");
  });

  it("compare fails on a changed view and names it", () => {
    const f = summarizeBaselines([r("a", "match"), r("https://x.example/p", "changed")], "compare");
    expect(f.passed).toBe(false);
    expect(f.detail).toContain("CHANGED: https://x.example/p");
  });
});
