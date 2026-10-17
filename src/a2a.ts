/**
 * A2A (Agent-to-Agent) protocol server for the CFmail agent.
 *
 * Adapted from Cloudflare's examples/a2a, but deliberately NOT using its
 * dependency set. The example imports `ai@^7` and `workers-ai-provider@^4` for
 * `generateText`; this repo runs `ai@6` and calls `env.AI.run()` directly, and
 * `models.json` already holds the model ids. Upgrading `ai` by a major version
 * across a working payment system to serve one endpoint is not a trade worth
 * making, so the executor uses the existing `AI.run` pattern instead. The only
 * new dependency is `@a2a-js/sdk`.
 *
 * What it exposes, per the A2A spec:
 *   GET  /.well-known/agent-card.json   the agent card (discovery)
 *   POST /a2a                           JSON-RPC: message/send, message/stream
 *
 * Access model: the card is public because A2A clients discover by fetching it,
 * and it contains no data. /a2a requires a bearer credential, because every call
 * spends Workers AI tokens and this is a live payment system. That matches the
 * gate already on /mcp.
 *
 * Read-only by construction: the executor answers questions about state the
 * agent already holds. It has no tool surface, so it cannot send mail, move
 * funds or pay an x402 endpoint.
 */

import type { AgentCard, Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import type { Env } from "./types";
import { defaultModelId } from "./models";

/** Path that serves the agent card. Both spellings are in the spec's history. */
export const A2A_CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];

/** Path that serves the JSON-RPC endpoint. */
/** JSON-RPC endpoint for the cfmail capability. */
export const A2A_RPC_PATH = "/a2a";

/**
 * JSON-RPC endpoint for the payments capability.
 *
 * Separate from A2A_RPC_PATH because the cards must advertise the path that
 * actually routes to them: both previously used A2A_RPC_PATH, so a client that
 * fetched the payments card and POSTed where it was told would have reached the
 * monolith and the wrong capability.
 */
export const A2A_PAYMENTS_RPC_PATH = "/a2a/payments";

/** Discovery path for the payments capability card. */
export const A2A_PAYMENTS_CARD_PATH = "/a2a/payments/agent-card.json";

export const A2A_EMAIL_RPC_PATH = "/a2a/email";
export const A2A_EMAIL_CARD_PATH = "/a2a/email/agent-card.json";

export const A2A_WEBHOOK_RPC_PATH = "/a2a/webhooks";
export const A2A_WEBHOOK_CARD_PATH = "/a2a/webhooks/agent-card.json";

export const A2A_SLACK_RPC_PATH = "/a2a/slack";
export const A2A_SLACK_CARD_PATH = "/a2a/slack/agent-card.json";

export const A2A_QA_RPC_PATH = "/a2a/qa";
export const A2A_QA_CARD_PATH = "/a2a/qa/agent-card.json";

export const A2A_ORCHESTRATOR_RPC_PATH = "/a2a/orchestrator";
export const A2A_ORCHESTRATOR_CARD_PATH = "/a2a/orchestrator/agent-card.json";

export const A2A_SEARCH_RPC_PATH = "/a2a/search";
export const A2A_SEARCH_CARD_PATH = "/a2a/search/agent-card.json";

export const A2A_VOICE_RPC_PATH = "/a2a/voice";
export const A2A_VOICE_CARD_PATH = "/a2a/voice/agent-card.json";

export const A2A_CHAT_RPC_PATH = "/a2a/chat";
export const A2A_CHAT_CARD_PATH = "/a2a/chat/agent-card.json";

/** True when the presented credential authorises a /a2a call. */
export function a2aAuthorised(request: Request, env: Env): boolean {
  const expected = (env.DASHBOARD_API_KEY ?? "").trim();
  if (!expected) return false; // fail closed, as everywhere else in this Worker
  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : (request.headers.get("x-api-key") ?? "").trim();
  if (!presented || presented.length !== expected.length) return false;
  // Constant-time compare: a length-or-prefix leak is still a leak.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/* ----------------------------- task storage ------------------------------ */

/**
 * Task store on the Durable Object's own SQLite.
 *
 * The example does the same. Anything else would need another binding for state
 * that is only ever read back by the same DO.
 */
export class AgentTaskStore implements TaskStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS a2a_tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async save(task: Task): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO a2a_tasks (id, data, updated_at) VALUES (?, ?, ?)",
      task.id,
      JSON.stringify(task),
      new Date().toISOString(),
    );
  }

  async load(taskId: string): Promise<Task | undefined> {
    const rows = [...this.sql.exec("SELECT data FROM a2a_tasks WHERE id = ?", taskId)];
    if (rows.length === 0) return undefined;
    try {
      return JSON.parse(rows[0].data as string) as Task;
    } catch {
      return undefined;
    }
  }

  /** Count of stored tasks, for the operator-facing status output. */
  count(): number {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS n FROM a2a_tasks")];
    return Number(rows[0]?.n ?? 0);
  }
}

