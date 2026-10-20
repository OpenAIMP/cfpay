/**
 * The self-describing A2A operation table (issue #258).
 *
 * Every agent card served at /a2a/<agent>/agent-card.json and
 * /.well-known/agent-card.json carries an `operations` array generated
 * from this table, so a caller reading only the card knows every
 * operation the surface supports and exactly what inputs each one
 * requires. One source of truth: tests/a2a-ops.test.ts pins this table
 * against the implemented operation set (the MCP spec in
 * src/mcp-agent-tools.ts) and against the card builders, so the
 * documentation cannot drift from the code.
 *
 * Pure and SDK-free: no cloudflare: imports, no agent runtime.
 *
 * Access classes match src/mcp-agent-tools.ts:
 *   read   - returns state or an answer; no durable mutation.
 *   action - performs work (browser QA runs, hunts) but mutates no
 *            business state.
 *   write  - mutates durable state or sends/spends externally.
 *
 * Conventions for the inputs (verified against each agent's own arg
 * parsing, not guessed):
 *   - `required: true` means the handler refuses without it
 *     (missing_* / invalid_* / bad_* outcome).
 *   - `required: false` means the handler proceeds without it
 *     (a default applies, or the field is a filter).
 *   - `type: "json"` means the tester/ caller passes a JSON value
 *     (array or object); the hint shows the shape.
 */

export interface A2aOpInput {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  required: boolean;
  hint?: string;
}

export interface A2aOpSpec {
  operation: string;
  summary: string;
  access: "read" | "write" | "action";
  inputs: A2aOpInput[];
}

/** The 12 A2A surfaces, matching src/a2a.ts A2A_FLEET and the MCP agent keys. */
export type A2aSurfaceKey =
  | "cfmail"
  | "payments"
  | "email"
  | "webhook"
  | "slack"
  | "qa"
  | "chat"
  | "voice"
  | "search"
  | "orchestrator"
  | "scheduled"
  | "autopilot";

/** Dispatch path per surface (webhook's key is singular, its path is not). */
export const A2A_SURFACE_RPC: Record<A2aSurfaceKey, string> = {
  cfmail: "/a2a",
  payments: "/a2a/payments",
  email: "/a2a/email",
  webhook: "/a2a/webhooks",
  slack: "/a2a/slack",
  qa: "/a2a/qa",
  chat: "/a2a/chat",
  voice: "/a2a/voice",
  search: "/a2a/search",
  orchestrator: "/a2a/orchestrator",
  scheduled: "/a2a/scheduled",
  autopilot: "/a2a/autopilot",
};

const s = (
  name: string,
  type: A2aOpInput["type"],
  required: boolean,
  hint?: string,
): A2aOpInput => ({ name, type, required, hint });

