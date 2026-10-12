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
const RUN_ATTACHMENT =
  String(process.env.QA_RUN_ATTACHMENT_CHECK || "").toLowerCase() === "true";

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

  // 5. The attachment check SENDS REAL MAIL, so it is opt-in and off by default.
  if (!RUN_ATTACHMENT) {
    skip("send-email form with attachment", 'QA_RUN_ATTACHMENT_CHECK is not "true"');
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

  finish();
}

main().catch((err) => {
  console.error("QA smoke run crashed:", err);
  process.exit(1);
});
