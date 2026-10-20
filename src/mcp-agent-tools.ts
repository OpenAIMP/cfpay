/**
 * MCP exposure of every agent operation (issue #173).
 *
 * Pure and SDK-free so vitest covers it; src/mcp.ts turns each spec
 * into a registered MCP tool whose handler dispatches through the
 * owning agent's own A2A handler - the same JSON-RPC message/send
 * body an external A2A caller (or the orchestrator) would use, so
 * every agent's own gates apply unchanged. No operation gets a
 * second, MCP-only implementation.
 *
 * Access classes:
 *   read   - returns state or an answer; no durable mutation.
 *            readOnlyHint is set for these.
 *   action - performs work (browser QA runs) but mutates no
 *            business state; not a write tool for JWT scoping.
 *   write  - mutates durable state or sends/spends externally.
 *            JWT callers need the mcp:tools:write scope for these
 *            (src/mcp-jwt.ts builds WRITE_TOOLS from this table).
 *
 * Deliberate exclusions, recorded here rather than silent:
 *   - Trade DECISIONS stay dashboard-only; the desk tools below
 *     only LIST proposals and hunts.
 *   - Desk ask / hunt RUNS are not exposed: they need the caller's
 *     Public.com session machinery owned by the API layer, and the
 *     MCP surface must not become a second trading entry point.
 */

export type McpAccess = "read" | "action" | "write";

export interface McpFieldDef {
  kind: "string" | "number" | "boolean" | "object" | "array";
  describe: string;
}

export const MCP_FIELDS: Record<string, McpFieldDef> = {
  text: { kind: "string", describe: "Message text; also used as the A2A text part when the operation reads one." },
  message: { kind: "string", describe: "The message to send." },
  question: { kind: "string", describe: "The question to ask." },
  goal: { kind: "string", describe: "The goal text." },
  query: { kind: "string", describe: "The search query." },
  url: { kind: "string", describe: "An http(s) URL." },
  to: { kind: "string", describe: "Recipient email address." },
  subject: { kind: "string", describe: "Email subject." },
  body: { kind: "string", describe: "Email body (plain text)." },
  html: { kind: "string", describe: "Optional HTML email body." },
  from: { kind: "string", describe: "Optional sender address." },
  direction: { kind: "string", describe: "Direction filter where the operation supports one." },
  provider: { kind: "string", describe: "Provider filter (github, stripe, slack)." },
  limit: { kind: "number", describe: "Maximum records to return." },
  budget: { kind: "number", describe: "Budget in dollars for an opportunity hunt (required)." },
  maxRiskPct: { kind: "number", describe: "Per-trade risk cap as percent of budget (default 2)." },
  maxUnderlyingPct: { kind: "number", describe: "Per-underlying risk cap as percent of budget (default 25)." },
  horizonDays: { kind: "number", describe: "Hunt horizon in days." },
  symbols: { kind: "array", describe: "Underlying symbols to restrict the hunt to." },
  senderId: { kind: "string", describe: "The conversation sender id." },
  id: { kind: "string", describe: "The record / goal id." },
  proposalId: { kind: "string", describe: "The persisted rebalance proposal id (see autopilot.proposals)." },
  cron: { kind: "string", describe: "5-field cron (UTC) or an @alias." },
  at: { kind: "string", describe: "ISO-8601 time, or a +2m / +1h / +3d offset (one-shot goals)." },
  delaySeconds: { kind: "number", describe: "Delay in seconds from now (one-shot goals)." },
  enabled: { kind: "boolean", describe: "Enable (arm) or disable (cancel) the goal's schedule." },
  cadenceCron: { kind: "string", describe: "5-field cron (UTC) for the autopilot discovery cadence." },
  notifyEmail: { kind: "string", describe: "Email address for autopilot recommendation reports." },
  mode: { kind: "string", describe: "Orchestrator mode: plan (default) or supervise." },
  channel: { kind: "string", describe: "Slack channel id; omit to post via the incoming webhook." },
  email: { kind: "string", describe: "Email address the payment request belongs to." },
  request: { kind: "string", describe: "The payment request text / id, per the operation." },
  requestId: { kind: "string", describe: "The checkout request id." },
  claim: { kind: "string", describe: "A verified payment claim reference (payment.process)." },
  card: { kind: "string", describe: "A card payment reference (payment.process)." },
  paymentIntentId: { kind: "string", describe: "The Stripe payment intent id (checkout.fulfil)." },
  eventType: { kind: "string", describe: "Webhook event type (webhook.receive)." },
  payload: { kind: "object", describe: "The webhook event payload (webhook.receive)." },
  agentName: { kind: "string", describe: "Optional agent name for webhook.receive." },
  action: { kind: "string", describe: "Sub-action where the operation supports one (qa.browser_profile)." },
  checks: { kind: "array", describe: "Check names for qa.check." },
  spec: { kind: "object", describe: "Audit spec for qa.ux_audit." },
  profile: { kind: "string", describe: "Browser profile name (qa.browser_profile)." },
  attachments: { kind: "array", describe: "Email attachments: records with filename, type, and base64 content." },
};

