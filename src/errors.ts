/**
 * Error catalog access + platform-error mapping (issue #209).
 *
 * src/errors.json is the single source of truth for every error the
 * deployment returns: each entry carries the HTTP status, the
 * user-facing message, recovery guidance, and whether retrying can
 * help. The back end builds response bodies from it; the front end
 * fetches the same catalog from GET /api/errors.json. The CODE is
 * the linkage - callers never string-match error prose again.
 *
 * Response body shape (kept flat so existing string consumers keep
 * working): { error: <user message>, code, hint, retryable }.
 * Raw exception text is NEVER put in a body; unmapped failures
 * become INTERNAL and the original is logged server-side.
 */

import catalog from "./errors.json";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorSpec {
  http: number;
  message: string;
  hint: string;
  retryable: boolean;
}

export type ErrorCode = keyof typeof catalog;

export const ERROR_CATALOG = catalog as Record<ErrorCode, ErrorSpec>;

export const ERROR_CODES = Object.keys(catalog) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in catalog;
}

export function errorSpec(code: ErrorCode): ErrorSpec {
  return ERROR_CATALOG[code];
}

export function errorStatus(code: ErrorCode): ContentfulStatusCode {
  return ERROR_CATALOG[code].http as ContentfulStatusCode;
}

/** The JSON body for a catalog error. `detail` is for server logs, never sent. */
export function errorBody(code: ErrorCode): {
  error: string;
  code: ErrorCode;
  hint: string;
  retryable: boolean;
} {
  const spec = ERROR_CATALOG[code];
  return { error: spec.message, code, hint: spec.hint, retryable: spec.retryable };
}

/**
 * Map an unknown thrown value to the closest catalog code. Known
 * platform failures get precise codes; anything else is INTERNAL
 * (the caller logs the original). Matching is on the provider's
 * stable markers (numeric codes, error names), never on prose the
 * user sees.
 */
/**
 * Map an A2A operation's failure value (the `error` string in a
 * reply's data part) to a catalog code (issue #209 phase 2). The
 * agents' error strings are stable snake_case tokens for the named
 * failures (unknown_operation, not_found, invalid_cron, ...);
 * anything else falls through to the platform mapper.
 */
export function a2aErrorCode(error: unknown): ErrorCode {
  const text = typeof error === "string" ? error : "";
  if (text === "unknown_operation") return "BAD_REQUEST";
  if (text === "not_found") return "NOT_FOUND";
  if (text === "already_fired") return "CONFLICT";
  if (/quota/i.test(text)) return "RATE_LIMITED";
  if (/required|too_long|invalid|missing|bad_|never_fires|not_future|too_far|needs/.test(text)) {
    return "VALIDATION_FAILED";
  }
  return mapUnknownError(text || error);
}

export function mapUnknownError(err: unknown): ErrorCode {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  if (/4006|neurons|free allocation/i.test(text)) return "AI_QUOTA_EXHAUSTED";
  if (/3043/.test(text)) return "AI_PROVIDER_UNAVAILABLE";
  if (/ai_search_not_found|AI Search.*not found/i.test(text)) return "SEARCH_NOT_CONFIGURED";
  if (/did not return a WebSocket|browser.*capacity|capacity.*browser/i.test(text)) return "BROWSER_CAPACITY";
  if (/AiError|workers ai|inference/i.test(text)) return "AI_REQUEST_FAILED";
  if (/timed? ?out|timeout|deadline/i.test(text)) return "UPSTREAM_TIMEOUT";
  if (/proposal not found|trade proposal.*not found/i.test(text)) return "NOT_FOUND";
  return "INTERNAL";
}
