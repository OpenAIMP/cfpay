# Agentic Solution — Cloudflare Agents

A full-stack agentic solution built on the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) that combines every capability from the Agents documentation:

| Capability | Where in this project | Docs |
|---|---|---|
| **AI / LLM** | `src/agent.ts` — `callReasoningModel()`, `generateInsight()` | [Using AI Models](https://developers.cloudflare.com/agents/runtime/operations/using-ai-models/) |
| **MCP Tools** | `src/mcp-server.ts` — `ToolsMCP` class + `addMcpServer()` in agent | [MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/) |
| **Scheduled Tasks** | `src/agent.ts` — `this.schedule()` with cron, delay, one-time | [Schedule tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/) |
| **Email Routing** | `src/agent.ts` — `onEmail()`, `replyToEmail()`, `sendEmail()` | [Email](https://developers.cloudflare.com/agents/communication-channels/email/) |
| **Cloudflare Workflows** | `src/workflow.ts` — `ProcessingWorkflow extends AgentWorkflow` | [Run Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/) |
| **Webhooks** | `src/webhooks.ts` — signature verification + routing for GitHub, Stripe, Slack | [Webhooks](https://developers.cloudflare.com/agents/communication-channels/webhooks/) |
| **State Management** | `src/agent.ts` — `initialState`, `setState()`, `onStateChanged()` | [State management](https://developers.cloudflare.com/agents/runtime/lifecycle/state/) |
| **Callable Methods** | `src/agent.ts` — `@callable()` decorator for RPC | [Callable methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/) |
| **Client SDK** | `public/index.html` — `useAgent()` React hook | [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Client (Browser)                    │
│  useAgent() ←→ WebSocket ←→ Agent (Durable Object)   │
└──────────────────────────┬──────────────────────────┘
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐    ┌──────────┐     ┌──────────────┐
   │ Workers AI│    │ MCP Server│     │  Workflows   │
   │ (LLM)    │    │ (ToolsMCP)│     │ (Processing) │
   └──────────┘    └─────┬────┘     └──────┬───────┘
                         │                  │
                    External MCP      Durable steps
                    servers (OAuth)   + retries
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐    ┌──────────┐     ┌──────────────┐
   │  Email   │    │ Scheduled │     │   Webhooks   │
   │ Routing  │    │  Tasks    │     │ GitHub/Stripe│
   └──────────┘    │ (cron)   │     │ /Slack       │
                   └──────────┘     └──────────────┘
```

## Quick start

```bash
npm install
npx wrangler types
npx wrangler dev
```

Then open `http://localhost:8787`.

## Deploy

```bash
npx wrangler deploy
```

## File structure

```
agentic-solution/
├── src/
│   ├── index.ts          # Worker entry point (re-exports)
│   ├── agent.ts          # Main Agent class — AI, MCP, scheduling, email, state, RPC, webhooks
│   ├── mcp-server.ts     # MCP server exposing tools (get_weather, search_knowledge, create_task)
│   ├── webhooks.ts       # Webhook signature verification (GitHub, Stripe, Slack) + outgoing webhook helpers
│   └── workflow.ts       # AgentWorkflow — durable multi-step background processing
├── public/
│   └── index.html        # React frontend using useAgent() client SDK
├── wrangler.jsonc        # Wrangler config (AI, email, DOs, workflows, assets bindings)
├── package.json
└── tsconfig.json
```

## Key APIs used

### State Management
```ts
initialState: AgentState = { messages: [], taskProgress: 0, ... };
onStateChanged(prev, current) { /* react to changes */ }
this.setState({ ...this.state, taskProgress: 0.5 });
```

### Callable Methods (RPC)
```ts
@callable()
async addTask(title: string, data: string) { ... }

// From client:
await agent.call("addTask", ["My Task", "data"]);
```

### Scheduling
```ts
// One-time delay (seconds)
await this.schedule(60, "processTask", { taskId: "123" });

// Cron (daily at 9 AM)
await this.schedule("0 9 * * *", "dailySummary", {}, { idempotent: true });
```

### Email
```ts
async onEmail(email: AgentEmail) {
  const parsed = await PostalMime.parse(await email.getRaw());
  await this.replyToEmail(email, { fromName: "AI Agent", body: "..." });
}
```

### Workflows
```ts
class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event, step) {
    await this.agent.updateStatus(taskId, "processing");
    const result = await step.do("process", async () => { ... });
    await this.reportComplete(result);
  }
}
```

### MCP Client
```ts
await this.addMcpServer("internal-tools", this.env.MCP_SERVER);
await this.addMcpServer("github", "https://mcp.github.com/mcp", { callbackHost: "..." });
```

## Prerequisites

1. A Cloudflare account with Workers.
2. A domain onboarded to [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) for email features.
3. Workers AI binding (included — no API key needed for `@cf/` models).

## Webhooks

Incoming webhooks from GitHub, Stripe, and Slack are verified and routed to
per-entity agent instances.

### Endpoints

| Provider | URL Path | Signature Header |
|----------|----------|-----------------|
| GitHub | `POST /webhooks/github` | `X-Hub-Signature-256` (HMAC-SHA256) |
| Stripe | `POST /webhooks/stripe` | `Stripe-Signature` (HMAC-SHA256 + timestamp) |
| Slack | `POST /webhooks/slack` | `X-Slack-Signature` (HMAC-SHA256 + timestamp) |

### Agent routing

The Worker verifies the raw request body against the provider's signature,
then derives the agent instance name from the authenticated payload:

- **GitHub** → `repository.full_name` (e.g. `owner/repo` → `owner-repo`)
- **Stripe** → `customer` / `account` / event `id`
- **Slack** → `team_id` / `event.channel`

Each entity gets its own isolated, stateful agent instance via `getAgentByName()`.

### Secrets

Set these via `npx wrangler secret put <NAME>` (or `.dev.vars` for local dev):

```
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret
SLACK_WEBHOOK_SECRET=your-slack-signing-secret
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # optional, for outgoing notifications
```

### Outgoing webhooks

The agent can also send webhooks:

```ts
// Slack notification
await agent.call("notifySlack", ["Deployment complete!"]);

// Signed webhook to any URL
await agent.call("sendWebhook", ["https://example.com/hook", { event: "done" }]);
```

Docs: [Webhooks](https://developers.cloudflare.com/agents/communication-channels/webhooks/)