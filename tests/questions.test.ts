import { describe, expect, it } from "vitest";
import library from "../src/questions.json";

/**
 * The Public tab's strategy question library. These tests pin the shape the
 * UI and the /api/public/questions route rely on, the classification every
 * group must carry (tier / outlook / premium — see the library's $comment),
 * and the taxonomy coverage from the expansion issue, so a strategy family
 * cannot silently drop out of the library in a future edit.
 */

interface QQuestion {
  id: string;
  label: string;
  question: string;
  outlook?: string;
  premium?: string;
}
interface QGroup {
  id: string;
  label: string;
  intro: string;
  tier: string;
  outlook: string;
  premium: string;
  questions: QQuestion[];
}
const lib = library as unknown as { groups: QGroup[] };

const TIERS = ["basic", "intermediate", "advanced", "expert"];
const OUTLOOKS = ["bullish", "bearish", "neutral", "directional"];
const PREMIUMS = ["selling", "buying", "mixed"];

// The taxonomy the expansion set out to cover, by question id. One flagship
// question per named strategy; append here when the library grows.
const TAXONOMY = [
  // single legs & protection
  "long-call", "long-put", "protective-put", "cc-30d", "cc-ladder",
  // credit & debit verticals
  "put-credit", "bear-call", "bull-call", "bear-put",
  // income & undefined-risk selling
  "covered-strangle", "short-put-naked", "short-call-naked",
  "short-straddle", "short-strangle",
  "covered-short-straddle", "covered-short-strangle",
  // neutral premium structures
  "iron-condor", "iron-butterfly",
  "long-call-butterfly", "long-put-butterfly",
  "short-call-butterfly", "short-put-butterfly",
  "long-call-condor", "long-put-condor",
  "short-call-condor", "short-put-condor",
  // directional / volatility structures
  "inverse-iron-butterfly", "inverse-iron-condor",
  "straddle", "guts", "short-guts", "strip", "strap",
  // time spreads
  "calendar-call", "calendar-put", "diagonal-call", "diagonal-put",
  "calendar", "diagonal", "double-diagonal",
  // ladders
  "bull-call-ladder", "bear-call-ladder", "bull-put-ladder", "bear-put-ladder",
  // jade lizards
  "jade-lizard", "reverse-jade-lizard",
  // ratios & broken wings
  "call-ratio-spread", "put-ratio-spread",
  "call-ratio-backspread", "put-ratio-backspread",
  "call-broken-wing", "put-broken-wing",
  "inverse-call-broken-wing", "inverse-put-broken-wing",
  // synthetics & combos
  "long-synthetic-future", "short-synthetic-future", "synthetic-put",
  "long-combo", "short-combo", "collar",
];

describe("strategy question library", () => {
  it("has groups with unique ids and at least one question each", () => {
    const ids = lib.groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of lib.groups) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.questions.length).toBeGreaterThan(0);
    }
  });

  it("classifies every group (tier / outlook / premium) and states it in the intro", () => {
    for (const g of lib.groups) {
      expect(TIERS, g.id).toContain(g.tier);
      expect(OUTLOOKS, g.id).toContain(g.outlook);
      expect(PREMIUMS, g.id).toContain(g.premium);
      expect(g.intro, g.id).toContain("Classification:");
    }
  });

  it("keeps question ids globally unique, with label and text", () => {
    const seen = new Set<string>();
    for (const g of lib.groups) {
      for (const q of g.questions) {
        expect(seen.has(q.id), q.id).toBe(false);
        seen.add(q.id);
        expect(q.label.length, q.id).toBeGreaterThan(0);
        expect(q.question.length, q.id).toBeGreaterThan(40);
        if (q.outlook !== undefined) expect(OUTLOOKS, q.id).toContain(q.outlook);
        if (q.premium !== undefined) expect(PREMIUMS, q.id).toContain(q.premium);
      }
    }
  });

  it("keeps the default comparison question first and intact", () => {
    const first = lib.groups[0];
    expect(first.id).toBe("compare");
    expect(first.questions[0].id).toBe("semi-compare");
    expect(first.questions[0].question).toBe(
      "Compare NVDA and AMD for a bullish view on semiconductors — which has the better setup?",
    );
  });

  it("covers the full strategy taxonomy", () => {
    const ids = new Set(lib.groups.flatMap((g) => g.questions.map((q) => q.id)));
    const missing = TAXONOMY.filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("separates premium selling from premium buying somewhere in the library", () => {
    const groupPremiums = new Set(lib.groups.map((g) => g.premium));
    expect(groupPremiums.has("selling")).toBe(true);
    expect(groupPremiums.has("buying")).toBe(true);
    // Every outlook family is represented — at group level, or via the
    // per-question overrides inside the family groups (bearish lives
    // there: long-put, bear-call, short-combo, ...).
    const outlooks = new Set<string>(lib.groups.map((g) => g.outlook));
    for (const g of lib.groups) {
      for (const q of g.questions) {
        outlooks.add(q.outlook ?? g.outlook);
      }
    }
    for (const o of OUTLOOKS) expect(outlooks.has(o), o).toBe(true);
  });
});
