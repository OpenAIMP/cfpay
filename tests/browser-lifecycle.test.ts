/**
 * Regression tests for the QA email-report 500.
 *
 * The shipped failure: QAAgent ended its browser methods with
 *
 *     await browser.close().catch(() => {});
 *
 * but CdpConnection.close() is declared `close(): void`, so `.catch` on the
 * returned undefined threw a TypeError. Because it sat in a `finally`, the throw
 * REPLACED the method's return value, and the result was an opaque
 * "HTTP 500: Internal Server Error" on /api/dashboard/qa/email-report even
 * though the QA run itself had completed.
 *
 * No type check can catch this: the browser handle is `any`. These tests pin the
 * behaviour instead.
 */
import { describe, it, expect, vi } from "vitest";
import { closeConnectionQuietly, safeStringify } from "../src/browser-lifecycle";

describe("closeConnectionQuietly", () => {
  it("does not throw when close() returns undefined", () => {
    // The exact shape that caused the outage: close(): void.
    const connection = { close() { /* returns undefined */ } };
    expect(() => closeConnectionQuietly(connection)).not.toThrow();
    expect(closeConnectionQuietly(connection)).toBe(true);
  });

  it("does not throw when close() returns a non-promise", () => {
    // Guards against re-introducing the bug for a close() that returns a bool.
    const connection = { close: () => true };
    expect(() => closeConnectionQuietly(connection)).not.toThrow();
  });

  it("handles a promise-returning close(), resolved or rejected", async () => {
    expect(() => closeConnectionQuietly({ close: () => Promise.resolve() })).not.toThrow();
    expect(() => closeConnectionQuietly({ close: () => Promise.reject(new Error("nope")) }))
      .not.toThrow();
    // Let the rejection settle; an unhandled one would fail the run.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("swallows a close() that throws synchronously", () => {
    const connection = {
      close() {
        throw new Error("socket already gone");
      },
    };
    expect(() => closeConnectionQuietly(connection)).not.toThrow();
  });

  it("tolerates a missing or non-callable close", () => {
    expect(closeConnectionQuietly(undefined)).toBe(false);
    expect(closeConnectionQuietly(null)).toBe(false);
    expect(closeConnectionQuietly({})).toBe(false);
    expect(closeConnectionQuietly({ close: "not-a-function" })).toBe(false);
  });

  it("never lets a rejected promise escape as an unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.once("unhandledRejection", onUnhandled);
    closeConnectionQuietly({ close: () => Promise.reject(new Error("boom")) });
    await new Promise((r) => setTimeout(r, 20));
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe("safeStringify", () => {
  it("serializes ordinary values", () => {
    expect(safeStringify({ ok: true })).toBe('{"ok":true}');
  });

  it("survives a circular reference, which JSON.stringify cannot", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => JSON.stringify(circular)).toThrow();
    expect(safeStringify(circular)).toContain("[circular]");
  });

  it("survives a BigInt, which JSON.stringify cannot", () => {
    // tx amounts are BigInt in this codebase, so this is a live risk.
    expect(() => JSON.stringify({ amount: 1n })).toThrow();
    expect(safeStringify({ amount: 1n })).toContain("1n");
  });

  it("bounds its output so a huge payload cannot flood the log", () => {
    const out = safeStringify({ big: "x".repeat(5000) }, 100);
    expect(out.length).toBeLessThanOrEqual(130);
    expect(out).toContain("[truncated]");
  });

  it("describes a value it still cannot serialize", () => {
    const hostile = {
      toJSON() {
        throw new Error("no");
      },
    };
    expect(safeStringify(hostile)).toContain("unserializable");
  });
});
