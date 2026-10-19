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

import { a2aErrorCode, mapUnknownError } from "./errors";
import type { AgentCard, Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
// WS1 aspects (issue #252): the executor strips the private trace part from
// inbound messages and emits one structured event per execution, so a
// multi-agent run shows a single correlationId across all its events.
import {
  type AspectTrace,
  type AspectEnv,
  aspectEventNow,
  emitAspectEvent,
  extractTracePart,
  mintCorrelationId,
} from "./aspect-logging";
import { tenantIdFor, userIdFor } from "./tenancy";
import { A2A_OPS, type A2aOpSpec } from "./a2a-ops";

/** An agent card whose operations are declared machine-readably (issue #258). */
export interface AgentCardWithOps extends AgentCard {
  operations: A2aOpSpec[];
}
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

/** Path that serves the fleet card index (issue #254): every agent's card, enumerated. */
export const A2A_FLEET_INDEX_PATH = "/.well-known/agent-cards.json";

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
export const A2A_SCHEDULED_RPC_PATH = "/a2a/scheduled";
export const A2A_SCHEDULED_CARD_PATH = "/a2a/scheduled/agent-card.json";

export const A2A_AUTOPILOT_RPC_PATH = "/a2a/autopilot";
export const A2A_AUTOPILOT_CARD_PATH = "/a2a/autopilot/agent-card.json";

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
  handle(
    message: Message,
    context: { taskId: string; contextId: string; trace?: AspectTrace },
  ): Promise<CapabilityResult>;
}

/**
 * Executor for any capability.
 *
 * Publishes the A2A lifecycle (submitted, working, message, completed) and
 * delegates the actual answer. It has no tool surface, so a prompt cannot talk
 * it into acting: it can only return text.
 */
export class CapabilityExecutor implements AgentExecutor {
  constructor(
    private capability: A2ACapability,
    private agentName?: string,
    private aspectEnv?: AspectEnv | null,
  ) {}

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

    // WS1 aspects (issue #252, design §2.3): strip the private trace part so
    // it never reaches the capability's prompt, and emit one structured event
    // per execution so a multi-agent run shows a single correlationId.
    const t0 = Date.now();
    const { trace, parts } = extractTracePart((userMessage as { parts?: unknown })?.parts);
    const correlationId = trace?.correlationId ?? mintCorrelationId();
    const tracedMessage = { ...(userMessage as unknown as Record<string, unknown>), parts };
    const execTrace = trace ?? {
      correlationId,
      tenantId: tenantIdFor(),
      userId: userIdFor(),
    };

    let answer: string;
    let resultData: unknown;
    try {
      const handled = await this.capability.handle(tracedMessage as Message, {
        taskId,
        contextId,
        trace: execTrace,
      });
      answer = (handled.text || "").trim();
      resultData = handled.data;
      // Phase 2 of the error catalog (issue #209): a failure's data
      // part carries the stable catalog CODE alongside its error
      // token, so consumers judge failures by code, not prose.
      if (resultData && typeof resultData === "object" && !Array.isArray(resultData)) {
        const d = resultData as { ok?: unknown; error?: unknown; code?: unknown };
        if ((d.ok === false || typeof d.error === "string") && typeof d.code !== "string") {
          resultData = { ...d, code: a2aErrorCode(d.error) };
        }
      }
    } catch (error) {
      answer = "The agent could not answer: " + String(error);
      resultData = { ok: false, error: "agent_error", code: mapUnknownError(error) };
    }
    if (!answer) answer = "The agent produced no answer for that question.";