/* ------------------------------- executor -------------------------------- */

/** Pull the concatenated text out of an A2A message. */
function messageText(message: Message): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p: any) => p && p.kind === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n")
    .trim();
}

/**
 * A snapshot of what the agent currently holds, rendered for the model.
 *
 * Built from the caller-supplied accessors rather than by reaching into the DO
 * directly, so this class has no dependency on the agent's internal shape.
 */
/**
 * A capability exposed over A2A.
 *
 * Each agent supplies its own card and its own answer function. This module
 * knows nothing about what the capability is, which is what lets the same
 * transport serve the payments agent and the cfmail agent without either
 * leaking into the other.
 */
/** Result of handling one A2A message. */
export interface CapabilityResult {
  /** Human-readable reply. Always present, so the task always ends with a message. */
  text: string;
  /**
   * Optional structured result, published as a data artifact alongside the text.
   *
   * A caller that needs a machine-readable outcome (a payment id, a status) reads
   * this rather than parsing prose.
   */
  data?: unknown;
}

export interface A2ACapability {
  /** The card served at the discovery paths. `url` must be the request origin. */
  card(origin: string): AgentCard;
  /**
   * Handle one A2A message.
   *
   * Takes the message rather than a question string because a capability may
   * accept structured input: a data part carrying an operation and its arguments.
   * A capability that only answers questions ignores the parts it does not
   * understand and treats the text parts as the question.
   *
   * Implementations own their own truth: compute facts and use Workers AI only to
   * phrase them, so a model cannot invent a figure it was not given. Throwing is
   * fine - the executor reports the failure as the reply.
   */
  handle(message: Message, context: { taskId: string; contextId: string }): Promise<CapabilityResult>;
}

/**
 * Executor for any capability.
 *
 * Publishes the A2A lifecycle (submitted, working, message, completed) and
 * delegates the actual answer. It has no tool surface, so a prompt cannot talk
 * it into acting: it can only return text.
 */
export class CapabilityExecutor implements AgentExecutor {
  constructor(private capability: A2ACapability) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    if (!task) {
      eventBus.publish({
        id: taskId,
        contextId,
        kind: "task",
        history: [userMessage],
        status: { state: "submitted", timestamp: new Date().toISOString() },
      } as Task);
    }

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      final: false,
      status: { state: "working", timestamp: new Date().toISOString() },
    } as TaskStatusUpdateEvent);

    const question = messageText(userMessage) || "Summarise the current state.";

    let answer: string;
    let resultData: unknown;
    try {
      const handled = await this.capability.handle(userMessage, { taskId, contextId });
      answer = (handled.text || "").trim();
      resultData = handled.data;
    } catch (error) {
      answer = "The agent could not answer: " + String(error);
    }
    if (!answer) answer = "The agent produced no answer for that question.";

    const reply: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      taskId,
      contextId,
      parts: [{ kind: "text", text: answer }],
    };
    eventBus.publish(reply);

    // Structured outcome, when the capability returned one. A caller that asked
    // for work to be done reads this instead of parsing the prose reply.
    if (resultData !== undefined) {
      eventBus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: "result",
          parts: [{ kind: "data", data: resultData as Record<string, unknown> }],
        },
      } as never);
    }

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      final: true,
      status: { state: "completed", message: reply, timestamp: new Date().toISOString() },
    } as TaskStatusUpdateEvent);

    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {
    // Nothing to cancel: execute() has no long-running work and publishes its
    // final state inline.
  };
}

/* --------------------------- capability cards --------------------------- */

