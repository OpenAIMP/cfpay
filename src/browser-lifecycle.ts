/**
 * Browser connection teardown and safe serialization, in one place.
 *
 * Exists because of a specific, shipped failure: QAAgent ended two browser
 * methods with
 *
 *     await browser.close().catch(() => {});
 *
 * but `CdpConnection.close()` is declared `close(): void` and returns
 * `undefined`. `.catch` on `undefined` throws a TypeError, and because the call
 * sat in a `finally`, the throw REPLACED whatever the method was about to
 * return. A QA run that had completed successfully surfaced as
 * "HTTP 500: Internal Server Error" on /api/dashboard/qa/email-report, with the
 * real result discarded and nothing in the response to say why.
 *
 * The mistake is invisible to the compiler: the browser handle is `any`, so
 * `.catch` on a void return type type-checks cleanly. Keeping teardown here
 * means it is written once and can be tested directly.
 */

/** Anything with an optional close(). */
interface Closeable {
  close?: () => unknown;
}

/**
 * Close a browser/CDP connection without letting teardown fail the caller.
 *
 * Tolerates every shape a real close() takes:
 *   - a void close() (CdpConnection) - the case that caused the outage
 *   - a promise-returning close(), resolved or rejected
 *   - close() that throws synchronously
 *   - no close() at all
 *
 * Returns true when a close was attempted, so a caller can distinguish "closed"
 * from "there was nothing to close".
 */
export function closeConnectionQuietly(connection: unknown): boolean {
  const close = (connection as Closeable | null | undefined)?.close;
  if (typeof close !== "function") return false;

  try {
    const outcome = (connection as Required<Closeable>).close();
    // Guard the promise case explicitly rather than assuming it. A void close()
    // returns undefined here, and assuming a promise is the bug being fixed.
    if (outcome && typeof (outcome as { catch?: unknown }).catch === "function") {
      void (outcome as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Teardown must never mask the result it is cleaning up after.
  }
  return true;
}

/**
 * Best-effort stringify for diagnostics.
 *
 * Used when reporting a failure: stringifying the value that just failed would
 * throw again (circular reference, BigInt) and turn a recoverable error into
 * the same 500 it was meant to explain. Handles both, and bounds the output.
 */
export function safeStringify(value: unknown, maxLength = 500): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return `${val.toString()}n`;
      if (typeof val === "object" && val !== null) {
        if (seen.has(val as object)) return "[circular]";
        seen.add(val as object);
      }
      return val;
    });
    if (json === undefined) return String(value);
    return json.length > maxLength ? `${json.slice(0, maxLength)}... [truncated]` : json;
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}
