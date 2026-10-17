/**
 * Autopilot opportunity hunt (issue #135): a budget-bounded scan for
 * premium-selling trades whose sizing is computed HERE, in code -
 * never by the model. The model (via the autopilot pipeline) gathers
 * live Public.com evidence and proposes candidates with figures; this
 * module verifies every figure against the live spot, rejects
 * undefined-risk or moneyness-violating structures, ranks by expected
 * value per dollar of risk, and allocates contracts under the budget
 * caps. Report-only: nothing here can place an order.
 */

export interface HuntLeg {
  action: "sell" | "buy";
  type: "call" | "put";
  strike: number;
}

export interface HuntCandidate {
  underlying: string;
  strategy: string;
  legs: HuntLeg[];
  expiry: string; // YYYY-MM-DD
  /** Net credit per share (positive = credit received, negative = debit paid). */
  credit: number;
  /** Model's estimated probability of profit, 0..1 (from the chain's deltas). */
  probability?: number;
  thesis: string;
  invalidation: string;
}

export interface HuntRequest {
  budget: number;
  /** Per-trade risk cap as a percent of budget. Default 2. */
  maxRiskPct?: number;
  /** Per-underlying risk cap as a percent of budget. Default 25. */
  maxUnderlyingPct?: number;
  horizonDays?: number;
  symbols?: string[];
}

export interface SizedTrade extends HuntCandidate {
  contracts: number;
  spot: number;
  maxLossPerContract: number;
  maxProfitPerContract: number;
  totalRisk: number;
  totalMaxProfit: number;
  expectedValue: number;
  evPerRisk: number;
}

export interface RejectedCandidate {
  underlying: string;
  strategy: string;
  reason: string;
}