export const A2A_OPS: Record<A2aSurfaceKey, A2aOpSpec[]> = {
  cfmail: [
    {
      operation: "chat.summary",
      summary: "The host agent's own summary (model-generated).",
      access: "read",
      inputs: [s("question", "string", false, "Optional question; the message text part is the fallback.")],
    },
    {
      operation: "chat.facts",
      summary: "Mailbox facts held by the host agent (no model in the path).",
      access: "read",
      inputs: [],
    },
    {
      operation: "chat.send",
      summary: "Send a message through the host agent's chat and get its reply.",
      access: "write",
      inputs: [s("message", "string", true, "The message; the message text part is the fallback.")],
    },
    {
      operation: "desk.hunt",
      summary: "Run a budget-bounded defined-risk opportunity hunt (heavyweight; places no orders).",
      access: "action",
      inputs: [
        s("budget", "number", true, "Budget in dollars, positive."),
        s("maxRiskPct", "number", false, "Per-trade risk cap as percent of budget (default 2)."),
        s("maxUnderlyingPct", "number", false, "Per-underlying risk cap as percent of budget (default 25)."),
        s("horizonDays", "number", false, "Hunt horizon in days."),
        s("symbols", "json", false, 'Underlying symbols to restrict to, e.g. ["NVDA", "AMD"].'),
      ],
    },
    {
      operation: "desk.autopilot",
      summary: "Deep multi-step research answer via the autopilot pipeline.",
      access: "action",
      inputs: [s("goal", "string", true, "The goal or question; 'question' and the message text part are fallbacks.")],
    },
    {
      operation: "identity.loopMetrics",
      summary:
        "R0 loop-metrics summary (issue #241): per-operation success/failure rates, failure recurrences, and recording coverage over the caller's own tenant accounting stream. The tenant is the caller's resolved tenant, never an input.",
      access: "read",
      inputs: [
        s("from", "string", false, "ISO-8601 window start; default is all recorded events."),
        s("to", "string", false, "ISO-8601 window end."),
      ],
    },
    {
      operation: "desk.portfolio",
      summary: "Read the account's current Public.com portfolio positions (read-only holdings seam; places no orders).",
      access: "read",
      inputs: [],
    },
    {
      operation: "desk.funding",
      summary:
        "Read the account's brokerage funding movements (deposits/withdrawals) from the Public read surface (issue #242 P3.1). Reports observable:false when the account offers no funding/activity feed - movements are then unobservable and none are invented. Read-only; records nothing.",
      access: "read",
      inputs: [],
    },
  ],

  payments: [
    {
      operation: "ledger.summary",
      summary: "Payments ledger summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "payments.list",
      summary: "List payment records.",
      access: "read",
      inputs: [
        s("direction", "string", false, "Direction filter."),
        s("limit", "number", false, "Max records (default 20, cap 100)."),
      ],
    },
    {
      operation: "payments.totals",
      summary: "Payment totals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "funding.list",
      summary: "List recorded brokerage funding movements (issue #242 P3.1), newest first.",
      access: "read",
      inputs: [s("limit", "number", false, "Max records (default 50, cap 200).")],
    },
    {
      operation: "funding.totals",
      summary:
        "Funding position from the recorded ledger: deposits, withdrawals, net for the named tenant (or this instance's whole book). Zero state when nothing is recorded.",
      access: "read",
      inputs: [s("tenantId", "string", false, "Tenant to total; default is the instance's own book.")],
    },
    {
      operation: "funding.record",
      summary:
        "Record brokerage funding movements into the funding ledger with objective attribution (issue #242 P3.1). Idempotent on each movement's source reference. Recording only - executes no payment, checkout, or transfer.",
      access: "write",
      inputs: [
        s("records", "json", true, "FundingRecord array: movements (sourceRef, direction, amount, currency, ts) each with attribution {tenantId, objectiveId, goal}."),
      ],
    },
    {
      operation: "payment.process",
      summary: "Process a payment request (refuses without a verified claim or card reference).",
      access: "write",
      inputs: [
        s("email", "string", true, "Email address the payment request belongs to."),
        s("request", "string", true, "The payment request text / id."),
        s("claim", "string", false, "A verified payment claim reference. One of claim or card is required."),
        s("card", "string", false, "A card payment reference. One of claim or card is required."),
      ],
    },
    {
      operation: "checkout.create",
      summary: "Create an x402 checkout.",
      access: "write",
      inputs: [
        s("requestId", "string", true, "The checkout request id."),
        s("email", "string", true, "Email address the payment request belongs to."),
        s("request", "string", true, "The payment request text / id."),
      ],
    },
    {
      operation: "checkout.status",
      summary: "A checkout's status.",
      access: "read",
      inputs: [s("requestId", "string", true, "The checkout request id.")],
    },
    {
      operation: "checkout.fulfil",
      summary: "Fulfil a checkout after payment.",
      access: "write",
      inputs: [
        s("requestId", "string", true, "The checkout request id."),
        s("paymentIntentId", "string", true, "The Stripe payment intent id."),
      ],
    },
  ],

  email: [
    {
      operation: "email.summary",
      summary: "Email agent summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "email.totals",
      summary: "Email totals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "email.list",
      summary: "List email records (subjects and metadata, not bodies).",
      access: "read",
      inputs: [
        s("direction", "string", false, "Direction filter."),
        s("limit", "number", false, "Max records (default 20, cap 100)."),
      ],
    },
    {
      operation: "email.quota",
      summary: "The email send quota.",
      access: "read",
      inputs: [],
    },
    {
      operation: "email.send",
      summary: "Send an email through the email agent (its quota and self-send rules apply).",
      access: "write",
      inputs: [
        s("to", "string", true, "Recipient email address."),
        s("subject", "string", true, "Email subject."),
        s("body", "string", true, "Email body (plain text)."),
      ],
    },
    {
      operation: "email.sendWithAttachments",
      summary: "Send an email with attachments (the agent's attachment caps apply).",
      access: "write",
      inputs: [
        s("to", "string", true, "Recipient email address."),
        s("subject", "string", true, "Email subject."),
        s("body", "string", true, "Email body (plain text)."),
        s("attachments", "json", true, 'Array of {filename, type, base64} records.'),
      ],
    },
  ],

  webhook: [
    {
      operation: "webhook.summary",
      summary: "Webhook event summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "webhook.totals",
      summary: "Webhook totals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "webhook.list",
      summary: "List webhook events (payloads omitted).",
      access: "read",
      inputs: [
        s("provider", "string", false, "Provider filter: github, stripe, slack."),
        s("limit", "number", false, "Max records (default 20, cap 100)."),
      ],
    },
    {
      operation: "webhook.receive",
      summary: "Record an inbound webhook event as a2a-sourced (no signature is verified).",
      access: "write",
      inputs: [
        s("provider", "string", true, "Must be github, stripe, or slack."),
        s("eventType", "string", false, "Webhook event type (default: a2a)."),
        s("payload", "json", false, "The webhook event payload (recorded as-is, never verified)."),
        s("agentName", "string", false, "Optional agent name (default: external)."),
      ],
    },
  ],

  slack: [
    {
      operation: "slack.summary",
      summary: "Slack agent summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "slack.totals",
      summary: "Slack totals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "slack.status",
      summary: "Slack connection status.",
      access: "read",
      inputs: [],
    },
    {
      operation: "slack.list",
      summary: "List Slack message records (subjects and metadata, not bodies).",
      access: "read",
      inputs: [s("limit", "number", false, "Max records (default 20, cap 100).")],
    },
    {
      operation: "slack.post",
      summary:
        "Post to Slack. Aliases slack.notify and slack.send are the same operation. With a channel argument the post goes through the bot token; without one it goes through the incoming webhook.",
      access: "write",
      inputs: [
        s("text", "string", true, "Message text; 'message' is accepted as an alias."),
        s("channel", "string", false, "Slack channel id. Omit to post via the incoming webhook."),
      ],
    },
    {
      operation: "slack.postFile",
      summary:
        "Upload a file (for example a PDF) into a Slack channel through the bot, using the three-step external upload.",
      access: "write",
      inputs: [
        s("channel", "string", true, "Slack channel id to upload into."),
        s("filename", "string", true, "Filename Slack shows for the upload."),
        s("contentB64", "string", true, "File bytes, base64; 'contentBase64' is accepted as an alias."),
        s("title", "string", false, "File title (defaults to the filename)."),
        s("initial_comment", "string", false, "Message posted above the file; 'text' is accepted as an alias."),
      ],
    },
  ],

  qa: [
    {
      operation: "qa.summary",
      summary: "QA agent summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "qa.check",
      summary: "Run QA checks against a URL (slow; real browser).",
      access: "action",
      inputs: [
        s("url", "string", true, "An http(s) URL."),
        s("checks", "json", false, "Check names to run, e.g. [\"title\", \"no-console-errors\"]."),
      ],
    },
    {
      operation: "qa.ux_audit",
      summary: "Run a UX audit from a caller-supplied spec (slow; real browser).",
      access: "action",
      inputs: [
        s(
          "spec",
          "json",
          true,
          'Audit spec object with at least one page URL: {"pages": [{"url": "https://..."}]}. Credentials ride in spec.auth and are never stored.',
        ),
      ],
    },
    {
      operation: "qa.investigate",
      summary: "Investigate a question with a real browser driven by the agent's model (slow).",
      access: "action",
      inputs: [
        s("question", "string", true, "The question to investigate."),
        s("url", "string", true, "The starting http(s) URL."),
        s("profile", "boolean", false, "Reuse the persistent browser profile's signed-in session."),
      ],
    },
    {
      operation: "qa.dashboard",
      summary: "Verify this Worker's own dashboard end to end (slow; real browser).",
      access: "action",
      inputs: [],
    },
    {
      operation: "qa.browser_profile",
      summary: "Inspect the persistent browser profile.",
      access: "action",
      inputs: [s("action", "string", false, "One of status, start, stop (default: status).")],
    },
  ],

  chat: [
    {
      operation: "chat.summary",
      summary: "Conversation history summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "chat.totals",
      summary: "Conversation totals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "chat.transcript",
      summary: "One sender's transcript (a disclosure of message contents).",
      access: "read",
      inputs: [s("senderId", "string", true, "The conversation sender id; named explicitly, never defaulted.")],
    },
    {
      operation: "chat.emailTranscript",
      summary: "Email one sender's transcript.",
      access: "write",
      inputs: [
        s("senderId", "string", true, "The conversation sender id."),
        s("to", "string", true, "Recipient email address."),
        s("subject", "string", false, "Email subject."),
      ],
    },
    {
      operation: "chat.clear",
      summary: "Clear one sender's conversation history. Destructive.",
      access: "write",
      inputs: [s("senderId", "string", true, "The conversation sender id.")],
    },
  ],

  voice: [
    {
      operation: "voice.snapshot",
      summary: "Voice channel state (counts only).",
      access: "read",
      inputs: [],
    },
    {
      operation: "voice.ask",
      summary: "Ask the desk a question through the voice agent; returns the speakable answer.",
      access: "read",
      inputs: [s("question", "string", true, "The question to ask.")],
    },
  ],

  search: [
    {
      operation: "search.summary",
      summary: "Search agent summary (reports honestly when the AI Search instance is missing).",
      access: "read",
      inputs: [],
    },
    {
      operation: "search.query",
      summary: "Retrieve chunks from the owner's AI Search index.",
      access: "read",
      inputs: [
        s("query", "string", true, "The search query."),
        s("limit", "number", false, "Max chunks to return."),
      ],
    },
    {
      operation: "search.ask",
      summary: "Ask the index a question; returns a grounded answer with chunks.",
      access: "read",
      inputs: [s("query", "string", true, "The search query.")],
    },
  ],

  orchestrator: [
    {
      operation: "orchestrator.summary",
      summary: "Orchestrator summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "orchestrator.jobs",
      summary: "Recent orchestration jobs (most recent 10).",
      access: "read",
      inputs: [],
    },
    {
      operation: "orchestrator.run",
      summary: "Plan and run a goal across the agents. Can take minutes when browser steps are involved.",
      access: "write",
      inputs: [
        s("goal", "string", true, "The goal text."),
        s("mode", "string", false, "plan (default) or supervise."),
      ],
    },
  ],

  scheduled: [
    {
      operation: "scheduled.summary",
      summary: "Scheduler summary.",
      access: "read",
      inputs: [],
    },
    {
      operation: "scheduled.list",
      summary: "List the standing goals.",
      access: "read",
      inputs: [],
    },
    {
      operation: "scheduled.create",
      summary: "Create a recurring goal on a native schedule.",
      access: "write",
      inputs: [
        s("goal", "string", true, "The standing goal text."),
        s("cron", "string", true, "5-field cron (UTC) or an @alias."),
      ],
    },
    {
      operation: "scheduled.once",
      summary: "Create a one-shot goal.",
      access: "write",
      inputs: [
        s("goal", "string", true, "The goal text."),
        s("at", "string", false, "ISO-8601 fire time, or a +2m / +1h / +3d offset. One of at or delaySeconds is required."),
        s("delaySeconds", "number", false, "Fire this many seconds from now (alternative to at)."),
      ],
    },
    {
      operation: "scheduled.trigger",
      summary: "Run an existing goal immediately.",
      access: "write",
      inputs: [s("id", "string", true, "The scheduled goal id.")],
    },
    {
      operation: "scheduled.setEnabled",
      summary: "Arm or cancel a goal's schedule (the row is kept).",
      access: "write",
      inputs: [
        s("id", "string", true, "The scheduled goal id."),
        s("enabled", "boolean", true, "True arms the schedule, false cancels it."),
      ],
    },
    {
      operation: "scheduled.delete",
      summary: "Delete a standing goal. Destructive.",
      access: "write",
      inputs: [s("id", "string", true, "The scheduled goal id.")],
    },
  ],

  autopilot: [
    {
      operation: "autopilot.summary",
      summary: "Autopilot summary: objective, arming state, cycle counts.",
      access: "read",
      inputs: [],
    },
    {
      operation: "autopilot.objective.get",
      summary: "Show the standing portfolio objective.",
      access: "read",
      inputs: [],
    },
    {
      operation: "autopilot.objective.set",
      summary: "Set the portfolio objective and arm its discovery cadence.",
      access: "write",
      inputs: [
        s("goal", "string", true, "The portfolio objective (max 500 chars)."),
        s("budget", "number", true, "Budget in dollars, positive, at most $100M."),
        s("cadenceCron", "string", false, "5-field cron (UTC); default weekdays 14:00 UTC (0 14 * * 1-5)."),
        s("symbols", "json", false, 'Ticker universe, e.g. ["NVDA", "AMD"] (max 20).'),
        s("notifyEmail", "string", false, "Email address for autopilot recommendation reports."),
      ],
    },
    {
      operation: "autopilot.objective.clear",
      summary: "Clear the portfolio objective and cancel its schedule. Destructive.",
      access: "write",
      inputs: [],
    },
    {
      operation: "autopilot.cycles",
      summary: "Recent autopilot discovery cycles.",
      access: "read",
      inputs: [s("limit", "number", false, "Max cycles to return.")],
    },
    {
      operation: "autopilot.runCycle",
      summary: "Run one autopilot discovery cycle now (heavyweight hunt + notifications).",
      access: "action",
      inputs: [],
    },
    {
      operation: "autopilot.proposals",
      summary: "Recent persisted rebalance proposals: target vs current holdings with delta actions and reasons. Review records only - nothing is executed.",
      access: "read",
      inputs: [s("limit", "number", false, "Max proposals to return.")],
    },
    {
      operation: "autopilot.funding",
      summary:
        "Recorded funding position for the objective, read from PaymentsAgent's funding ledger at read time (issue #242 P3.1): totals plus recent movements. Explicit zero state when nothing is recorded.",
      access: "read",
      inputs: [s("limit", "number", false, "Max recorded movements to return.")],
    },
    {
      operation: "autopilot.fundingSync",
      summary:
        "Read the account's funding movements from the host's Public surface and record them in PaymentsAgent's ledger, attributed to the objective (issue #242 P3.1). Idempotent; reports unobservable when the account offers no funding feed. Recording only - initiates no transfer and moves no money.",
      access: "action",
      inputs: [],
    },
    {
      operation: "autopilot.submitProposal",
      summary:
        "Stage a persisted rebalance proposal's delta actions as trade proposals in the EXISTING human-approval trade workflow (issue #242 P3.2): each staged action becomes a pending trade proposal a human approves or rejects in the dashboard, and the proposal-to-trade attribution is recorded. AutopilotAgent gains no execution path; refuses when trading is disabled on the deployment. Idempotent per proposal.",
      access: "action",
      inputs: [s("proposalId", "string", true, "The persisted rebalance proposal id (see autopilot.proposals).")],
    },
    {
      operation: "autopilot.executions",
      summary:
        "Execution attribution for staged rebalance proposals (issue #242 P3.2): per staged action, the trade proposal id, the human decision (pending/approved/rejected/expired), and the execution outcome, refreshed from the host's trade ledger at read time.",
      access: "read",
      inputs: [s("limit", "number", false, "Max attribution records to return.")],
    },
    {
      operation: "autopilot.chain",
      summary:
        "End-to-end attribution chain (issue #242 P3.3): the objective, cycles, funding position, latest rebalance proposal, and its execution attribution in ONE read - each stage linked by id, honest empty states, executions in last recorded state (refresh via autopilot.executions).",
      access: "read",
      inputs: [],
    },
  ],
};

