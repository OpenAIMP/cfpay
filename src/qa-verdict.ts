/**
 * The QA agent's decision rules, with no browser, no model and no framework in them.
 *
 * These are separated from qa-agent.ts because they are the rules that decide what a
 * run is allowed to claim, and a rule like that has to be testable on its own rather
 * than through a live browser session.
 *
 * The split the whole agent is built on: the model chooses what to look at and judges
 * what it found, while the functions here decide what counts as a recordable claim. A
 * model that could both observe and assert would be able to report a pass it never saw,
 * and at the other end that report is indistinguishable from a real one.
 */

export type QAFindingStatus = "pass" | "fail" | "blocked";

export const FINDING_STATUSES: readonly QAFindingStatus[] = ["pass", "fail", "blocked"];

export interface QAFinding {
  /** What was being verified, in the reporter's own words. */
  claim: string;
  status: QAFindingStatus;
  /** The observation the claim rests on. Required - see recordFinding. */
  evidence: string;
}

/**
 * Why a run stopped.
 *
 * Reported rather than inferred, so a reader can tell "the agent looked and decided"
 * apart from "the agent never got to look". Those are different facts and only one of
 * them is a QA result.
 */
export type QAStoppedReason =
  | "concluded"
  | "no_findings"
  | "bad_url"
  | "blocked_host"
  | "no_browser"
  | "error";

export interface QASessionFacts {
  url: string;
  goal: string;
  findings: QAFinding[];
  /** Browser tool calls the model made. 0 means it never looked at anything. */
  toolCalls: number;
  /** Characters of page text it actually read, before truncation. */
  textLength: number;
  stoppedReason: QAStoppedReason;
  error?: string;
}

export interface QAVerdict extends QASessionFacts {
  /** True only when something was checked, cleanly, and every claim passed. */
  ok: boolean;
}

/**
 * The shortest evidence string accepted.
 *
 * Not a formatting preference. A one-word "evidence" field is an assurance with a
 * punctuation mark in it, so the bar sits where a real quoted observation passes
 * comfortably and an invented one does not.
 */
export const MIN_EVIDENCE_CHARS = 12;

/**
 * Record one claim, if it carries the observation it rests on.
 *
 * Refusing here rather than validating later is the point: the tool that calls this
 * returns the refusal to the model inside the same turn, so a model that tried to assert
 * a pass it did not observe is told to go and look instead of being silently dropped.
 */
export function recordFinding(
  findings: QAFinding[],
  candidate: { claim?: unknown; status?: unknown; evidence?: unknown },
): { accepted: boolean; reason?: string; recorded: number } {
  const claim = typeof candidate.claim === "string" ? candidate.claim.trim() : "";
  const evidence = typeof candidate.evidence === "string" ? candidate.evidence.trim() : "";
  const status = candidate.status;

  if (!claim) {
    return {
      accepted: false,
      reason: "A finding needs a claim: say what you were checking.",
      recorded: findings.length,
    };
  }
  if (!FINDING_STATUSES.includes(status as QAFindingStatus)) {
    return {
      accepted: false,
      reason: 'status must be one of "pass", "fail" or "blocked".',
      recorded: findings.length,
    };
  }
  if (evidence.length < MIN_EVIDENCE_CHARS) {
    return {
      accepted: false,
      reason:
        `A ${String(status)} claim needs the observation behind it, quoted from a browser tool ` +
        `(at least ${MIN_EVIDENCE_CHARS} characters). Read the page and quote what it shows, or ` +
        `record the claim as blocked if you could not determine it.`,
      recorded: findings.length,
    };
  }

  findings.push({ claim, status: status as QAFindingStatus, evidence });
  return { accepted: true, recorded: findings.length };
}

/**
 * Turn the session's facts into a verdict.
 *
 * Two rules, both of which exist because the opposite has a specific failure:
 *
 *   - No findings is not a pass. It is "no_findings", whatever the model wrote in prose.
 *     Nothing was recorded, so there is nothing that passed.
 *   - A run that did not conclude cleanly is not a pass either, even if the findings it
 *     did record all passed. Half a check is not a check.
 */
