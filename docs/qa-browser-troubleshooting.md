# QAAgent — Capabilities, Limitations & Platform Guide

## What QAAgent is

QAAgent is the autonomous QA agent for the cfpay dashboard (`pay.openaimp.com`). It drives headless Chromium through Cloudflare's Browser Rendering binding to verify the dashboard works. It extends Think (making it chat-capable and composable via `agentTool()`), but its QA checks are deterministic scripts — not model-driven.

## Capabilities

Seven `@callable()` methods, all behind `requireAuth`, exposed as `POST /api/dashboard/qa/*` and as dashboard buttons:

| Button | Endpoint | Method | What it proves |
|---|---|---|---|
| Run Full Suite | `/qa/full-suite` | `qaFullSuite(apiKey, toEmail?)` | Runs every check below in order; one aggregate PASS/FAIL. The two email checks are skipped unless a recipient is entered. |
| Run QA Check | `/qa/check` | `qaCheck(url, checks)` | Browser-check any URL with text assertions |
| Check This Dashboard | `/qa/dashboard` | `qaDashboard(apiKey)` | Dashboard loads, key elements present, screenshot captured |
| Verify Tab Data | `/qa/tabs` | `qaDashboardTabs(apiKey)` | Tab click-through with data verification (see below) |
| Test Attachment via UI | `/qa/test-attachment` | `testEmailAttachmentUI(apiKey, toEmail)` | End-to-end Send Email form: fill fields, attach file via `DataTransfer`, submit via real button, verify success. Sends a **real email** with attachment. |
| Check Payment Guards | `/qa/payment-flow` | `qaPaymentFlow(apiKey)` | Payment *gate* holds: 402 challenge is well-formed, malformed signatures refused. **No money moves** — no crypto, no card. |
| Check Edge Cases | `/qa/edge-cases` | `qaEdgeCases(apiKey)` | Unauthenticated reads rejected, wrong API key rejected, unknown routes don't report success, errors are JSON not HTML |
| Email QA Report | `/qa/email-report` | `qaAndEmailReport(apiKey, toEmail)` | Runs tab checks + dashboard screenshot on one shared browser session, emails the report with PNG attached. Sends a **real email**. |

### Tab coverage

`qaDashboardTabs` clicks through and verifies loaded data for **3 tabs**:

- **Emails** (`emails` → `emailList`)
- **Payments** (`payments` → `paymentList`)
- **Webhooks** (`webhooks` → `webhookList`)

Each tab is clicked, the click is asserted to have landed, and the data container is checked for real content (not just the tab existing).

**Not covered:** Chat tab (interactive), QA tab itself (self-test would be circular), Dashboard home (covered by `qaDashboard`), Send Email form (covered by `testEmailAttachmentUI`).

### How tabs are selected

The tab list is **hardcoded** in `qaDashboardTabs` (`src/qa-agent.ts`) — not discovered from the DOM:

```ts
const tabs = [
  { name: "Emails", tab: "emails", containerId: "emailList", emptyText: "No emails yet" },
  { name: "Payments", tab: "payments", containerId: "paymentList", emptyText: "No payments yet" },
  { name: "Webhooks", tab: "webhooks", containerId: "webhookList", emptyText: "No webhook events yet" },
];
```

Each entry maps a tab button ID → the data container it populates → the expected empty-state text. The `emptyText` lets the check distinguish "loaded but empty" from "failed to load". Adding a new tab requires a code change to this array — the assertions are tab-specific and can't be inferred generically.

### Screenshots

`qaAndEmailReport` attaches **one** screenshot: the dashboard homepage (`qa-dashboard-YYYY-MM-DD.png`), captured on the same shared browser session as the tab checks. The tab checks verify data but capture no per-tab screenshots. (Open issue: capture per-tab screenshots after each click lands.)

## QA workflow — how to use it

### Prerequisites

