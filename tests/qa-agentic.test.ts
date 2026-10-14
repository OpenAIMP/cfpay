/**
 * Unit tests for the QA agent's decision rules (src/qa-verdict.ts) and browser
 * teardown (src/browser-lifecycle.ts).
 *
 * These modules exist so the parts that decide what a QA run may claim are testable
 * without a live browser: there is no browser binding in this repo's test environment,
 * so anything that needed real CDP could not be verified here at all. Everything below
 * is a pure function, which is the point of the split.
 */
import { describe, it, expect } from "vitest";
import {
  assembleVerdict,
  isAllowedTarget,
  parseAllowedHosts,
  parseInvestigationEnvelope,
  readInvestigationRequest,
  recordFinding,
  truncateText,
  MIN_EVIDENCE_CHARS,
  type QAFinding,
} from "../src/qa-verdict";
import { closeConnectionQuietly } from "../src/browser-lifecycle";

const EVIDENCE = 'Page text contains "Payments" in the first table heading.';

describe("recordFinding refuses a claim it cannot support", () => {
  it("accepts a claim with a quoted observation", () => {
    const findings: QAFinding[] = [];
    const outcome = recordFinding(findings, {
      claim: "the payments tab renders",
      status: "pass",
      evidence: EVIDENCE,
    });

    expect(outcome.accepted).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toBe("the payments tab renders");
  });

  it("refuses a pass whose evidence is too short to be an observation", () => {
    const findings: QAFinding[] = [];
    const outcome = recordFinding(findings, { claim: "looks fine", status: "pass", evidence: "ok" });

    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/observation/);
    expect(findings, "a refused claim must not be recorded").toHaveLength(0);
  });

  it("draws the evidence line exactly at the documented length", () => {
    // The boundary is asserted rather than assumed: a rule that rejected a real quoted
    // observation would push the model to write longer prose instead of looking again.
    const findings: QAFinding[] = [];
    const tooShort = recordFinding(findings, {
      claim: "boundary",
      status: "pass",
      evidence: "x".repeat(MIN_EVIDENCE_CHARS - 1),
    });
    const exactly = recordFinding(findings, {
      claim: "boundary",
      status: "pass",
      evidence: "x".repeat(MIN_EVIDENCE_CHARS),
    });

    expect(tooShort.accepted).toBe(false);
    expect(exactly.accepted).toBe(true);
  });

  it("refuses a claim with no evidence field at all", () => {
    const findings: QAFinding[] = [];
    const outcome = recordFinding(findings, { claim: "the dashboard loads", status: "pass" });

    expect(outcome.accepted).toBe(false);
    expect(findings).toHaveLength(0);
  });

  it("refuses a claim with no claim text", () => {
    const findings: QAFinding[] = [];
    const outcome = recordFinding(findings, { claim: "   ", status: "fail", evidence: EVIDENCE });

    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/what you were checking/i);
  });

  it("refuses a status outside pass, fail and blocked", () => {
    const findings: QAFinding[] = [];
    const outcome = recordFinding(findings, { claim: "x", status: "maybe", evidence: EVIDENCE });

    expect(outcome.accepted).toBe(false);
    expect(findings).toHaveLength(0);
  });

  it("requires evidence for a failure and a blocker too, not only a pass", () => {
    // "It failed" with nothing quoted is the mirror image of an unobserved pass, and
    // just as unactionable at the other end.
    const findings: QAFinding[] = [];
    expect(recordFinding(findings, { claim: "tab missing", status: "fail", evidence: "no" }).accepted).toBe(false);
    expect(recordFinding(findings, { claim: "cannot tell", status: "blocked", evidence: "no" }).accepted).toBe(false);
    expect(recordFinding(findings, { claim: "tab missing", status: "fail", evidence: EVIDENCE }).accepted).toBe(true);
  });

  it("reports the running total so a caller can see the record grow", () => {
    const findings: QAFinding[] = [];
    recordFinding(findings, { claim: "a", status: "pass", evidence: EVIDENCE });
    const second = recordFinding(findings, { claim: "b", status: "pass", evidence: EVIDENCE });

    expect(second.recorded).toBe(2);
  });
});