export interface HuntPlan {
  trades: SizedTrade[];
  unsized: RejectedCandidate[];
  rejected: RejectedCandidate[];
  totalRisk: number;
  totalMaxProfit: number;
  totalExpectedValue: number;
  unallocated: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deterministic per-contract max loss / max profit from the legs.
 * Only defined-risk structures are supported:
 *  - a vertical spread (sell one, buy one further out, same type/expiry)
 *  - a single cash-secured short put
 * Anything else returns null (undefined or unrecognized risk).
 */
export function structureRisk(c: HuntCandidate): { maxLoss: number; maxProfit: number } | null {
  const credit = c.credit;
  if (!Number.isFinite(credit) || credit === 0) return null;
  if (c.legs.length === 1) {
    const leg = c.legs[0];
    if (leg.action === "sell" && leg.type === "put" && credit > 0) {
      // Cash-secured put: worst case the underlying goes to zero.
      return { maxLoss: round2((leg.strike - credit) * 100), maxProfit: round2(credit * 100) };
    }
    return null;
  }
  if (c.legs.length === 2) {
    const [a, b] = c.legs;
    if (a.type !== b.type) return null;
    const sell = c.legs.find((l) => l.action === "sell");
    const buy = c.legs.find((l) => l.action === "buy");
    if (!sell || !buy || sell === buy) return null;
    const width = Math.abs(a.strike - b.strike);
    if (width <= 0) return null;
    // The bought leg must be further from the money than the sold leg.
    if (sell.type === "put" && !(buy.strike < sell.strike)) return null;
    if (sell.type === "call" && !(buy.strike > sell.strike)) return null;
    if (credit > 0) {
      return { maxLoss: round2((width - credit) * 100), maxProfit: round2(credit * 100) };
    }
    // Debit spread: max loss is the debit paid.
    return { maxLoss: round2(-credit * 100), maxProfit: round2((width + credit) * 100) };
  }
  return null;
}

/**
 * Verify a candidate against the live spot. The moneyness checks are
 * the NVDA lesson (issue #135 design): a "premium-selling" candidate
 * whose short strike is already in the money is a directional bet
 * wearing a hedge's clothes, and price checks alone bless it.
 */
export function verifyCandidate(
  c: HuntCandidate,
  spot: number | undefined,
  now: Date = new Date(),
): string | null {
  if (!c.underlying || !/^[A-Z][A-Z0-9.]{0,9}$/.test(c.underlying)) return "bad underlying symbol";
  if (!c.legs.length || c.legs.some((l) => !(l.strike > 0))) return "legs need positive strikes";
  const expiry = new Date(`${c.expiry}T20:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return "unparseable expiry";
  if (expiry.getTime() < now.getTime()) return "expiry is in the past";
  const risk = structureRisk(c);
  if (!risk) return "not a defined-risk structure (vertical spread or cash-secured put only)";
  if (risk.maxLoss <= 0) return "non-positive max loss (credit meets or exceeds the width)";
  if (spot === undefined || !(spot > 0)) return "no live spot available to verify moneyness";
  const sell = c.legs.find((l) => l.action === "sell");
  if (sell?.type === "put" && sell.strike > spot) {
    return `short put strike ${sell.strike} is above spot ${spot} (in the money - not premium selling)`;
  }
  if (sell?.type === "call" && sell.strike < spot) {
    return `short call strike ${sell.strike} is below spot ${spot} (in the money - not premium selling)`;
  }
  return null;
}

/** Rank verified candidates and allocate contracts under the caps. */
export function sizePlan(
  candidates: HuntCandidate[],
  spots: Record<string, number | undefined>,
  request: HuntRequest,
  now: Date = new Date(),
): HuntPlan {
  const budget = request.budget;
  const perTradeCap = (budget * (request.maxRiskPct ?? 2)) / 100;
  const perUnderlyingCap = (budget * (request.maxUnderlyingPct ?? 25)) / 100;
  const rejected: RejectedCandidate[] = [];
  const scored: SizedTrade[] = [];
  for (const c of candidates) {
    const spot = spots[c.underlying];
    const problem = verifyCandidate(c, spot, now);
    if (problem) {
      rejected.push({ underlying: c.underlying, strategy: c.strategy, reason: problem });
      continue;
    }
    const risk = structureRisk(c)!;
    const prob = Math.min(0.97, Math.max(0.03, c.probability ?? 0.7));
    const ev = round2(prob * risk.maxProfit - (1 - prob) * risk.maxLoss);
    scored.push({
      ...c,
      contracts: 0,
      spot: spot!,
      maxLossPerContract: risk.maxLoss,
      maxProfitPerContract: risk.maxProfit,
      totalRisk: 0,
      totalMaxProfit: 0,
      expectedValue: ev,
      evPerRisk: risk.maxLoss > 0 ? round2((ev / risk.maxLoss) * 1000) / 1000 : 0,
    });
  }
  // Best expected value per dollar of risk first; only positive-EV
  // candidates are sized at all.
  scored.sort((x, y) => y.evPerRisk - x.evPerRisk);
  let totalRisk = 0;
  const byUnderlying = new Map<string, number>();
  const trades: SizedTrade[] = [];
  const unsized: RejectedCandidate[] = [];
  for (const t of scored) {
    if (t.expectedValue <= 0) {
      unsized.push({ underlying: t.underlying, strategy: t.strategy, reason: "negative expected value at the model's own probability estimate" });
      continue;
    }
    const underlyingUsed = byUnderlying.get(t.underlying) ?? 0;
    const room = Math.min(perTradeCap, perUnderlyingCap - underlyingUsed, budget - totalRisk);
    const contracts = Math.floor(room / t.maxLossPerContract);
    if (contracts <= 0) {
      unsized.push({ underlying: t.underlying, strategy: t.strategy, reason: `one contract risks $${t.maxLossPerContract}, over the per-trade cap of $${Math.round(perTradeCap)}` });
      continue;
    }
    t.contracts = contracts;
    t.totalRisk = round2(contracts * t.maxLossPerContract);
    t.totalMaxProfit = round2(contracts * t.maxProfitPerContract);
    t.expectedValue = round2(contracts * t.expectedValue);
    totalRisk = round2(totalRisk + t.totalRisk);
    byUnderlying.set(t.underlying, underlyingUsed + t.totalRisk);
    trades.push(t);
  }
  return {
    trades,
    unsized,
    rejected,
    totalRisk,
    totalMaxProfit: round2(trades.reduce((s, t) => s + t.totalMaxProfit, 0)),
    totalExpectedValue: round2(trades.reduce((s, t) => s + t.expectedValue, 0)),
    unallocated: round2(budget - totalRisk),
  };
}

/**
 * Pull the candidates array out of the model's final answer. The hunt
 * goal instructs the synthesis to end with a fenced ```json block
 * holding an array of candidate objects; be liberal about finding it.
 */
export function parseCandidates(text: string): HuntCandidate[] {
  if (!text) return [];
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  blocks.push(text);
  for (const block of blocks) {
    const start = block.indexOf("[");
    const end = block.lastIndexOf("]");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(block.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      const out: HuntCandidate[] = [];
      for (const raw of parsed) {
        const c = sanitizeCandidate(raw);
        if (c) out.push(c);
      }
      if (out.length) return out;
    } catch {
      // Try the next block.
    }
  }
  return [];
}

function sanitizeCandidate(raw: unknown): HuntCandidate | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") return null;
  const legsRaw = Array.isArray(r.legs) ? r.legs : [];
  const legs: HuntLeg[] = [];
  for (const l of legsRaw) {
    const leg = l as Record<string, unknown>;
    const action = leg?.action === "buy" ? "buy" : leg?.action === "sell" ? "sell" : null;
    const type = leg?.type === "call" ? "call" : leg?.type === "put" ? "put" : null;
    const strike = Number(leg?.strike);
    if (!action || !type || !(strike > 0)) return null;
    legs.push({ action, type, strike });
  }
  const credit = Number(r.credit);
  if (!legs.length || !Number.isFinite(credit)) return null;
  return {
    underlying: String(r.underlying || "").toUpperCase().trim(),
    strategy: String(r.strategy || "spread"),
    legs,
    expiry: String(r.expiry || ""),
    credit,
    probability: r.probability !== undefined ? Number(r.probability) : undefined,
    thesis: String(r.thesis || ""),
    invalidation: String(r.invalidation || ""),
  };
}

/** Extract one symbol's spot from a get_quotes payload, whatever its shape. */
export function extractSpot(payload: unknown, symbol: string): number | undefined {
  const wanted = symbol.toUpperCase();
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const fromObject = (o: Record<string, unknown>): number | undefined => {
    const sym = String(o.symbol ?? o.ticker ?? o.underlying ?? "").toUpperCase();
    if (sym && sym !== wanted) return undefined;
    for (const key of ["last", "lastPrice", "last_price", "price", "mark", "close", "bid"]) {
      const n = num(o[key]);
      if (n !== undefined) return n;
    }
    return undefined;
  };
  const walk = (v: unknown, depth: number): number | undefined => {
    if (depth > 4 || v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      // Table shape: {columns, rows} handled by caller; a bare array of
      // objects or of row arrays.
      for (const item of v) {
        const hit = walk(item, depth + 1);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.rows) && Array.isArray(o.columns)) {
      const cols = (o.columns as unknown[]).map((c) => String(c).toLowerCase());
      const symI = cols.findIndex((c) => /symbol|ticker/.test(c));
      const priceI = cols.findIndex((c) => /^(last|last price|price|mark|close)/.test(c));
      if (priceI >= 0) {
        for (const row of o.rows as unknown[][]) {
          if (symI >= 0 && String(row[symI]).toUpperCase() !== wanted) continue;
          const n = num(row[priceI]);
          if (n !== undefined) return n;
        }
      }
    }
    const direct = fromObject(o);
    if (direct !== undefined) return direct;
    for (const key of ["quotes", "data", "results", "items"]) {
      const hit = walk(o[key], depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(payload, 0);
}

/** The goal handed to the autopilot pipeline for a hunt. */
export function buildHuntGoal(request: HuntRequest): string {
  const symbols = (request.symbols ?? []).filter(Boolean);
  const universe = symbols.length
    ? `these underlyings: ${symbols.join(", ")}`
    : "the account's portfolio underlyings and the desk watchlist (NVDA, AMD, SMH, SPY, QQQ, AAPL, MSFT)";
  const horizon = request.horizonDays ?? 45;
  return [
    `Opportunity hunt: scan ${universe} for premium-selling option trades expiring within about ${horizon} days.`,
    `Planning budget: $${request.budget} total max risk, at most ${request.maxRiskPct ?? 2}% of the budget on any one trade, at most ${request.maxUnderlyingPct ?? 25}% on any one underlying. These are planning constraints for a report - do NOT place or propose any orders.`,
    "For each underlying: get the current quote, then the option chain for a suitable expiry. Prefer defined-risk premium-selling structures: put credit spreads and call credit spreads with the short strike out of the money, and cash-secured puts at or below the current spot. Use real chain figures only - strikes, expiries, bid/ask midpoints for credit, and delta as the probability estimate. Discard illiquid contracts (wide bid/ask, no open interest).",
    "Your final answer must END with a fenced json block holding an array of candidate objects, each exactly:",
    '{"underlying":"NVDA","strategy":"put credit spread","legs":[{"action":"sell","type":"put","strike":200},{"action":"buy","type":"put","strike":195}],"expiry":"YYYY-MM-DD","credit":1.25,"probability":0.72,"thesis":"why this trade, citing the live figures","invalidation":"the price/condition that kills the thesis"}',
    "credit is the net credit per share from the chain midpoints (negative for a debit). Before the json block, summarize the scan in prose: what you looked at, what you discarded and why.",
  ].join("\n");
}

export interface StoredHunt {
  id: string;
  createdAt: string;
  request: HuntRequest;
  model: string;
  runId: string;
  plan: HuntPlan;
  summary: string;
}

export const HUNT_MAX_KEPT = 20;

/** SQL-backed hunt store, mirroring AutopilotRunStore's shape. */
export class HuntStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hunt_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);
  }

  save(hunt: StoredHunt): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO hunt_runs (id, created_at, data) VALUES (?, ?, ?)",
      hunt.id,
      hunt.createdAt,
      JSON.stringify(hunt),
    );
    this.sql.exec(
      "DELETE FROM hunt_runs WHERE id NOT IN (SELECT id FROM hunt_runs ORDER BY created_at DESC LIMIT ?)",
      HUNT_MAX_KEPT,
    );
  }

