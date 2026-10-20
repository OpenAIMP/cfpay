/**
 * AutopilotAgent portfolio construction core (issue #242 P2.1, #328).
 *
 * Pure and SDK-free so vitest covers it. The hunt (src/opportunity-hunt.ts)
 * finds candidates and sizes them deterministically; this module decides,
 * also deterministically and in code, which of those sized trades may
 * coexist in one portfolio under portfolio-level caps. The model never
 * sizes and never allocates: it proposes candidates, code disposes.
 *
 * Scope: construction only. Existing holdings and rebalance proposals are
 * the holdings seam (#329); persistence and surfaces are #330. Nothing
 * here reads state, places orders, or re-sizes a trade - a sized trade is
 * allocated whole (all its contracts) or rejected with a reason.
 *
 * Determinism: candidates are consumed in the hunt's ranked order and
 * never re-sorted; every rejection carries exactly one machine-readable
 * reason from a fixed precedence; no clock, no randomness, no locale.
 * Same inputs -> byte-identical plan.
 */

import { structureRisk, type SizedTrade } from "./opportunity-hunt";

/** A construction candidate is exactly a hunt-sized trade. */
export type PortfolioCandidate = SizedTrade;

/**
 * Portfolio caps, as fractions of the objective budget.
 *
 * PER_UNDERLYING 0.25 matches the hunt's own per-underlying planning cap
 * (HuntRequest.maxUnderlyingPct default 25), so construction never admits
 * an underlying concentration the hunt itself would not plan.
 * PER_STRATEGY 0.40 sits above the per-underlying cap (one strategy may
 * span several underlyings) but below half the budget, so no single
 * strategy kind can dominate the book.
 * TOTAL_OPEN_RISK 0.80 keeps a 20% reserve uncommitted: the portfolio
 * never stakes the whole budget as open risk in one construction pass,
 * leaving headroom for later cycles and adjustments.
 */
export const DEFAULT_PER_UNDERLYING_FRACTION = 0.25;
export const DEFAULT_PER_STRATEGY_FRACTION = 0.4;
export const DEFAULT_TOTAL_OPEN_RISK_FRACTION = 0.8;

export interface PortfolioConstraints {
  /** Max share of budget at risk on one underlying. Default 0.25. */
  perUnderlyingFraction?: number;
  /** Max share of budget at risk on one strategy kind. Default 0.40. */
  perStrategyFraction?: number;
  /** Max share of budget at risk across the whole portfolio. Default 0.80. */
  totalOpenRiskFraction?: number;
}

export interface ResolvedPortfolioConstraints {
  perUnderlyingFraction: number;
  perStrategyFraction: number;
  totalOpenRiskFraction: number;
}

/**
 * The slice of the objective construction needs. AutopilotObjective
 * (src/autopilot-core.ts) satisfies this structurally; symbols empty or
 * absent means the whole hunt universe is in scope.
 */
export interface PortfolioObjectiveInput {
  budget: number;
  symbols?: string[];
}

/**
 * Why a candidate was not allocated. Exactly one per rejection, assigned
 * by the first failing check in this precedence:
 *   outside_objective_symbols -> undefined_risk -> duplicate_exposure
 *   -> per_underlying_cap -> per_strategy_cap -> total_risk_cap
 *   -> budget_exhausted
 * (With a non-positive budget every measurable candidate is
 * budget_exhausted: there is nothing to allocate against.)
 */
export type PortfolioRejectionReason =
  | "outside_objective_symbols"
  | "undefined_risk"
  | "duplicate_exposure"
  | "per_underlying_cap"
  | "per_strategy_cap"
  | "total_risk_cap"
  | "budget_exhausted";

export interface AllocatedPosition extends SizedTrade {
  /** Normalized strategy kind the per-strategy cap accounted this under. */
  strategyKind: string;
  /** Dollars of budget at risk (= the candidate's hunt-sized totalRisk). */
  risk: number;
  /** risk / budget, rounded to 4 decimals. */
  budgetShare: number;
}

export interface PortfolioRejection {
  underlying: string;
  strategy: string;
  expiry: string;
  reason: PortfolioRejectionReason;
  /** Human-readable detail with the figures behind the reason. */
  detail: string;
}