- The QA tab is on the dashboard at `https://pay.openaimp.com` (sign in with your API key first).
- The login-seeding fix (PR #74) must be merged **and** deployed. Before it, "Verify Tab Data" always failed with "Dashboard showed the login page... The API key was not accepted" even with a valid key, because the agent seeded `localStorage` on the `about:blank` target (opaque origin) before navigating — `localStorage` is origin-scoped, so the dashboard never saw the key. The fix reorders to navigate → seed → reload.

### Running the checks (dashboard QA tab)

The QA tab shows buttons on the left and a plain-language description of each on the right. Run in this order, lightest first — or click **Run Full Suite** to run everything below in one go and get a single aggregate PASS/FAIL (the two email checks are included only when a recipient address is entered):

1. **Check This Dashboard** — smoke test. Loads the dashboard, checks key text, captures a screenshot. Note: its text assertions also appear on the public landing page, so a PASS here does not prove authentication — treat it as a load check only.
2. **Verify Tab Data** — clicks Emails → Payments → Webhooks and verifies each tab loads real data. This is the honest auth check: it fails loudly on the login page instead of reporting "container missing".
3. **Check Payment Guards** — verifies the 402 challenge is well-formed and malformed signatures are refused. No money moves.
4. **Check Edge Cases** — wrong key rejected, unauthenticated access rejected, unknown routes don't false-pass, errors are JSON not HTML.
5. **Test Attachment via UI** — drives the real Send Email form and sends a **real email with attachment**. Use a test recipient.
6. **Email QA Report** — runs the tab checks + one dashboard screenshot on a single shared browser session, then emails the report with the PNG attached. Sends a **real email**.

**Pacing:** wait 3–5 minutes between runs. The Free plan allows 3 concurrent browsers and 10 browser-minutes per day — back-to-back clicks exhaust this and produce "Could not open a browser session", which is a capacity refusal, not a misconfiguration.

### Programmatic use

The same methods are `POST /api/dashboard/qa/*`, all behind `requireAuth`:

| Endpoint | Notes |
|---|---|
| `/qa/check` | Takes `url` + `checks.textContains[]`; optional `apiKey` |
| `/qa/dashboard` | Optional `apiKey` |
| `/qa/tabs` | **Requires** `X-API-Key` header (400 otherwise — session/OAuth auth is not enough, the browser needs a key to seed) |
| `/qa/test-attachment` | Requires `apiKey` + `toEmail` |
| `/qa/payment-flow` | No key needed (tests unauthenticated guards) |
| `/qa/edge-cases` | Requires `apiKey` |
| `/qa/full-suite` | Requires `apiKey`; optional `toEmail` (validated when present). Email checks skipped without it. |
| `/qa/email-report` | Requires `apiKey` + `toEmail` |

Pass the key via the `X-API-Key` header (`Authorization: Bearer` works as a fallback for non-browser callers).

### Reading results

Each check returns per-item `{ name, passed, detail }`. `detail` names the actual cause — e.g. the tab check reports the login-page failure explicitly rather than burying it as "container missing". A result of `FAIL` on all tabs with the login-page message means the seeded key was not accepted: verify the key is valid and that the deployed code includes the PR #74 ordering fix.

## Limitations

### Deterministic, not LLM-driven

QAAgent extends Think but `getTools()` returns `{}`. The model has no tools, makes no decisions, and drives nothing. All QA methods are `@callable()` RPC endpoints triggered by dashboard buttons — not by prompts. You cannot chat with QAAgent and ask it to "check the dashboard"; there is no prompt-driven path.

This is arguably correct for regression testing: deterministic scripts give you the same assertions every time. An LLM deciding what to click introduces non-determinism where you need it least. The missing piece is **orchestration and interpretation** — the model deciding which checks to run, analyzing failures, and explaining results — not replacing the deterministic checks themselves.

### No webhook ingestion test

`qaDashboardTabs` verifies the Webhooks *tab* loads data, but nothing sends a synthetic webhook to verify the ingestion pipeline end-to-end.

### No real payment testing

`qaPaymentFlow` tests that the payment gate rejects bad requests. It does not submit a real crypto or card payment. Testing real payment processing requires explicit authorization (no spend is currently authorized).

### Single screenshot per report

Only the dashboard homepage is screenshotted. Tab-level visual evidence is not captured.

## Platform constraints

### Browser Rendering limits (Workers Free plan)

| Limit | Free plan | Paid plan |
|---|---|---|
| Concurrent browsers per account | **3** | Higher |
| New browser instances | 1 every 20 seconds | Higher |
| Browser hours | 10 minutes per day | Higher |
| Per-browser timeout | 60 seconds | Higher |
| `worker_loaders` (Dynamic Workers) | **Not available** | Available |

Source: [Browser Rendering limits](https://developers.cloudflare.com/browser-rendering/limits/)

### "Browser Rendering binding did not return a WebSocket"

This error means the account's concurrent browser slots are exhausted — **not** that the binding is misconfigured. The `browser` binding (`BROWSER`) is declared in `wrangler.jsonc` and works. The failure occurs when `connectBrowser` is called while all 3 Free-plan slots are occupied by sessions from previous runs that have not yet expired.

`qaAndEmailReport` previously opened **two** browser sessions per invocation (one for tabs, one for screenshot). This has been fixed to use a single shared session, but rapid successive test runs can still exhaust the 3-slot limit.

**Remedy:** wait 3–5 minutes for sessions to expire, then retry **once**. Do not run multiple QA checks back-to-back.

### `worker_loaders` requires a paid plan (critical)

The model-driven browser-tools infrastructure (`LOADER` binding via `worker_loaders`, plus `CodemodeRuntime` export) **cannot deploy on the Free plan**. Any deploy with `worker_loaders` fails at the Cloudflare API with:

> In order to use Dynamic Workers, you must switch to a paid plan [code: 10195]

This broke all production deploys on 2026-10-12 (15:22–15:34 UTC) and was reverted. Consequence: `createBrowserTools()` / `browser_execute` (Cloudflare's recommended model-driven browser pattern) is **not available** on this account. All browser automation must use the hand-rolled CDP `connectBrowser` pattern.

## What should be enabled (by plan)

### Free plan (current) — deterministic CDP

What works now and should stay:
- Hand-rolled CDP via `connectBrowser` with `cdp.send(method, params, { sessionId })`
- `BROWSER` binding in `wrangler.jsonc` (already present)
- Single shared browser session per QA invocation (already implemented in `qaAndEmailReport`)
- `finally`-block cleanup (`Target.closeTarget` + `browser.close()`) on every QA method

What to add (no plan upgrade needed):
- Expose QA methods via `getTools()` so the Think model can **orchestrate** them (decide which checks to run, interpret results) — the checks stay deterministic, the model handles composition and explanation
- Per-tab screenshots in the email report (open issue)
- Webhook ingestion test (synthetic webhook → verify it appears)
- Auto-QA on deploy (workflow change via GitHub UI — the integration can't touch `.github/workflows/*`)

### Paid plan — model-driven browser tools

If the account upgrades, these become available:
- `worker_loaders` binding named `LOADER` in `wrangler.jsonc`
- `export { CodemodeRuntime } from "agents/browser"` in `src/index.ts`
- `createBrowserTools()` in `getTools()` via dynamic `import("agents/browser/ai")` (not a static import — breaks Workers ESM)
- Model-driven browser automation: the LLM decides what to click, fill, and verify, using `browser_execute`

Note: even on a paid plan, keep the deterministic `@callable()` checks for regression. Use model-driven tools for exploratory testing and failure analysis, not as a replacement for assertions.

## Operational rules

1. **One QA run at a time.** Never run "Check This Dashboard" and "Email QA Report" back-to-back; each consumes browser slots.
2. **Wait between runs.** Allow 3–5 minutes for sessions to expire after a failure before retrying.
3. **Watch the daily budget.** 10 browser-minutes/day on Free — heavy QA testing can exhaust it.
4. **Keep browser work in the DO, not the handler.** All `connectBrowser` calls live in QAAgent methods; do not add browser code to API routes.
5. **Close what you open.** Every `connectBrowser` must have a matching `Target.closeTarget` + `browser.close()` in a `finally` block. Verify this on every new QA method.
6. **Typecheck before pushing.** `npx tsc --noEmit` must pass. The 2026-10-12 `qa-agent.ts` corruption (PR #65) was caused by string-inserting a method mid-signature — never use string manipulation to add methods; write whole files or use proper edits.
7. **The GitHub UI is the source of truth for CI status.** API-based CI readings proved unreliable on 2026-10-12; verify in the Actions tab.

## Diagnosing the `/api/dashboard/qa/email-report` 500 (2026-10-12)

Worker logs showed the fetch handler returning 500 after ~10.6s wall (5ms CPU) while the QAAgent DO completed `qaAndEmailReport` with `outcome: "ok"` after ~10.8s. The fetch handler errored **before** the DO finished, with the stack trace pointing at the RPC `await` line — ruling out `c.json(result)` serialization (which can't throw before the result exists).

Candidate causes:
1. **Session exhaustion propagating through RPC** — the "did not return a WebSocket" error thrown inside the DO surfaces at the `await` in the fetch handler.
2. **Structured-clone failure on the RPC return value** — per the [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/), return values use Structured Clone. If the DO returns non-cloneable data, the method completes but the transport fails. (Later ruled out: `tests/qa-payloads.test.ts` verifies all return shapes clone cleanly.)

Debug harness (isolates RPC vs serialization):

```ts
let result;
try {
  result = await qaAgent.qaAndEmailReport(apiKey, toEmail);
} catch (rpcErr: any) {
  console.error("RPC threw:", rpcErr?.name, rpcErr?.message);
  return c.json({ error: "RPC call failed", message: rpcErr?.message }, 500);
}
try {
  return c.json(result);
} catch (jsonErr: any) {
  console.error("c.json threw:", jsonErr?.message);
  return c.json({ error: "Serialization failed", detail: jsonErr?.message }, 500);
}
```
