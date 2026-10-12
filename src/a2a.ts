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
      "Owns the CFmail payment ledger: payments received and sent, Stripe card checkouts, and replay protection for both rails. Read-only over A2A.",
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
          "Report on payments received and sent, by currency and status. Cannot move funds, refund, or create a payment.",
        tags: ["read-only", "payments", "x402", "stripe"],
        examples: [
          "How many payments have been received?",
          "What currencies are on the ledger?",
          "Are there any failed payments?",
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
      "Inspects the state of a CFmail agent: emails it has handled, payments on its ledger, and inbound webhook events. Read-only.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: origin + A2A_RPC_PATH,
    preferredTransport: "JSONRPC",
    capabilities: { pushNotifications: false, stateTransitionHistory: false, streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    provider: { organization: "OpenAIMP", url: origin },
    skills: [
      {
        id: "inspect-state",
        name: "Inspect agent state",
        description:
          "Answer questions about emails handled, payments recorded and webhook events received. Cannot send email, move funds or place trades.",
        tags: ["read-only", "email", "payments", "webhooks"],
        examples: [
          "How many emails has this agent handled?",
          "What payments are on the ledger?",
          "Which webhook providers have sent events recently?",
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