export interface PortfolioPlan {
  /** Effective budget construction ran against (0 if the input was invalid). */
  budget: number;
  constraints: ResolvedPortfolioConstraints;
  allocations: AllocatedPosition[];
  rejections: PortfolioRejection[];
  totalRisk: number;
  totalMaxProfit: number;
  totalExpectedValue: number;
  /** budget - totalRisk: budget not committed as open risk. */
  unallocated: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const money = (n: number) => `$${round2(n)}`;

/** A cap fraction is honored only when it is a finite positive number. */
function validFraction(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function resolveConstraints(input?: PortfolioConstraints): ResolvedPortfolioConstraints {
  return {
    perUnderlyingFraction: validFraction(input?.perUnderlyingFraction, DEFAULT_PER_UNDERLYING_FRACTION),
    perStrategyFraction: validFraction(input?.perStrategyFraction, DEFAULT_PER_STRATEGY_FRACTION),
    totalOpenRiskFraction: validFraction(input?.totalOpenRiskFraction, DEFAULT_TOTAL_OPEN_RISK_FRACTION),
  };
}

const normalizeUnderlying = (s: unknown): string => String(s ?? "").trim().toUpperCase();

/** Strategy kinds group case/whitespace variants of the same hunt label. */
export function strategyKindOf(strategy: unknown): string {
  const kind = String(strategy ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return kind || "unspecified";
}

/** Canonical identity of a trade for duplicate detection (leg order-free). */
function exposureSignature(c: SizedTrade, underlying: string, kind: string): string {
  const legs = c.legs
    .map((l) => `${l.action}:${l.type}:${l.strike}`)
    .sort()
    .join(",");
  return `${underlying}|${kind}|${c.expiry}|${legs}`;
}

/**
 * Defined-risk measurability: the structure itself must price as
 * defined-risk under the hunt's own gate, and the hunt's sizing figures
 * must be present and positive. A candidate failing this is never sized
 * here and never silently trusted - it is rejected as undefined_risk.
 */
function measurabilityProblem(c: SizedTrade, underlying: string): string | null {
  if (!underlying) return "candidate has no underlying to account risk against";
  if (!structureRisk(c)) return "structure is not defined-risk (vertical spread or cash-secured put only)";
  if (!(c.contracts > 0) || !Number.isFinite(c.contracts)) return "candidate carries no contract count";
  if (!(c.maxLossPerContract > 0) || !Number.isFinite(c.maxLossPerContract)) {
    return "candidate carries no per-contract max loss";
  }
  if (!(c.totalRisk > 0) || !Number.isFinite(c.totalRisk)) return "candidate carries no total max risk";
  return null;
}

/**
 * Build the allocation plan for one construction pass.
 *
 * Candidates arrive ranked best-first (the hunt's evPerRisk order) and
 * are considered in that order: an earlier candidate's allocation is
 * what later candidates' caps are measured against. Every input
 * candidate appears exactly once across allocations + rejections.
 */
export function constructPortfolio(
  candidates: readonly SizedTrade[],
  objective: PortfolioObjectiveInput,
  constraintsInput?: PortfolioConstraints,
): PortfolioPlan {
  const budget =
    typeof objective.budget === "number" && Number.isFinite(objective.budget) && objective.budget > 0
      ? round2(objective.budget)
      : 0;
  const constraints = resolveConstraints(constraintsInput);
  const perUnderlyingCap = round2(budget * constraints.perUnderlyingFraction);
  const perStrategyCap = round2(budget * constraints.perStrategyFraction);
  const totalRiskCap = round2(budget * constraints.totalOpenRiskFraction);
  const symbolScope = new Set((objective.symbols ?? []).map(normalizeUnderlying).filter(Boolean));

  const allocations: AllocatedPosition[] = [];
  const rejections: PortfolioRejection[] = [];
  const byUnderlying = new Map<string, number>();
  const byStrategy = new Map<string, number>();
  const allocatedSignatures = new Set<string>();
  let totalRisk = 0;

  const reject = (c: SizedTrade, reason: PortfolioRejectionReason, detail: string) => {
    rejections.push({ underlying: c.underlying, strategy: c.strategy, expiry: c.expiry, reason, detail });
  };

  for (const c of candidates) {
    const underlying = normalizeUnderlying(c.underlying);
    const kind = strategyKindOf(c.strategy);
    const risk = round2(c.totalRisk);

    if (symbolScope.size > 0 && !symbolScope.has(underlying)) {
      reject(c, "outside_objective_symbols", `${underlying || "(blank)"} is outside the objective's symbol scope`);
      continue;
    }
    const problem = measurabilityProblem(c, underlying);
    if (problem) {
      reject(c, "undefined_risk", problem);
      continue;
    }
    const signature = exposureSignature(c, underlying, kind);
    if (allocatedSignatures.has(signature)) {
      reject(c, "duplicate_exposure", "identical exposure (underlying, strategy, expiry, legs) is already allocated");
      continue;
    }
    if (budget <= 0) {
      reject(c, "budget_exhausted", "the objective budget is zero or invalid - nothing can be allocated");
      continue;
    }
    const underlyingUsed = byUnderlying.get(underlying) ?? 0;
    if (round2(underlyingUsed + risk) > perUnderlyingCap) {
      reject(
        c,
        "per_underlying_cap",
        `${underlying} risk would reach ${money(underlyingUsed + risk)}, over the per-underlying cap of ${money(perUnderlyingCap)} (${constraints.perUnderlyingFraction} of budget)`,
      );
      continue;
    }
    const strategyUsed = byStrategy.get(kind) ?? 0;
    if (round2(strategyUsed + risk) > perStrategyCap) {
      reject(
        c,
        "per_strategy_cap",
        `"${kind}" risk would reach ${money(strategyUsed + risk)}, over the per-strategy cap of ${money(perStrategyCap)} (${constraints.perStrategyFraction} of budget)`,
      );
      continue;
    }
    if (round2(totalRisk + risk) > totalRiskCap) {
      reject(
        c,
        "total_risk_cap",
        `portfolio risk would reach ${money(totalRisk + risk)}, over the total open-risk cap of ${money(totalRiskCap)} (${constraints.totalOpenRiskFraction} of budget)`,
      );
      continue;
    }
    if (round2(totalRisk + risk) > budget) {
      reject(
        c,
        "budget_exhausted",
        `portfolio risk would reach ${money(totalRisk + risk)}, over the ${money(budget)} budget`,
      );
      continue;
    }

    allocations.push({ ...c, strategyKind: kind, risk, budgetShare: round4(risk / budget) });
    allocatedSignatures.add(signature);
    byUnderlying.set(underlying, round2(underlyingUsed + risk));
    byStrategy.set(kind, round2(strategyUsed + risk));
    totalRisk = round2(totalRisk + risk);
  }

  return {
    budget,
    constraints,
    allocations,
    rejections,
    totalRisk,
    totalMaxProfit: round2(allocations.reduce((s, a) => s + a.totalMaxProfit, 0)),
    totalExpectedValue: round2(allocations.reduce((s, a) => s + a.expectedValue, 0)),
    unallocated: round2(budget - totalRisk),
  };
}
