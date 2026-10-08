# CFmail Agent — Fully Agentic Email + x402 Payments on Cloudflare

A production-grade, fully agentic solution that:
- **Receives and sends emails** via `cfmail.openaimp.com` using Cloudflare Email Service
- **Accepts x402 v2 payments** in ETH or USDC on Base, Base Sepolia, and Ethereum Sepolia — clients pay via MetaMask
- **Sends payments to other x402 endpoints** — agent can pay other x402-gated services using viem
- **Uses Workers AI** to generate intelligent email responses and summaries
- **Built on the Agents SDK** with Durable Objects for stateful, persistent state
- **Web dashboard** at `https://pay.openaimp.com` — view emails, payments, send emails, chat with agent, pay via MetaMask
- **CI/CD via GitHub Actions** with GitHub Environments — auto-deploys on push to `main`

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
npm install
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

## Documentation References

- [Agentic Payments](https://developers.cloudflare.com/agents/tools/payments/)
- [Email Agent Example](https://developers.cloudflare.com/agents/examples/email-agent/)
- [Email Service](https://developers.cloudflare.com/email-service/)
- [x402 Examples](https://github.com/cloudflare/agents/tree/main/examples)
- [Cloudflare Wallets](https://blog.cloudflare.com/wallets/)










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

Capabilities that move money or send mail are deliberately **not** exposed, because
this endpoint has no authentication yet: `payExternalEndpoint`, `processPaidRequest`,
`sendOutboundEmail` and `sendWebhook`. Add authentication before widening the tool set.

### Webhook events

A verified webhook delivery is stored, analysed by AI and shown in the Webhooks
tab. It posts a Slack line when `SLACK_WEBHOOK_URL` is set, and emails a human
when `WEBHOOK_NOTIFY_EMAIL` is set. Webhooks never create payment records — only
a verified x402 request does that.

To connect Slack: `api.slack.com/apps` -> your app -> **Features -> MCP Servers**.
