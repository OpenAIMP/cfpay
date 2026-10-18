/**
 * Budget & policy guard for outbound agent payments (issue #211;
 * bundle 203 adapted to this repo).
 *
 * A pure, deterministic validator for a single outbound payment
 * against a policy (per-call cap, global daily cap, per-agent
 * daily/per-call caps, recipient/service allowlist, idempotent
 * replay) plus the state transitions around it. Amounts are safe
 * integers in minor units (USDC atomic units = 6 decimals, the
 * units x402 challenges already use).
 *
 * Where it bites: the host's payExternalEndpoint already fails
 * closed on PAYMENT_PRIVATE_KEY, OUTBOUND_PAY_TO_WHITELIST and
 * OUTBOUND_MAX_AMOUNT_ATOMIC (env gates). This guard adds the
 * CUMULATIVE layer env vars cannot express - spend so far today,
 * per agent, with named refusal codes - enforced inside the x402
 * validator, before anything is signed. Policy and daily state
 * live in the spending agent's own SQL (budget_policy /
 * budget_state tables), so the owner can change caps without a
 * redeploy (host getBudget / setBudgetPolicy callables).
 *
 * No policy row = no cumulative caps: the policy falls back to the
 * env-derived per-call ceiling and uncapped daily totals, and the
 * snapshot reports configured: false. Inventing dollar limits the
 * owner never set would break flows silently; the env gates remain
 * the fail-closed layer until a policy exists.
 */

export type AgentId = string;
export type ServiceId = string;
export type DayKey = string; // YYYY-MM-DD UTC
export type MinorUnits = number; // safe integer >= 0

export const BUDGET_REJECTION_CODES = [
  "PER_CALL_CAP_EXCEEDED",
  "DAILY_CAP_EXCEEDED",
  "AGENT_DAILY_CAP_EXCEEDED",
  "RECIPIENT_NOT_ALLOWED",
  "SERVICE_NOT_ALLOWED",
  "INVALID_AMOUNT",
  "POLICY_NOT_CONFIGURED",
  "DAILY_BUDGET_EXHAUSTED",
] as const;
export type BudgetRejectionCode = (typeof BUDGET_REJECTION_CODES)[number];

export interface OutboundPaymentRequest {
  /** Unique idempotency key for this payment attempt. */
  id: string;
  /** Agent initiating the payment ("host" is the only spender today). */
  agentId: AgentId;
  /** Service identifier (the endpoint host for x402 calls). */
  serviceId: ServiceId;
  /** Recipient (the x402 payTo address). */
  recipient: string;
  /** Amount in minor units - must be a positive safe integer. */
  amount: MinorUnits;
  /** ISO timestamp for audit; not used in cap math. */
  timestamp: string;
  /** Day bucket YYYY-MM-DD UTC the state must correspond to. */
  dayKey: DayKey;
}

export interface BudgetPolicy {
  dailyCap: MinorUnits;
  perCallCap: MinorUnits;
  /** Service ids, recipients, or hosts. Consulted when enforceAllowlist. */
  allowlist?: string[];
  enforceAllowlist: boolean;
  /** Per-agent daily caps; falls back to dailyCap. */
  agentCaps?: Record<AgentId, MinorUnits>;
  /** Per-agent per-call caps; the effective cap is the min of all that apply. */
  agentPerCallCaps?: Record<AgentId, MinorUnits>;
  serviceCaps?: Record<ServiceId, MinorUnits>;
  /** Exact matching when true (default); subdomain/prefix when false. */
  strictAllowlist?: boolean;
}

export interface BudgetState {
  dayKey: DayKey;
  totalSpent: MinorUnits;
  spentByAgent: Record<AgentId, MinorUnits>;
  spentByService?: Record<ServiceId, MinorUnits>;
  processedIds?: string[];
  callCount: number;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  code?: BudgetRejectionCode;
  remainingDaily?: MinorUnits;
  remainingAgentDaily?: MinorUnits;
  projectedTotal?: MinorUnits;
  projectedAgentTotal?: MinorUnits;
  request: OutboundPaymentRequest;
}

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

function isPositiveSafeInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

function isNonNegativeSafeInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

function matchesAllowlist(candidate: string, allowlist: string[], strict = true): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  const c = norm(candidate);
  for (const entry of allowlist) {
    const e = norm(entry);
    if (strict) {
      if (c === e) return true;
    } else if (c === e || c.endsWith(`.${e}`) || c.startsWith(e) || e.startsWith(c)) {
      return true;
    }
  }
  return false;
}

function effectiveAgentDailyCap(policy: BudgetPolicy, agentId: AgentId): MinorUnits {
  return policy.agentCaps?.[agentId] ?? policy.dailyCap;
}

function effectivePerCallCap(policy: BudgetPolicy, req: OutboundPaymentRequest): MinorUnits {
  let cap = policy.perCallCap;
  const agent = policy.agentPerCallCaps?.[req.agentId];
  const service = policy.serviceCaps?.[req.serviceId];
  if (agent !== undefined) cap = Math.min(cap, agent);
  if (service !== undefined) cap = Math.min(cap, service);
  return cap;
}

/**
 * Validate one outbound payment against policy + the day's state.
 * Pure: never mutates. The caller persists state only on success
 * (see recordBudgetSpend).
 */
export function validateOutboundPayment(
  request: OutboundPaymentRequest,
  policy: BudgetPolicy,
  state: BudgetState,
): ValidationResult {
  const fail = (code: BudgetRejectionCode, reason: string): ValidationResult => ({
    allowed: false,
    code,
    reason,
    request,
  });

  if (!policy || !isNonNegativeSafeInt(policy.dailyCap) || !isNonNegativeSafeInt(policy.perCallCap)) {
    return fail("POLICY_NOT_CONFIGURED", "Policy caps must be safe non-negative integers.");
  }
  if (!isPositiveSafeInt(request.amount)) {
    return fail("INVALID_AMOUNT", `Amount ${request.amount} is not a positive safe integer in minor units.`);
  }
  if (request.dayKey !== state.dayKey) {
    return fail("INVALID_AMOUNT", `Day mismatch: request ${request.dayKey} vs state ${state.dayKey}.`);
  }

  const processed = new Set(state.processedIds ?? []);
  if (processed.has(request.id)) {
    return {
      allowed: true,
      reason: "Already processed - idempotent replay.",
      request,
      remainingDaily: policy.dailyCap - state.totalSpent,
      remainingAgentDaily: effectiveAgentDailyCap(policy, request.agentId) - (state.spentByAgent[request.agentId] ?? 0),
      projectedTotal: state.totalSpent,
      projectedAgentTotal: state.spentByAgent[request.agentId] ?? 0,
    };
  }

  const perCallCap = effectivePerCallCap(policy, request);
  if (request.amount > perCallCap) {
    return fail("PER_CALL_CAP_EXCEEDED", `Amount ${request.amount} exceeds the per-call cap ${perCallCap}.`);
  }

  if (policy.enforceAllowlist) {
    const list = policy.allowlist ?? [];
    if (list.length === 0) {
      return fail("SERVICE_NOT_ALLOWED", "Allowlist is enforced but empty - denying by default.");
    }
    const strict = policy.strictAllowlist ?? true;
    const serviceOk = matchesAllowlist(request.serviceId, list, strict);
    const recipientOk = matchesAllowlist(request.recipient, list, strict);
    if (!serviceOk && !recipientOk) {
      return fail(
        serviceOk ? "RECIPIENT_NOT_ALLOWED" : "SERVICE_NOT_ALLOWED",
        `Neither service ${request.serviceId} nor recipient ${request.recipient} is on the allowlist.`,
      );
    }
  }

  const projectedTotal = state.totalSpent + request.amount;
  if (projectedTotal > policy.dailyCap) {
    const remaining = policy.dailyCap - state.totalSpent;
    return {
      ...fail(
        remaining <= 0 ? "DAILY_BUDGET_EXHAUSTED" : "DAILY_CAP_EXCEEDED",
        `Daily cap exceeded: spent ${state.totalSpent} + ${request.amount} > cap ${policy.dailyCap} (remaining ${remaining}).`,
      ),
      remainingDaily: Math.max(0, remaining),
      projectedTotal,
    };
  }

  const agentSpent = state.spentByAgent[request.agentId] ?? 0;
  const projectedAgentTotal = agentSpent + request.amount;
  const agentCap = effectiveAgentDailyCap(policy, request.agentId);
  if (projectedAgentTotal > agentCap) {
    return {
      ...fail(
        "AGENT_DAILY_CAP_EXCEEDED",
        `Agent ${request.agentId} daily cap exceeded: spent ${agentSpent} + ${request.amount} > cap ${agentCap}.`,
      ),
      remainingDaily: policy.dailyCap - state.totalSpent,
      remainingAgentDaily: Math.max(0, agentCap - agentSpent),
      projectedTotal,
      projectedAgentTotal,
    };
  }

  return {
    allowed: true,
    request,
    remainingDaily: policy.dailyCap - projectedTotal,
    remainingAgentDaily: agentCap - projectedAgentTotal,
    projectedTotal,
    projectedAgentTotal,
  };
}