/** Card for the payments capability. */
export function paymentsCard(origin: string): AgentCard {
  return {
    name: "CFmail Payments Agent",
    description:
      "Owns the CFmail payment ledger and the Pay And Process capability: payments received and sent, Stripe card checkouts, and replay protection for both rails. Reads and writes over A2A.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_PAYMENTS_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "payment-ledger",
        name: "Payment ledger",
        description:
          "Report on payments received and sent, and process a paid request. Write operations are payment.process, checkout.create and checkout.fulfil; all require a bearer credential. This agent cannot move funds or refund.",
        tags: ["payments", "x402", "stripe", "write"],
        examples: [
          "How many payments have been received?",
          "What currencies are on the ledger?",
          "Are there any failed payments?",
          "Process this paid request and email the answer.",
        ],
      },
    ],
  };
}

/** Card for the cfmail capability. */
export function cfmailCard(origin: string): AgentCard {
  return {
    name: "CFmail Agent",
    description:
      "The chat channel and the aggregate view: asks and answers questions about mail, payments and webhook events across this Worker. Read-only. Cannot send mail, post to Slack, move funds or change anything.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "chat",
        name: "Chat and aggregate state",
        description:
          "Answer a question in natural language over the aggregate state, or return the raw facts without inference. Reads mail and payment counts and webhook activity. Read-only: every operation here answers, none acts, and the resources that do act are separate agents with their own rules.",
        tags: ["read-only", "chat", "email", "payments", "webhooks"],
        examples: [
          "How many emails has this agent handled?",
          "What payments are on the ledger?",
          "Which webhook providers have sent events recently?",
        ],
      },
    ],
  };
}
export function emailCard(origin: string): AgentCard {
  return {
    name: "CFmail Email Agent",
    description:
      "Owns the CFmail mail resource: message history, outbound sends, and the inbound record path. Other agents send through this. Reads and writes over A2A; sends are rate limited.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_EMAIL_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "email",
        name: "Email",
        description:
          "Report on message history and send mail. Write operations are email.send; all operations require a bearer credential. Sends are capped per hour for the agent instance.",
        tags: ["email", "send", "history", "write"],
        examples: [
          "How many emails has this agent handled?",
          "What were the last few subjects?",
          "Send a message to ops@example.com with this body.",
        ],
      },
    ],
  };
}
/**
 * Card for the webhook channel.
 *
 * States the boundary explicitly, because the boundary is the security property:
 * provider signatures are verified at the Worker edge, before anything here runs.
 * An A2A caller cannot mint one, so webhook.receive records an event as
 * a2a-sourced and unverified and never triggers the side effects a real delivery
 * would. A card that implied otherwise would invite exactly that mistake.
 */
export function webhookCard(origin: string): AgentCard {
  return {
    name: "CFmail Webhook Agent",
    description:
      "Owns the webhook event log and the GitHub delivery registry that makes redelivery safe. Provider signatures are verified at the Worker edge; this agent receives already-verified payloads. Reads freely over A2A; webhook.receive records an unverified a2a-sourced event only.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_WEBHOOK_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "webhook-channel",
        name: "Webhook channel",
        description:
          "Report on recorded webhook deliveries and replay-protection state. webhook.receive stores an external event as unverified and a2a-sourced; it cannot claim a GitHub delivery id, so it cannot suppress a genuine delivery. No provider signature is accepted or forged here.",
        tags: ["webhooks", "github", "stripe", "slack", "read-only-except-receive"],
        examples: [
          "How many webhook events have been recorded?",
          "Which providers have delivered recently?",
          "Has this GitHub delivery id already been seen?",
        ],
      },
    ],
  };
}
/**
 * Card for the Slack channel.
 *
 * The card is a contract, so it states the absence as plainly as the capability:
 * reads are available and posting is not. A card that omitted that would leave a
 * caller to discover the refusal by trying, which is a worse way to learn it.
 */
export function slackCard(origin: string): AgentCard {
  return {
    name: "CFmail Slack Agent",
    description:
      "Owns the Slack bot token, the Slack message history, and the ability to post. Reads are available over A2A; posting is not, because a shared bearer credential must not be enough to speak in this workspace. The bot token is never returned by any operation.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_SLACK_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "slack-channel",
        name: "Slack channel",
        description:
          "Report on Slack connectivity and message history. Posting is deliberately not offered: slack.post, slack.notify and slack.send are refused by name. The credential is never disclosed, only whether one is configured and where it came from.",
        tags: ["slack", "read-only", "no-credential-disclosure"],
        examples: [
          "Is Slack connected?",
          "How many Slack messages have been recorded?",
          "What were the last few message subjects?",
        ],
      },
    ],
  };
}
/* ------------------------------ plumbing --------------------------------- */

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<string, unknown>)[Symbol.asyncIterator as unknown as string] === "function"
  );
}