    // WS1 logging aspect (issue #252, design §2.2): one structured event per
    // execution. The outcome follows the capability's own failure signal
    // (ok:false / error), not the presence of a throw.
    {
      const d = resultData as { ok?: unknown; error?: unknown; code?: unknown } | undefined;
      const failed =
        d !== null &&
        typeof d === "object" &&
        !Array.isArray(d) &&
        (d.ok === false || typeof d.error === "string");
      emitAspectEvent(
        {
          v: 1,
          ts: aspectEventNow(),
          level: failed ? "error" : "info",
          tenantId: execTrace.tenantId,
          userId: execTrace.userId,
          agent: this.agentName ?? "a2a",
          operation: "a2a.execute",
          correlationId,
          durationMs: Date.now() - t0,
          outcome: failed ? "error" : "ok",
          ...(failed && typeof d?.code === "string" ? { errorCode: d.code } : {}),
        },
        this.aspectEnv ?? undefined,
      );
    }

    // Structured outcome, when the capability returned one. A caller that asked
    // for work to be done reads this instead of parsing the prose reply. It is
    // published BEFORE the reply Message on purpose: the SDK's result
    // aggregator treats a Message as the terminal stream event and closes
    // the stream, so anything published after it never reaches a
    // message/stream consumer (verified against the transport - this is
    // why in-process dispatchers read replies via a2aReplyFromOutcome).
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

    const reply: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      taskId,
      contextId,
      parts: [{ kind: "text", text: answer }],
    };
    eventBus.publish(reply);

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
export function paymentsCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Payments Agent",
    description:
      "Owns the CFmail payment ledger and the Pay And Process capability: payments received and sent, Stripe card checkouts, and replay protection for both rails. Reads and writes over A2A.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_PAYMENTS_RPC_PATH,
    operations: A2A_OPS.payments,
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
export function cfmailCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Agent",
    description:
      "The chat channel, the aggregate view, and the desk analysis pipelines. Asks and answers questions about mail, payments and webhook events across this Worker; chat.summary/chat.facts/chat.send are read-only. desk.hunt runs a budget-bounded defined-risk opportunity scan and desk.autopilot runs a multi-step research answer - both heavyweight, report-only pipelines that spend Workers AI tokens and persist records but cannot send mail, post to Slack, move funds, or place orders.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_RPC_PATH,
    operations: A2A_OPS.cfmail,
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
      {
        id: "desk",
        name: "Desk analysis pipelines",
        description:
          "Heavyweight, report-only pipelines over the Public.com desk. desk.hunt runs a budget-bounded defined-risk opportunity scan (args: budget required, maxRiskPct, maxUnderlyingPct, horizonDays, symbols) and desk.autopilot answers a question with the multi-step autopilot research pipeline (args: goal). They spend Workers AI tokens and persist hunt/run records, but they place no orders and send nothing.",
        tags: ["analysis", "hunt", "autopilot", "report-only", "public"],
        examples: [
          "Run a $10,000 SPY opportunity hunt.",
          "Research covered-call candidates on NVDA with the autopilot pipeline.",
        ],
      },
    ],
  };
}
export function emailCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Email Agent",
    description:
      "Owns the CFmail mail resource: message history, outbound sends, and the inbound record path. Other agents send through this. Reads and writes over A2A; sends are rate limited.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_EMAIL_RPC_PATH,
    operations: A2A_OPS.email,
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
export function webhookCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Webhook Agent",
    description:
      "Owns the webhook event log and the GitHub delivery registry that makes redelivery safe. Provider signatures are verified at the Worker edge; this agent receives already-verified payloads. Reads freely over A2A; webhook.receive records an unverified a2a-sourced event only.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_WEBHOOK_RPC_PATH,
    operations: A2A_OPS.webhook,
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
export function slackCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Slack Agent",
    description:
      "Owns the Slack bot token, the Slack message history, and the ability to post. Reads and posting (slack.post) are available over A2A - posting was enabled by the owner's explicit decision (issue #188); the same credential already authorizes email.send. The bot token itself is never returned by any operation.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_SLACK_RPC_PATH,
    operations: A2A_OPS.slack,
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
          "Report on Slack connectivity and message history, and post to Slack (slack.post: with a channel argument via the bot token, without one via the incoming webhook). The credential is never disclosed, only whether one is configured and where it came from.",
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
export function qaCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail QA Agent",
    description:
      "Runs browser checks against a URL and reports whether it loaded and whether expected text is present, with a screenshot. qa.check directs this Worker to load a caller-chosen http(s) URL, so it should be treated as a credentialed, outbound-capable operation rather than a read. qa.ux_audit runs the deterministic UX audit (WCAG contrast, target size, headings, layout, alt text) over a caller-supplied spec of pages on one origin, with optional header or localStorage auth for the target app. The spec may also crawl same-origin links (breadth-first, capped) and apply per-page click steps before measuring.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_QA_RPC_PATH,
    operations: A2A_OPS.qa,
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
export function voiceCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Voice Agent",
    description:
      "The Public.com Autopilot Trading Desk by voice: spoken questions are transcribed (Workers AI), answered by the desk pipeline over live Public.com data, and spoken back. voice.ask runs the same pipeline for A2A callers and returns the speakable answer. Trades are never executed from a voice or A2A turn - order-placing calls become proposals a human approves in the dashboard.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_VOICE_RPC_PATH,
    operations: A2A_OPS.voice,
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
export function orchestratorCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Orchestrator Agent",
    description:
      "Multi-agent orchestration: give it a goal and it plans steps across the email, payments, webhook, Slack, QA, chat, voice, search, and host agents, runs independent steps in parallel, retries a failed step once before reporting it by name, and returns one merged report. Jobs persist and are listable. Two modes: plan (the validated plan executes as computed) and supervise (the model reviews results between execution waves and may revise the remaining steps, within hard bounds). Dispatch goes through each agent's own A2A handler, so no agent's gates are bypassed.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_ORCHESTRATOR_RPC_PATH,
    operations: A2A_OPS.orchestrator,
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
export function searchCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Search Agent",
    description:
      "Retrieval over the owner's knowledge base, indexed by Cloudflare AI Search (website, R2, or uploaded files). search.query returns the retrieved chunks; search.ask returns a grounded answer with the chunks behind it. The agent reports honestly when no instance is configured yet.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_SEARCH_RPC_PATH,
    operations: A2A_OPS.search,
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
export function chatCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Chat Agent",
    description:
      "Owns per-sender conversation history for the chat channel. Reports counts and sender names freely; chat.transcript returns one named sender's conversation, which is a disclosure of private exchange contents.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_CHAT_RPC_PATH,
    operations: A2A_OPS.chat,
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
export interface A2ATransportOpts {
  /** Agent name for the WS1 logging aspect's per-execution events. */
  agentName?: string;
  /** Worker env (for the LOG_ASPECTS kill flag). Absent = aspects on. */
  env?: AspectEnv | null;
}

