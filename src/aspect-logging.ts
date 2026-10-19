/**
 * WS1 logging aspect (issue #252, design §2.2).
 *
 * One structured JSON event per operation, emitted at the API edge, the
 * A2A dispatch branches, the in-process A2A executor, agent callables, and
 * workflow steps. The event shape is fixed by the design; values are not.
 *
 * SDK-free so Vitest can import it directly.
 *
 * P1 notes (design migration plan §6 step 2):
 * - tenantId/userId are the operator identity until the P3 tenant cutover.
 * - Events ship behind the LOG_ASPECTS kill flag ("0"/"false" disables).
 * - Outcome-class events are ALSO fed to the outcome-ledger seam (§6/#241
 *   R0): one event stream, not two. The #241 R0 store is the named consumer
 *   and plugs in via setOutcomeLedgerSink; until then the feed is a no-op.
 */

export type AspectLevel = "debug" | "info" | "warn" | "error";
export type AspectOutcome = "ok" | "error" | "skipped" | "denied";

export interface AspectTrace {
  correlationId: string;
  tenantId: string;
  userId: string;
  scopeUsed?: string;
}

export interface AspectAuthDecision {
  relation: string;
  object: string;
  allow: boolean;
}

export interface AspectEvent {
  v: 1;
  ts: string;
  level: AspectLevel;
  tenantId: string;
  userId: string;
  agent: string;
  operation: string;
  correlationId: string;
  durationMs: number;
  outcome: AspectOutcome;
  errorCode?: string;
  scopeUsed?: string;
  authDecision?: AspectAuthDecision;
  detail?: unknown;
}

/** Correlation travels in headers and message parts — never in query strings. */
export const CORRELATION_HEADER = "X-Correlation-Id";

/** The env surface the aspects read. Both knobs are config, never secrets. */
export interface AspectEnv {
  /** Kill flag: "0"/"false" disables event emission. Absent = on. */
  LOG_ASPECTS?: string;
  /** Minimum level emitted: debug|info|warn|error. Default info. */
  LOG_LEVEL?: string;
}

const ASPECT_LEVELS: Record<AspectLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * LOG_LEVEL is configuration, never a code change (design §2.2).
 * Unknown values fall back to info.
 */
export function logLevelAllows(env: AspectEnv | undefined | null, level: AspectLevel): boolean {
  const configured = (env?.LOG_LEVEL ?? "info").trim().toLowerCase() as AspectLevel;
  const min = ASPECT_LEVELS[configured] ?? ASPECT_LEVELS.info;
  return ASPECT_LEVELS[level] >= min;
}

export function mintCorrelationId(): string {
  return crypto.randomUUID();
}

/** Honor an incoming correlation id when present, else mint a fresh one. */
export function resolveCorrelationId(request: Request): string {
  const incoming = (request.headers.get(CORRELATION_HEADER) ?? "").trim();
  return incoming ? incoming.slice(0, 128) : mintCorrelationId();
}

/**
 * LOG_ASPECTS is the kill flag (design §6): set it to "0" or "false" to
 * disable event emission. Absent or any other value = on.
 */
