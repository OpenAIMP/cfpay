# CFmail Agent — Fully Agentic Email + x402 Payments on Cloudflare

A production-grade, fully agentic solution that:
- **Receives and sends emails** via `cfmail.openaimp.com` using Cloudflare Email Service
- **Accepts x402 v2 payments** in ETH or USDC on Base, Base Sepolia, and Ethereum Sepolia — clients pay via MetaMask
- **Sends payments to other x402 endpoints** — agent can pay other x402-gated services using viem
- **Uses Workers AI** to generate intelligent email responses and summaries
- **Built on the Agents SDK** with Durable Objects for stateful, persistent state
- **Web dashboard** at `https://pay.openaimp.com` — view emails, payments, send emails, chat with agent, pay via MetaMask
- **CI/CD via GitHub Actions** with GitHub Environments — auto-deploys on push to `main`
- **Webhooks** — GitHub (HMAC-SHA256), Stripe (HMAC-SHA256 + timestamp), and Slack (HMAC-SHA256 + timestamp) incoming webhooks with per-entity agent instances and AI-powered event analysis
- **Routing** — `routeAgentRequest` with `onBeforeConnect`/`onBeforeRequest` authentication hooks for agent routes

## Architecture

```
                         ┌──────────────────────────┐
                         │   Email Routing            │
                         │   cfmail.openaimp.com      │
                         └───────────┬──────────────┘
                                     │ inbound email
                                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (pay.openaimp.com)           │
│                                                              │
│  ┌──────────┐   ┌──────────────────────────────────────────┐ │
│  │ email()  │──▶│  CfmailAgent (Durable Object)            │ │
│  │ handler  │   │  - onEmail(): parse + AI summary + reply │ │
│  └──────────┘   │  - sendOutboundEmail(): send via binding │ │
│                  │  - processPaidRequest(): x402 + AI + email│
│  ┌──────────┐   │  - payExternalEndpoint(): pay other x402 │ │
│  │ fetch()  │──▶│  - chat(): AI chat for dashboard          │ │
│  │ Hono API │   │  - State: emails[], payments[], stats    │ │
│  │ + x402   │   └──────────────────────────────────────────┘ │
│  └──────────┘                                                │
│  ┌──────────┐                                                 │
│  │ ASSETS   │──▶ public/index.html (Dashboard SPA + MetaMask) │
│  └──────────┘                                                 │
│  ┌──────────┐                                                 │
│  │ AI       │──▶ Workers AI (Llama 3.3 70B)                   │
│  └──────────┘                                                 │
└─────────────────────────────────────────────────────────────┘
       │                │                    │
       ▼                ▼                    ▼
  x402 v2 + facilitator  Email Service       Workers AI
  ETH / USDC on 3 EVM networks (outbound email) (AI responses)
```

## Webhook Setup

### GitHub
1. Repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://pay.openaimp.com/webhooks/github`
3. Content type: `application/json`
4. Secret: your `GITHUB_WEBHOOK_SECRET`

### Stripe
1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://pay.openaimp.com/webhooks/stripe`
3. Copy signing secret → `STRIPE_WEBHOOK_SECRET`

### Slack
1. Slack API → Your App → Event Subscriptions
2. Request URL: `https://pay.openaimp.com/webhooks/slack`
3. Uses `SLACK_WEBHOOK_SECRET`, falling back to `SLACK_SIGNING_SECRET`

Webhooks are verified by signature before being forwarded to a per-entity agent Durable Object (one agent per GitHub repo, Stripe customer, or Slack channel). The agent records the event, generates an AI analysis, and — for Slack slash commands and `response_url` payloads — replies with the analysis.

## Routing & Authentication

Agent routes (`/agents/*`) are protected by authentication hooks:
- **`onBeforeConnect`** — Verifies `token` query parameter (WebSocket connections)
- **`onBeforeRequest`** — Verifies `Authorization: Bearer <token>` or `X-API-Key` header (HTTP requests)

Both validate against `DASHBOARD_API_KEY`.

## Troubleshooting & Custom Domain Setup

### Why `pay.openaimp.com` didn't bring up the agent/UI on Cloudflare

