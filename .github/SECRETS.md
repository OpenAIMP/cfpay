# GitHub Environments & Secrets Setup

This project uses **GitHub Environments** to manage secrets for CI/CD deployment.

## Create the `PROD` Environment

1. Go to your GitHub repo → **Settings → Environments**
2. Click **New environment** → name it `PROD` → **Configure environment**
3. Add these secrets to the `PROD` environment:

### Required Secrets

| Secret Name | Description | How to Get |
|---|---|---|
| `CF_API_TOKEN` | Cloudflare API token with Workers/DNS permissions | [Create token](https://dash.cloudflare.com/profile/api-tokens) |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID | `1e7e9bb45eca8d59ec86bbd6dac9b900` |
| `PAYMENT_PRIVATE_KEY` | Wallet private key for x402 payment signing (agent-to-agent payments) | From MetaMask → Account details → Show private key |
| `EMAIL_SECRET` | Random string for secure email reply routing | Generate: `openssl rand -hex 32` |
| `DASHBOARD_API_KEY` | API key for dashboard authentication | Generate: `openssl rand -hex 32` |
| `GH_WEBHOOK_SECRET` | Secret for verifying incoming GitHub webhook signatures (named `GH_` because GitHub Actions disallows secret names starting with `GITHUB_`; deployed as Worker secret `GITHUB_WEBHOOK_SECRET`) | Set in your GitHub repo's webhook settings |
| `STRIPE_WEBHOOK_SECRET` | Secret for verifying incoming Stripe webhook signatures | Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret |
| `SLACK_WEBHOOK_SECRET` | Signing secret for verifying incoming Slack webhook requests | Slack App → Basic Information → App Credentials → Signing Secret |
| `SLACK_SIGNING_SECRET` | Signing secret for the Slack Events API endpoint `/slack/events` | Slack App → Basic Information → App Credentials → Signing Secret |
| `SLACK_BOT_TOKEN` | Bot user OAuth token, used to post messages to Slack | Slack App → OAuth & Permissions → Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode connections | Slack App → Basic Information → App-Level Tokens (scope `connections:write`, `xapp-...`) |
| `SLACK_CLIENT_ID` | OAuth client ID used by the `/slack/install` redirect | Slack App → Basic Information → App Credentials → Client ID |

### Cloudflare API Token Permissions

Create a token at https://dash.cloudflare.com/profile/api-tokens with:
- **Account → Workers Scripts → Edit** (covers Durable Objects too)
- **Zone → DNS → Edit**
- **Zone → Email Routing Rules → Edit**

## Create the `preview` Environment (optional)

1. **New environment** → name it `preview` → **Configure environment**
2. Add the same `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets
3. (Preview deploys don't need wallet/email secrets)

## Optional: Enabling Outbound Payments

The agent can pay external x402 endpoints via the `payExternalEndpoint` RPC method.
This spends real funds. It stays disabled until `OUTBOUND_PAY_TO_WHITELIST` names at least one address; `OUTBOUND_MAX_AMOUNT_ATOMIC` is an additional, optional ceiling.

| Variable | Purpose |
|---|---|
| `OUTBOUND_PAY_TO_WHITELIST` | Comma-separated list of `payTo` addresses the agent is allowed to pay. Checked BEFORE the transfer is signed. |
| `OUTBOUND_MAX_AMOUNT_ATOMIC` | Optional ceiling, in atomic units of the requested asset, on any single outbound payment. |

With `OUTBOUND_PAY_TO_WHITELIST` unset or empty, every call is refused with `403`
and no transaction is broadcast.

> **Precondition:** the `/ws` route is currently unauthenticated, and the x402 RPC
> surface is reachable through it. Secure `/ws` before enabling outbound payments,
> and always set `OUTBOUND_MAX_AMOUNT_ATOMIC` so a single request cannot drain the wallet.

Set them with:

```
npx wrangler secret put OUTBOUND_PAY_TO_WHITELIST
npx wrangler secret put OUTBOUND_MAX_AMOUNT_ATOMIC
```

A payment is written to the ledger only when a transaction was actually broadcast,
and it records the terms the endpoint requested (`asset`/`amount`/`network`/`payTo`).

## Optional: Outgoing Slack Notifications

`SLACK_WEBHOOK_URL` powers the dashboard's "Send to Slack" button and the
webhook-received notifications. It is optional — with it unset, the button
reports that it is not configured.

This is an **incoming webhook URL** from Slack (App → Incoming Webhooks →
Add New Webhook to Workspace), **not** a signing secret, and it is unrelated to
`SLACK_WEBHOOK_SECRET` above despite the similar name.

Add it to the GitHub `PROD` environment as **`SLACK_WEBHOOK_URL`**. The deploy
workflow pushes it to the Worker automatically, and skips it when the GitHub
secret is unset. To set it directly on the Worker instead:

```
read -rs SLACK_URL && printf '%s' "$SLACK_URL" | npx wrangler secret put SLACK_WEBHOOK_URL
```

For local development, add it to `.dev.vars` (which is gitignored):

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
```

Note: `wrangler secret put SLACK_WEBHOOK_URL <url>` passing the URL as an
argument can mangle it in some shells; piping it is safer.

Set it as a secret rather than a `wrangler.jsonc` var so the URL is not committed.

## Environment Protection Rules (recommended)

For the `PROD` environment:
1. **Required reviewers** — require approval before production deploys
2. **Deployment branches** — restrict to `main` only
3. **Wait timer** — optional 1-2 minute wait before deploy

## How It Works

```
Push to main
  → CI workflow: type check + dry-run
  → Deploy workflow:
    → typecheck job passes
    → deploy job (PROD environment):
      → uses PROD environment secrets
      → deploys Worker via wrangler-action
      → sets Worker secrets (PAYMENT_PRIVATE_KEY, EMAIL_SECRET, DASHBOARD_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN, SLACK_CLIENT_ID, GITHUB_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET, SLACK_WEBHOOK_SECRET)
      → Worker live at https://pay.openaimp.com

Pull Request
  → CI workflow: type check + dry-run
  → Deploy-preview workflow:
    → uses preview environment secrets
    → deploys preview Worker (cfmail-agent-preview)
```

## First-Time Setup Checklist

1. [ ] Create `PROD` environment in GitHub
2. [ ] Add all 12 secrets to `PROD` environment
3. [ ] Create `preview` environment in GitHub (optional)
4. [ ] Add 2 secrets to `preview` environment
5. [ ] Push to `main` → first deploy creates the Worker + custom domain
6. [ ] Verify Worker is live at `https://pay.openaimp.com`
7. [ ] Configure Email Routing rule: `agent@cfmail.openaimp.com` → `cfmail-agent` Worker