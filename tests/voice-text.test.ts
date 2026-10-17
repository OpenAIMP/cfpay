import { describe, expect, it } from "vitest";
import { speakable } from "../src/voice-text";

describe("speakable (voice answer shaping)", () => {
  it("strips markdown emphasis, headings and links", () => {
    const out = speakable("## Verdict\n**NVDA** looks [strong](https://x.example) here.");
    // The heading becomes its own spoken sentence.
    expect(out).toBe("Verdict. NVDA looks strong here.");
  });

  it("flattens table rows to comma prose and drops separators", () => {
    const out = speakable("| Symbol | Last |\n|---|---|\n| NVDA | 218.4 |\n| AMD | 162.1 |");
    expect(out).not.toContain("|");
    expect(out).toContain("NVDA, 218.4");
    expect(out).toContain("AMD, 162.1");
  });

  it("caps long answers at a sentence boundary with a pointer to the tab", () => {
    const sentence = "The desk gathered the live chain and compared both names. ";
    const out = speakable(sentence.repeat(30));
    expect(out.length).toBeLessThan(760);
    expect(out.endsWith("The full answer is in the Public tab.")).toBe(true);
  });

  it("leaves short plain answers untouched", () => {
    expect(speakable("SPY is at 512.30, up 0.4 percent.")).toBe("SPY is at 512.30, up 0.4 percent.");
  });
});
