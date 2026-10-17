import { describe, expect, it } from "vitest";
import {
  ERROR_CATALOG,
  ERROR_CODES,
  errorBody,
  errorSpec,
  errorStatus,
  isErrorCode,
  mapUnknownError,
} from "../src/errors";

// Issue #209: the error catalog is the contract between back end
// and front end. These tests keep every entry complete and the
// platform-error mapping honest.

describe("error catalog (issue #209)", () => {
  it("every entry is complete and well-formed", () => {
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(12);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      const spec = errorSpec(code);
      expect(Number.isInteger(spec.http)).toBe(true);
      expect(spec.http).toBeGreaterThanOrEqual(400);
      expect(spec.http).toBeLessThanOrEqual(599);
      expect(spec.message.length).toBeGreaterThan(0);
      expect(spec.hint.length).toBeGreaterThan(0);
      expect(typeof spec.retryable).toBe("boolean");
    }
  });

  it("errorBody carries the catalog copy plus the code linkage", () => {
    const body = errorBody("AI_QUOTA_EXHAUSTED");
    expect(body.code).toBe("AI_QUOTA_EXHAUSTED");
    expect(body.error).toBe(errorSpec("AI_QUOTA_EXHAUSTED").message);
    expect(body.hint).toBe(errorSpec("AI_QUOTA_EXHAUSTED").hint);
    expect(body.retryable).toBe(false);
    expect(errorStatus("AI_QUOTA_EXHAUSTED")).toBe(503);
    expect(errorStatus("UNAUTHORIZED")).toBe(401);
  });

  it("isErrorCode recognizes only catalog codes", () => {
    expect(isErrorCode("INTERNAL")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(ERROR_CATALOG.INTERNAL.message).toContain("server");
  });
});

describe("mapUnknownError (issue #209)", () => {
  it("maps the Workers AI quota wall (the raw 4006 leak)", () => {
    const err = new Error(
      "AiError: 4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
    );
    expect(mapUnknownError(err)).toBe("AI_QUOTA_EXHAUSTED");
  });

  it("maps the transient provider error (3043)", () => {
    expect(mapUnknownError(new Error("AiError: 3043: internal server error"))).toBe(
      "AI_PROVIDER_UNAVAILABLE",
    );
  });

  it("maps a missing AI Search instance", () => {
    expect(mapUnknownError(new Error("ai_search_not_found"))).toBe("SEARCH_NOT_CONFIGURED");
  });

  it("maps browser capacity refusals and timeouts", () => {
    expect(mapUnknownError(new Error("Browser session did not return a WebSocket"))).toBe(
      "BROWSER_CAPACITY",
    );
    expect(mapUnknownError(new Error("The operation timed out"))).toBe("UPSTREAM_TIMEOUT");
  });

  it("maps a missing trade proposal", () => {
    expect(mapUnknownError(new Error("Trade proposal not found"))).toBe("NOT_FOUND");
  });

  it("falls back to INTERNAL for anything unrecognized", () => {
    expect(mapUnknownError(new Error("something entirely new"))).toBe("INTERNAL");
    expect(mapUnknownError(null)).toBe("INTERNAL");
    expect(mapUnknownError(undefined)).toBe("INTERNAL");
    expect(mapUnknownError("a bare string")).toBe("INTERNAL");
  });
});