export function aspectsEnabled(env: AspectEnv | undefined | null): boolean {
  const v = (env?.LOG_ASPECTS ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Stamp the correlation header on a response; websocket upgrades pass through untouched. */
export function withCorrelationHeader(res: Response, correlationId: string): Response {
  if (res.status === 101 || res.headers.get("Upgrade")) return res;
  const headers = new Headers(res.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* ------------------------------- redaction ------------------------------ */

/** Key-name patterns whose values are never logged (design §2.2 redaction list). */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i,
  /bearer/i,
  /cookie/i,
  /authorization/i,
  /paymentintent/i,
  /card/i,
  /refresh/i,
  /webhook[_-]?url/i,
];

/** Payload keys that are user content: log a length, never the content. */
const PAYLOAD_KEYS = new Set([
  "subject",
  "body",
  "html",
  "attachments",
  "content",
  "prompt",
  "question",
]);

/** Secret-shaped values, redacted wherever they appear in free text. */
const SECRET_VALUE_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bghu_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/g,
  /\bpi_[A-Za-z0-9]{8,}/g,
  /\b4\/[A-Za-z0-9_-]{20,}/g, // Google OAuth authorization code
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // JWT-shaped
];

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out;
}

/**
 * Deep-redact a detail value before emission. Runs on the structured event
 * itself, not as a display filter, so nothing secret-shaped can reach the
 * log stream. Never throws: a redactor failure must not fail the operation.
 */
export function redactDetail(value: unknown, depth = 0): unknown {
  try {
    if (value == null) return value;
    if (typeof value === "string") return redactString(value);
    if (depth > 4) return "[truncated]";
    if (Array.isArray(value)) return value.map((v) => redactDetail(v, depth + 1));
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (PAYLOAD_KEYS.has(k.toLowerCase())) {
          out[k] = typeof v === "string" ? `[omitted:${v.length}chars]` : "[omitted]";
          continue;
        }
        if (SECRET_KEY_PATTERNS.some((re) => re.test(k))) {
          out[k] = "[redacted]";
          continue;
        }
        out[k] = redactDetail(v, depth + 1);
      }
      return out;
    }
    return value;
  } catch {
    return "[redaction-failed]";
  }
}

/* ------------------------------ event sinks ----------------------------- */

export type AspectEventSink = (event: AspectEvent) => void;

let eventSink: AspectEventSink | null = null;
/** Test seam: capture events instead of writing to the log stream. */
export function setAspectEventSink(sink: AspectEventSink | null): void {
  eventSink = sink;
}

let outcomeLedgerSink: AspectEventSink | null = null;
/**
 * THE SINK SEAM — IAAA "Accounting" (owner directive 2026-10-18, tracker
 * #297 comment 6258223486): the #252 model is the complete IAAA model —
 * Identification, Authentication, Authorization, Accounting — all four
 * first-class.
 *
 * This aspect emits through a sink interface, not hard-coded console-only:
 * - the TRANSPORT copy: structured console JSON (Workers log stream), the
 *   default event sink. Hot/operational, 30-day retention per §8.
 * - the SYSTEM-OF-RECORD copy: this sink. In P2 it lands inside
 *   IdentityAgent as a durable APPEND-ONLY accounting store carrying
 *   authn success/failure, session mint/rotate/revoke, token issuance,
 *   authz allow AND deny decisions (subject/relation/object), and
 *   per-tenant AI spend records. Until then it is a no-op — the seam is
 *   live, the store is P2 work.
 *
 * Every event the aspect emits is already in the same AspectEvent shape,
 * so the accounting store persists them unchanged: authz decisions are
 * events with operation "authz.allow"/"authz.deny" and an authDecision
 * field; accounting kinds are listed in AccountingEventKind.
 */
export function setOutcomeLedgerSink(sink: AspectEventSink | null): void {
  outcomeLedgerSink = sink;
}

/** Naming alias: the outcome-ledger feed IS the accounting sink. */
export const setAccountingSink = setOutcomeLedgerSink;

/**
 * The accounting event taxonomy (IAAA "Accounting"). Authn/session/token
 * events are emitted by the P2 identity work; authz events are emitted by
 * the authz aspect from P1; ai.spend is emitted by the budget guard from
 * P3. All are AspectEvents — the accounting sink persists them unchanged.
 */
export type AccountingEventKind =
  | "authn.success"
  | "authn.failure"
  | "session.mint"
  | "session.rotate"
  | "session.revoke"
  | "token.issue"
  | "authz.allow"
  | "authz.deny"
  | "ai.spend";

/**
 * Build an accounting event in the same AspectEvent shape. The sink
 * interface persists it unchanged — no per-kind serialization.
 */