export interface McpAgentToolSpec {
  /** MCP tool name, e.g. cfpay_email_send. */
  tool: string;
  /** Agent key used in names and the README matrix. */
  agent: string;
  /** Durable Object binding name on the Worker Env. */
  binding: string;
  /** Durable Object instance name, matching src/index.ts routing. */
  instance: string;
  /** The A2A operation dispatched through the agent's handler. */
  operation: string;
  access: McpAccess;
  /** Input fields (keys of MCP_FIELDS). `args`/`text` are implicit. */
  fields: string[];
  blurb: string;
}

function snake(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toLowerCase();
}

/** cfpay_<agent>_<operation>, dropping the operation's agent prefix when it repeats the agent key. */
export function mcpToolName(agent: string, operation: string): string {
  const segments = operation.split(".");
  if (segments[0] === agent) segments.shift();
  return `cfpay_${agent}_${segments.map(snake).join("_")}`;
}

function spec(
  agent: string,
  binding: string,
  instance: string,
  operation: string,
  access: McpAccess,
  fields: string[],
  blurb: string,
): McpAgentToolSpec {
  return { tool: mcpToolName(agent, operation), agent, binding, instance, operation, access, fields, blurb };
}

export const MCP_AGENT_TOOLS: McpAgentToolSpec[] = [
  // host (the CFmail agent itself; chat.* for the channel, desk.* for the analysis pipelines)
  spec("cfmail", "CfmailAgent", "agent", "chat.summary", "read", [], "The host agent's own summary."),
  spec("cfmail", "CfmailAgent", "agent", "chat.facts", "read", [], "Mailbox facts held by the host agent."),
  spec("cfmail", "CfmailAgent", "agent", "chat.send", "write", ["message", "question"], "Send a message through the host agent's chat."),
  // Desk analysis pipelines (#242 P0). action-class like qa.*: heavyweight analysis work,
  // but no orders, no sends, no funds movement - they are report-only.
  spec("cfmail", "CfmailAgent", "agent", "desk.hunt", "action", ["budget", "maxRiskPct", "maxUnderlyingPct", "horizonDays", "symbols"], "Run a budget-bounded defined-risk opportunity hunt (heavyweight analysis; places no orders)."),
  spec("cfmail", "CfmailAgent", "agent", "desk.autopilot", "action", ["goal", "question"], "Deep multi-step research answer to a question via the autopilot pipeline."),
  // R0 loop metrics (issue #241 R0.2, #326): the identity domain is served by the host
  // surface (IdentityAgent is RPC-only, no A2A surface of its own). Read class; the
  // tenant is the caller's resolved tenant inside the handler, so there is no tenant
  // field - and no from/to fields either: the tool returns the caller's full recorded
  // ledger (windowing is an A2A-argument refinement).
  spec("cfmail", "CfmailAgent", "agent", "identity.loopMetrics", "read", [], "R0 loop-metrics summary for the caller's tenant: per-operation success rates, failure recurrences, and recording coverage over the accounting stream."),
  spec("cfmail", "CfmailAgent", "agent", "desk.portfolio", "read", [], "Read the account's current Public.com portfolio positions (read-only holdings seam; places no orders)."),
  // Funding read seam (issue #242 P3.1, #331): the account's brokerage funding
  // movements from the Public read surface. Read class; reports unobservable
  // honestly when the account offers no funding/activity feed.
  spec("cfmail", "CfmailAgent", "agent", "desk.funding", "read", [], "Read the account's brokerage funding movements (deposits/withdrawals) from the Public read surface; observable:false when no funding feed is offered."),

  // email
  spec("email", "EMAIL_AGENT", "email", "email.summary", "read", [], "Email agent summary."),
  spec("email", "EMAIL_AGENT", "email", "email.totals", "read", [], "Email totals."),
  spec("email", "EMAIL_AGENT", "email", "email.list", "read", ["direction", "limit"], "List email records."),
  spec("email", "EMAIL_AGENT", "email", "email.quota", "read", [], "The email send quota."),
  spec("email", "EMAIL_AGENT", "email", "email.send", "write", ["to", "subject", "body", "html", "from"], "Send an email through the email agent (its quota and self-send rules apply)."),
  spec("email", "EMAIL_AGENT", "email", "email.sendWithAttachments", "write", ["to", "subject", "body", "html", "from", "attachments"], "Send an email with attachments (the agent's attachment caps apply)."),

  // payments
  spec("payments", "PAYMENTS_AGENT", "payments", "ledger.summary", "read", [], "Payments ledger summary."),
  spec("payments", "PAYMENTS_AGENT", "payments", "payments.list", "read", ["direction", "limit"], "List payment records."),
  spec("payments", "PAYMENTS_AGENT", "payments", "payments.totals", "read", [], "Payment totals."),
  // Funding ledger (issue #242 P3.1, #331): a separate book inside PaymentsAgent.
  // funding.record is write-class (it writes ledger records) but executes nothing:
  // no payment processing, no checkout, no transfer - records of movements already read.
  spec("payments", "PAYMENTS_AGENT", "payments", "funding.list", "read", ["limit"], "List recorded brokerage funding movements, newest first."),
  spec("payments", "PAYMENTS_AGENT", "payments", "funding.totals", "read", ["tenantId"], "Funding position from the recorded ledger (deposits, withdrawals, net); zero state when nothing is recorded."),
  spec("payments", "PAYMENTS_AGENT", "payments", "funding.record", "write", ["records"], "Record brokerage funding movements with objective attribution (idempotent on source reference; recording only, moves no money)."),
  spec("payments", "PAYMENTS_AGENT", "payments", "payment.process", "write", ["email", "request", "claim", "card"], "Process a payment request (refuses without a verified claim or card reference)."),
  spec("payments", "PAYMENTS_AGENT", "payments", "checkout.create", "write", ["requestId", "email", "request"], "Create an x402 checkout."),
  spec("payments", "PAYMENTS_AGENT", "payments", "checkout.status", "read", ["requestId"], "A checkout's status."),
  spec("payments", "PAYMENTS_AGENT", "payments", "checkout.fulfil", "write", ["requestId", "paymentIntentId"], "Fulfil a checkout after payment."),

  // webhooks
  spec("webhook", "WEBHOOK_AGENT", "webhooks", "webhook.summary", "read", [], "Webhook event summary."),
  spec("webhook", "WEBHOOK_AGENT", "webhooks", "webhook.totals", "read", [], "Webhook totals."),
  spec("webhook", "WEBHOOK_AGENT", "webhooks", "webhook.list", "read", ["provider", "limit"], "List webhook events."),
  spec("webhook", "WEBHOOK_AGENT", "webhooks", "webhook.receive", "write", ["provider", "eventType", "payload", "agentName"], "Record an inbound webhook event."),

  // slack
  spec("slack", "SLACK_AGENT", "slack", "slack.summary", "read", [], "Slack agent summary."),
  spec("slack", "SLACK_AGENT", "slack", "slack.totals", "read", [], "Slack totals."),
  spec("slack", "SLACK_AGENT", "slack", "slack.status", "read", [], "Slack connection status."),
  spec("slack", "SLACK_AGENT", "slack", "slack.list", "read", ["limit"], "List Slack message records."),
  spec("slack", "SLACK_AGENT", "slack", "slack.post", "write", ["text", "channel"], "Post to Slack (channel = bot token, none = incoming webhook)."),
  spec("slack", "SLACK_AGENT", "slack", "slack.notify", "write", ["text", "message", "channel"], "Send a Slack notification."),
  spec("slack", "SLACK_AGENT", "slack", "slack.send", "write", ["text", "message", "channel"], "Send a Slack message."),
  spec("slack", "SLACK_AGENT", "slack", "slack.postFile", "write", ["channel", "filename", "contentB64", "title", "initial_comment"], "Upload a file (for example a PDF) to a Slack channel via the bot."),

  // qa (action class: real browser work, no business-state mutation)
  spec("qa", "QA_AGENT", "qa", "qa.summary", "read", [], "QA agent summary."),
  spec("qa", "QA_AGENT", "qa", "qa.check", "action", ["url", "checks"], "Run QA checks against a URL. Slow (browser)."),
  spec("qa", "QA_AGENT", "qa", "qa.dashboard", "action", [], "Verify the dashboard end to end. Slow (browser)."),
  spec("qa", "QA_AGENT", "qa", "qa.ux_audit", "action", ["url", "spec"], "Run a UX audit. Slow (browser)."),
  spec("qa", "QA_AGENT", "qa", "qa.investigate", "action", ["question", "url"], "Investigate a question with a real browser. Slow."),
  spec("qa", "QA_AGENT", "qa", "qa.browser_profile", "action", ["action", "profile"], "Inspect the persistent browser profile."),

  // chat (conversation history)
  spec("chat", "CHAT_AGENT", "chat", "chat.summary", "read", [], "Conversation history summary."),
  spec("chat", "CHAT_AGENT", "chat", "chat.totals", "read", [], "Conversation totals."),
  spec("chat", "CHAT_AGENT", "chat", "chat.transcript", "read", ["senderId"], "One sender's transcript (a disclosure of message contents)."),
  spec("chat", "CHAT_AGENT", "chat", "chat.emailTranscript", "write", ["senderId", "to", "subject"], "Email one sender's transcript."),
  spec("chat", "CHAT_AGENT", "chat", "chat.clear", "write", ["senderId"], "Clear one sender's conversation history. Destructive."),

  // voice
  spec("voice", "VOICE_AGENT", "desk", "voice.snapshot", "read", [], "Voice channel state."),
  spec("voice", "VOICE_AGENT", "desk", "voice.ask", "read", ["question", "text"], "Ask the desk a question through the voice agent (the desk pipeline answers)."),

  // search
  spec("search", "SEARCH_AGENT", "search", "search.summary", "read", [], "Search agent summary (reports honestly when the AI Search instance is missing)."),
  spec("search", "SEARCH_AGENT", "search", "search.query", "read", ["query", "limit"], "Retrieve chunks from the owner's AI Search index."),
  spec("search", "SEARCH_AGENT", "search", "search.ask", "read", ["query"], "Ask the index a question; returns a grounded answer with chunks."),

  // orchestrator
  spec("orchestrator", "ORCHESTRATOR_AGENT", "orchestrator", "orchestrator.summary", "read", [], "Orchestrator summary."),
  spec("orchestrator", "ORCHESTRATOR_AGENT", "orchestrator", "orchestrator.jobs", "read", ["limit"], "Recent orchestration jobs."),
  spec("orchestrator", "ORCHESTRATOR_AGENT", "orchestrator", "orchestrator.run", "write", ["goal", "mode"], "Plan and run a goal across the agents. Can take minutes when browser steps are involved."),

  // scheduled
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.summary", "read", [], "Scheduler summary."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.list", "read", [], "List the standing goals."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.create", "write", ["goal", "cron"], "Create a recurring goal on a native schedule."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.once", "write", ["goal", "at", "delaySeconds"], "Create a one-shot goal."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.trigger", "write", ["id"], "Run an existing goal immediately."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.setEnabled", "write", ["id", "enabled"], "Arm or cancel a goal's schedule (the row is kept)."),
  spec("scheduled", "SCHEDULED_AGENT", "scheduler", "scheduled.delete", "write", ["id"], "Delete a standing goal. Destructive."),

  // autopilot (the standing portfolio-objective owner, issue #242 P1)
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.summary", "read", [], "Autopilot summary: objective, arming state, cycle counts."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.objective.get", "read", [], "Show the standing portfolio objective."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.objective.set", "write", ["goal", "budget", "cadenceCron", "symbols", "notifyEmail"], "Set the portfolio objective and arm its discovery cadence."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.objective.clear", "write", [], "Clear the portfolio objective and cancel its schedule. Destructive."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.cycles", "read", ["limit"], "Recent autopilot discovery cycles."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.runCycle", "action", [], "Run one autopilot discovery cycle now (heavyweight hunt + notifications)."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.proposals", "read", ["limit"], "Recent persisted rebalance proposals (target vs current, delta actions with reasons; review records only)."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.funding", "read", ["limit"], "Recorded funding position for the objective, read from PaymentsAgent's funding ledger (totals + recent movements; explicit zero state)."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.fundingSync", "action", [], "Sync the account's funding movements from Public into the payments funding ledger, attributed to the objective (idempotent; recording only, moves no money)."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.submitProposal", "action", ["proposalId"], "Stage a rebalance proposal's delta actions as trade proposals in the existing human-approval trade workflow; the attribution is recorded and nothing executes without a human approval there."),
  spec("autopilot", "AUTOPILOT_AGENT", "autopilot", "autopilot.executions", "read", ["limit"], "Execution attribution: rebalance proposal -> trade proposal -> human decision -> execution outcome (refreshed from the host trade ledger)."),
];

/** Names of the write-class tools, for JWT scope enforcement. */
export const MCP_WRITE_TOOL_NAMES: string[] = MCP_AGENT_TOOLS.filter((t) => t.access === "write").map((t) => t.tool);

/** Read-only desk listings (decisions stay dashboard-only). */
export const MCP_DESK_TOOLS = [
  { tool: "cfpay_desk_hunts_list", blurb: "List stored opportunity hunts from the Public.com desk, newest first." },
  { tool: "cfpay_desk_trades_list", blurb: "List trade proposals and their states. Listing only - decisions are made on the dashboard." },
] as const;
