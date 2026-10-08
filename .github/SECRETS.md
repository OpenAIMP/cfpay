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

### Cloudflare API Token Permissions

Create a token at https://dash.cloudflare.com/profile/api-tokens with:
- **Account → Workers Scripts → Edit** (covers Durable Objects too)
- **Zone → DNS → Edit**
- **Zone → Email Routing Rules → Edit**

## Create the `preview` Environment (optional)

1. **New environment** → name it `preview` → **Configure environment**
2. Add the same `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets
3. (Preview deploys don't need wallet/email secrets)

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
      → sets Worker secrets (PAYMENT_PRIVATE_KEY, EMAIL_SECRET, DASHBOARD_API_KEY, GITHUB_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET, SLACK_WEBHOOK_SECRET)
      → Worker live at https://pay.openaimp.com

Pull Request
  → CI workflow: type check + dry-run
  → Deploy-preview workflow:
    → uses preview environment secrets
    → deploys preview Worker (cfmail-agent-preview)
```

## First-Time Setup Checklist

1. [ ] Create `PROD` environment in GitHub
2. [ ] Add all 8 secrets to `PROD` environment
3. [ ] Create `preview` environment in GitHub (optional)
4. [ ] Add 2 secrets to `preview` environment
5. [ ] Push to `main` → first deploy creates the Worker + custom domain
6. [ ] Verify Worker is live at `https://pay.openaimp.com`
7. [ ] Configure Email Routing rule: `agent@cfmail.openaimp.com` → `cfmail-agent` Worker