1. **Durable Object Binding Loop (`script_name` issue in `wrangler.jsonc`):**
   - In `wrangler.jsonc`, the Durable Object binding had `"script_name": "cfmail-agent"`. Self-referencing Durable Objects in the same Worker script must NOT specify `script_name` pointing to itself. Having `script_name` set causes Cloudflare Workers to attempt cross-script RPC resolution to a target script that fails or creates an invalid binding loop, resulting in runtime 500 errors when accessing agent routes or rendering DO-dependent components. This has been fixed in `wrangler.jsonc`.

2. **GitHub Actions Deployment CI/CD Peer Dependency Failures:**
   - The CI deployment action (`.github/workflows/deploy.yml`) runs `npm install`. Without `legacy-peer-deps=true`, `npm install` failed due to peer dependency mismatches between `@cloudflare/workers-types`, `wrangler`, and `agents`. Added `.npmrc` with `legacy-peer-deps=true` so deployments succeed seamlessly in CI/CD.

3. **Cloudflare Custom Domain DNS & SSL Propagation:**
   - Worker custom domains require `openaimp.com` to be an active DNS zone in your Cloudflare account (`CF_ACCOUNT_ID`). On initial creation, TLS certificate generation and DNS route creation can take 1–2 minutes. Ensure the `CF_API_TOKEN` in GitHub secrets has permissions for `Zone:Edit` or `Workers Tail/Routes`.

## Custom Domain

The Worker is served at `https://pay.openaimp.com` via a Workers custom domain (configured in `wrangler.jsonc`). On first deploy, Wrangler automatically creates the DNS record and TLS certificate.

## MetaMask Integration

The dashboard includes a **Pay & Process** tab that lets users:
1. Choose Base, Base Sepolia, or Ethereum Sepolia and connect MetaMask (auto-switches to the selected chain)
2. Submit a request with their email address
3. Pay the configured ETH or USDC amount on the selected chain via MetaMask
4. The agent processes the request with AI and sends a response via email

Payment requirements use CAIP-2 network IDs (`eip155:8453`, `eip155:84532`, and `eip155:11155111`) and are configured in `PAYMENT_CONFIG`. The Worker verifies payment signatures through `X402_FACILITATOR_URL` and fails closed if verification is unavailable or unsuccessful. A successful response includes both `PAYMENT-RESPONSE` and `x-payment-response` receipt headers.

The dashboard displays the configured payment amount for the selected network and currency. Paid requests are recorded as confirmed only after payment verification, with the transaction hash retained in the payment record.

## Agent-to-Agent Payments

The agent can also **pay other x402-gated services** using the `payExternalEndpoint` RPC method. This uses `viem` to sign and send USDC transfers on Base, then retries the request with payment proof.

### Getting your wallet address and private key from MetaMask

**Wallet address** (for `PAY_TO_ADDRESS` in `wrangler.jsonc`):
- Open MetaMask → copy the address at the top (starts with `0x...`)

**Private key** (for `PAYMENT_PRIVATE_KEY` GitHub secret):
- MetaMask → Account details → Show private key (requires password)
- Format: `0x` followed by 64 hex characters
- ⚠️ Never commit this to git — only put it in GitHub environment secrets