/** The refusal text for a payment, or null when it may proceed. */
export function budgetRefusal(
  policy: BudgetPolicy,
  state: BudgetState,
  request: OutboundPaymentRequest,
): string | null {
  const result = validateOutboundPayment(request, policy, state);
  return result.allowed ? null : `budget ${result.code}: ${result.reason}`;
}

/** The next state after an allowed payment (idempotent replays change nothing). */
export function transitionBudgetState(
  policy: BudgetPolicy,
  state: BudgetState,
  request: OutboundPaymentRequest,
): BudgetState {
  const result = validateOutboundPayment(request, policy, state);
  if (!result.allowed) return state;
  if ((state.processedIds ?? []).includes(request.id)) return state;
  return {
    dayKey: state.dayKey,
    totalSpent: result.projectedTotal ?? state.totalSpent,
    callCount: state.callCount + 1,
    spentByAgent: {
      ...state.spentByAgent,
      [request.agentId]: result.projectedAgentTotal ?? state.spentByAgent[request.agentId] ?? 0,
    },
    spentByService: {
      ...(state.spentByService ?? {}),
      [request.serviceId]: (state.spentByService?.[request.serviceId] ?? 0) + request.amount,
    },
    processedIds: [...(state.processedIds ?? []), request.id],
  };
}

export function freshBudgetState(dayKey: DayKey): BudgetState {
  return { dayKey, totalSpent: 0, spentByAgent: {}, spentByService: {}, processedIds: [], callCount: 0 };
}

export function budgetDayKey(date: Date = new Date()): DayKey {
  return date.toISOString().slice(0, 10);
}

/** This deployment's agents, for per-agent cap defaults. */
export const FLEET_AGENTS = [
  "host",
  "orchestrator",
  "payments",
  "email",
  "webhooks",
  "slack",
  "qa",
  "chat",
  "voice",
  "search",
] as const;

/**
 * The policy used when the owner has not stored one: no cumulative
 * caps, per-call ceiling inherited from OUTBOUND_MAX_AMOUNT_ATOMIC
 * when set, allowlist advisory-only (the env whitelist still gates).
 */
export function envDerivedPolicy(env: { OUTBOUND_MAX_AMOUNT_ATOMIC?: string }): BudgetPolicy {
  let perCallCap = Number.MAX_SAFE_INTEGER;
  const raw = env.OUTBOUND_MAX_AMOUNT_ATOMIC?.trim();
  if (raw) {
    try {
      const parsed = BigInt(raw);
      if (parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) perCallCap = Number(parsed);
    } catch {
      /* the caller's own env validation reports the bad value */
    }
  }
  return {
    dailyCap: Number.MAX_SAFE_INTEGER,
    perCallCap,
    enforceAllowlist: false,
    allowlist: [],
    strictAllowlist: true,
    agentCaps: {},
    agentPerCallCaps: {},
    serviceCaps: {},
  };
}