export function createA2ATransport(
  sql: SqlStorage,
  origin: string,
  card: AgentCard,
  capability: A2ACapability,
  opts?: A2ATransportOpts,
) {
  const store = new AgentTaskStore(sql);
  const executor = new CapabilityExecutor(capability, opts?.agentName, opts?.env);
  const handler = new DefaultRequestHandler(card, store, executor);
  return { handler, transport: new JsonRpcTransportHandler(handler), store };
}

export function scheduledCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Scheduled Agent",
    description:
      "Autonomous scheduling: stores {goal, cron} goals (UTC, 5-field cron plus @hourly/@daily/@weekly/@monthly aliases) and, when one falls due, hands the goal to the OrchestratorAgent through its own A2A handler as an ordinary orchestrator job - every agent's gates apply unchanged. Nothing is seeded: no goal exists and nothing runs until one is created.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_SCHEDULED_RPC_PATH,
    operations: A2A_OPS.scheduled,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "scheduled-goals",
        name: "Scheduled goals",
        description:
          "scheduled.list shows the goals; scheduled.create {goal, cron} adds a recurring one (cron is 5-field UTC or an @alias); scheduled.once {goal, at|delaySeconds} adds a one-shot; scheduled.trigger {id} runs a goal immediately without changing its schedule; scheduled.setEnabled {id, enabled} arms or cancels a goal's schedule (the row is kept); scheduled.delete {id} removes one. Each goal is a native SDK schedule on the agent, woken by a Durable Object alarm; a firing hands the goal to the orchestrator as a job.",
        tags: ["scheduling", "cron", "automation"],
        examples: [
          "List the scheduled goals",
          "Every weekday at 13:00 UTC, summarize the state of qa, search, and slack",
        ],
      },
    ],
  };
}


