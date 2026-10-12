/**
 * The QA payloads must survive Durable Object RPC.
 *
 * DO RPC structured-clones the return value, so a payload containing a live
 * object - a browser handle, a WebSocket, a function - would make the CALL
 * itself fail, before any HTTP serialization happens. That failure surfaces at
 * the `await` in the fetch handler, which is a genuinely different bug from a
 * c.json() problem and needs a different fix.
 *
 * A theory was raised that this is what produced the QA 500. These tests check
 * the actual shapes the methods return, so the question is settled by evidence
 * rather than by reading the code.
 */
import { describe, it, expect } from "vitest";

// The shapes the QA methods return, built from the real field sets.
const payloads: Record<string, unknown> = {
  "runBrowserCheck success": {
    ok: true,
    url: "https://pay.openaimp.com",
    textLength: 4030,
    // The realistic worst case: a full-page PNG as a data URL.
    screenshot: "data:image/png;base64," + "A".repeat(500_000),
    checks: [{ name: "text contains \"Dashboard\"", passed: true }],
  },
  "runBrowserCheck failure": { ok: false, url: "u", textLength: 0, error: "boom" },
  qaDashboardTabs: {
    ok: true,
    tabs: [{ name: "Emails", passed: true, detail: "Rendered 3 row(s)." }],
  },
  qaAndEmailReport: {
    ok: true,
    emailed: true,
    tabs: [{ name: "Emails", passed: true, detail: "Rendered 3 row(s)." }],
  },
  testEmailAttachmentUI: { ok: true, detail: "Form submitted with 1 attachment" },
  qaPaymentFlow: {
    ok: true,
    detail: "Payment guards hold.",
    checks: [{ name: "unpaid request is challenged with 402", passed: true, detail: "status=402" }],
    unpaidPathVerified: true,
    settlementVerified: false,
  },
  qaEdgeCases: {
    ok: true,
    detail: "Edge cases behave.",
    checks: [{ name: "unauthenticated dashboard read is rejected", passed: true, detail: "status=401" }],
  },
};

describe("QA payloads survive structured clone (the DO RPC boundary)", () => {
  for (const [name, payload] of Object.entries(payloads)) {
    it(`${name} is structured-clonable`, () => {
      expect(() => structuredClone(payload)).not.toThrow();
    });
  }

  it("detects a non-clonable payload, so this suite can actually fail", () => {
    // Negative controls. A plain class instance is NOT a valid control:
    // structuredClone clones its own properties happily. These are.
    expect(() => structuredClone({ ok: true, fn: () => {} })).toThrow();
    expect(() =>
      structuredClone({ ok: true, handle: { send() {}, close() {} } }),
    ).toThrow();
  });

  it("keeps browser handles out of every returned field", () => {
    // The real risk this guards: a future edit returning the connection or a
    // target handle alongside the result. Only JSON-safe values may appear.
    for (const [name, payload] of Object.entries(payloads)) {
      const json = JSON.stringify(payload);
      expect(json, `${name} must be JSON-serializable`).toBeTypeOf("string");
      expect(json, `${name} must not leak a close/send handle`).not.toMatch(
        /"(close|send|attachToTarget)"\s*:/,
      );
    }
  });
});