export function assembleVerdict(facts: QASessionFacts): QAVerdict {
  const checked = facts.findings.length > 0;
  const clean = facts.stoppedReason === "concluded";
  const stoppedReason: QAStoppedReason = clean && !checked ? "no_findings" : facts.stoppedReason;
  const ok = clean && checked && facts.findings.every((f) => f.status === "pass");
  return { ...facts, stoppedReason, ok };
}

/* ------------------------------- target guard ------------------------------- */

export type TargetGuard =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: "bad_url" | "blocked_host"; url: string; host?: string };

/** Split a comma-separated allowlist var. Empty or absent means "not configured". */
export function parseAllowedHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether this agent may browse to a URL, and why not when it may not.
 *
 * Matching is on the parsed hostname rather than on a prefix of the URL string, because
 * `https://expected.example.com@attacker.test/` has the expected name in its prefix and
 * resolves to attacker.test - a prefix test passes exactly the URL it is meant to stop.
 * Parsing also normalises the scheme's case, so `HTTPS://` is accepted rather than
 * refused as a scheme nobody listed.
 *
 * No allowlist configured means no restriction, which is the behaviour the A2A card
 * already states. An allowlist is the only thing that actually bounds the destination;
 * a denylist of private ranges would be theatre, since a hostname can resolve anywhere.
 */
export function isAllowedTarget(raw: string, allowedHosts: readonly string[] = []): TargetGuard {
  const trimmed = String(raw ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "bad_url", url: trimmed };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "bad_url", url: parsed.toString() };
  }
  const host = parsed.hostname.toLowerCase();
  if (allowedHosts.length > 0 && !allowedHosts.some((entry) => hostMatches(host, entry))) {
    return { ok: false, reason: "blocked_host", url: parsed.toString(), host };
  }
  return { ok: true, url: parsed.toString(), host };
}

/**
 * `example.com` matches that host only. `*.example.com` matches subdomains and not the
 * bare domain, so an entry never silently widens past what it says.
 */
function hostMatches(host: string, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === entry;
}

/* -------------------------------- text bounds -------------------------------- */

export interface TruncatedText {
  text: string;
  originalLength: number;
  truncated: boolean;
}

export function truncateText(raw: unknown, maxChars: number): TruncatedText {
  const text = typeof raw === "string" ? raw : "";
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (text.length <= limit) return { text, originalLength: text.length, truncated: false };
  return { text: text.slice(0, limit), originalLength: text.length, truncated: true };
}

/* --------------------------- dispatched investigations --------------------------- */

export interface InvestigationRequest {
  url: string;
  goal?: string;
  apiKey?: string;
}

/**
 * Read a `qa.investigate` request out of the messages that admitted a turn.
 *
 * The host reaches its children as tools: `agentTool(QAAgent, ...)` sends
 * `{ operation, url, goal }` as the child's input, which arrives as a user message. This
 * is what lets a dispatched call run the same bounded, evidence-checked investigation as
 * the direct RPC instead of a turn with no shape to it.
 *
 * Best effort by design, and only the newest user message is read: an envelope from
 * earlier in a conversation must not re-arm a bounded turn for a later, unrelated
 * question. A message that is not an envelope returns null, which leaves the turn
 * exactly as it would have been without this function.
 */
export function readInvestigationRequest(
  messages: readonly unknown[] | undefined,
): InvestigationRequest | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null | undefined;
    if (!message || message.role !== "user") continue;
    return parseInvestigationEnvelope(messageContentText(message.content));
  }
  return null;
}

/** Text of a model message's content: a plain string, or the text parts of an array. */
function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The envelope itself: `{ "operation": "qa.investigate", "url": ..., "goal": ... }`. */
export function parseInvestigationEnvelope(text: string): InvestigationRequest | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const envelope = parsed as Record<string, unknown>;
  if (envelope.operation !== "qa.investigate") return null;

  const url = typeof envelope.url === "string" ? envelope.url.trim() : "";
  if (!url) return null;

  const goal = typeof envelope.goal === "string" ? envelope.goal.trim() : "";
  const apiKey = typeof envelope.apiKey === "string" ? envelope.apiKey : "";

  return {
    url,
    goal: goal || undefined,
    apiKey: apiKey || undefined,
  };
}
