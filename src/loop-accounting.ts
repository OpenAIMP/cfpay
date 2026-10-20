/**
 * Loop outcome accounting — issue #241 R0.3 (child issue #327).
 *
 * The producer seam for the in-Worker loops whose outcomes are known
 * only inside an agent: orchestrator plans, autopilot cycles, scheduled
 * firings, and QAAgent suite runs. Each loop calls emitLoopOutcome
 * exactly once, at the point its outcome is genuinely known (never
 * speculatively, never on a timer), and the event flows through the
 * standard aspect feed into the #252 accounting store — the same stream
 * the R0 ledger (src/r0-metrics-core.ts) aggregates. One stream, not
 * two: a loop outcome is an AspectEvent like every other operation's.
 *
 * Conventions:
 * - loop := operation, per the ledger: the operation names are
 *   "orchestrator.plan", "autopilot.cycle", "scheduled.firing",
 *   "qa.suite" — distinct from the edge/dispatch operation names
 *   (e.g. "autopilot.runCycle"), because the dispatch outcome and the
 *   loop outcome are different facts (a dispatch can succeed while the
 *   cycle it started fails; alarm-driven loops have no dispatch at all).
 * - durationMs is measured by the caller at the seam (started/finished
 *   timestamps the loop already tracks); this module never invents one.
 * - errorCode is set only on failures, from stable producer codes or
 *   the thrown value's catalog code (errorCodeOf) — never raw exception
 *   text, which belongs in detail at most, redacted at emission.
 * - userId mirrors tenantId: tenant = user 1:1 in v1, and the operator
 *   pseudo-identity is "operator" on both sides (see identity-core).
 *
 * SDK-free so Vitest can import it directly, like the aspect modules.
 */

import {
  aspectEventNow,
  emitAspectEvent,
  mintCorrelationId,
  type AspectEnv,
  type AspectEvent,
  type AspectOutcome,
} from "./aspect-logging";

export interface LoopOutcomeInput {
  /** The agent that owns the loop ("orchestrator", "autopilot", ...). */
  agent: string;
  /** The loop's operation name (see header: loop := operation). */
  operation: string;
  /** The tenant the loop ran for (ownTenantId of the agent instance). */
  tenantId: string;
  outcome: AspectOutcome;
  /** Measured at the seam by the caller; clamped to a sane value here. */
  durationMs: number;
  /** Failures only: a stable code, never raw exception text. */
  errorCode?: string;
  /** Ids/counts/status only — no user content (redacted at emission anyway). */
  detail?: unknown;
  correlationId?: string;
}

const LEVEL_FOR: Record<AspectOutcome, AspectEvent["level"]> = {
  ok: "info",
  error: "error",
  denied: "warn",
  skipped: "info",
};

/** Build the AspectEvent for one loop outcome. Pure. */
export function buildLoopOutcomeEvent(input: LoopOutcomeInput): AspectEvent {
  return {
    v: 1,
    ts: aspectEventNow(),
    level: LEVEL_FOR[input.outcome],
    tenantId: input.tenantId,
    userId: input.tenantId,
    agent: input.agent,
    operation: input.operation,
    correlationId: input.correlationId ?? mintCorrelationId(),
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : 0,
    outcome: input.outcome,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

/**
 * Emit one loop outcome into the aspect feed (and thereby the
 * accounting store). Never throws — emitAspectEvent already guarantees
 * emission cannot fail the operation.
 */
export function emitLoopOutcome(input: LoopOutcomeInput, env?: AspectEnv | null): void {
  emitAspectEvent(buildLoopOutcomeEvent(input), env ?? null);
}

/**
 * The catalog code a thrown value carries (the error aspect's
 * classification keeps a known `code` property), else the caller's
 * stable fallback. Exists so agent classes can name a failure without
 * importing the aspect-error stack.
 */
export function errorCodeOf(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return fallback;
}
