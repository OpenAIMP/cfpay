/**
 * Post-deploy QA smoke test.
 *
 * Runs against a deployed Worker after a successful deploy. It exists because a
 * deploy that "succeeds" only proves the upload worked, not that the app does.
 *
 * Exit code is the contract: 0 means every check that RAN passed. A check that
 * could not run (missing secret, endpoint absent) is reported as a skip rather
 * than silently passing, so the log never implies coverage it does not have.
 *
 * A plain .mjs script rather than a vitest suite: it must talk to live
 * production over HTTP, and it must not be collected by `vitest run`.
 */

const BASE_URL = (process.env.BASE_URL || "https://pay.openaimp.com").replace(/\/$/, "");
const API_KEY = process.env.DASHBOARD_API_KEY || "";
const TEST_EMAIL = process.env.QA_TEST_EMAIL || "";
// The attachment check is part of the suite and runs by default. It sends a
// real email, so QA_RUN_ATTACHMENT_CHECK=false remains as an explicit
// off-switch — included unless deliberately disabled (Mubasher, 2026-10-15).
const RUN_ATTACHMENT =
  String(process.env.QA_RUN_ATTACHMENT_CHECK || "").toLowerCase() !== "false";
// Same default for the report email (section 8): included unless disabled.
const RUN_REPORT =
  String(process.env.QA_RUN_REPORT_CHECK || "").toLowerCase() !== "false";

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`  [SKIP] ${name} - ${why}`);
}

/** POST a JSON body with the dashboard key. */
async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // An HTML error page is itself a finding; callers check the status.
  }
  return { status: res.status, json };
}

/** GET with the dashboard key. */
async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...(API_KEY ? { "X-API-Key": API_KEY } : {}) },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Same reasoning as post(): an HTML error page is itself a finding.
  }
  return { status: res.status, json };
}