describe("assembleVerdict never turns silence into a pass", () => {
  const base = { url: "https://example.com/", goal: "check it loads", toolCalls: 3, textLength: 900 };

  it("is not a pass when nothing was recorded", () => {
    const verdict = assembleVerdict({ ...base, findings: [], stoppedReason: "concluded" });

    expect(verdict.ok).toBe(false);
    expect(verdict.stoppedReason).toBe("no_findings");
  });

  it("is a pass when every recorded claim passed", () => {
    const verdict = assembleVerdict({
      ...base,
      findings: [{ claim: "a", status: "pass", evidence: EVIDENCE }],
      stoppedReason: "concluded",
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.stoppedReason).toBe("concluded");
  });

  it("is not a pass when any recorded claim did not", () => {
    const verdict = assembleVerdict({
      ...base,
      findings: [
        { claim: "a", status: "pass", evidence: EVIDENCE },
        { claim: "b", status: "fail", evidence: EVIDENCE },
      ],
      stoppedReason: "concluded",
    });

    expect(verdict.ok).toBe(false);
  });

  it("is not a pass when the run did not conclude cleanly", () => {
    // Half a check is not a check, even if the half that ran came back clean.
    const verdict = assembleVerdict({
      ...base,
      findings: [{ claim: "a", status: "pass", evidence: EVIDENCE }],
      stoppedReason: "error",
      error: "browser disconnected",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.stoppedReason).toBe("error");
    expect(verdict.error).toBe("browser disconnected");
  });

  it("keeps a refusal reason that arrived before any browser was touched", () => {
    const verdict = assembleVerdict({ ...base, findings: [], toolCalls: 0, textLength: 0, stoppedReason: "blocked_host" });

    expect(verdict.ok).toBe(false);
    expect(verdict.stoppedReason).toBe("blocked_host");
  });
});

describe("the target guard bounds where browsing may go", () => {
  const allowed = parseAllowedHosts(" pay.example.com , *.trusted.test ");

  it("accepts http and https", () => {
    expect(isAllowedTarget("https://example.com/page").ok).toBe(true);
    expect(isAllowedTarget("http://example.com/").ok).toBe(true);
  });

  it("normalises the scheme's case instead of refusing it", () => {
    expect(isAllowedTarget("HTTPS://example.com/").ok).toBe(true);
  });

  it("refuses a scheme that is not http(s)", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/"]) {
      const guard = isAllowedTarget(url);
      expect(guard.ok, url + " must be refused").toBe(false);
      expect(guard.ok === false && guard.reason).toBe("bad_url");
    }
  });

  it("refuses something that is not a URL at all", () => {
    const guard = isAllowedTarget("example.com");
    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.reason).toBe("bad_url");
  });

  it("is unrestricted when no allowlist is configured", () => {
    expect(isAllowedTarget("https://anything.test/").ok).toBe(true);
    expect(parseAllowedHosts(undefined)).toHaveLength(0);
    expect(parseAllowedHosts("")).toHaveLength(0);
    expect(parseAllowedHosts(" , ,")).toHaveLength(0);
  });

  it("matches an exact host, and a wildcard on subdomains only", () => {
    expect(isAllowedTarget("https://pay.example.com/x", allowed).ok).toBe(true);
    expect(isAllowedTarget("https://a.trusted.test/x", allowed).ok).toBe(true);
    expect(isAllowedTarget("https://trusted.test/x", allowed).ok).toBe(false);
  });

  it("refuses a host that merely appears in the URL", () => {
    // The userinfo trap: the allowed name is in the prefix and the request goes to
    // attacker.test. A prefix comparison passes exactly the URL it is meant to stop.
    const guard = isAllowedTarget("https://pay.example.com@attacker.test/steal", allowed);

    expect(guard.ok).toBe(false);
    expect(guard.ok === false && guard.reason).toBe("blocked_host");
    expect(guard.ok === false && guard.host).toBe("attacker.test");
  });

  it("does not match a suffix that is not a dot boundary", () => {
    expect(isAllowedTarget("https://evilpay.example.com.attacker.test/", allowed).ok).toBe(false);
  });
});

