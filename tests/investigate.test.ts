import { describe, expect, it } from "vitest";
import {
  INVESTIGATE_MAX_CALLS,
  INVESTIGATE_MAX_TURNS,
  clampInvestigateInput,
  investigateToolSpecs,
  pageStateExpression,
} from "../src/investigate";

describe("clampInvestigateInput (issue #102)", () => {
  it("accepts a question and an http(s) start URL", () => {
    expect(clampInvestigateInput("  Is the checkout button visible? ", " https://a.example/shop ")).toEqual({
      question: "Is the checkout button visible?",
      url: "https://a.example/shop",
    });
  });

  it("rejects a missing or over-long question", () => {
    expect(clampInvestigateInput("", "https://a.example")).toEqual({ error: "A question is required." });
    expect(clampInvestigateInput("x".repeat(501), "https://a.example")).toEqual({
      error: "Question is too long (500 chars max).",
    });
    expect(clampInvestigateInput(null, "https://a.example")).toEqual({ error: "A question is required." });
  });

  it("rejects non-http(s) or malformed URLs before any browser opens", () => {
    expect(clampInvestigateInput("q", "ftp://a.example")).toEqual({
      error: "A starting http(s) URL is required.",
    });
    expect(clampInvestigateInput("q", "")).toEqual({ error: "A starting http(s) URL is required." });
    expect(clampInvestigateInput("q", "https://")).toEqual({ error: "Invalid URL: https://" });
  });
});

describe("investigateToolSpecs (issue #102)", () => {
  it("offers the hand-rolled browser tools plus a report finish", () => {
    const names = investigateToolSpecs().map((s) => s.function.name);
    expect(names).toEqual(["navigate", "click", "type", "evaluate", "page_state", "screenshot", "report"]);
  });

  it("every spec is a well-formed Workers AI function tool", () => {
    for (const spec of investigateToolSpecs()) {
      expect(spec.type).toBe("function");
      expect(spec.function.description.length).toBeGreaterThan(10);
      expect(spec.function.parameters.type).toBe("object");
    }
    const report = investigateToolSpecs().find((s) => s.function.name === "report");
    expect(report?.function.parameters.required).toEqual(["findings"]);
  });
});

describe("pageStateExpression (issue #102)", () => {
  it("summarizes url, title, text, and interactive elements", () => {
    const expr = pageStateExpression();
    expect(expr).toContain("location.href");
    expect(expr).toContain("document.title");
    expect(expr).toContain("innerText");
    expect(expr).toContain("[data-tab]");
    expect(expr).toContain("JSON.stringify");
  });
});

describe("investigation budget (issue #102)", () => {
  it("stays inside the Free-plan browser budget", () => {
    expect(INVESTIGATE_MAX_TURNS).toBeLessThanOrEqual(8);
    expect(INVESTIGATE_MAX_CALLS).toBeLessThanOrEqual(12);
  });
});
