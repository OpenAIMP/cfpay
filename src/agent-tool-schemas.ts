/**
 * Input schemas for the agent tools, as plain JSON Schema.
 *
 * agentTool() wants an AI SDK FlexibleSchema, which is a zod schema in this repo. The
 * capability tools in the Worker's own tool list are declared as JSON Schema, and having
 * two declarations of the same operation is how they drift: one gains an argument, the
 * other does not, and a caller sees a validation error for a field the docs describe.
 *
 * So the JSON Schema is the source and zod is derived. zod 4 converts one to the other,
 * which keeps a single definition per tool.
 */

/** Payments capability operations, mirroring the A2A operation set. */
export const paymentAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["ledger.summary", "payments.list", "payments.totals", "payment.process"],
      description: "Which ledger or fulfilment operation to perform.",
    },
    email: { type: "string", description: "Recipient of the fulfilled request. Required for payment.process." },
    request: { type: "string", description: "The work the payment buys. Required for payment.process." },
    direction: { type: "string", enum: ["received", "sent"], description: "Filter for payments.list." },
    limit: { type: "integer", description: "Max rows, up to 100." },
  },
  required: ["operation"],
} as const;

/** Webhook capability operations. Read-only except receive, which is explicitly unverified. */
export const webhookAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["webhook.summary", "webhook.totals", "webhook.list", "webhook.receive"],
      description: "Which webhook operation to perform.",
    },
    provider: { type: "string", enum: ["github", "stripe", "slack"], description: "Filter, or the source for webhook.receive." },
    eventType: { type: "string", description: "Event type, for webhook.receive." },
    agentName: { type: "string", description: "Who supplied the event, for webhook.receive." },
    limit: { type: "integer", description: "Max rows, up to 100." },
  },
  required: ["operation"],
} as const;

/** Slack capability operations. Reads only: no write operation exists over a network path. */
export const slackAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["slack.summary", "slack.totals", "slack.status", "slack.list"],
      description: "Which Slack read to perform. Posting is not available.",
    },
    limit: { type: "integer", description: "Max rows, up to 100." },
  },
  required: ["operation"],
} as const;
/** QA capability operations. qa.check directs the Worker to load a caller-chosen URL. */
export const qaAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["qa.summary", "qa.check", "qa.dashboard"],
      description: "Which QA operation to perform.",
    },
    url: { type: "string", description: "http(s) URL to load. Required for qa.check." },
    checks: {
      type: "object",
      properties: {
        textContains: { type: "array", items: { type: "string" }, description: "Strings that must appear in the page text." },
      },
      description: "Assertions for qa.check.",
    },
  },
  required: ["operation"],
} as const;