export function autopilotCard(origin: string): AgentCardWithOps {
  return {
    name: "CFmail Autopilot Agent",
    description:
      "The standing portfolio-objective owner (issue #242): given a goal and a budget it runs defined-risk opportunity-hunt discovery cycles on a cadence, notifies via Slack, and emails the recommendations report. It places no orders and moves no money - proposals go through the human-approved trade workflow.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_AUTOPILOT_RPC_PATH,
    operations: A2A_OPS.autopilot,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "autopilot-objective",
        name: "Portfolio objective",
        description:
          "autopilot.summary reports the objective and cycle counts; autopilot.objective.get shows the objective; autopilot.objective.set {goal, budget, cadenceCron?, symbols?, notifyEmail?} sets it and arms the discovery cadence on the ScheduledAgent (default cron: weekdays 14:00 UTC); autopilot.objective.clear removes it and cancels the schedule; autopilot.cycles {limit?} lists recent discovery cycles; autopilot.runCycle runs one discovery cycle now: a defined-risk hunt on the host, a Slack notification, and an email report when a notify address is set.",
        tags: ["portfolio", "objectives", "autopilot", "discovery"],
        examples: [
          "Is the autopilot objective armed?",
          "Run an autopilot discovery cycle now",
        ],
      },
    ],
  };
}

/**
 * The fleet, as one table (issue #254): agent key, dispatch path, card
 * path, and the card builder itself. The fleet card index is GENERATED
 * from this table and the builders, so an entry's name, description and
 * skills are the card's own - the index cannot drift from the cards it
 * lists. The wiring tests pin this table against the routed paths and
 * against A2A_ENDPOINTS (the QAAgent probe list in src/a2a-test.ts).
 */
export const A2A_FLEET: { agent: string; rpcPath: string; cardPath: string; card: (origin: string) => AgentCard }[] = [
  { agent: "cfmail", rpcPath: A2A_RPC_PATH, cardPath: A2A_CARD_PATHS[0], card: cfmailCard },
  { agent: "payments", rpcPath: A2A_PAYMENTS_RPC_PATH, cardPath: A2A_PAYMENTS_CARD_PATH, card: paymentsCard },
  { agent: "email", rpcPath: A2A_EMAIL_RPC_PATH, cardPath: A2A_EMAIL_CARD_PATH, card: emailCard },
  { agent: "webhook", rpcPath: A2A_WEBHOOK_RPC_PATH, cardPath: A2A_WEBHOOK_CARD_PATH, card: webhookCard },
  { agent: "slack", rpcPath: A2A_SLACK_RPC_PATH, cardPath: A2A_SLACK_CARD_PATH, card: slackCard },
  { agent: "qa", rpcPath: A2A_QA_RPC_PATH, cardPath: A2A_QA_CARD_PATH, card: qaCard },
  { agent: "chat", rpcPath: A2A_CHAT_RPC_PATH, cardPath: A2A_CHAT_CARD_PATH, card: chatCard },
  { agent: "voice", rpcPath: A2A_VOICE_RPC_PATH, cardPath: A2A_VOICE_CARD_PATH, card: voiceCard },
  { agent: "search", rpcPath: A2A_SEARCH_RPC_PATH, cardPath: A2A_SEARCH_CARD_PATH, card: searchCard },
  { agent: "orchestrator", rpcPath: A2A_ORCHESTRATOR_RPC_PATH, cardPath: A2A_ORCHESTRATOR_CARD_PATH, card: orchestratorCard },
  { agent: "scheduled", rpcPath: A2A_SCHEDULED_RPC_PATH, cardPath: A2A_SCHEDULED_CARD_PATH, card: scheduledCard },
  { agent: "autopilot", rpcPath: A2A_AUTOPILOT_RPC_PATH, cardPath: A2A_AUTOPILOT_CARD_PATH, card: autopilotCard },
];