## Setup

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd cfmail-agent
# --legacy-peer-deps is required: wrangler peers on a newer workers-types
npm install --legacy-peer-deps
```

### 2. Configure wrangler.jsonc
Update `PAY_TO_ADDRESS` with your MetaMask wallet address on Base.

### 3. Set Up GitHub Environments (see .github/SECRETS.md)
1. Go to GitHub repo → Settings → Environments → New environment → `PROD`
2. Add 5 secrets:
   - `CF_API_TOKEN`
   - `CF_ACCOUNT_ID` — `1e7e9bb45eca8d59ec86bbd6dac9b900`
   - `PAYMENT_PRIVATE_KEY` (from MetaMask → Account details → Show private key)
   - `EMAIL_SECRET` — `openssl rand -hex 32`
   - `DASHBOARD_API_KEY` — `openssl rand -hex 32`

### 4. Push to main → CI/CD deploys automatically

### 5. Configure Email Routing (one-time, dashboard)
1. Go to [Email Routing](https://dash.cloudflare.com/1e7e9bb45eca8d59ec86bbd6dac9b900/openaimp.com/email/routing)
2. Settings → Subdomains → Add `cfmail` (Cloudflare auto-adds MX/SPF/DKIM)
3. Onboard `cfmail.openaimp.com` for [Email Sending](https://dash.cloudflare.com/?to=/:account/email-service/sending)
4. Create routing rule: `agent@cfmail.openaimp.com` → Send to Worker → `cfmail-agent`

## Post-deploy QA (automated testing)

Every push to `main` deploys the Worker and then runs `scripts/qa-smoke.mjs` against live production (the **Post-deploy QA** job in `.github/workflows/deploy.yml`). A green deploy only proves the upload worked; this job proves the app works. The exit code is the contract — any FAIL fails the job, and a check that cannot run reports SKIP with the reason, never a silent pass.

What it checks:

1. `/health` responds.
2. Dashboard edge cases behave.
3. Payment guards: the x402 challenge is well-formed (no money moves).
4. Tab data: Emails / Payments / Webhooks render real rows or their recognized empty states.
5. UX audit (dashboard): the deterministic accessibility/UX audit runs end to end. Its findings are reported, not gated — the dashboard legitimately has findings.
6. UX audit (fixture self-test): the same audit pointed at `public/qa-fixture.html`, a page with exactly four planted violations, must return the exact expected findings. This is the audit testing itself; a miss fails the job.
7. Attachment check: drives the real Send Email form and sends a real email with an attachment to `QA_TEST_EMAIL`. It runs by default; set `QA_RUN_ATTACHMENT_CHECK=false` to disable it explicitly.

Configuration: the job declares `environment: PROD`, so it uses the PROD environment's secrets — `DASHBOARD_API_KEY` and `QA_TEST_EMAIL` (the inbox that receives the attachment test email) live there, not as repository secrets.

Run it manually:

- **GitHub:** Actions → a *Deploy CFmail Agent* run → Re-run (failed) jobs replays Post-deploy QA against current production.
- **Locally:** `BASE_URL=https://pay.openaimp.com DASHBOARD_API_KEY=<key> QA_TEST_EMAIL=<recipient> node scripts/qa-smoke.mjs`

Reading a run: Actions → the Deploy run → **Post-deploy QA** → *Run QA checks against production* — per-check `[PASS]` / `[FAIL]` / `[SKIP]` lines plus a summary (e.g. `7/7 checks passed`). The QA tab's **Audit URL** button uses the same audit interactively and defaults to the fixture page, so one click there is the same self-test by hand.

> Note: two deploys landing back-to-back run two suites at once; on the Free plan's browser limits they can starve each other and false-fail. Re-run the job solo before treating a red run as a regression.

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | — | Dashboard SPA + MetaMask |
| `/health` | GET | — | Health check |
| `/api/process` | POST | x402 ($0.01 USDC) | Process request + send email |
| `/api/emails` | GET | x402 ($0.01 USDC) | Retrieve email history |
| `/mcp` | POST/GET | **none (phase 1)** | Remote MCP server (Streamable HTTP). Read-only tools. |
| `/mcp/tools/process` | POST | x402 ($0.01 USDC) | Legacy paid alias for agent-to-agent calls (not a real MCP server) |
| `/api/dashboard/*` | GET/POST | API Key | Dashboard endpoints |
| `/agents/*` | GET/POST/WS | Token or API Key | Agent routes (guarded by auth hooks) |
| `/webhooks/github` | POST | Signature | GitHub webhook (HMAC-SHA256) |
| `/webhooks/stripe` | POST | Signature | Stripe webhook (HMAC-SHA256 + timestamp) |
| `/webhooks/slack` | POST | Signature | Slack webhook (HMAC-SHA256 + timestamp) |

## Documentation References