/**
 * Read the A2A operation name out of a request body, mirroring how the
 * agents route it: the data part's `operation` first, then the text part.
 * Returns null when no operation can be determined. SDK-free.
 */
export function a2aOperationFromBody(body: unknown): string | null {
  try {
    const parts = (body as { params?: { message?: { parts?: unknown[] } } })
      ?.params?.message?.parts;
    if (!Array.isArray(parts)) return null;
    for (const p of parts) {
      const op = (p as { kind?: string; data?: { operation?: unknown } })
        ?.data?.operation;
      if ((p as { kind?: string })?.kind === "data" && typeof op === "string" && op) {
        return op;
      }
    }
    for (const p of parts) {
      const t = (p as { kind?: string; text?: unknown })?.text;
      if ((p as { kind?: string })?.kind === "text" && typeof t === "string" && t.trim()) {
        return t.trim();
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * The access class of a qa operation, or null when unknown. The /a2a/qa
 * branch gates user-tenant callers to read-class operations only (per-tenant
 * QA is a named P4); unknown operations deny by default.
 */
export function qaOperationAccess(op: string | null): A2aOpSpec["access"] | null {
  if (!op) return null;
  const spec = A2A_OPS.qa.find((s) => s.operation === op);
  return spec ? spec.access : null;
}
