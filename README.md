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

The complete Slack requirements - every secret, the bot-token scopes (`chat:write`, plus `files:write` for uploads), and the QA file mirror's channel - are documented in `.github/SECRETS.md` under "Slack integration requirements (complete)". In short: inbound events are verified with the signing secrets; outbound messages **and file uploads** use the bot token (Slack's incoming webhook, `SLACK_WEBHOOK_URL`, is text-only and cannot carry attachments); and the QA screenshots/PDF mirror posts to the channel named by `SLACK_QA_CHANNEL_ID`, which the bot must be a member of.

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

### Budget guard for outbound payments (issue #211)

The host's `payExternalEndpoint` already fails closed on env gates (`PAYMENT_PRIVATE_KEY`, `OUTBOUND_PAY_TO_WHITELIST`, `OUTBOUND_MAX_AMOUNT_ATOMIC`). On top of those sits a cumulative budget guard (`src/budget-guard.ts`, a pure validator): a stored policy caps spend per call, per day, and per agent per day, with an optional enforced allowlist and named refusal codes (`PER_CALL_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`, `AGENT_DAILY_CAP_EXCEEDED`, ...). The check runs inside the x402 validator - after the endpoint names its price, before anything is signed - and a completed payment is recorded into the day's state in the host's own SQL. With no policy stored, no cumulative caps apply (the snapshot reports `configured: false`) and the env gates remain the protection; the owner sets a policy through the host's `getBudget` / `setBudgetPolicy` callables on the authenticated WebSocket surface.

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

## Public.com Autopilot Trading Desk

The Public tab is an analysis and execution desk over a connected Public.com account. The Public.com MCP server is the only source of market and account facts (and the only execution venue); everything the user reads as prose is the agent's analysis over that data - Public.com itself emits no verdicts or recommendations.

### Capabilities