// ---------------------------------------------------------------------------
// SQL persistence (the spending agent's own storage)
// ---------------------------------------------------------------------------

/** The slice of Durable Object SQL storage these helpers need. */
export interface BudgetSql {
  exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
}

export function ensureBudgetTables(sql: BudgetSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS budget_policy (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS budget_state (day TEXT PRIMARY KEY, json TEXT NOT NULL)");
}

export function loadBudgetPolicy(
  sql: BudgetSql,
  env: { OUTBOUND_MAX_AMOUNT_ATOMIC?: string },
): { policy: BudgetPolicy; configured: boolean } {
  ensureBudgetTables(sql);
  const rows = sql.exec("SELECT json FROM budget_policy WHERE id = 1").toArray();
  if (rows.length > 0 && typeof rows[0].json === "string") {
    try {
      return { policy: JSON.parse(rows[0].json) as BudgetPolicy, configured: true };
    } catch {
      /* a corrupt stored policy falls back to the env-derived one */
    }
  }
  return { policy: envDerivedPolicy(env), configured: false };
}

export function saveBudgetPolicy(sql: BudgetSql, policy: BudgetPolicy): void {
  ensureBudgetTables(sql);
  sql.exec("INSERT OR REPLACE INTO budget_policy (id, json) VALUES (1, ?)", JSON.stringify(policy));
}

export function loadBudgetState(sql: BudgetSql, dayKey: DayKey): BudgetState {
  ensureBudgetTables(sql);
  const rows = sql.exec("SELECT json FROM budget_state WHERE day = ?", dayKey).toArray();
  if (rows.length > 0 && typeof rows[0].json === "string") {
    try {
      const parsed = JSON.parse(rows[0].json) as BudgetState;
      if (parsed.dayKey === dayKey) return parsed;
    } catch {
      /* fall through to a fresh state */
    }
  }
  return freshBudgetState(dayKey);
}

export function saveBudgetState(sql: BudgetSql, state: BudgetState): void {
  ensureBudgetTables(sql);
  sql.exec("INSERT OR REPLACE INTO budget_state (day, json) VALUES (?, ?)", state.dayKey, JSON.stringify(state));
}

/** Validate-and-record a completed payment; returns the refusal or null. */
export function recordBudgetSpend(
  sql: BudgetSql,
  policy: BudgetPolicy,
  state: BudgetState,
  request: OutboundPaymentRequest,
): string | null {
  const refusal = budgetRefusal(policy, state, request);
  if (refusal) return refusal;
  saveBudgetState(sql, transitionBudgetState(policy, state, request));
  return null;
}

/** Policy + today's state in one load, for the spending seam. */
export function loadBudget(
  sql: BudgetSql,
  env: { OUTBOUND_MAX_AMOUNT_ATOMIC?: string },
  now: Date = new Date(),
): { policy: BudgetPolicy; configured: boolean; state: BudgetState } {
  const { policy, configured } = loadBudgetPolicy(sql, env);
  return { policy, configured, state: loadBudgetState(sql, budgetDayKey(now)) };
}

/** Build the guard request for an x402 challenge term. */
export function makeBudgetRequest(
  attemptId: string,
  agentId: string,
  serviceId: string,
  recipient: string,
  amountAtomic: string,
  dayKey: DayKey,
): OutboundPaymentRequest {
  return {
    id: attemptId,
    agentId,
    serviceId,
    recipient,
    amount: Number(BigInt(amountAtomic)),
    timestamp: new Date().toISOString(),
    dayKey,
  };
}

export interface BudgetSnapshot {
  configured: boolean;
  policy: BudgetPolicy;
  today: BudgetState;
}

export function budgetSnapshot(
  sql: BudgetSql,
  env: { OUTBOUND_MAX_AMOUNT_ATOMIC?: string },
  now: Date = new Date(),
): BudgetSnapshot {
  const { policy, configured } = loadBudgetPolicy(sql, env);
  const today = loadBudgetState(sql, budgetDayKey(now));
  return { configured, policy, today };
}