- [Agentic Payments](https://developers.cloudflare.com/agents/tools/payments/)
- [Email Agent Example](https://developers.cloudflare.com/agents/examples/email-agent/)
- [Email Service](https://developers.cloudflare.com/email-service/)
- [x402 Examples](https://github.com/cloudflare/agents/tree/main/examples)
- [Cloudflare Wallets](https://blog.cloudflare.com/wallets/)











## Agents

Three Durable Object agents, each owning a **resource** rather than a code path. A
resource has one owner: the agent that holds it is the only writer, and every other
agent reads or writes it through that agent's tool or A2A endpoint.

| | CFmail Agent | Payments Agent | Email Agent |
|---|---|---|---|
| Class | `CfmailAgentSQLite` | `PaymentsAgent` | `EmailAgent` |
| Binding | `CfmailAgent` | `PAYMENTS_AGENT` | `EMAIL_AGENT` |
| Instance | `agent` | `payments` | `email` |
| Owns | emails, webhooks, Slack, MCP server, Public.com chat | payment ledger, Stripe checkouts, x402 + Stripe replay registries, Pay & Process | mail history, outbound sends, inbound record path |
| Writes | no | yes | yes |

The split is by resource, not by call graph. A payment is recorded by the agent
that owns the ledger; mail is sent by the agent that owns the mail resource. Where
one capability needs another, it calls that agent rather than reaching into its
state.

### Every URL

All paths are served by the single Worker `cfmail-agent` on its custom domain.

**CFmail Agent** — the monolith

| Purpose | URL |
|---|---|
| Worker origin | `https://pay.openaimp.com` |
| Agent card | `https://pay.openaimp.com/.well-known/agent-card.json` |
| Agent card (alias) | `https://pay.openaimp.com/.well-known/agent.json` |
| A2A endpoint | `https://pay.openaimp.com/a2a` |
| MCP server | `https://pay.openaimp.com/mcp` |
| Health | `https://pay.openaimp.com/health` |
| Dashboard | `https://pay.openaimp.com/` |

**Payments Agent**

| Purpose | URL |
|---|---|
| Agent card | `https://pay.openaimp.com/a2a/payments/agent-card.json` |
| A2A endpoint | `https://pay.openaimp.com/a2a/payments` |

**Email Agent**

| Purpose | URL |
|---|---|
| Agent card | `https://pay.openaimp.com/a2a/email/agent-card.json` |
| A2A endpoint | `https://pay.openaimp.com/a2a/email` |

**Dashboard and REST**

| Purpose | URL |
|---|---|
| Dashboard stats | `https://pay.openaimp.com/api/dashboard/stats` |
| Dashboard emails | `https://pay.openaimp.com/api/dashboard/emails` |
| Dashboard payments | `https://pay.openaimp.com/api/dashboard/payments` |
| Dashboard send email | `https://pay.openaimp.com/api/dashboard/send-email` (POST) |
| x402 process | `https://pay.openaimp.com/api/process` (POST) |
| x402 emails | `https://pay.openaimp.com/api/emails` (POST) |
| x402 via MCP tool | `https://pay.openaimp.com/mcp/tools/process` (POST) |
| Stripe checkout | `https://pay.openaimp.com/api/stripe/checkout` (POST) |
| Stripe return | `https://pay.openaimp.com/api/stripe/return` |
| Stripe webhook | `https://pay.openaimp.com/api/stripe/webhook` (POST) |
| GitHub webhook | `https://pay.openaimp.com/webhooks/github` (POST) |
| Slack webhook | `https://pay.openaimp.com/webhooks/slack` (POST) |
| Public.com connect | `https://pay.openaimp.com/auth/public/connect` |

### Agent cards

Every card is public and cacheable. Cards carry no data, and A2A clients discover by
fetching them.

`/.well-known/agent-card.json` — CFmail Agent

```json
{
  "name": "CFmail Agent",
  "description": "Inspects the state of a CFmail agent: emails it has handled, payments on its ledger, and inbound webhook events. Read-only.",
  "version": "0.1.0",
  "protocolVersion": "0.3.0",
  "url": "https://pay.openaimp.com/a2a",
  "preferredTransport": "JSONRPC",
  "capabilities": { "pushNotifications": false, "stateTransitionHistory": false, "streaming": true },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "provider": { "organization": "OpenAIMP", "url": "https://pay.openaimp.com" },
  "skills": [
    {
      "id": "inspect-state",
      "name": "Inspect agent state",
      "description": "Answer questions about emails handled, payments recorded and webhook events received. Cannot send email, move funds or place trades.",
      "tags": ["read-only", "email", "payments", "webhooks"],
      "examples": [
        "How many emails has this agent handled?",
        "What payments are on the ledger?",
        "Which webhook providers have sent events recently?"
      ]
    }
  ]
}
```

`/a2a/payments/agent-card.json` — Payments Agent

```json
{
  "name": "CFmail Payments Agent",
  "description": "Owns the CFmail payment ledger and the Pay And Process capability: payments received and sent, Stripe card checkouts, and replay protection for both rails. Reads and writes over A2A.",
  "version": "0.1.0",
  "protocolVersion": "0.3.0",
  "url": "https://pay.openaimp.com/a2a/payments",
  "preferredTransport": "JSONRPC",
  "capabilities": { "pushNotifications": false, "stateTransitionHistory": false, "streaming": true },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "provider": { "organization": "OpenAIMP", "url": "https://pay.openaimp.com" },
  "skills": [
    {
      "id": "payment-ledger",
      "name": "Payment ledger",
      "description": "Report on payments received and sent, and process a paid request. Write operations are payment.process, checkout.create and checkout.fulfil; all require a bearer credential. This agent cannot move funds or refund.",
      "tags": ["payments", "x402", "stripe", "write"],
      "examples": [
        "How many payments have been received?",
        "What currencies are on the ledger?",
        "Are there any failed payments?",
        "Process this paid request and email the answer."
      ]
    }
  ]
}
```

`/a2a/email/agent-card.json` — Email Agent

```json
{
  "name": "CFmail Email Agent",
  "description": "Owns the CFmail mail resource: message history, outbound sends, and the inbound record path. Other agents send through this. Reads and writes over A2A; sends are rate limited.",
  "version": "0.1.0",
  "protocolVersion": "0.3.0",
  "url": "https://pay.openaimp.com/a2a/email",
  "preferredTransport": "JSONRPC",
  "capabilities": { "pushNotifications": false, "stateTransitionHistory": false, "streaming": true },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "provider": { "organization": "OpenAIMP", "url": "https://pay.openaimp.com" },
  "skills": [
    {
      "id": "email",
      "name": "Email",
      "description": "Report on message history and send mail. Write operations are email.send; all operations require a bearer credential. Sends are capped per hour for the agent instance.",
      "tags": ["email", "send", "history", "write"],
      "examples": [
        "How many emails has this agent handled?",
        "What were the last few subjects?",
        "Send a message to ops@example.com with this body."
      ]
    }
  ]
}
```

### Authentication

The cards are public. **Every A2A call requires a bearer credential** — the same
`DASHBOARD_API_KEY` used elsewhere — compared in constant time. Each call spends
Workers AI tokens or sends mail, so an open endpoint is an open budget.

```
Authorization: Bearer <DASHBOARD_API_KEY>
```

### The email tool

Email is one shared definition in `src/email-tool.ts`: a JSON-schema function
definition plus a dispatcher. A change to sending lands once and every agent inherits
it, rather than each agent carrying its own copy of the send logic.

Three routes, one destination — the same method on the same Durable Object:

1. **Direct Durable Object RPC**, for agents inside this Worker.
2. **A2A**, an HTTP JSON-RPC message to the endpoint the email card advertises.
3. **The model's tool list**, where `email` appears alongside the MCP tools, so the
   agent can decide to send mail during a chat turn.

| Operation | Kind | Arguments | Effect |
|---|---|---|---|
| `email.summary` | read | — | totals and recent subjects |
| `email.totals` | read | — | received / sent / stored counts |
| `email.list` | read | `direction?`, `limit?` | recent messages, bodies omitted |
| `email.quota` | read | — | remaining sends in the current window |
| `email.send` | **write** | `to`, `subject`, `body` | sends and records the message |

Sends are capped per hour per agent instance. **A refusal is never bypassed:** no
caller falls through to the `EMAIL` binding to get around it, or the limit would be
decorative. Sending to the agent's own address is refused, because that message would
return through the inbound path and could answer itself.

```bash
curl -X POST https://pay.openaimp.com/a2a/email \
  -H "Authorization: Bearer $DASHBOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": "1", "method": "message/send",
    "params": { "message": {
      "kind": "message", "messageId": "m1", "role": "user",
      "parts": [
        { "kind": "text", "text": "Send the summary" },
        { "kind": "data", "data": { "operation": "email.send",
          "to": "ops@example.com", "subject": "Report",
          "body": "The nightly report is attached." } }
      ]
    } }
  }'
```

### The payments ledger

The payments agent is **the only writer and the only reader** of the payment ledger.
There is no second copy: a ledger with two writers is how a settled card payment once
appeared in the webhook feed while the Payments tab showed nothing.

| Operation | Kind | Arguments | Effect |
|---|---|---|---|
| `ledger.summary` | read | — | counts, currencies, statuses |
| `payments.list` | read | `direction?`, `limit?` | ledger entries |
| `payments.totals` | read | — | received / sent / stored |
| `payment.process` | **write** | `email`, `request`, `claim?` or `card?` | claims the payment, generates the answer, emails it, records the entry |
| `checkout.create` | write | `requestId`, `email`, `request` | records a Stripe intent |
| `checkout.status` | read | `requestId` | checkout state |
| `checkout.fulfil` | write | `requestId`, `paymentIntentId?` | marks a checkout fulfilled |

An unknown operation is **refused with the supported list**, not ignored, so a typo
cannot look like a silent success. `payment.process` requires either a verified
`claim` or a `card` reference: without one it refuses rather than doing unpaid work.

Entries written before the split are adopted by an idempotent `payments.backfill`,
matched on transaction hash where there is one and on id otherwise, so re-running
cannot duplicate the ledger.

### How the agents talk

Directly, over A2A, or not at all — never through another agent's state.

- **The CFmail agent forwards Pay & Process** to the payments agent over A2A, with
  direct RPC as the fast path. A refusal is raised, never retried through the other
  route, or a replay check would be pointless.
- **The payments agent sends fulfilment mail through the email tool**, so it cannot
  be the hole in the send limit. It records the ledger entry **before** doing the
  work: once a payment has been taken it must be visible, even if the work then
  fails.
- **The email agent sends its own mail** rather than calling back into the CFmail
  agent. A Durable Object cannot re-enter itself: if CFmail were awaiting an A2A call
  to Payments, and Payments called back into CFmail, the pair would deadlock. Email
  being a third agent is what makes that safe.

## Framework

This repo runs on the Cloudflare Agents framework. The versions are pinned together
deliberately: the Worker and the dashboard client must be the same version, so they
change in the same commit.

| Package | Version | Why |
|---|---|---|
| `agents` | `0.28.0` | Durable Object agents, routing, A2A and MCP entry points |
| `@cloudflare/think` | `0.20.2` | Chat-capable base for `EmailAgent`, which makes it a valid `agentTool()` child |
| `ai` | `^7.0.0` | Peer of `agents@0.28` |
| `@modelcontextprotocol/client` | `2.0.0` | Required peer — `agents/mcp/client` imports it directly |
| `@modelcontextprotocol/server` | `2.0.0` | Required peer — `agents/mcp/server` imports it directly |
| `@modelcontextprotocol/sdk` | `1.30.0` | The version `agents@0.28` declares |
| `@cloudflare/workers-types` | `^5.20261006.1` | Peer requirement of the current `wrangler` |

Install with peer resolution relaxed; `npm install` alone stops on a `wrangler` /
`workers-types` peer conflict:

```bash
npm install --legacy-peer-deps
```

CI already sets this. `.github/workflows/deploy.yml` runs `npm install` with
`legacy-peer-deps=true`, so a push deploys without special handling.

### Two things that break if you change versions carelessly

**The dashboard client is pinned to the Worker's version.** `public/index.html`
imports `https://esm.sh/agents@0.28.0/client`. If the two drift, the WebSocket still
connects and `onStateUpdate` simply never fires, so the dashboard goes silently stale
rather than failing — the single most expensive bug in this repo's history. Change the
pin in `package.json` and the pin in `public/index.html` in the **same commit**.

**The MCP 2.0 split packages are not optional.** `agents@0.28` imports
`@modelcontextprotocol/client` and `@modelcontextprotocol/server` from its own MCP
entry points. Without them the Worker fails to **bundle** — a build error that a
typecheck does not catch, so `wrangler deploy --dry-run` is worth running before
pushing a dependency change.

### Adopting the framework's agent tools

The framework's agents-as-tools pattern is `agentTool(ChildClass, { description,
inputSchema })` for model-selected dispatch, plus `runAgentTool(ChildClass, options)`
for explicit fan-out. What was measured here, rather than assumed:

- `agentTool` is exported from `agents/agent-tools`, **not** from the package root.
- `runAgentTool` resolves on a plain `Agent` subclass. Re-basing the existing agents
  onto `Think` is **not** required to call it.
- `ChatCapableAgentClass` is a constructor shape (`new (ctx, env) => T`), so a `Think`
  subclass satisfies it structurally.
- `Think<Env, State, Props> extends Agent<Env, State, Props>`, so it is available as a
  base class when a child needs a chat turn of its own.
- `agentTool` dispatches through the **child's chat loop**: the child runs its own
  model turn with its own tools and messages. That is a different mechanism from a
  capability call, and it is why it is not used for email here.

### Email: two paths, and which to use

Both exist on purpose, and they are not redundant.

**The capability call** is `email` on the A2A endpoint `/a2a/email`, and the `email`
tool in the Worker's tool list. There is **no model in the path**: it sends an exact
message and reports whether it left, including when the rate limit refused it. This is
what the payments agent and the dashboard use.

**The agent tool** is `emailAgentTool` in `src/agent-tools.ts`, built with the
framework's `agentTool(EmailAgent, {...})`. It is for a *conversational* request —
"summarise recent mail" — where the email agent runs a chat turn of its own.

`EmailAgent` is re-based on `Think` to make that possible, because `agentTool` requires
a chat-capable child. `Think<Env, State, Props> extends Agent<Env, State, Props>`, so
every `@callable()` method, the A2A surface and the send quota are inherited unchanged:
the re-base adds a dispatch path without moving the deterministic one. The tests assert
that all six capability methods survive, because `agentTool` dispatches the *same* agent
and a lost method would break direct callers silently.

Choose by whether you know the message:

| If you... | Use | Why |
|---|---|---|
| know the recipient, subject and body | `email` capability call | deterministic; no model can mis-describe the send |
| want a conversational answer about mail | `emailAgentTool` | the agent reasons over the resource |

**`emailAgentTool` is not wired into the monolith's tool loop**, deliberately. The
monolith is `Agent`, not `Think`, and its chat runs a custom loop over MCP tool
definitions plus the `email` capability tool — that loop is what the dashboard's chat
tab speaks, and its protocol is not Think's. Adding the agent tool there would put a
second model inside the email agent's turn before a send, which is the mis-description
risk the capability tool exists to avoid. Adopting `Think` for the monolith would
replace the dashboard's chat protocol and is a larger change than an email extraction.

**Cost, measured.** Adopting `Think` for the email agent grows the Worker bundle from
**5.83 MiB to 11.61 MiB**, because `Think` is now genuinely pulled in rather than being
an unused declaration. Worth knowing before adopting it for the monolith as well.
### Rollback

The state before this migration is tagged:

```bash
git checkout pre-think-migration
```

## Remote MCP Server

The Worker serves a remote MCP server at `https://pay.openaimp.com/mcp` using the
stateless Streamable HTTP handler from `agents/mcp`, so Slack (or any MCP client)
can connect with just the URL.

**Phase 1 is unauthenticated and read-only.** The exposed tools are:

| Tool | Returns |
|---|---|
| `cfmail_recent_emails` | Recent emails with their AI summary |
| `cfmail_recent_payments` | Recent x402 payments |
| `cfmail_recent_webhooks` | Recent webhook events with AI analysis |
| `cfmail_ledger_diagnostics` | Hop-by-hop health of the ledger and both sub-agents, with real error text instead of a zero |

Capabilities that move money or send mail are deliberately **not** exposed, because
this endpoint has no authentication yet: `payExternalEndpoint`, `processPaidRequest`,
`sendOutboundEmail` and `sendWebhook`. Add authentication before widening the tool set.

### Testing the agents as independent participants

Each agent is reachable on its own, which is the point of splitting them: a failure
can be attributed to one hop instead of to "the system".

**Discover them.** Cards are public; fetch one to see what an agent claims it can do.

```bash
curl -s https://pay.openaimp.com/.well-known/agent-card.json
curl -s https://pay.openaimp.com/a2a/payments/agent-card.json
curl -s https://pay.openaimp.com/a2a/email/agent-card.json
```

**Confirm they are gated.** All three must return 401 without a credential.

```bash
for p in /a2a /a2a/payments /a2a/email; do
  printf "%s -> " "$p"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://pay.openaimp.com$p" \
    -H 'Content-Type: application/json' -d '{}'
done
```

**Call one.** A text part answers a question; a data part with an `operation` performs
one. `DASHBOARD_API_KEY` is the bearer credential.

```bash
curl -s -X POST https://pay.openaimp.com/a2a/email \
  -H "Authorization: Bearer $DASHBOARD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":
       {"kind":"message","messageId":"m1","role":"user","parts":[
       {"kind":"data","data":{"operation":"email.quota"}}]}}}'
```

**Or skip the network.** The agents are Durable Objects, so inside the Worker a
direct RPC call reaches the same method, which is what the diagnostics tool does to
attribute a failure to a hop. That is also why a missing method fails at runtime
rather than at build time: the stub is `any`-typed, so the compiler cannot check it.

`cfmail_ledger_diagnostics` is the fastest end-to-end check of this wiring. It probes
four hops separately and returns the real error text rather than a zero:

```bash
curl -s -X POST https://pay.openaimp.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":
       {"name":"cfmail_ledger_diagnostics","arguments":{}}}'
```

A healthy response has no `error` key on any hop. If one hop reports an error and the
next does not, the failure is in the hop, not in the ledger.
### Card payments

Alongside x402, users can pay by card. `POST /api/stripe/checkout` creates a
hosted Stripe Checkout session and stores the request server-side against a
generated reference; the browser is redirected to Stripe. Fulfilment happens
**only** in the signature-verified `POST /webhooks/stripe` handler, after
checking that the session is paid, is a one-off payment, and matches our own
currency and amount. The browser return page is display-only, so returning
early or closing the tab cannot lose or duplicate an order.

Fulfilment is idempotent: a Stripe event id is handled once, a checkout can
only transition to fulfilled once, and a payment reference already on the
ledger is never recorded twice. Card checkout is disabled unless
`STRIPE_SECRET_KEY` and `STRIPE_CONFIG` are both configured.

### Webhook events

A verified webhook delivery is stored, analysed by AI and shown in the Webhooks
tab. It posts a Slack line when `SLACK_WEBHOOK_URL` is set, and emails a human
when `WEBHOOK_NOTIFY_EMAIL` is set. Webhooks never create payment records — only
a verified x402 request does that.

To connect Slack: `api.slack.com/apps` -> your app -> **Features -> MCP Servers**.
## Securing the MCP endpoint (`mcp-security/`)

`/mcp` authenticates nothing by default. `mcp-security/` puts a Cloudflare MCP
Server Portal in front of it — Access policies, an OAuth 2.0 authorization-code
flow with PKCE and Dynamic Client Registration — and proxies to this Worker
without changing its code.

| | |
|---|---|
| Upstream (this Worker) | `https://pay.openaimp.com/mcp` |
| Protected endpoint | `https://mcp.openaimp.com/mcp` |

```bash
cd mcp-security
cp env.example .env      # CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CF_TEAM_NAME
./scripts/run-all.sh
```

`scripts/run-all.sh` runs identity providers, portal creation, Access policies
and verification in order. Each script is idempotent, so re-running reconciles.
`scripts/05-protect-direct-url.sh` is optional and blocks access to
`pay.openaimp.com/mcp` directly — without it the portal is protected but this
Worker's own endpoint is not.

The GitHub workflow is `workflow_dispatch` only: it mutates live Cloudflare
state, so it is never applied as a side effect of a push. `legacy/` holds an
earlier flow from two merged repositories, kept for reference.

Note that this Worker's own `/mcp` gate is independent of the portal. See
`MCP_AUTH_MODE` in `wrangler.jsonc` and `.dev.vars.example`.