- **Reactive Q&A** - questions answered by a bounded tool loop over the live MCP catalogue (quotes, option chains, portfolio, account and order reads), under an evidence-only answer contract: a figure the tools did not return is reported as `n/a`, never estimated.
- **Autopilot pipeline** - a goal-oriented run for multi-part questions: Goal -> Planner -> Task Queue -> Executor -> Verifier, at most one replan aimed at the verifier's named gaps, then a synthesis written from the verified evidence. Runs persist per-run (newest 20) with a Sessions transcript each.
- **Trading desk** - watchlist quotes, portfolio positions, and an option-chain viewer served by read endpoints with **no model in the numbers path**; clicking a contract drafts a prefilled question. A classified library of 71 questions (tier / outlook / premium) seeds the composer, and every exchange keeps its raw tool data downloadable (JSON/CSV per call) so model prose and Public.com data stay separable.
- **Trade approvals** - with `PUBLIC_ALLOW_TRADING` on, an order-placing tool call never executes in the model turn. It is recorded as a proposal (tool + exact arguments + originating question) and a workflow waits up to 24h for a human decision; only an approval executes, exactly the call shown.
- **Voice desk** - a Talk control in the Ask card connects to the VoiceAgent (Cloudflare's voice channel: Workers AI transcription and speech). If the cloud call does not start, the client falls back to the browser's own speech recognition and synthesis, running each turn as text through the VoiceAgent's voice.ask (the cfagent pattern) - so voice keeps working whenever the desk's language model does. Spoken questions run the same desk pipeline and the answers are spoken back in plain prose; trades still become approval-gated proposals, never executions. Also dispatchable over A2A at `/a2a/voice` (`voice.ask`, `voice.snapshot`).
- **Knowledge search** (issue #170): the SearchAgent card sits in the Tools view — Ask returns a grounded answer with its source chunks, Chunks shows the retrieved text itself. The agent queries a Cloudflare AI Search instance (created in the dashboard under AI > AI Search; the name comes from `AI_SEARCH_INSTANCE`, default `cfpay`) and reports honestly in its snapshot until one exists. It is a full agent like the others: Think base, `searchAgent` dispatch from the host, an A2A surface at `/a2a/search`, and a row in the endpoint tests.
- **Multi-agent orchestration** (issue #180): the OrchestratorAgent takes a goal, plans steps across the other agents from a fixed operation catalog, runs independent steps in parallel, retries a failed step once before reporting it by name, and merges one report; jobs persist in its own storage. Dispatch goes through each agent's own A2A handler, so every agent's gates apply unchanged. Surface: the desk's Orchestrate view, the `orchestratorAgent` host tool, and `/a2a/orchestrator`.
- **Opportunity hunt** (issue #135) - a budget-bounded scan for premium-selling trades: the pipeline gathers live chain evidence and proposes candidates; deterministic code verifies and sizes them (below), and the resulting plan renders as an HTML report or an emailed PDF. Report-only - the hunt has no path to an order.

### Multi-agent orchestration

The OrchestratorAgent (issue #180) is the coordination layer above the agents. The host agent has always been able to dispatch one agent at a time inside its own chat; the orchestrator takes a **goal** and runs it as a durable, multi-agent job.

**The pattern.** A job uses the orchestrator's own LLM exactly twice:

1. **Planning** - one model call turns the goal into a JSON step plan. The prompt is generated from a fixed operation catalog (`src/orchestrate.ts`, the only operations a plan may use), and deterministic code validates the reply: an operation outside the catalog, a dependency cycle, a dangling reference, or more than 8 steps rejects the plan. One correction retry, then the job fails by name instead of improvising. The catalog excludes only operations whose inputs a plan cannot author, destructive operations, and inbound-event simulation (see the header of `src/orchestrate.ts`). Slack posting was briefly excluded while the Slack agent refused it over A2A; the owner enabled slack.post over A2A (issue #188), so it is plannable.
2. **Synthesis** - after execution, one model call writes the merged report from the step results. If it fails, the deterministic step summary stands as the report.

Everything between those calls is code, not model judgement: dependency waves are computed topologically, independent steps run in parallel, each result is judged by a fixed rule (no reply text, `ok: false`, or an `error` field means failure), a failed step is retried once and then reported by name with its dependents skipped, and the job and its steps persist in the orchestrator's own SQL tables - so a job outlives any conversation and stays inspectable in the desk's Orchestrate view.

**Two modes: plan-and-execute, and supervised (issue #185).** The pattern above is `plan` mode, and it stays the default. `supervise` mode keeps the same start - a catalog-validated plan - but after each execution wave the orchestrator's model reviews the actual results against the goal and returns a verdict: **continue**, **stop** (the remaining steps are recorded as skipped with the model's reason), or **revise** (replace the remaining steps; the revision passes through the same catalog validation - no unknown operations, no cycles, no reusing an executed step's id). Supervision is hard-bounded: at most 3 reviews and 12 total steps per job, and an unreadable verdict counts as continue, so a confused supervisor degrades to the plan rather than breaking the job.

Why keep both? They optimize for different things, and neither dominates:

- **Plan mode** is auditable end to end - the entire plan exists and is validated *before* anything runs, which matters when steps can send email or create checkouts - and it is cheaper and more predictable: two model calls regardless of job size, no mid-flight surprises.
- **Supervise mode** is adaptive: when a step's result changes what should happen next (a search finds nothing, a QA check fails in an unexpected way), the model can react instead of the job blindly executing a stale plan. The cost is more model calls, less predictability, and a wider - still catalog-bounded - decision surface.

**Model routing (issue #212).** The orchestrator's model calls route per task over the repo's model catalogue (`src/model-routing.ts`): planning starts with the strongest model, verdicts and synthesis start cheaper. A transient provider error (3043 class) retries once, then falls to the next model in the chain. The account-level neuron quota (4006) is terminal - every model on the account fails identically - so the router surfaces it immediately rather than burning the chain.

**Scheduled goals (issue #213).** The ScheduledAgent is the fleet's clock: it stores {goal, cron} goals in its own SQL and, when one falls due, hands the goal to the orchestrator as an ordinary job - every gate applies unchanged. A Worker cron trigger fires every minute (UTC) and calls the agent's tick; due goals dispatch capped per tick and always advance to their next slot, so a failing goal cannot hot-loop. Cron is 5-field UTC with @hourly/@daily/@weekly/@monthly aliases (`src/cron-next.ts`). Nothing is seeded: no goal exists until the owner creates one (dashboard API `/api/dashboard/scheduled-goals`, A2A `scheduled.create`, or the host's `scheduledAgent` tool). Plans may READ the schedule (`scheduled.summary` / `scheduled.list` are in the operation catalog) but never write it - making work recur is an owner action, not a planner action.

Choose per job: `mode` on the A2A operation and the dashboard route, the orchestratorAgent tool's `mode` argument, or the Supervise checkbox in the desk's Orchestrate view. Jobs record their mode and revision count.

**Planning memory (issue #192).** The orchestrator no longer plans cold. Every finished job writes its step outcomes back into per-operation reliability counters (runs, failures, last error), and before planning a new goal the agent reads its own history: the planner's prompt gains a short memory brief naming similar past goals and how they ended, plus any operation that has failed at least half of its last runs (two or more) - with the instruction to avoid it unless the goal requires it. The brief is distilled deterministically from the job tables (token-overlap relevance, counted failure rates, capped length) - no extra model call, and no brief at all when nothing is relevant, so a fresh deployment plans exactly as before. The brief each job planned with is stored on the job record, and `orchestrator.summary` reports how many operations are tracked and which are currently unreliable.

**Dispatch: A2A, not agent-as-a-tool.** Each step is executed by building the same JSON-RPC `message/send` body an external A2A caller would send (operation and arguments in a data part) and calling the owning agent's `handleA2A` directly on its Durable Object stub - no HTTP hop, since it is the same Worker. The rationale, in order of weight:

- **One dispatch path per agent.** The A2A handler is the same code external callers, the endpoint tests, and the post-deploy probes exercise. Orchestration cannot drift onto a second, private path into each agent that behaves differently from what the world sees.
- **Gates stay with the owner.** Each agent enforces its own rules inside its own handler - `payment.process` refuses without a verified claim, trades still need dashboard approval, QA stays read-only. The orchestrator holds no other agent's credentials and cannot bypass anything; it just delivers the same requests any caller could.
- **Jobs are not chat turns.** Agent-as-a-tool runs the child inside the *host's* conversation - its history, registry, and cancellation. An orchestration job is none of that: it is planned upfront, runs steps in parallel, and must survive independently of any chat. The A2A request/reply shape fits that; the tool-call shape does not.
- **Uniform contract.** Every agent exposes the same handler, so the catalog is uniform - and an external orchestrator could drive the identical steps over real HTTP A2A unchanged.

The two mechanisms coexist at different layers: agent-as-a-tool remains how the host dispatches within a conversation (and the orchestrator itself is registered as a host tool, `orchestratorAgent`), while the orchestrator dispatches downward over A2A.

### Separation of concerns

| Component | Owns | Never does |
|---|---|---|
| **Model** (Workers AI; desk picker, default GPT-OSS 120B) | Planning, tool selection, reading evidence, candidate discovery, theses, probability estimates, prose | Hold credentials, execute orders, source a number, size a position |
| **Host agent** (`CfmailAgentSQLite`) | The Public token, the tool loop and its budgets, run/proposal state (one SQL table per run type), the answer contracts | Let a model turn place an order; store runs inside the shared state blob |
| **Deterministic modules** (`src/models.ts`, `src/public-autopilot.ts`, `src/opportunity-hunt.ts`, `src/public-data.ts`) | Context budgeting and pruning, the pipeline's step/budget/replan bounds, hunt risk math and caps, mapping semantic arguments onto the tools' live input schemas | Invent data - inputs are tool results and the live spot only |
| **API layer** (`src/api.ts`) | Dashboard auth on every route, cross-agent orchestration (e.g. hunt report: host data -> QAAgent prints the PDF -> EmailAgent sends it) | Business logic that belongs to an agent |
| **Trade workflow** (`src/trade-workflow.ts`) | The only execution path: wait-for-approval, the decision record, claim-to-`executing` persisted *before* calling Public (no double placement), credentials re-read at execution time | Execute without a recorded human approval |
| **QAAgent** | Browser verification of the product itself: dashboard checks, UX audits, failure investigation, desk snapshots, PDF printing | Anything in the trading path |
| **EmailAgent** | The only sender; attachment validation, caps, and base64-to-binary decoding | Send on a model's say-so outside a user- or system-initiated flow |
| **Dashboard UI** | Presentation, the approvals queue, raw-data downloads | Hold a number's provenance - figures render from tool data or the plan store |

### Split of duties

| Decision or action | Model | Deterministic code | Human |
|---|---|---|---|
| What to investigate; the plan's steps | Proposes | Bounds (max steps, per-step tool budgets, one replan) | Asks the question |
| Tool calls | Chooses tool + semantic intent | Maps arguments onto the live schema; refuses unmapped required parameters | - |
| Figures in an answer | Phrases them | Supplies them - tool results only, `n/a` otherwise | - |
| Whether evidence supports the goal | Verifier judges, names gaps | Enforces the replan bound; the answer is synthesized from verified evidence only | - |
| Candidate trades (hunt) | Discovers them; writes thesis + invalidation; estimates probability from deltas | **Verifies** moneyness against a fresh live spot, structure (defined-risk only), and expiry | Sets the budget - a planning constraint, never a spend authorization |
| Position sizing (hunt) | - | Computes per-contract risk from the legs; ranks by expected value per dollar of risk; allocates under the caps (per-trade <= 2% of budget by default, per-underlying <= 25%, total <= budget) | - |
| Placing an order | Never | Executes the approved call exactly as proposed, once, after the workflow's claim | Approves or rejects in the Trade approvals card |
| QA verdicts | Narrates investigations | Deterministic pass/fail checks; capacity refusals degrade to skips, never passes | - |

Invariants that follow from the split: no number in any answer or plan originates from the model; no order executes inside a model turn; a budget bounds a *plan*, and only a human approval moves money; the Public access token is used by the tool transport only - it never appears in prompts, run records, or reports.

### Model vs quant, in plain terms

The split above, stated as plainly as it can be:

- **The model proposes** - actions and candidates, never facts or executions. In the desk chat it proposes which tools to call with what arguments, and, with trading on, it proposes *trades*: a proposal record for human approval, not an execution. In the hunt it proposes *candidate trades* - structures with specific legs, strikes, expiry, and the credit it read off the chain.
- **The model analyzes** - it reads what the tools returned (quotes, chains, portfolio, step findings) and turns it into judgment: comparisons, the synthesis answer, the verifier's verdict on whether the evidence supports the goal, a thesis and invalidation per candidate, and a probability estimate from the deltas. Prose and judgment are its; numbers are not.
- **What is verified, and why** - a model will state figures that contradict its own tool data (in production it once invented an IV of ~23% against a verified ~48-54% chain, and pitched a deep-in-the-money spread as low-risk because nothing checked it against spot). So the pipeline verifies in two places: the autopilot **verifier** is a separate model pass that re-reads the step evidence against the goal and names the gaps before the answer is written; and in the hunt, code re-verifies every candidate against a **fresh live spot** - moneyness, defined-risk structure, expiry - before sizing. The answer contract adds the floor rule: a figure the tools did not return is `n/a`, never estimated.
- **Sizing is the quant part** - deciding *how many contracts*, in deterministic code. Per-contract risk is computed from the legs (a 5-wide spread collecting 1.25 risks $375 per contract); contracts are the per-trade risk cap divided by that risk, rounded down, also respecting the per-underlying cap and the total budget. Leftovers stay unallocated. The model never does this arithmetic, and its probability estimate only orders the queue - it cannot enlarge a position past the caps.

## Post-deploy QA (automated testing)

Every push to `main` deploys the Worker and then runs `scripts/qa-smoke.mjs` against live production (the **Post-deploy QA** job in `.github/workflows/deploy.yml`). A green deploy only proves the upload worked; this job proves the app works. The exit code is the contract — any FAIL fails the job, and a check that cannot run reports SKIP with the reason, never a silent pass. Browser-bound checks refused by Browser Rendering capacity are not skipped on the spot: they are deferred, the suite waits (`QA_CAPACITY_WAIT_MS`, default 90000) for sessions from earlier runs to drain, and retries them once — a SKIP is recorded only if the retry is refused too. The closing summary email is sent as formatted HTML (status-chip table) with a plain-text fallback.

What it checks:

1. `/health` responds.
2. Dashboard edge cases behave.
3. Payment guards: the x402 challenge is well-formed (no money moves).
4. Tab data: Emails / Payments / Webhooks render real rows or their recognized empty states.
5. UX audit (dashboard): the deterministic accessibility/UX audit runs end to end. Its findings are reported, not gated — the dashboard legitimately has findings.
6. UX audit (fixture self-test): the same audit pointed at `public/qa-fixture.html`, a page with exactly four planted violations, must return the exact expected findings. This is the audit testing itself; a miss fails the job.
7. Attachment check: drives the real Send Email form and sends a real email with an attachment to `QA_TEST_EMAIL`. It runs by default; set `QA_RUN_ATTACHMENT_CHECK=false` to disable it explicitly.
8. QA report email: the tab check with screenshots, emailed to `QA_TEST_EMAIL` as the 4-PNG report — the same email the dashboard's **Email QA Report** button sends, and the report of record for the run. (The attachment check above is just a form probe; this is the actual report.) It runs by default; set `QA_RUN_REPORT_CHECK=false` to disable it explicitly.
9. Desk endpoints respond (quotes / portfolio / chain; a disconnected Public account skips).
10. A2A dispatch: the QA agent's endpoint refuses the unauthenticated (401) and round-trips `qa.summary` and a fixture `qa.ux_audit`.
11. Desk snapshot email: five screenshots of the whole desk, emailed (`QA_RUN_DESK_CHECK=false` disables).
12. A2A endpoint test email: every agent's A2A surface probed (card, 401, snapshot dispatch) and the results emailed (`QA_RUN_A2A_CHECK=false` disables). Needs no browser, so it lands even during a merge train.
13. Autopilot hunt report PDF email: QAAgent tests the autopilot agent's workflow end to end - it runs a real opportunity hunt (budget $10,000, SPY) through the public routes and has the hunt's report PDF emailed. The autopilot workflow's own output, not a synthetic page (`QA_RUN_PDF_CHECK=false` disables).
14. Agent A2A operations (issue #190): the manual per-agent curl checks, automated - one real read operation against every A2A surface (host, email, payments, webhooks, slack, qa, chat, voice, search, orchestrator) asserting the reply contract, plus a slack.post write proof (issue #188; `QA_RUN_SLACK_POST=false` skips just that row). Headless and model-free, so it still runs when browser capacity or the neuron budget is exhausted.

Two cross-cutting pieces: any FAIL also hands the failure to QAAgent's investigator, whose diagnosis prints in the log - and the **self-healing loop** (below) files that diagnosis where work is tracked - and at the end of every run the script emails a one-page **summary** (every section's PASS/FAIL/SKIP) to `QA_TEST_EMAIL` through the dashboard's send-email route, so a skipped or failed email is itself reported rather than silent. The report and snapshot screenshots, and the hunt PDF, are additionally mirrored to Slack as file uploads through the bot API when `SLACK_QA_CHANNEL_ID` is configured (Slack's incoming webhook cannot carry files). Browser-bound sections degrade to SKIP when Browser Rendering capacity refuses a session - weather, not a verdict.

### The self-healing loop

The QA system does not stop at reporting failures - it tracks them, attempts repairs, and closes its own tickets. Three stages, each deliberately bounded:

**1. Track (phase 1, issue #193).** When a run finishes with gated failures (a SKIP never counts), the smoke files one GitHub issue per failing section, titled `[QA self-heal] <section>`, carrying the failure detail, the link to the Actions run, and QAAgent's investigator diagnosis. A repeat failure comments on the still-open issue instead of duplicating it. When a section demonstrably passes again on a later deploy, its issue gets a "passing again" comment and auto-closes. Filing is best-effort - it can never change the run's exit code - and `QA_SELF_HEAL=false` disables it.

*Workflow requirement (satisfied 2026-10-17):* the filer runs on the Actions token, which GitHub does not expose to a step automatically - the qa-smoke job passes `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in the step's `env:` and holds `issues: write` in its job `permissions:` (alongside `contents: read`). Without the token the run logs exactly that, instead of staying silent - the misconfiguration that run 39040787456 exposed, before the workflow was updated.

*Where the information comes from:* the workflow needs no external input - the smoke script is both the test runner and the reporter. Every section records its own result (name, pass/fail/skip, detail) in the run; on gated failures the script sends the failing checks to the production Worker's `/api/dashboard/qa/investigate` endpoint, where QAAgent drives a real browser and returns a diagnosis, which the script keeps. At the finish step it assembles the issue from those two sources plus the run's own Actions context (repository and run id become the run link), and files it with the step's `GITHUB_TOKEN`. Dedupe and auto-close read the same run state back: open issues carrying the `[QA self-heal]` title prefix are matched against this run's results. The fixer - either edition - then works from the issue as its brief: the failure detail and diagnosis are in the body, and it reproduces the rest from the checked-out code.

**2. Repair (phase 2, issue #195).** Two autonomous fixers watch the same issues. One runs in Muse on a 30-minute poll (claim comments on the issue). The other runs in GitHub Actions (template at `docs/self-heal-fixer-workflow.yml`) and needs no model of its own: it **assigns the issue to GitHub's Copilot coding agent**, which runs on the account's existing Copilot plan - the smoke's issue body is already the complete brief Copilot works from, and the assignment call carries the condensed runbook as custom instructions (triage first, minimal fix, gates green, draft PR, never merge). Copilot opens a draft PR on its own `copilot/` branch. The fixers coordinate through the issue: assignment is the Actions edition's claim, a `Fix claimed by` comment (stale after 2 hours) is the Muse edition's, and a `Fix PR:` comment or an open fix branch marks an issue done. Each works at most one issue per run, following a fixed runbook. It first **triages**:

- `CODE` - a repo defect: it reproduces the root cause against fresh `main`, makes the minimal fix on a `self-heal/<issue#>-<slug>` branch, requires the local gates green (`tsc --noEmit`, the full test suite, `node --check` for plain JS), and opens a PR titled "Self-heal fix for #<issue#>", commenting `Fix PR: <url>` on the issue so no second fixer duplicates the work.
- `ENVIRONMENTAL` - browser capacity, Workers AI neuron exhaustion, provider transients: it comments the classification and stops. No code fixes weather.
- `NEEDS-OWNER` - a dashboard step, a secret, a policy call: it comments exactly what the owner must do and stops.

**3. Merge (the machine gate).** By the owner's directive the loop is fully autonomous - there is no human merge step. The fixer merges a self-heal PR (its own or Copilot's) as soon as its required checks pass (type check + the CI test suite; the independently broken Deploy Preview job is not a gate), and comments the merge on the issue. A PR whose checks fail gets one corrective follow-up from the fixer; a second failure leaves it open and escalates to the owner - humans see exceptions, not routine merges. The merge deploys, the smoke runs, and stage 1 closes the issue when the section passes: detection, diagnosis, tracking, repair, merge, and closure, with no human decision in the routine path.

Configuration: the job declares `environment: PROD`, so it uses the PROD environment's secrets — `DASHBOARD_API_KEY` and `QA_TEST_EMAIL` (the inbox that receives the attachment test email) live there, not as repository secrets.

Run it manually:

- **GitHub:** Actions → a *Deploy CFmail Agent* run → Re-run (failed) jobs replays Post-deploy QA against current production.
- **Locally:** `BASE_URL=https://pay.openaimp.com DASHBOARD_API_KEY=<key> QA_TEST_EMAIL=<recipient> node scripts/qa-smoke.mjs`

Reading a run: Actions → the Deploy run → **Post-deploy QA** → *Run QA checks against production* — per-check `[PASS]` / `[FAIL]` / `[SKIP]` lines plus a summary (e.g. `8/8 checks passed`). The QA tab's **Audit URL** button uses the same audit interactively and defaults to the fixture page, so one click there is the same self-test by hand.

> Note: two deploys landing back-to-back run two suites at once; on the Free plan's browser limits they can starve each other and false-fail. Re-run the job solo before treating a red run as a regression.

#### Testing secure (authenticated) URLs

The QA tab's **Audit URL** box audits public pages only. For a page behind auth, call `POST /api/dashboard/qa/ux-audit-url` (the call itself is authenticated with the dashboard `X-API-Key`) and carry the *target* app's auth inside the spec — one of two modes:

- **`headers`** — an auth header or session cookie is sent on every request of the browser session; fits token- or cookie-protected apps.
- **`localStorage`** — keys are seeded on the origin before navigation; fits SPAs that keep a token in localStorage (cfpay's own dashboard pattern, `cfmail_api_key`).

```json
{
  "spec": {
    "pages": ["https://app.example.com/dashboard"],
    "auth": { "mode": "headers", "headers": { "Authorization": "Bearer <target-token>" } },
    "settleSelector": "#app"
  }
}
```

```bash
curl -X POST https://pay.openaimp.com/api/dashboard/qa/ux-audit-url \
  -H "X-API-Key: <DASHBOARD_API_KEY>" \
  -H "Content-Type: application/json" \
  -d @spec.json
```

All pages must share the first page's origin (max 8). Interactive login flows — form fill, OAuth redirects, MFA, CAPTCHA — are not supported yet. For automated coverage of a secure target, store its credential as a PROD environment secret and have `scripts/qa-smoke.mjs` build the spec from the environment at runtime; credentials never go in the repo.

#### Testing the agentTool / A2A exposure

The generalized audit is also a service operation, **`qa.ux_audit`**, reachable by other agents two ways. Test them in this order:

1. **Discovery (no auth):** `GET https://pay.openaimp.com/a2a/qa/agent-card.json` — the card's description and Browser QA skill name `qa.ux_audit`.
2. **A2A dispatch (deterministic):** send a JSON-RPC `message/send` to `/a2a/qa` with the A2A bearer and a data part carrying the operation and a spec:

```bash
curl -X POST https://pay.openaimp.com/a2a/qa \
  -H "Authorization: Bearer <A2A_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","data":{"operation":"qa.ux_audit","spec":{"pages":["https://pay.openaimp.com/qa-fixture.html"]}}}]}}}'
```

Against the fixture the reply text reads *"UX audit on 1 page(s) found failing checks: Contrast (WCAG AA), Target size, Heading hierarchy, Image alt text."*, with the full findings in the data artifact. Negative checks in the same shape: an unknown operation returns the supported list (now ending in `qa.ux_audit`); `qa.ux_audit` without a spec is refused as `bad_spec`; a non-http(s) page is refused as `bad_url`. This path uses no AI.

3. **Host agentTool dispatch (model-mediated):** ask the dashboard's host agent — *"Run a UX audit of https://pay.openaimp.com/qa-fixture.html and tell me which checks fail."* It should dispatch the QA tool with `qa.ux_audit` and summarize the same four failures. Wording varies (a model makes the call) and the turn spends Workers AI neurons, so treat step 2 as the verdict and this as the experience.

#### Testing the live frame stream

Run any watched check from the QA tab — **Verify Tab Data** is the longest — and watch the Live view panel:

- The large view updates about once a second between the named screenshots, captioned **"Live — streaming"** (before, it sat frozen on each still until the next landed).
- The filmstrip gains thumbnails **only** at the named screenshot beats; streamed frames never add thumbnails or step lines.
- Clicking a thumbnail pins the large view: frames stop overriding it while the run continues.
- The run still finishes with the normal result block. The same streaming applies to **UX Audit** and **Audit URL** runs; unwatched runs (Post-deploy QA included) stream nothing and pay nothing.

The stream is capture polling (about 1 fps), not `Page.startScreencast` — the Agents SDK's CDP client discards protocol events, so screencast frames cannot reach the agent through the connection the checks use. True screencast is tracked in issue #102.

#### Testing the Public.com autopilot

What the autopilot is and who does what: see **Public.com Autopilot Trading Desk** above.

The Public tab's **Autopilot** toggle runs a question as a goal instead of a single reactive chat turn: a planner decomposes it into steps (max 6), each step executes with its own tool budget and writes a finding into the run's evidence, a verifier judges the evidence against the goal (complete / incomplete, a confidence score, and the gaps by name), and at most one replan (max 3 follow-up steps aimed at the gaps) runs before the answer is synthesized from the verified evidence. Runs persist in agent state (newest 20), and each run also records a transcript into the agent's Sessions store under `autopilot-<runId>`. Order-placing calls inside steps still become approval-gated trade proposals — autopilot never executes a trade. It costs several times the Workers AI calls of a plain question, so use it for multi-part goals, not lookups.

Test it in production:

1. **Run one.** Public tab → tick **Autopilot** → ask a multi-part question, e.g. *"Compare NVDA and AMD for a bullish view on semiconductors — which has the better setup?"* — the question shape that used to exhaust the reactive loop's tool-call cap. GPT-OSS 20B keeps the neuron cost down. The run card should finish with every step checked off, a verifier verdict with confidence, and an answer built from the step findings. With Autopilot off, the same question takes the reactive path, unchanged.
2. **List the runs.** `GET https://pay.openaimp.com/api/public/autopilot-runs` with the dashboard `X-API-Key` header returns the persisted runs; the newest is the one from step 1. Its presence is the state check — the run survived in the typed `autopilotRuns` state.
3. **Read the session transcript.** `GET https://pay.openaimp.com/api/public/autopilot-runs/<id>/session` (same header) returns the run's Sessions transcript: the goal, one message per completed step carrying its finding, the verifier verdict, and the final answer — matching the run card. Call it twice: the two lists must be identical. Recording re-runs on every state save during the run, and stable message ids keep the appends idempotent, so duplicated messages mean a bug. Runs created before the platform-alignment deploy (PR #109, 2026-10-15) have no transcript.
4. **Check tracing.** Cloudflare dashboard → Workers & Pages → `cfmail-agent` → Observability → Traces shows agent activity from step 1 (allow a minute). Message and tool payloads are intentionally not recorded — they can contain email bodies and financial data.

Reading failures: **401** — missing or wrong API key. **404** on the session URL — wrong run id, or a pre-alignment run. **AiError 4006 / 3043** mid-run — Workers AI quota / transient errors; the run dies at whichever AI call it was making, so retry. **HTTP 502, "Internal error in Durable Object storage caused object to be reset"** — the agent's Durable Object was reset by a storage-layer error mid-run (first observed 2026-10-15, on the step-1 test question above). Retry the run; if it recurs, treat it as a defect in the run's state/session writes, not a Workers AI problem.

### Error handling: one catalog for back end and front end (issue #209)

Every error the deployment returns comes from **`src/errors.json`** - one catalog, the single source of truth. Each entry is a stable code (`AI_QUOTA_EXHAUSTED`, `PUBLIC_NOT_CONNECTED`, `SEARCH_NOT_CONFIGURED`, ...) with its HTTP status, a user-facing message, recovery guidance, and a `retryable` flag. The back end builds response bodies from it (`src/errors.ts`): `{ error: <message>, code, hint, retryable }`. Known platform failures are mapped to codes at the boundary - a Workers AI quota refusal becomes `AI_QUOTA_EXHAUSTED`, a transient provider error `AI_PROVIDER_UNAVAILABLE`, a missing AI Search instance `SEARCH_NOT_CONFIGURED` - and a global handler turns any unhandled exception into `INTERNAL`, logging the original server-side. **Raw exception text never reaches a client** (the desk once rendered a bare `AiError: 4006: ...` platform string as a chat answer; that class of leak is what this removes). The front end fetches the same catalog from `GET /api/errors.json` and renders errors by code - message plus the recovery hint - so back end and front end can never drift: **the code is the linkage**. Existing string consumers keep working because `error` remains the user message. Phase 1 covers the API's auth failure, the Public routes (connect, tools, chat, hunt, trade decisions), and the desk's chat/search rendering; later phases sweep the remaining routes and carry codes in A2A failure replies.

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
