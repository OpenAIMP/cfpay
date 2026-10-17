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
const RUN_PDF =
  String(process.env.QA_RUN_PDF_CHECK || "").toLowerCase() !== "false";
const RUN_SLACK_POST =
  String(process.env.QA_RUN_SLACK_POST || "").toLowerCase() !== "false";

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

// Capacity wait-and-retry: a browser section refused by Browser
// Rendering capacity on the first pass is not skipped yet - it is
// deferred. After every section has run, the suite waits
// (QA_CAPACITY_WAIT_MS, default 90000) for browser sessions from
// earlier runs to drain, then re-runs ONLY the deferred sections
// once. A refusal on the retry pass is the honest SKIP of record.
// This exists because merge trains overlap deploys: the previous
// run's sessions are still holding the browser when the next run
// starts, and every browser section used to skip in lockstep.
let pass = 1;
const deferredNames = new Set();
function skipCapacity(name) {
  if (pass === 1) {
    deferredNames.add(name);
    console.log(`  [DEFER] ${name} - browser capacity; queued for the retry pass`);
    return;
  }
  skip(name, CAPACITY_WHY);
}
function shouldRun(name) {
  if (pass === 1) return true;
  if (!deferredNames.has(name)) return false;
  deferredNames.delete(name);
  return true;
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

// The same summary as a presentable HTML email (light theme, inline
// styles, status chips) - mail clients render the table; the plain
// text body above remains the fallback for clients that do not.
function summaryEmailHtml(subject) {
  const esc = (x) =>
    String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const chip = (r) => {
    const st = r.skipped
      ? "background:#e5e7eb;color:#4b5563;"
      : r.ok
        ? "background:#dcfce7;color:#166534;"
        : "background:#fee2e2;color:#b91c1c;";
    const label = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    return `<span style="${st}border-radius:999px;padding:1px 9px;font-size:11px;font-weight:700;">${label}</span>`;
  };
  const rows = results
    .map(
      (r) =>
        `<tr><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${chip(r)}</td>` +
        `<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${esc(r.name)}</td>` +
        `<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;">${esc(r.detail || "")}</td></tr>`,
    )
    .join("");
  return (
    `<div style="background:#f3f4f6;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">` +
    `<div style="padding:18px 22px;border-bottom:1px solid #e5e7eb;">` +
    `<div style="font-size:17px;font-weight:700;color:#111827;">${esc(subject)}</div>` +
    `<div style="font-size:12px;color:#6b7280;margin-top:3px;">Post-deploy QA against ${esc(BASE_URL)} - ${new Date().toISOString()}</div></div>` +
    `<table style="width:100%;border-collapse:collapse;">${rows}</table>` +
    `<div style="padding:14px 22px;font-size:12px;line-height:1.55;color:#6b7280;">A SKIP means the check did not run (usually browser capacity during a merge train), never that it passed. Browser sections refused by capacity are retried once after a wait before any SKIP is recorded. This summary is sent on every deploy precisely so a skipped or failed email is itself reported.</div>` +
    `</div></div>`
  );
}

let summarySent = false;
async function sendSummaryEmail() {
  // One short email per deploy listing every section's PASS/FAIL/SKIP,
  // sent through the dashboard's send-email route (no browser needed),
  // so a check that was skipped - including an email check itself - is
  // reported somewhere the owner actually reads. Best-effort: it never
  // changes the run's exit code.
  if (summarySent) return;
  summarySent = true;
  if (!TEST_EMAIL || !API_KEY) return;
  if (String(process.env.QA_RUN_SUMMARY || "").toLowerCase() === "false") return;
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const subject =
    `Post-deploy QA: ${passed}/${ran} passed` +
    (skipped ? `, ${skipped} skipped` : "") +
    (failed ? `, ${failed} FAILED` : "") +
    ` - ${new Date().toISOString().slice(0, 10)}`;
  const body = [
    `Post-deploy QA against ${BASE_URL} - ${new Date().toISOString()}`,
    "",
    ...results.map(
      (r) =>
        `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`,
    ),
    "",
    "A SKIP means the check did not run (usually browser capacity during a merge train), never that it passed. This summary is sent on every deploy precisely so a skipped or failed email is itself reported.",
  ].join("\n");
  try {
    const { status, json } = await post("/api/dashboard/send-email", {
      to: TEST_EMAIL,
      subject,
      body,
      html: summaryEmailHtml(subject),
    });
    console.log(
      json && (json.ok === true || json.emailId)
        ? `  [SUMMARY] emailed to ${TEST_EMAIL}`
        : `  [SUMMARY] send did not complete (status=${status})`,
    );
  } catch (err) {
    console.log(`  [SUMMARY] send failed: ${err.message}`);
  }
}

async function finish() {
  await investigateFailures();
  await sendSummaryEmail();
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

  await runSections();

  // Retry pass: give deferred browser sections one more chance once
  // earlier runs' sessions have had time to drain.
  if (deferredNames.size > 0) {
    pass = 2;
    const waitMs = Number(process.env.QA_CAPACITY_WAIT_MS || 90000);
    console.log(
      `\nBrowser capacity blocked ${deferredNames.size} check(s) on the first pass; ` +
        `waiting ${Math.round(waitMs / 1000)}s for sessions to drain, then retrying once...`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    await runSections();
  }

  await finish();
}

async function runSections() {
  if (pass === 1) {
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
  }

  if (pass === 1) {
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
  }

  if (shouldRun("dashboard tabs render real data")) {
  // 4. Tab data: proves the dashboard authenticates and renders real rows.
  try {
    const { status, json } = await post("/api/dashboard/qa/tabs", {});
    if (status === 400) {
      skip("dashboard tabs render real data", "endpoint requires an explicit API key");
    } else if (isCapacityRefusal(json?.error)) {
      skipCapacity("dashboard tabs render real data");
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
  }

  if (shouldRun("UX audit runs against the dashboard")) {
  // 5. UX audit of the dashboard itself (issue #91). Asserts the audit RUNS
  //    and returns structured findings. The dashboard's own findings may
  //    legitimately fail rules — that is the audit working — so the verdict
  //    itself is reported, not gated.
  try {
    const { status, json } = await post("/api/dashboard/qa/ux-audit", {});
    const findings = Array.isArray(json?.checks) ? json.checks : [];
    if (isCapacityRefusal(json?.error)) {
      skipCapacity("UX audit runs against the dashboard");
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
  }

  if (shouldRun("UX audit catches the fixture's planted violations")) {
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
      skipCapacity("UX audit catches the fixture's planted violations");
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
  }

  if (shouldRun("send-email form with attachment")) {
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
        skipCapacity("send-email form with attachment");
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
  }

  if (shouldRun("QA report email with screenshots")) {
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
        skipCapacity("QA report email with screenshots");
      } else {
        record(
          "QA report email with screenshots",
          status === 200 && json?.emailed === true,
          (json?.error || `status=${status}`) + (json?.slackConfigured ? ` slack=${json.slackPosted ?? 0} file(s)` : " slack=not-configured"),
        );
        for (const t of json?.tabs || []) {
          console.log(`      ${t.passed ? "ok  " : "BAD "} ${t.name}: ${t.detail}`);
        }
      }
    } catch (err) {
      record("QA report email with screenshots", false, err.message);
    }
  }
  }

  if (pass === 1) {
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

    if (pass === 1) {
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
    }

    // The reply Message carries the dispatch's text summary (the failing
    // check names); the structured artifact does not cross message/send,
    // so assert on the text: the fixture must report failing checks and
    // name the contrast rule among them.
    if (shouldRun("A2A qa.ux_audit dispatch returns findings")) {
    const audit = await a2aSend({ operation: "qa.ux_audit", spec: { pages: [`${BASE_URL}/qa-fixture.html`] } }, true);
    if (isCapacityRefusal(audit.blob)) {
      skipCapacity("A2A qa.ux_audit dispatch returns findings");
    } else {
      record(
        "A2A qa.ux_audit dispatch returns findings",
        audit.status === 200 && audit.blob.includes("found failing checks") && audit.blob.includes("Contrast (WCAG AA)"),
        `status=${audit.status}`,
      );
    }
    }
  } catch (err) {
    record("A2A dispatch", false, err.message);
  }

  if (shouldRun("Autopilot Trading Desk snapshot email")) {
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
        skipCapacity("Autopilot Trading Desk snapshot email");
      } else {
        record(
          "Autopilot Trading Desk snapshot email",
          status === 200 && json?.emailed === true && (json?.shots || []).length === 5,
          json?.error || `status=${status}, shots=${(json?.shots || []).length}, slack=${json?.slackConfigured ? `${json.slackPosted ?? 0} file(s)` : "not-configured"}`,
        );
      }
    } catch (err) {
      record("Autopilot Trading Desk snapshot email", false, err.message);
    }
  }
  }

  if (pass === 1) {
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
  }

  if (shouldRun("Autopilot hunt report PDF email")) {
  // 13. Autopilot hunt report PDF email: QAAgent tests the autopilot
  // agent's workflow end to end - it runs a real hunt through the
  // public routes and has the hunt's report PDF emailed (QAAgent
  // prints it, the EmailAgent sends it, Slack mirrors it). The
  // callable reports skipped when Public is not connected.
  if (!RUN_PDF) {
    skip("Autopilot hunt report PDF email", 'QA_RUN_PDF_CHECK is "false"');
  } else if (!TEST_EMAIL) {
    skip("Autopilot hunt report PDF email", "QA_TEST_EMAIL is not set");
  } else {
    try {
      const { status, json } = await post("/api/dashboard/qa/autopilot-hunt-test", { toEmail: TEST_EMAIL });
      if (json?.skipped) {
        skip("Autopilot hunt report PDF email", json.skipped);
      } else if (isCapacityRefusal(json?.error)) {
        skipCapacity("Autopilot hunt report PDF email");
      } else {
        record(
          "Autopilot hunt report PDF email",
          status === 200 && json?.emailed === true,
          json?.error ||
            `hunt=${json?.huntId || "?"} trades=${json?.trades ?? "?"} slack=${json?.slackConfigured ? `${json.slackPosted ?? 0} file(s)` : "not-configured"}`,
        );
      }
    } catch (err) {
      record("Autopilot hunt report PDF email", false, err.message);
    }
  }
  }

  if (shouldRun("agent A2A operations answer (all agents)")) {
  // 14. Agent A2A operations (issue #190): the manual curl checks,
  //     automated - one REAL read operation per A2A surface (the
  //     same authenticated message/send body an external caller
  //     sends with curl), plus the slack.post write proof
  //     (issue #188). Headless and model-free: runs even when
  //     browser capacity or the neuron budget is exhausted.
  //     QA_RUN_SLACK_POST=false skips only the Slack write row.
  try {
    const a2aOp = async (path, data) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
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
      return { status: res.status, json };
    };
    const replyText = (json) =>
      (json?.result?.parts || [])
        .filter((p) => p.kind === "text")
        .map((p) => p.text || "")
        .join(" ");
    const replyData = (json) =>
      (json?.result?.parts || []).find((p) => p.kind === "data")?.data || {};
    const rows = [
      ["host chat.summary", "/a2a", "chat.summary"],
      ["email.summary", "/a2a/email", "email.summary"],
      ["payments ledger.summary", "/a2a/payments", "ledger.summary"],
      ["webhooks webhook.summary", "/a2a/webhooks", "webhook.summary"],
      ["slack.summary", "/a2a/slack", "slack.summary"],
      ["qa.summary", "/a2a/qa", "qa.summary"],
      ["chat.summary", "/a2a/chat", "chat.summary"],
      ["voice.snapshot", "/a2a/voice", "voice.snapshot"],
      ["search.summary", "/a2a/search", "search.summary"],
      ["orchestrator.summary", "/a2a/orchestrator", "orchestrator.summary"],
    ];
    const bad = [];
    for (const [label, path, operation] of rows) {
      const r = await a2aOp(path, { operation });
      const data = replyData(r.json);
      const okRow =
        r.status === 200 &&
        r.json?.result?.kind === "message" &&
        replyText(r.json).length > 0 &&
        data?.ok !== false &&
        !data?.error;
      console.log(`      ${okRow ? "ok  " : "BAD "} ${label} (status=${r.status})`);
      if (!okRow) bad.push(`${label}: ${data?.error || `status=${r.status}`}`);
    }
    if (RUN_SLACK_POST) {
      const p = await a2aOp("/a2a/slack", {
        operation: "slack.post",
        text: `Post-deploy check (${new Date().toISOString()}): slack.post over A2A is live.`,
      });
      const pd = replyData(p.json);
      const postOk = p.status === 200 && pd?.ok === true;
      console.log(`      ${postOk ? "ok  " : "BAD "} slack.post write (via=${pd?.via || "?"})`);
      if (!postOk) bad.push(`slack.post: ${pd?.error || `status=${p.status}`}`);
    }
    record(
      "agent A2A operations answer (all agents)",
      bad.length === 0,
      bad.length ? bad.join("; ") : "10 read ops + slack.post write ok",
    );
  } catch (err) {
    record("agent A2A operations answer (all agents)", false, err.message);
  }
  }
}

main().catch((err) => {
  console.error("QA smoke run crashed:", err);
  process.exit(1);
});