export interface FleetIndexEntry {
  agent: string;
  name: string;
  description: string;
  /** JSON-RPC dispatch endpoint (POST; requires the dashboard key). */
  url: string;
  /** This agent's card (GET; public). */
  cardUrl: string;
  protocolVersion: string;
  skills: string[];
}

/**
 * The fleet card index served at A2A_FLEET_INDEX_PATH: the machine-
 * readable discovery document for every agent in the fleet. Public,
 * like the cards themselves - it carries names, descriptions and URLs,
 * no data. Dispatch still requires the dashboard key.
 */
export function fleetCardIndex(origin: string): { name: string; description: string; version: string; agents: FleetIndexEntry[] } {
  return {
    name: "cfpay agent fleet",
    description:
      "Every A2A agent in the cfpay fleet. Fetch an agent's cardUrl for its full card; POST JSON-RPC to its url to dispatch (the dashboard key is required as a bearer credential or X-API-Key; cards and this index are public).",
    version: "0.1.0",
    agents: A2A_FLEET.map((f) => {
      const card = f.card(origin);
      return {
        agent: f.agent,
        name: card.name,
        description: card.description,
        url: card.url,
        cardUrl: origin + f.cardPath,
        protocolVersion: card.protocolVersion,
        skills: (card.skills || []).map((sk) => sk.id),
      };
    }),
  };
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

/**
 * Extract the reply {text, data} from a handleCollecting outcome -
 * THE way in-process A2A callers must read a dispatch.
 *
 * The transport wraps everything in JSON-RPC envelopes: for
 * message/send the reply Message sits at outcome.result.result
 * (outcome.result is the envelope, not the Message), and the
 * structured data part does not survive that mode at all - it is
 * published as a separate artifact-update event. Callers that need
 * the data (orchestrator steps, scheduled dispatch, MCP tools) must
 * dispatch with message/stream and read the collected events: the
 * reply Message event carries the text, the artifact-update event
 * carries the data. Reading outcome.result.parts directly was the
 * fleet-wide bug this replaces: it silently yielded empty text and
 * no data for every in-process dispatch.
 */
export function a2aReplyFromOutcome(outcome: unknown): { text: string; data?: unknown } {
  const unwrap = (v: unknown): Record<string, unknown> | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const inner = o.result;
    if (inner && typeof inner === "object" && ("kind" in inner || "parts" in inner)) {
      return inner as Record<string, unknown>;
    }
    return o;
  };
  const o = (outcome ?? {}) as { result?: unknown; events?: unknown[] };
  let message = unwrap(o.result);
  let data: unknown;
  if (Array.isArray(o.events)) {
    for (const raw of o.events) {
      const e = unwrap(raw);
      if (!e) continue;
      if (e.kind === "message" && Array.isArray(e.parts)) message = e;
      if (e.kind === "artifact-update") {
        const artifact = e.artifact as { parts?: { kind: string; data?: unknown }[] } | undefined;
        const part = artifact?.parts?.find((p) => p.kind === "data");
        if (part) data = part.data;
      }
    }
  }
  const parts = (Array.isArray(message?.parts) ? message.parts : []) as {
    kind: string;
    text?: string;
    data?: unknown;
  }[];
  const text = parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();
  if (data === undefined) data = parts.find((p) => p.kind === "data")?.data;
  return { text, data };
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