/**
 * Build the request handler and transport for one DO instance.
 *
 * The card carries the agent's own URL, and the SDK validates the incoming
 * JSON-RPC request against that card. So the handler must be built with the
 * origin the request actually arrived on - a hard-coded or placeholder origin
 * would make the card disagree with the endpoint a client called, and the SDK
 * would reject it. Hence a handler per request rather than one per instance.
 */
/**
 * Card for the QA capability.
 *
 * The exposure is stated on the card rather than left to be inferred: qa.check makes
 * this Worker launch a real browser against a URL the caller chooses. That is the same
 * shape as server-side request forgery, bounded by the bearer credential and the
 * http(s) scheme check, and a caller holding the credential can direct the browse.
 */
export function qaCard(origin: string): AgentCard {
  return {
    name: "CFmail QA Agent",
    description:
      "Runs browser checks against a URL and reports whether it loaded and whether expected text is present, with a screenshot. qa.check directs this Worker to load a caller-chosen http(s) URL, so it should be treated as a credentialed, outbound-capable operation rather than a read. qa.ux_audit runs the deterministic UX audit (WCAG contrast, target size, headings, layout, alt text) over a caller-supplied spec of pages on one origin, with optional header or localStorage auth for the target app. The spec may also crawl same-origin links (breadth-first, capped) and apply per-page click steps before measuring.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_QA_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "browser-qa",
        name: "Browser QA",
        description:
          "Load an http(s) URL in a real browser and report pass/fail for the expected strings, plus a screenshot. qa.dashboard checks this Worker's own dashboard. qa.ux_audit audits a web app's rendered pages against UX rules from a caller-supplied spec. qa.investigate hands the agent a question and a start URL and lets its model drive the browser (navigate, click, type, inspect) to answer it. qa.browser_profile manages a persistent browser profile (start/status/stop) whose signed-in session audits and investigations can reuse. All operations require a bearer token.",
        tags: ["qa", "browser", "outbound", "write"],
        examples: [
          "Check that https://example.com loads and contains Welcome.",
          "Does the dashboard still render?",
          "Audit https://example.com for accessibility and UX issues.",
        ],
      },
    ],
  };
}
/**
 * Card for the voice channel (issue #168): the Public.com desk by
 * voice. voice.ask runs the desk's own pipeline - the same guard
 * rails as the typed chat apply, so an order-placing call becomes an
 * approval-gated proposal, never an execution. The card says so.
 */
export function voiceCard(origin: string): AgentCard {
  return {
    name: "CFmail Voice Agent",
    description:
      "The Public.com Autopilot Trading Desk by voice: spoken questions are transcribed (Workers AI), answered by the desk pipeline over live Public.com data, and spoken back. voice.ask runs the same pipeline for A2A callers and returns the speakable answer. Trades are never executed from a voice or A2A turn - order-placing calls become proposals a human approves in the dashboard.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_VOICE_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "voice-desk",
        name: "Voice desk",
        description:
          "Ask the Public.com desk a question (voice.ask) and get the speakable answer, or read the conversation snapshot. All operations require a bearer <redacted>",
        tags: ["voice", "public", "read"],
        examples: [
          "Compare NVDA and AMD for a covered call.",
          "What is in my portfolio?",
        ],
      },
    ],
  };
}
/**
 * Card for the orchestrator (issue #180): the coordination layer.
 * It plans a goal into steps across the other agents, dispatches
 * each step through that agent's own A2A handler (so every gate -
 * payment claims, trade approvals, QA read-only - applies
 * unchanged), supervises results, and merges one report. It does
 * no domain work itself and holds no other agent's credentials.
 */
