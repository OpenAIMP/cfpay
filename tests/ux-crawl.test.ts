import { describe, expect, it } from "vitest";
import { crawlUrlKey, pageEntriesOf } from "../src/ux-audit-spec";

describe("pageEntriesOf (issue #94 step 2)", () => {
  it("passes bare strings through with no steps", () => {
    expect(pageEntriesOf({ pages: ["https://a.example/", "https://a.example/x"] })).toEqual([
      { url: "https://a.example/", steps: [] },
      { url: "https://a.example/x", steps: [] },
    ]);
  });

  it("keeps object entries and their click steps", () => {
    expect(
      pageEntriesOf({
        pages: [{ url: "https://a.example/app", steps: [{ click: "[data-tab]" }, { click: "#more" }] }],
      }),
    ).toEqual([
      { url: "https://a.example/app", steps: [{ click: "[data-tab]" }, { click: "#more" }] },
    ]);
  });

  it("drops malformed entries and steps instead of failing", () => {
    expect(
      pageEntriesOf({
        pages: [
          "",
          { url: "" },
          { steps: [{ click: "#x" }] } as never,
          { url: "https://a.example/", steps: [{ click: "" }, { nope: 1 } as never, { click: "#ok" }] },
          42 as never,
          null as never,
        ],
      }),
    ).toEqual([{ url: "https://a.example/", steps: [{ click: "#ok" }] }]);
  });

  it("caps steps at five per page", () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ click: `#s${i}` }));
    const [entry] = pageEntriesOf({ pages: [{ url: "https://a.example/", steps }] });
    expect(entry.steps).toHaveLength(5);
  });

  it("returns nothing for a missing or empty spec", () => {
    expect(pageEntriesOf(null)).toEqual([]);
    expect(pageEntriesOf(undefined)).toEqual([]);
    expect(pageEntriesOf({ pages: [] })).toEqual([]);
  });
});

describe("crawlUrlKey (issue #94 step 2)", () => {
  const origin = "https://a.example";

  it("accepts same-origin http(s) pages", () => {
    expect(crawlUrlKey("https://a.example/docs", origin)).toBe("https://a.example/docs");
    expect(crawlUrlKey("https://a.example/docs?x=1", origin)).toBe("https://a.example/docs?x=1");
  });

  it("strips fragments (an anchor is not a new page)", () => {
    expect(crawlUrlKey("https://a.example/docs#section", origin)).toBe("https://a.example/docs");
  });

  it("rejects cross-origin, subdomains, and non-http links", () => {
    expect(crawlUrlKey("https://b.example/docs", origin)).toBeNull();
    expect(crawlUrlKey("https://sub.a.example/docs", origin)).toBeNull();
    expect(crawlUrlKey("mailto:hi@a.example", origin)).toBeNull();
    expect(crawlUrlKey("javascript:void(0)", origin)).toBeNull();
  });

  it("rejects unparseable values", () => {
    expect(crawlUrlKey("not a url", origin)).toBeNull();
    expect(crawlUrlKey("", origin)).toBeNull();
  });
});
