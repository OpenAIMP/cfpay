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
      enum: ["qa.summary", "qa.check", "qa.dashboard", "qa.ux_audit", "qa.investigate", "qa.browser_profile"],
      description: "Which QA operation to perform.",
    },
    url: { type: "string", description: "http(s) URL to load. Required for qa.check; the start URL for qa.investigate." },
    question: { type: "string", description: "What to investigate, in plain language. Required for qa.investigate (max 500 chars)." },
    action: { type: "string", enum: ["start", "status", "stop"], description: "For qa.browser_profile: manage the persistent browser profile." },
    profile: { type: "boolean", description: "For qa.investigate / qa.ux_audit spec: run inside the persistent browser profile when one is active." },
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
        baselines: { type: "string", enum: ["record", "compare"], description: "Visual baselines: record stores each view's screenshot hash; compare fails on any view whose screenshot changed since recording." },
        profile: { type: "boolean", description: "Run inside the persistent browser profile when one is active (issue #102)." },
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
/** Search capability operations (issue #170): retrieval over the owner's AI Search index. */
export const searchAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["search.summary", "search.query", "search.ask"],
      description: "Which search operation to perform.",
    },
    query: { type: "string", description: "The search query or question. Required for search.query and search.ask." },
    limit: { type: "integer", description: "Max chunks for search.query (1-10, default 5)." },
  },
  required: ["operation"],
} as const;

/** Voice capability operations (issues #168/#173): the spoken desk channel's state and one-question dispatch. */
export const voiceAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["voice.snapshot", "voice.ask"],
      description: "Which voice operation to perform.",
    },
    question: { type: "string", description: "The question to ask the desk. Required for voice.ask." },
  },
  required: ["operation"],
} as const;

/** Autopilot operations (issue #242 P1): the standing portfolio-objective owner. */
export const autopilotAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["autopilot.summary", "autopilot.objective.get", "autopilot.objective.set", "autopilot.objective.clear", "autopilot.cycles", "autopilot.runCycle"],
      description: "Which autopilot operation to perform.",
    },
    goal: { type: "string", description: "The portfolio goal text. Required for autopilot.objective.set." },
    budget: { type: "number", description: "Budget in dollars for hunts. Required for autopilot.objective.set." },
    cadenceCron: { type: "string", description: "5-field cron in UTC for the discovery cadence (default weekdays 14:00 UTC). For autopilot.objective.set." },
    symbols: { type: "array", items: { type: "string" }, description: "Restrict hunts to these underlying symbols. For autopilot.objective.set." },
    notifyEmail: { type: "string", description: "Email the recommendations report to this address. For autopilot.objective.set." },
    limit: { type: "number", description: "Maximum cycles to return. For autopilot.cycles." },
  },
  required: ["operation"],
} as const;

/** Orchestrator operations (issue #180): plan and run a goal across the other agents. */
export const scheduledAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["scheduled.summary", "scheduled.list", "scheduled.create", "scheduled.once", "scheduled.trigger", "scheduled.setEnabled", "scheduled.delete"],
      description: "Which scheduled-goals operation to perform.",
    },
    goal: { type: "string", description: "The goal text. Required for scheduled.create and scheduled.once." },
    cron: { type: "string", description: "5-field cron in UTC, or @hourly/@daily/@weekly/@monthly. Required for scheduled.create." },
    at: { type: "string", description: "For scheduled.once: an ISO-8601 fire time, or a relative offset like +2m / +1h / +3d." },
    delaySeconds: { type: "number", description: "For scheduled.once: fire this many seconds from now (alternative to at)." },
    enabled: { type: "boolean", description: "For scheduled.setEnabled: true arms the schedule, false cancels it (row and cron kept)." },
    id: { type: "string", description: "The scheduled goal id. Required for scheduled.delete, scheduled.trigger, and scheduled.setEnabled." },
  },
  required: ["operation"],
} as const;

export const orchestratorAgentToolSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["orchestrator.summary", "orchestrator.run", "orchestrator.jobs"],
      description: "Which orchestrator operation to perform.",
    },
    goal: { type: "string", description: "The goal to plan and execute. Required for orchestrator.run." },
    limit: { type: "number", description: "Max jobs to list. For orchestrator.jobs (default 10, cap 50)." },
    mode: { type: "string", enum: ["plan", "supervise"], description: "plan (default): execute the validated plan. supervise: the model reviews results between waves and may revise the remaining steps (bounded)." },
  },
  required: ["operation"],
} as const;
