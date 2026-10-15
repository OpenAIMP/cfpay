# QAAgent — Capabilities, Limitations & Platform Guide

## What QAAgent is

QAAgent is the autonomous QA agent for the cfpay dashboard (`pay.openaimp.com`). It drives headless Chromium through Cloudflare's Browser Rendering binding to verify the dashboard works. It extends Think (making it chat-capable and composable via `agentTool()`), but its QA checks are deterministic scripts — not model-driven.

## Capabilities

Ten `@callable()` methods, all behind `requireAuth`, exposed as `POST /api/dashboard/qa/*` and as dashboard buttons — plus an eleventh, `qaLiveSnapshot`, which is reachable only over the agent WebSocket and serves the live view (below); it has no button and no HTTP route:

| Button | Endpoint | Method | What it proves |
|---|---|---|---|
| Run Full Suite | `/qa/full-suite` | `qaFullSuite(apiKey, toEmail?)` | Every check below, in order, as one aggregate PASS/FAIL. The two real-email checks are **skipped** (marked SKIP, excluded from the verdict) unless a recipient is supplied |
| Run QA Check | `/qa/check` | `qaCheck(url, checks)` | Browser-check any URL with text assertions |
| UX Audit | `/qa/ux-audit` | `qaUxAudit(apiKey)` | Deterministic design-rule checks on the rendered views (issue #91): WCAG AA contrast from computed styles, 44px target sizes, heading hierarchy, primary-button consistency across views, layout overflow/overlap, image alt text, tab landing patterns. Rules are the `UX_RULES` config in `src/qa-agent.ts` — no model in the verdict path |
| Audit URL | `/qa/ux-audit-url` | `qaUxAuditUrl(spec)` | The UX audit generalized (issue #94): audit any single-origin webapp from a target spec — page list, auth mode (none / localStorage seed / headers), settle selector, and a per-target rule profile (thresholds, ignore selectors, declared button-color token). The dashboard's Audit URL box covers public pages; full specs go through the API |
| Check This Dashboard | `/qa/dashboard` | `qaDashboard(apiKey)` | Dashboard loads, key elements present, screenshot captured |
| Verify Tab Data | `/qa/tabs` | `qaDashboardTabs(apiKey)` | Tab click-through with data verification (see below) |
| Test Attachment via UI | `/qa/test-attachment` | `testEmailAttachmentUI(apiKey, toEmail)` | End-to-end Send Email form: fill fields, attach file via `DataTransfer`, submit via real button, verify success. Sends a **real email** with attachment. |
| Check Payment Guards | `/qa/payment-flow` | `qaPaymentFlow()` | Payment *gate* holds: 402 challenge is well-formed, malformed signatures refused. **No money moves** — no crypto, no card. |
| Check Edge Cases | `/qa/edge-cases` | `qaEdgeCases()` | Unauthenticated reads rejected, wrong API key rejected, unknown routes don't report success, errors are JSON not HTML |
| Email QA Report | `/qa/email-report` | `qaAndEmailReport(apiKey, toEmail)` | Runs tab checks + dashboard screenshot on one shared browser session, emails the report with **4 PNGs** attached (dashboard + one per tab). Sends a **real email**. |

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

`qaDashboardTabs` captures a PNG of each tab as it renders, whenever it is asked to (`captureScreenshots`) or whenever a live-view run is watching. `qaAndEmailReport` attaches **four** PNGs — the dashboard homepage (`qa-dashboard-YYYY-MM-DD.png`) plus one per tab (`qa-emails-…`, `qa-payments-…`, `qa-webhooks-…`) — all captured on the one shared browser session, within EmailAgent's caps (5 attachments, 2 MB each, 3 MB total). The same captures feed the live view panel.

### Live view (issue #88)

Every QA button also opens a **Live view** panel under the buttons, so a run can be watched instead of only awaited:

- **Steps** — plain-language narration as the check moves ("Loading dashboard", "Checking Emails tab", …).
- **Verdicts** — each tab and each suite section reports PASS, FAIL or SKIP the moment it lands.
- **Screenshots** — every capture joins a filmstrip under the large view; the large view follows the newest capture until a thumbnail is clicked to hold one.

How it works: the dashboard mints a run id per click and sends it in the request body; the API routes thread it into the QAAgent methods. Inside the checks, `emitLive()` records each event into a bounded per-run buffer (300 events, newest 4 runs, in memory only) and broadcasts it over the QAAgent WebSocket as a `{type: "qa-live"}` frame. The panel holds a second `AgentClient` socket — to QAAgent, instance `qa`, the same name the API routes use — receives the broadcasts, and polls `qaLiveSnapshot(runId, sinceSeq)` every 2s over the same socket as a catch-up/backstop; both paths dedupe by event sequence number and ignore other runs' ids. The panel's lifecycle follows the button's HTTP request: when the response lands, it makes one final snapshot pull and marks the run finished. `emitLive` is an observer only — it no-ops without a run id and can never throw into a check, so the live view cannot fail a run. The payment-guards and edge-cases buttons show only start/finish lines in the panel: they are fast HTTP assertions with no browser session to watch (inside the Full Suite their sub-checks narrate normally).

**Troubleshooting — the panel shows only "started" / "Run finished" and a permanent "Waiting for the first screenshot…":** the panel rendered but no event ever arrived, meaning the QA socket never connected. The known cause is an agent-name routing trap in the Agents SDK: the client kebab-cases its `agent` option per capital letter, so the class name `"QAAgent"` becomes the path segment `q-a-agent`, while `routeAgentRequest` builds its route map from the DO **binding** name (`QA_AGENT` → `qa-agent`). No route matches, the handshake is refused, and PartySocket retries silently. The host agent is unaffected — `CfmailAgent` converts identically on both sides. The dashboard therefore passes `agent: "qa-agent"` (the binding's kebab form, which the client's conversion leaves unchanged), and a wiring test pins it.

## Limitations

### Deterministic, not LLM-driven

QAAgent extends Think, but no QA method consults the model: every check is a deterministic `@callable()` RPC triggered by a dashboard button — not by a prompt. (`getTools()` does expose an email tool, and browser tools when the LOADER binding exists, for host-agent dispatch; the checks themselves never use them.) You cannot chat with QAAgent and ask it to "check the dashboard"; there is no prompt-driven path.

This is arguably correct for regression testing: deterministic scripts give you the same assertions every time. An LLM deciding what to click introduces non-determinism where you need it least. The missing piece is **orchestration and interpretation** — the model deciding which checks to run, analyzing failures, and explaining results — not replacing the deterministic checks themselves.

### No webhook ingestion test

`qaDashboardTabs` verifies the Webhooks *tab* loads data, but nothing sends a synthetic webhook to verify the ingestion pipeline end-to-end.

### No real payment testing

`qaPaymentFlow` tests that the payment gate rejects bad requests. It does not submit a real crypto or card payment. Testing real payment processing requires explicit authorization (no spend is currently authorized).

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
8. **The audit tests itself.** Post-deploy QA (`scripts/qa-smoke.mjs`) runs both audit endpoints after every deploy — the dashboard audit for liveness, and the generalized audit against `public/qa-fixture.html`, a page with exactly four planted violations the audit must catch (and compliant controls it must not flag). If the smoke's authenticated checks report SKIP, the job never received `DASHBOARD_API_KEY` — the deploy job runs under the `PROD` GitHub environment and the smoke job does not, so an environment-scoped secret never reaches it. The fix (decided 2026-10-15) is to declare `environment: PROD` on the qa-smoke job so it inherits the PROD environment's secrets and vars — PROD is the single home for them; the key is not duplicated as a repository secret. The same script's attachment check also runs by default (it sends real mail to `QA_TEST_EMAIL` on every deploy); `QA_RUN_ATTACHMENT_CHECK=false` is its explicit off-switch. The run also emails the full QA report (tab check + screenshots, the 4-PNG report) to the same inbox as its report of record; `QA_RUN_REPORT_CHECK=false` is that section's off-switch.

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
