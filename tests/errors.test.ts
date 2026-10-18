import { describe, expect, it } from "vitest";
import {
  ERROR_CATALOG,
  ERROR_CODES,
  errorBody,
  errorSpec,
  errorStatus,
  isErrorCode,
  a2aErrorCode,
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
  it("maps A2A failure tokens to catalog codes (phase 2)", () => {
    expect(a2aErrorCode("unknown_operation")).toBe("BAD_REQUEST");
    expect(a2aErrorCode("not_found")).toBe("NOT_FOUND");
    expect(a2aErrorCode("already_fired")).toBe("CONFLICT");
    expect(a2aErrorCode("goal_required")).toBe("VALIDATION_FAILED");
    expect(a2aErrorCode("invalid_cron")).toBe("VALIDATION_FAILED");
    expect(a2aErrorCode("missing_fields")).toBe("VALIDATION_FAILED");
    expect(a2aErrorCode("bad_url")).toBe("VALIDATION_FAILED");
    expect(a2aErrorCode("ai_search_not_found")).toBe("SEARCH_NOT_CONFIGURED");
    expect(a2aErrorCode("send quota exceeded for today")).toBe("RATE_LIMITED");
    expect(a2aErrorCode("something unrecognized")).toBe("INTERNAL");
    expect(a2aErrorCode(undefined)).toBe("INTERNAL");
  });

  it("the catalog carries the MCP token config code", () => {
    expect(isErrorCode("MCP_JWT_NOT_CONFIGURED")).toBe(true);
    expect(errorStatus("MCP_JWT_NOT_CONFIGURED")).toBe(503);
  });
});

describe("errorBodyAs / errorResponse helpers (issue #269 cluster C3)", () => {
  it("errorBodyAs keeps the route's exact string under the catalog contract", async () => {
    const { errorBodyAs, errorResponseAs, errorResponse } = await import("../src/errors");
    const body = errorBodyAs("UNAUTHORIZED", "API key required");
    expect(body).toEqual({
      error: "API key required",
      code: "UNAUTHORIZED",
      hint: errorSpec("UNAUTHORIZED").hint,
      retryable: false,
    });
    // The C3 contract strings survive verbatim:
    expect(errorBodyAs("INVALID_JSON", "Invalid JSON").error).toBe("Invalid JSON");
    expect(errorBodyAs("NO_HANDLER", "No handler").error).toBe("No handler");
  });

  it("errorResponse carries the catalog status and JSON content type", async () => {
    const { errorResponse, errorResponseAs } = await import("../src/errors");
    const res = errorResponse("INVALID_JSON");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const res2 = errorResponseAs("UNAUTHORIZED", "Unauthorized", {
      "WWW-Authenticate": "Bearer",
    });
    expect(res2.status).toBe(401);
    expect(res2.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await res2.json()).error).toBe("Unauthorized");
  });

  it("the C3 codes carry the statuses the old hand-rolled bodies used", () => {
    expect(errorStatus("INVALID_JSON")).toBe(400);
    expect(errorStatus("NO_HANDLER")).toBe(500);
    expect(errorStatus("PAYMENT_REQUIRED")).toBe(402);
    expect(errorStatus("INSUFFICIENT_SCOPE")).toBe(403);
    expect(errorStatus("EMAIL_AGENT_UNAVAILABLE")).toBe(503);
    expect(errorStatus("FEATURE_NOT_CONFIGURED")).toBe(503);
    expect(errorStatus("STRIPE_UPSTREAM")).toBe(502);
  });
});