describe("readInvestigationRequest only arms on a real envelope", () => {
  const envelope = JSON.stringify({ operation: "qa.investigate", url: "https://pay.example.com/", goal: "find the broken tab" });

  it("reads the envelope a dispatched tool call sends", () => {
    const request = readInvestigationRequest([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: envelope },
    ]);

    expect(request?.url).toBe("https://pay.example.com/");
    expect(request?.goal).toBe("find the broken tab");
  });

  it("reads it out of message parts as well as a plain string", () => {
    const request = readInvestigationRequest([
      { role: "user", content: [{ type: "text", text: envelope }] },
    ]);

    expect(request?.url).toBe("https://pay.example.com/");
  });

  it("ignores an envelope from earlier in the conversation", () => {
    // Otherwise a spent envelope would bound a later, unrelated question to browser
    // tools with no page open.
    const request = readInvestigationRequest([
      { role: "user", content: envelope },
      { role: "user", content: "what does the dashboard say today?" },
    ]);

    expect(request).toBeNull();
  });

  it("ignores prose, other operations, and an envelope with no url", () => {
    expect(readInvestigationRequest([{ role: "user", content: "check the dashboard" }])).toBeNull();
    expect(readInvestigationRequest([{ role: "user", content: JSON.stringify({ operation: "qa.check", url: "https://x.test/" }) }])).toBeNull();
    expect(readInvestigationRequest([{ role: "user", content: JSON.stringify({ operation: "qa.investigate" }) }])).toBeNull();
    expect(readInvestigationRequest([])).toBeNull();
    expect(readInvestigationRequest(undefined)).toBeNull();
  });

  it("ignores JSON that only starts like one", () => {
    expect(parseInvestigationEnvelope("{not json")).toBeNull();
    expect(parseInvestigationEnvelope('"qa.investigate"')).toBeNull();
  });

  // The caller-supplied key passthrough is deliberately not asserted here: the test
  // would have to write a literal assignment to that field, which the workspace secret
  // guard refuses. It is covered by reading parseInvestigationEnvelope, which returns
  // the field when it is a non-empty string and omits it otherwise.
});

describe("truncateText reports what it cut", () => {
  it("leaves a short string alone", () => {
    expect(truncateText("hello", 100)).toEqual({ text: "hello", originalLength: 5, truncated: false });
  });

  it("cuts a long string and keeps the original length", () => {
    const result = truncateText("abcdef", 3);
    expect(result.text).toBe("abc");
    expect(result.originalLength).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it("does not report a cut when nothing was removed", () => {
    // The boundary matters: a run told "truncated" when nothing was removed would report
    // blocked claims it had actually checked in full.
    const exact = "x".repeat(10);
    expect(truncateText(exact, 10).truncated).toBe(false);
    expect(truncateText(exact + "y", 10).truncated).toBe(true);
  });

  it("does not throw on a non-string, and never returns a negative limit", () => {
    expect(truncateText(undefined, 10).text).toBe("");
    expect(truncateText("abc", -5).text).toBe("");
  });
});

describe("closeConnectionQuietly survives every teardown shape", () => {
  it("handles the void close() that caused the outage", () => {
    // CdpConnection.close() is declared `close(): void`. The shipped bug was
    // `await browser.close().catch(...)`, where .catch ran on undefined.
    let closed = false;
    const connection = { close: () => { closed = true; } };

    const attempted = closeConnectionQuietly(connection);

    expect(attempted).toBe(true);
    expect(closed).toBe(true);
  });

  it("handles a promise-returning close, resolved", () => {
    const connection = { close: () => Promise.resolve() };
    expect(closeConnectionQuietly(connection)).toBe(true);
  });

  it("handles a rejecting close without surfacing it", () => {
    const connection = { close: () => Promise.reject(new Error("socket gone")) };
    expect(() => closeConnectionQuietly(connection)).not.toThrow();
  });

  it("handles a close that throws synchronously", () => {
    const connection = { close: () => { throw new Error("already closed"); } };
    expect(() => closeConnectionQuietly(connection)).not.toThrow();
  });

  it("reports that there was nothing to close", () => {
    expect(closeConnectionQuietly(null)).toBe(false);
    expect(closeConnectionQuietly(undefined)).toBe(false);
    expect(closeConnectionQuietly({})).toBe(false);
    expect(closeConnectionQuietly({ close: "not a function" })).toBe(false);
  });
});
