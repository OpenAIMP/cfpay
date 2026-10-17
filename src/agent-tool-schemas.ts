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
/** QA capability operations. qa.check directs the Worker to load a caller-chosen URL,
 * and qa.ux_audit does the same for a whole target spec (issue #94, step 3). */
export const qaAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["qa.summary", "qa.check", "qa.dashboard", "qa.ux_audit", "qa.investigate"],
      description: "Which QA operation to perform.",
    },
    url: { type: "string", description: "http(s) URL to load. Required for qa.check; the start URL for qa.investigate." },
    question: { type: "string", description: "What to investigate, in plain language. Required for qa.investigate (max 500 chars)." },
    checks: {
      type: "object",
      properties: {
        textContains: { type: "array", items: { type: "string" }, description: "Strings that must appear in the page text." },
      },
      description: "Assertions for qa.check.",
    },
    spec: {
      type: "object",
      properties: {
        pages: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  url: { type: "string" },
                  steps: {
                    type: "array",
                    items: { type: "object", properties: { click: { type: "string" } }, required: ["click"] },
                    description: "Clicks applied to the page before it is measured (max 5).",
                  },
                },
                required: ["url"],
              },
            ],
          },
          description: "Pages to audit: absolute http(s) URLs on one origin, max 8; an entry may be { url, steps } to click through states first. Required for qa.ux_audit.",
        },
        crawl: {
          type: "object",
          properties: {
            maxPages: { type: "integer", description: "Total pages including seeds (clamped 1-8)." },
            maxDepth: { type: "integer", description: "Link depth from the seeds (clamped 0-2)." },
          },
          description: "Optional same-origin crawl: follow each audited page's links breadth-first and audit those pages too.",
        },
        auth: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["none", "localStorage", "headers"], description: "How the browser gets into the target app." },
            localStorage: { type: "object", description: "Keys seeded on the origin before auditing (mode localStorage)." },
            headers: { type: "object", description: "Headers sent on every request of the session (mode headers)." },
          },
          description: "Target-app auth, if the pages need it. Values are the caller's own; they are passed through, never stored.",
        },
        settleSelector: { type: "string", description: "Audit each page once this selector exists." },
        evidence: { type: "boolean", description: "Capture console errors, failed requests, and Web Vitals per page (default true)." },
        viewports: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, width: { type: "number" }, height: { type: "number" } },
            required: ["name", "width", "height"],
          },
          description: "Measure every page at each viewport (max 3, sizes 320..2560). Findings are labelled per viewport.",
        },
        settleTimeoutMs: { type: "integer", description: "Settle timeout per page in ms (clamped)." },
        rules: { type: "object", description: "Optional rule profile: contrastNormal, contrastLarge, minTargetPx, ignoreSelectors, expectedButtonBg." },
      },
      description: "Target spec for qa.ux_audit, the generalized UX audit.",
    },
  },
  required: ["operation"],
} as const;

/** Chat capability operations. chat.transcript returns conversation contents. */
export const chatAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["chat.summary", "chat.totals", "chat.transcript", "chat.clear"],
      description: "Which chat operation to perform.",
    },
    senderId: {
      type: "string",
      description: "Who the conversation belongs to. Required for chat.transcript and chat.clear.",
    },
  },
  required: ["operation"],
} as const;