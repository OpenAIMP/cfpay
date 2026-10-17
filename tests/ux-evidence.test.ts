import { describe, expect, it } from "vitest";
import {
  evidenceCollectorScript,
  parsePageEvidence,
  summarizeEvidence,
  type PageEvidence,
} from "../src/ux-audit-spec";

const page = (over: Partial<PageEvidence>): PageEvidence => ({
  view: "https://a.example/",
  console: [],
  requests: [],
  vitals: { lcp: 0, cls: 0, fcp: 0 },
  ...over,
});

describe("summarizeEvidence (issue #102 evidence pack)", () => {
  it("passes clean pages and reports vitals as informational", () => {
    const findings = summarizeEvidence([
      page({ vitals: { lcp: 1200, cls: 0.02, fcp: 600 } }),
      page({ view: "https://a.example/x", vitals: { lcp: 2400, cls: 0.05, fcp: 900 } }),
    ]);
    expect(findings.map((f) => f.name)).toEqual(["Console errors", "Failed requests", "Web Vitals"]);
    expect(findings.every((f) => f.passed)).toBe(true);
    expect(findings[2].detail).toContain("2.40s");
    expect(findings[2].detail).toContain("https://a.example/x");
  });

  it("fails the console finding on errors, counting warnings separately", () => {
    const findings = summarizeEvidence([
      page({
        console: [
          { level: "error", text: "TypeError: boom" },
          { level: "warn", text: "deprecated" },
        ],
      }),
    ]);
    expect(findings[0].passed).toBe(false);
    expect(findings[0].detail).toContain("TypeError: boom");
    const clean = summarizeEvidence([page({ console: [{ level: "warn", text: "deprecated" }] })]);
    expect(clean[0].passed).toBe(true);
    expect(clean[0].detail).toContain("1 warning(s)");
  });

  it("fails the requests finding with URLs and statuses", () => {
    const findings = summarizeEvidence([
      page({ requests: [{ url: "https://a.example/api", status: 500 }, { url: "https://a.example/x", status: 0 }] }),
    ]);
    expect(findings[1].passed).toBe(false);
    expect(findings[1].detail).toContain("HTTP 500");
    expect(findings[1].detail).toContain("network error");
  });

  it("returns nothing when no pages were measured", () => {
    expect(summarizeEvidence([])).toEqual([]);
  });
});

describe("parsePageEvidence", () => {
  it("sanitizes and caps harvested data", () => {
    const raw = {
      console: Array.from({ length: 30 }, (_, i) => ({ level: "error", text: `e${i}` })),
      requests: [{ url: "https://a.example/a", status: "404" }, { nope: true }, { url: 42 }],
      vitals: { lcp: "1500", cls: 0.1, fcp: null },
    };
    const parsed = parsePageEvidence("view", raw);
    expect(parsed.console).toHaveLength(20);
    expect(parsed.requests).toEqual([{ url: "https://a.example/a", status: 404 }]);
    expect(parsed.vitals).toEqual({ lcp: 1500, cls: 0.1, fcp: 0 });
  });

  it("tolerates null and junk", () => {
    expect(parsePageEvidence("v", null).console).toEqual([]);
    expect(parsePageEvidence("v", "junk").vitals.lcp).toBe(0);
  });
});

describe("evidenceCollectorScript", () => {
  it("wraps console, fetch, XHR, and performance observers", () => {
    const src = evidenceCollectorScript();
    expect(src).toContain("__qaEvidence");
    expect(src).toContain("console.error");
    expect(src).toContain("unhandledrejection");
    expect(src).toContain("XMLHttpRequest");
    expect(src).toContain("PerformanceObserver");
    expect(src).toContain("largest-contentful-paint");
  });
});