export function orchestratorCard(origin: string): AgentCard {
  return {
    name: "CFmail Orchestrator Agent",
    description:
      "Multi-agent orchestration: give it a goal and it plans steps across the email, payments, webhook, Slack, QA, chat, voice, search, and host agents, runs independent steps in parallel, retries a failed step once before reporting it by name, and returns one merged report. Jobs persist and are listable. Two modes: plan (the validated plan executes as computed) and supervise (the model reviews results between execution waves and may revise the remaining steps, within hard bounds). Dispatch goes through each agent's own A2A handler, so no agent's gates are bypassed.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_ORCHESTRATOR_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "multi-agent-orchestration",
        name: "Multi-agent orchestration",
        description:
          "orchestrator.run plans and executes a goal across the other agents; orchestrator.jobs lists recent jobs. Steps run only operations from the published catalog, through each agent's own handler and gates. Long jobs (browser QA steps) take minutes.",
        tags: ["orchestration", "agents", "planning"],
        examples: [
          "Summarize the state of every agent",
          "QA-check the dashboard and search the knowledge base for the approval policy",
        ],
      },
    ],
  };
}
/**
 * Card for the search capability (issue #170): retrieval over the
 * owner's own AI Search index. The disclosure is stated plainly:
 * search.query returns chunks of the indexed content itself, so a
 * caller with the credential reads what the owner indexed - the
 * index is the owner's data, exposed to their own callers.
 */
export function searchCard(origin: string): AgentCard {
  return {
    name: "CFmail Search Agent",
    description:
      "Retrieval over the owner's knowledge base, indexed by Cloudflare AI Search (website, R2, or uploaded files). search.query returns the retrieved chunks; search.ask returns a grounded answer with the chunks behind it. The agent reports honestly when no instance is configured yet.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_SEARCH_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "knowledge-search",
        name: "Knowledge search",
        description:
          "Search the owner's indexed content (search.query) or ask it a question (search.ask). Returned chunks are the indexed content itself - a disclosure of the owner's own data to a credential holder. All operations require a bearer <redacted>",
        tags: ["search", "retrieval", "read"],
        examples: [
          "How are trade proposals approved?",
          "What does the QA summary email contain?",
        ],
      },
    ],
  };
}
/**
 * Card for the chat channel.
 *
 * States the disclosure plainly. Most operations here are counts and sender names,
 * but chat.transcript returns the contents of a private exchange. A caller reading
 * this card should know that a transcript is a disclosure and not a summary.
 */
export function chatCard(origin: string): AgentCard {
  return {
    name: "CFmail Chat Agent",
    description:
      "Owns per-sender conversation history for the chat channel. Reports counts and sender names freely; chat.transcript returns one named sender's conversation, which is a disclosure of private exchange contents.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_CHAT_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "chat-channel",
        name: "Chat channel",
        description:
          "Report on conversation history, return one sender's transcript, or clear it. The transcript is a disclosure: it returns message contents, and it requires naming the sender rather than defaulting. All operations require a bearer credential.",
        tags: ["chat", "history", "disclosure-on-request"],
        examples: [
          "How many conversations are recorded?",
          "Show me the transcript for dashboard.",
        ],
      },
    ],
  };
}
export function createA2ATransport(
  sql: SqlStorage,
  origin: string,
  card: AgentCard,
  capability: A2ACapability,
) {
  const store = new AgentTaskStore(sql);
  const executor = new CapabilityExecutor(capability);
  const handler = new DefaultRequestHandler(card, store, executor);
  return { handler, transport: new JsonRpcTransportHandler(handler), store };
}

/**
 * Handle one JSON-RPC call and return a plain JSON value.
 *
 * The SDK returns an async iterable when the method streams. That cannot cross
 * a Durable Object RPC boundary: SerializableReturnValue permits only
 * primitives, plain objects and arrays, so an iterable is rejected. This
 * collects the stream into an array of the events, which is serializable, and
 * the caller decides whether to frame them as SSE.
 */
export async function handleCollecting(
  transport: JsonRpcTransportHandler,
  body: unknown,
): Promise<{ streamed: boolean; events: unknown[]; result?: unknown }> {
  const result = await transport.handle(body as never);
  if (isAsyncIterable(result)) {
    const events: unknown[] = [];
    for await (const event of result as AsyncIterable<unknown>) events.push(event);
    return { streamed: true, events };
  }
  return { streamed: false, events: [], result };
}

/** SSE frame writer, matching the example's format. */
export function streamFromAsyncIterable(iterable: AsyncIterable<unknown>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  void (async () => {
    try {
      for await (const event of iterable) {
        await writer.write(encoder.encode(`id: ${Date.now()}\ndata: ${JSON.stringify(event)}\n\n`));
      }
    } catch {
      // A broken client is not an error worth propagating.
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export { isAsyncIterable };