export function accountingEvent(
  kind: AccountingEventKind,
  fields: {
    tenantId: string;
    userId: string;
    correlationId: string;
    agent?: string;
    durationMs?: number;
    authDecision?: AspectAuthDecision;
    scopeUsed?: string;
    detail?: unknown;
  },
): AspectEvent {
  return {
    v: 1,
    ts: aspectEventNow(),
    level: kind === "authz.deny" || kind === "authn.failure" ? "warn" : "info",
    tenantId: fields.tenantId,
    userId: fields.userId,
    agent: fields.agent ?? "identity",
    operation: kind,
    correlationId: fields.correlationId,
    durationMs: fields.durationMs ?? 0,
    outcome:
      kind === "authz.deny" || kind === "authn.failure" ? "denied" : "ok",
    ...(fields.authDecision ? { authDecision: fields.authDecision } : {}),
    ...(fields.scopeUsed ? { scopeUsed: fields.scopeUsed } : {}),
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
  };
}

/**
 * Emit one structured event. Never throws: emission is observability, not
 * the operation. The primary sink is the structured console JSON the
 * Workers log stream captures; outcome events also feed the #241 ledger.
 */
export function emitAspectEvent(
  event: AspectEvent,
  env?: AspectEnv | null,
): void {
  if (!aspectsEnabled(env)) return;
  if (!logLevelAllows(env, event.level)) return;
  try {
    const safe: AspectEvent = {
      ...event,
      detail: event.detail === undefined ? undefined : redactDetail(event.detail),
    };
    if (eventSink) {
      eventSink(safe);
    } else {
      console.log(JSON.stringify(safe));
    }
    if (outcomeLedgerSink && event.outcome !== undefined) {
      outcomeLedgerSink(safe);
    }
  } catch {
    /* emission must never fail the operation */
  }
}

export function aspectEventNow(): string {
  return new Date().toISOString();
}

/* --------------------------- A2A trace parts ---------------------------- */

const TRACE_DATA_KEY = "_trace";

export function isTraceData(data: unknown): data is { _trace: AspectTrace } {
  return (
    typeof data === "object" &&
    data !== null &&
    TRACE_DATA_KEY in (data as Record<string, unknown>) &&
    typeof (data as Record<string, unknown>)[TRACE_DATA_KEY] === "object"
  );
}

/**
 * Append the private trace data part to an outbound A2A message body
 * (design §2.3). Bodies that are not the {params.message.parts} shape pass
 * through unchanged; nothing is mutated.
 */
export function withTracePart(body: unknown, trace: AspectTrace): unknown {
  if (typeof body !== "object" || body === null) return body;
  const params = (body as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null) return body;
  const message = (params as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return body;
  const parts = (message as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return body;
  return {
    ...(body as Record<string, unknown>),
    params: {
      ...(params as Record<string, unknown>),
      message: {
        ...(message as Record<string, unknown>),
        parts: [...parts, { kind: "data", data: { [TRACE_DATA_KEY]: trace } }],
      },
    },
  };
}

/**
 * Split the private trace part out of an inbound message's parts.
 * Returns the trace (null when absent) and the parts with the trace
 * part removed, so the trace never reaches the capability's prompt.
 */
export function extractTracePart(parts: unknown): {
  trace: AspectTrace | null;
  parts: unknown[];
} {
  const list = Array.isArray(parts) ? parts : [];
  let trace: AspectTrace | null = null;
  const rest: unknown[] = [];
  for (const p of list) {
    if (
      typeof p === "object" &&
      p !== null &&
      (p as Record<string, unknown>).kind === "data" &&
      isTraceData((p as Record<string, unknown>).data)
    ) {
      if (!trace) {
        const t = ((p as Record<string, unknown>).data as { _trace: AspectTrace })[
          TRACE_DATA_KEY
        ];
        if (typeof t.correlationId === "string" && t.correlationId) trace = t;
      }
      continue;
    }
    rest.push(p);
  }
  return { trace, parts: rest };
}
