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
const RUN_DESK =
  String(process.env.QA_RUN_DESK_CHECK || "").toLowerCase() !== "false";
const RUN_A2A =
  String(process.env.QA_RUN_A2A_CHECK || "").toLowerCase() !== "false";

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

// QAAgent prefixes every browser-capacity refusal the same way
// (describeBrowserFailure in src/qa-agent.ts): the session could not be
// opened at all, which is Cloudflare Browser Rendering quota/concurrency
// — weather, not evidence about the app. Per this suite's contract, a
// check that could not run is a SKIP, never a failure; the skip line
// keeps the refusal visible in the log and the summary.
const CAPACITY_WHY =
  "browser capacity unavailable (Cloudflare Browser Rendering quota/concurrency) - check not run";
function isCapacityRefusal(...texts) {
  return texts.some(
    (t) =>
      typeof t === "string" &&
      t.toLowerCase().includes("could not open a browser session"),
  );
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

// Failure follow-up (issue #102): when anything gated failed, hand
// the failure to QAAgent's agentic investigator before exiting, so
// the CI log carries a diagnosis and not just a red X. Runs once,
// best-effort, and never changes the exit code.
let investigated = false;
async function investigateFailures() {
  if (investigated) return;
  investigated = true;
  const failures = results.filter((r) => !r.ok && !r.skipped);
  if (failures.length === 0 || !API_KEY) return;
  console.log("\nInvestigating the failure(s) with QAAgent (qa.investigate)...");
  try {
    const question =
      "The post-deploy QA smoke failed. Failing checks: " +
      failures.map((f) => `${f.name}${f.detail ? ` - ${f.detail}` : ""}`).join("; ") +
      ". Investigate the site, find the likely cause, and report what is broken and what evidence supports it.";
    const { status, json } = await post("/api/dashboard/qa/investigate", { question, url: BASE_URL, profile: true });
    if (status === 200 && json && json.answer) {
      console.log(`  [INVESTIGATE] ${String(json.answer).split("\n").join("\n  ")}`);
    } else if (json && json.error) {
      console.log(`  [INVESTIGATE] no diagnosis: ${String(json.error).slice(0, 300)}`);
    } else {
      console.log(`  [INVESTIGATE] no diagnosis (status=${status})`);
    }
  } catch (err) {
    console.log(`  [INVESTIGATE] failed to run: ${err.message}`);
  }
}

async function finish() {
  await investigateFailures();
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
    await finish();
    return;
  }

  if (!API_KEY) {
    skip("authenticated QA checks", "DASHBOARD_API_KEY is not set");
    await finish();
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
    } else if (isCapacityRefusal(json?.error)) {
      skip("dashboard tabs render real data", CAPACITY_WHY);
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
    if (isCapacityRefusal(json?.error)) {
      skip("UX audit runs against the dashboard", CAPACITY_WHY);
    } else {
      record(
        "UX audit runs against the dashboard",
        status === 200 && findings.length > 0,
        json?.error || `${findings.length} findings, status=${status}`,
      );
      for (const f of findings) {
        console.log(`      ${f.passed ? "ok  " : "BAD "} ${f.name} (${f.detail})`);
      }
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
    if (
      isCapacityRefusal(json?.error) &&
      (json?.checks || []).length === 0
    ) {
      skip("UX audit catches the fixture's planted violations", CAPACITY_WHY);
    } else {
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
      if (isCapacityRefusal(json?.error, json?.detail)) {
        skip("send-email form with attachment", CAPACITY_WHY);
      } else {
        record(
          "send-email form with attachment",
          status === 200 && json?.ok === true,
          json?.error || json?.detail || `status=${status}`,
        );
      }
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
      if (isCapacityRefusal(json?.error)) {
        skip("QA report email with screenshots", CAPACITY_WHY);
      } else {
        record(
          "QA report email with screenshots",
          status === 200 && json?.emailed === true,
          json?.error || `status=${status}`,
        );
        for (const t of json?.tabs || []) {
          console.log(`      ${t.passed ? "ok  " : "BAD "} ${t.name}: ${t.detail}`);
        }
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

  // 10. A2A dispatch (issue #102 step 3): the QA agent's A2A endpoint
  //     refuses the unauthenticated, and an authenticated JSON-RPC
  //     message/send carrying a data part dispatches the operation and
  //     returns its result in the task artifact. qa.summary proves the
  //     round-trip cheaply; qa.ux_audit against the fixture proves a
  //     real browser operation travels the same path.
  try {
    const a2aSend = async (data, withAuth) => {
      const res = await fetch(`${BASE_URL}/a2a/qa`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(withAuth ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `smoke-${data.operation}`,
          method: "message/send",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: `smoke-${Date.now()}`,
              parts: [{ kind: "data", data }],
            },
          },
        }),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json, blob: JSON.stringify(json || {}) };
    };

    const noAuth = await a2aSend({ operation: "qa.summary" }, false);
    record("A2A refuses unauthenticated dispatch", noAuth.status === 401, `status=${noAuth.status}`);

    // The transport's message/send result is the agent's reply Message
    // (kind: "message" with the text part), not a Task - assert that
    // real shape, not the shape one might assume from the spec diagram.
    const summary = await a2aSend({ operation: "qa.summary" }, true);
    const summaryParts = summary.json?.result?.parts || [];
    record(
      "A2A qa.summary dispatch round-trips",
      summary.status === 200 &&
        summary.json?.result?.kind === "message" &&
        summaryParts.some((p) => p.kind === "text" && String(p.text || "").includes("QA status.")),
      `status=${summary.status}`,
    );

    // The reply Message carries the dispatch's text summary (the failing
    // check names); the structured artifact does not cross message/send,
    // so assert on the text: the fixture must report failing checks and
    // name the contrast rule among them.
    const audit = await a2aSend({ operation: "qa.ux_audit", spec: { pages: [`${BASE_URL}/qa-fixture.html`] } }, true);
    if (isCapacityRefusal(audit.blob)) {
      skip("A2A qa.ux_audit dispatch returns findings", CAPACITY_WHY);
    } else {
      record(
        "A2A qa.ux_audit dispatch returns findings",
        audit.status === 200 && audit.blob.includes("found failing checks") && audit.blob.includes("Contrast (WCAG AA)"),
        `status=${audit.status}`,
      );
    }
  } catch (err) {
    record("A2A dispatch", false, err.message);
  }

  // 11. Autopilot Trading Desk snapshot email (PR #134): the second
  //     standing email - five screenshots of the whole desk (overview,
  //     trading chat, runs, portfolio/chain, trade approvals) to the
  //     same QA_TEST_EMAIL as the report. Runs by default;
  //     QA_RUN_DESK_CHECK=false disables it.
  if (!RUN_DESK) {
    skip("Autopilot Trading Desk snapshot email", 'QA_RUN_DESK_CHECK is "false"');
  } else if (!TEST_EMAIL) {
    skip("Autopilot Trading Desk snapshot email", "QA_TEST_EMAIL is not set");
  } else {
    try {
      const { status, json } = await post("/api/dashboard/qa/desk-snapshot", {
        toEmail: TEST_EMAIL,
      });
      if (isCapacityRefusal(json?.error)) {
        skip("Autopilot Trading Desk snapshot email", CAPACITY_WHY);
      } else {
        record(
          "Autopilot Trading Desk snapshot email",
          status === 200 && json?.emailed === true && (json?.shots || []).length === 5,
          json?.error || `status=${status}, shots=${(json?.shots || []).length}`,
        );
      }
    } catch (err) {
      record("Autopilot Trading Desk snapshot email", false, err.message);
    }
  }

  // 12. A2A test email: QAAgent probes EVERY agent's A2A endpoint
  // (card, 401-without-auth, authenticated snapshot dispatch - all
  // read-only) and emails the results. No browser involved, so no
  // capacity skip: a failure here is a real endpoint failure.
  if (!RUN_A2A) {
    skip("A2A endpoint test email", 'QA_RUN_A2A_CHECK is "false"');
  } else if (!TEST_EMAIL) {
    skip("A2A endpoint test email", "QA_TEST_EMAIL is not set");
  } else {
    try {
      const { status, json } = await post("/api/dashboard/qa/a2a-test", { toEmail: TEST_EMAIL });
      const rows = (json && json.results) || [];
      const passed = rows.filter((r) => r.ok).length;
      record(
        "A2A endpoint test email",
        status === 200 && !!json && json.emailed === true && json.ok === true,
        json && json.emailed
          ? `${passed}/${rows.length} surfaces responding`
          : `status=${status} emailed=${json && json.emailed} error=${(json && json.error) || "none"}`,
      );
    } catch (err) {
      record("A2A endpoint test email", false, err.message);
    }
  }

  await finish();
}

main().catch((err) => {
  console.error("QA smoke run crashed:", err);
  process.exit(1);
});