  list(): StoredHunt[] {
    const rows = [...this.sql.exec("SELECT data FROM hunt_runs ORDER BY created_at DESC LIMIT ?", HUNT_MAX_KEPT)];
    const out: StoredHunt[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data as string) as StoredHunt);
      } catch {
        // Skip a corrupt row rather than failing the list.
      }
    }
    return out;
  }

  get(id: string): StoredHunt | null {
    const rows = [...this.sql.exec("SELECT data FROM hunt_runs WHERE id = ? LIMIT 1", id)];
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].data as string) as StoredHunt;
    } catch {
      return null;
    }
  }
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The printable hunt report (also the PDF source in phase 2). */
export function renderHuntReportHtml(hunt: StoredHunt): string {
  const { plan, request } = hunt;
  const legsOf = (t: SizedTrade) =>
    t.legs.map((l) => `${l.action} ${l.strike}${l.type === "call" ? "C" : "P"}`).join(" / ");
  const tradeRows = plan.trades
    .map(
      (t) => `<tr>
        <td><strong>${esc(t.underlying)}</strong><br><span class="muted">${esc(t.strategy)}</span></td>
        <td>${esc(legsOf(t))}<br><span class="muted">exp ${esc(t.expiry)} · spot ${t.spot}</span></td>
        <td>${t.contracts}</td>
        <td>${money(t.maxProfitPerContract * t.contracts)}</td>
        <td>${money(t.totalRisk)}</td>
        <td>${t.maxLossPerContract ? Math.round((t.maxProfitPerContract / t.maxLossPerContract) * 100) : 0}%</td>
        <td>${esc(t.thesis)}<br><span class="muted">Invalidation: ${esc(t.invalidation)}</span></td>
      </tr>`,
    )
    .join("");
  const rejectRows = [...plan.rejected, ...plan.unsized]
    .map((r) => `<li><strong>${esc(r.underlying)}</strong> (${esc(r.strategy)}): ${esc(r.reason)}</li>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Autopilot Opportunity Hunt — ${esc(hunt.createdAt.slice(0, 10))}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem; color: #111; }
  h1 { font-size: 1.35rem; margin-bottom: 0.25rem; }
  .muted { color: #666; font-size: 0.82rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.85rem; }
  th, td { border: 1px solid #ccc; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  .rollup { display: flex; gap: 1.5rem; flex-wrap: wrap; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.8rem 1rem; }
  .rollup div strong { display: block; font-size: 1.05rem; }
  @media print { body { margin: 1rem; } }
</style></head><body>
<h1>Autopilot Opportunity Hunt</h1>
<p class="muted">Generated ${esc(hunt.createdAt)} · model ${esc(hunt.model)} · report-only — no orders were placed or proposed.</p>
<h2>Plan</h2>
<p>Budget ${money(request.budget)} · per-trade risk cap ${request.maxRiskPct ?? 2}% · per-underlying cap ${request.maxUnderlyingPct ?? 25}% · horizon ~${request.horizonDays ?? 45} days.</p>
<div class="rollup">
  <div><span class="muted">Trades</span><strong>${plan.trades.length}</strong></div>
  <div><span class="muted">Total max risk</span><strong>${money(plan.totalRisk)}</strong></div>
  <div><span class="muted">Total max profit</span><strong>${money(plan.totalMaxProfit)}</strong></div>
  <div><span class="muted">Expected value (model probabilities)</span><strong>${money(plan.totalExpectedValue)}</strong></div>
  <div><span class="muted">Unallocated</span><strong>${money(plan.unallocated)}</strong></div>
</div>
<table>
  <thead><tr><th>Underlying</th><th>Legs</th><th>Contracts</th><th>Max profit</th><th>Max risk</th><th>Return on risk</th><th>Justification</th></tr></thead>
  <tbody>${tradeRows || '<tr><td colspan="7">No candidate survived verification and sizing.</td></tr>'}</tbody>
</table>
${rejectRows ? `<h2>Discarded</h2><ul>${rejectRows}</ul>` : ""}
<h2>Scan summary</h2>
<p>${esc(hunt.summary).replace(/\n/g, "<br>")}</p>
<h2>Provenance &amp; limits</h2>
<p class="muted">Candidates and their figures come from the agent's live Public.com MCP tool calls during this run; every candidate was re-verified in code against the live spot (moneyness, defined-risk structure, expiry) and sized deterministically under the caps above — the model does no sizing arithmetic. Probability estimates are the model's (delta-based) and expected value inherits their error. Prices move; re-run before acting. This report is analysis, not financial advice, and it places no orders: execution, if any, goes through the desk's approval workflow separately.</p>
</body></html>`;
}