function finish() {
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = ran - failed;
  console.log(
    `\n${passed}/${ran} checks passed` +
      (skipped ? `, ${skipped} skipped` : "") +
      (failed ? `, ${failed} FAILED` : ""),
  );
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  console.log(`Post-deploy QA against ${BASE_URL}\n`);

  // 1. The Worker answers at all. Everything else depends on it, so it is
  //    reported first and separately.
  try {
    const res = await fetch(`${BASE_URL}/health`);
    record("worker responds on /health", res.ok, `status=${res.status}`);
  } catch (err) {
    record("worker responds on /health", false, err.message);
    finish();
    return;
  }

  if (!API_KEY) {
    skip("authenticated QA checks", "DASHBOARD_API_KEY is not set");
    finish();
    return;
  }

  // 2. Non-destructive edge cases. Safe on every deploy.
  try {
    const { status, json } = await post("/api/dashboard/qa/edge-cases", {});
    record(
      "edge cases hold against production",
      status === 200 && json?.ok === true,
      json?.detail || `status=${status}`,
    );
    for (const c of json?.checks || []) {
      console.log(`      ${c.passed ? "ok  " : "BAD "} ${c.name} (${c.detail})`);
    }
  } catch (err) {
    record("edge cases hold against production", false, err.message);
  }

  // 3. Payment guards. Never signs, never spends.
  try {
    const { status, json } = await post("/api/dashboard/qa/payment-flow", {});
    record(
      "payment guards hold (no funds moved)",
      status === 200 && json?.ok === true,
      json?.detail || `status=${status}`,
    );
    if (json && json.settlementVerified === false) {
      console.log(
        "      note: settlement is NOT covered here; that would need a funded key.",
      );
    }
  } catch (err) {
    record("payment guards hold (no funds moved)", false, err.message);
  }

  // 4. Tab data: proves the dashboard authenticates and renders real rows.
  try {
    const { status, json } = await post("/api/dashboard/qa/tabs", {});
    if (status === 400) {
      skip("dashboard tabs render real data", "endpoint requires an explicit API key");
    } else {
      record(
        "dashboard tabs render real data",
        status === 200 && json?.ok === true,
        json?.error || `status=${status}`,
      );
      for (const t of json?.tabs || []) {
        console.log(`      ${t.passed ? "ok  " : "BAD "} ${t.name}: ${t.detail}`);
      }
    }
  } catch (err) {
    record("dashboard tabs render real data", false, err.message);
  }

  // 5. UX audit of the dashboard itself (issue #91). Asserts the audit RUNS
  //    and returns structured findings. The dashboard's own findings may
  //    legitimately fail rules — that is the audit working — so the verdict
  //    itself is reported, not gated.
  try {
    const { status, json } = await post("/api/dashboard/qa/ux-audit", {});
    const findings = Array.isArray(json?.checks) ? json.checks : [];
    record(
      "UX audit runs against the dashboard",
      status === 200 && findings.length > 0,
      json?.error || `${findings.length} findings, status=${status}`,
    );
    for (const f of findings) {
      console.log(`      ${f.passed ? "ok  " : "BAD "} ${f.name} (${f.detail})`);
    }
  } catch (err) {
    record("UX audit runs against the dashboard", false, err.message);
  }

  // 6. UX audit correctness (issue #94): the fixture page plants exactly
  //    four violations (public/qa-fixture.html). The generalized audit must
  //    catch those — and only those. This is the audit checking its own
  //    eyesight; a miss here means the probe or the rules regressed, even
  //    if every endpoint still answers.
  try {
    const fixtureUrl = `${BASE_URL}/qa-fixture.html`;
    const { status, json } = await post("/api/dashboard/qa/ux-audit-url", {
      spec: { pages: [fixtureUrl] },
    });
    const byName = new Map((json?.checks || []).map((c) => [c.name, c]));
    const expectFinding = (name, passed, detailPart) => {
      const f = byName.get(name);
      return (
        !!f &&
        f.passed === passed &&
        (!detailPart || (f.detail || "").includes(detailPart))
      );
    };
    const expectations = [
      ["Coverage", true, "1/1 pages measured"],
      ["Contrast (WCAG AA)", false, "planted-faint"],
      ["Target size", false, "planted-tiny"],
      ["Heading hierarchy", false, "skips h1 to h3"],
      ["Style consistency", true, null],
      ["Layout integrity", true, null],
      ["Image alt text", false, null],
    ];
    const misses = expectations.filter(
      ([n, p, d]) => !expectFinding(n, p, d),
    );
    record(
      "UX audit catches the fixture's planted violations",
      status === 200 && misses.length === 0,
      misses.length
        ? `missed: ${misses.map(([n]) => n).join(", ")} (status=${status})`
        : "all 4 planted violations caught, compliant controls clean",
    );
    for (const c of json?.checks || []) {
      console.log(`      ${c.passed ? "ok  " : "BAD "} ${c.name} (${c.detail})`);
    }
  } catch (err) {
    record("UX audit catches the fixture's planted violations", false, err.message);
  }

  // 7. Attachment check: drives the real Send Email form end to end and sends
  // a real email to QA_TEST_EMAIL. Runs by default; see RUN_ATTACHMENT above.
  if (!RUN_ATTACHMENT) {
    skip("send-email form with attachment", 'QA_RUN_ATTACHMENT_CHECK is "false"');
  } else if (!TEST_EMAIL) {
    skip("send-email form with attachment", "QA_TEST_EMAIL is not set");
  } else {
    try {
      const { status, json } = await post("/api/dashboard/qa/test-attachment", {
        toEmail: TEST_EMAIL,
      });
      record(
        "send-email form with attachment",
        status === 200 && json?.ok === true,
        json?.error || json?.detail || `status=${status}`,
      );
    } catch (err) {
      record("send-email form with attachment", false, err.message);
    }
  }

  // 8. The QA report email: the tab check WITH screenshots, emailed as the
  // 4-PNG report - the same email the dashboard's Email QA Report button
  // sends, and the report of record for this automated run. (Section 7 is
  // only a form probe; this is the suite's actual report.) Runs by default;
  // QA_RUN_REPORT_CHECK=false disables it.
  if (!RUN_REPORT) {
    skip("QA report email with screenshots", 'QA_RUN_REPORT_CHECK is "false"');
  } else if (!TEST_EMAIL) {
    skip("QA report email with screenshots", "QA_TEST_EMAIL is not set");
  } else {
    try {
      const { status, json } = await post("/api/dashboard/qa/email-report", {
        toEmail: TEST_EMAIL,
      });
      record(
        "QA report email with screenshots",
        status === 200 && json?.emailed === true,
        json?.error || `status=${status}`,
      );
      for (const t of json?.tabs || []) {
        console.log(`      ${t.passed ? "ok  " : "BAD "} ${t.name}: ${t.detail}`);
      }
    } catch (err) {
      record("QA report email with screenshots", false, err.message);
    }
  }

  // 9. Trading desk data endpoints (issue #112 part 2): the desk's panels
  //    read quotes / portfolio / chain straight from the MCP tools via
  //    these endpoints, so the suite exercises them directly. A 409 means
  //    Public.com is not connected on this deployment; the endpoints then
  //    cannot be exercised and the section skips rather than fails.
  try {
    const quotes = await get("/api/public/quotes?symbols=NVDA,AMD");
    if (quotes.status === 409) {
      skip("trading desk data endpoints respond", "Public.com is not connected");
    } else {
      const hasData = (r) => r.status === 200 && r.json && "data" in r.json;
      record("desk quotes respond", hasData(quotes), quotes.json?.error || `status=${quotes.status}`);
      const portfolio = await get("/api/public/portfolio");
      record("desk portfolio responds", hasData(portfolio), portfolio.json?.error || `status=${portfolio.status}`);
      const chain = await get("/api/public/chain?symbol=SMH");
      record("desk chain responds", hasData(chain), chain.json?.error || `status=${chain.status}`);
    }
  } catch (err) {
    record("trading desk data endpoints respond", false, err.message);
  }

  finish();
}

main().catch((err) => {
  console.error("QA smoke run crashed:", err);
  process.exit(1);
});
