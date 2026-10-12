# QAAgent Browser Troubleshooting

## Browser Rendering limits (Workers Free plan)

QAAgent drives headless Chromium through Cloudflare's Browser Rendering binding.
On the Free plan the limits are tight — this is the #1 cause of QA failures in production.

| Limit | Free plan value |
|---|---|
| Concurrent browsers per account | **3** |
| New browser instances | 1 every 20 seconds |
| Browser hours | 10 minutes per day |
| Per-browser timeout | 60 seconds |

Source: [Browser Rendering limits](https://developers.cloudflare.com/browser-rendering/limits/)

## Symptom: "Browser Rendering binding did not return a WebSocket"

This error means the account's concurrent browser slots are exhausted — **not** that the binding is misconfigured. The `browser` binding (`BROWSER`) is declared in `wrangler.jsonc` and works; the failure occurs when `connectBrowser` (or `puppeteer.launch(env.BROWSER)`) is called while all 3 slots are occupied by sessions from previous runs that have not yet expired.

**Remedy:** wait 3–5 minutes for leaked sessions to expire, then retry the QA run **once**. Do not run multiple QA checks in quick succession — each consumes slots.

## Symptom: HTTP 500 from `/api/dashboard/qa/email-report`

### Diagnosis (2026-10-12)

Worker logs showed the fetch handler returning 500 after ~10.6s wall time (5ms CPU), while the QAAgent Durable Object completed `qaAndEmailReport` with `outcome: "ok"` after ~10.8s. The fetch handler errored **before** the DO finished, and the minified stack trace pointed at the RPC `await` line:

```js
const result = await qaAgent.qaAndEmailReport(apiKey, toEmail);
```

This rules out JSON serialization of the result (`c.json(result)` cannot throw before the result exists). The failure is at the **RPC layer**, one of:

1. **Session exhaustion propagating through RPC** — the "did not return a WebSocket" error thrown inside the DO surfaces at the `await` in the fetch handler.
2. **Structured-clone failure on the RPC return value** — per the [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/), return values use Structured Clone. If the DO returns an object containing non-cloneable data (live browser/tab objects, WebSocket references), the method body completes (`outcome: "ok"`) but the transport fails, surfacing at the `await`.

### Why `qaAndEmailReport` is especially vulnerable

It opens **two** browser sessions in one invocation:

1. `qaDashboardTabs(apiKey)` — one browser for tab checks
2. `qaDashboard(apiKey)` — a second browser for the dashboard screenshot

On a 3-slot Free plan, two slots consumed by a single report plus any lingering session from a prior run exhausts the account. The fix is to reuse a single browser session for both steps (open issue — see PR #67 discussion).

### Debug harness

To distinguish RPC-layer failure from serialization failure, wrap both in separate try/catches in the `/api/dashboard/qa/email-report` route:

```ts
let result;
try {
  result = await qaAgent.qaAndEmailReport(apiKey, toEmail);
} catch (rpcErr: any) {
  console.error("RPC threw:", rpcErr?.name, rpcErr?.message);
  console.error("RPC cause:", rpcErr?.cause);
  return c.json({ error: "RPC call failed", message: rpcErr?.message }, 500);
}
try {
  return c.json(result);
} catch (jsonErr: any) {
  console.error("c.json threw:", jsonErr?.message);
  return c.json({ error: "Serialization failed", detail: jsonErr?.message }, 500);
}
```

- First catch fires → RPC layer (session exhaustion or structured-clone on return).
- Second catch fires → result contains non-JSON-serializable data.

## Operational rules

1. **One QA run at a time.** Never run "Check This Dashboard" and "Email QA Report" back-to-back; each consumes browser slots.
2. **Wait between runs.** Allow 3–5 minutes for sessions to expire after a failure before retrying.
3. **Watch the daily budget.** 10 browser-minutes/day on Free — heavy QA testing can exhaust it.
4. **Keep browser work in the DO, not the handler.** All `connectBrowser` calls already live in QAAgent methods; do not add browser code to API routes.
5. **Close what you open.** Every `connectBrowser` must have a matching `Target.closeTarget` + `browser.close()` in a `finally` block. Verify this on every new QA method.
