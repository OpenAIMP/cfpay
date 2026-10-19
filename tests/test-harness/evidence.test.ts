/**
 * Evidence-record tests (cfpay #245).
 *
 * Pins the record shape, the NOT_CONFIGURED honesty of the dossier text
 * (never numbers for an unconfigured lane), and the deterministic,
 * length-bounded client test id.
 */

import { describe, expect, it } from "vitest";
import {
  makeClientTestId,
  newEvidenceRecord,
  summarizeEvidence,
  type EvidenceRecord,
} from "../../src/test-harness/evidence";

describe("newEvidenceRecord", () => {
  it("creates a record with both lanes pending and an ISO issuedAt", () => {
    const e = newEvidenceRecord({
      recommendationId: "rec-42",
      strategy: "bull_put",
      underlying: "SPY",
      sizerSpec: { contracts: 1 },
    });
    expect(e.recommendationId).toBe("rec-42");
    expect(e.strategy).toBe("bull_put");
    expect(e.underlying).toBe("SPY");
    expect(e.sizerSpec).toEqual({ contracts: 1 });
    expect(e.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.backtest.state).toBe("pending");
    expect(e.forward.state).toBe("pending");
    expect(e.forward.venueOrderIds).toEqual([]);
    expect(e.live).toBeUndefined();
  });
});

describe("summarizeEvidence honesty", () => {
  function base(): EvidenceRecord {
    return newEvidenceRecord({
      recommendationId: "rec-7",
      strategy: "iron_condor",
      underlying: "SPY",
      sizerSpec: { contracts: 2 },
    });
  }

  it("renders skipped-not-configured lanes as unavailable, never numbers", () => {
    const e = base();
    e.backtest = { state: "skipped-not-configured", provider: "tastytrade-backtest" };
    e.forward = { state: "skipped-not-configured", provider: "alpaca-paper" };
    const text = summarizeEvidence(e);
    expect(text).toContain("not configured — evidence unavailable");
    expect(text).not.toContain("realized P&L");
    expect(text).not.toContain("win rate");
  });

  it("carries the paper-fill optimism caveat for alpaca-paper forward tests", () => {
    const e = base();
    e.backtest.state = "complete";
    e.backtest.provider = "tastytrade-backtest";
    e.backtest.windows = [
      {
        start: "2023-01-01",
        end: "2024-01-01",
        tradeCount: 20,
        winRate: 0.65,
        predictedWinRate: 0.8,
        netPnl: 300,
        avgWin: 40,
        avgLoss: -25,
        notices: [],
      },
    ];
    e.forward.state = "complete";
    e.forward.provider = "alpaca-paper";
    e.forward.enteredAt = "2026-10-18T13:30:00Z";
    e.forward.venueOrderIds = ["order-1"];
    e.forward.outcome = {
      realizedPnl: 45.5,
      holdingDays: 12,
      closeReason: "profit target",
    };
    const text = summarizeEvidence(e);
    expect(text).toContain("systematically optimistic");
    expect(text).toContain("never live performance");
    expect(text).toContain("Backtest (tastytrade-backtest)");
    expect(text).toContain("300.00");
  });

  it("flags modeled-vs-realized win-rate drift in the backtest line", () => {
    const e = base();
    e.backtest.state = "complete";
    e.backtest.provider = "tastytrade-backtest";
    e.backtest.windows = [
      {
        start: "2023-01-01",
        end: "2024-01-01",
        tradeCount: 20,
        winRate: 0.5,
        predictedWinRate: 0.8,
        netPnl: 100,
        avgWin: 40,
        avgLoss: -25,
        notices: [],
      },
    ];
    e.forward.state = "pending";
    const text = summarizeEvidence(e);
    expect(text).toContain("overestimates realized");
  });

  it("renders a failed lane with its error", () => {
    const e = base();
    e.backtest.state = "failed";
    e.backtest.provider = "tastytrade-backtest";
    e.backtest.error = "backtester timed out";
    e.forward.state = "pending";
    const text = summarizeEvidence(e);
    expect(text).toContain("failed — backtester timed out");
  });
});

describe("makeClientTestId", () => {
  it("is deterministic and strategy-sensitive", () => {
    const a = makeClientTestId("rec-42", "bull_put");
    const b = makeClientTestId("rec-42", "bull_put");
    const c = makeClientTestId("rec-42", "bear_call");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^tt-rec-42-[0-9a-f]{8}$/);
  });

  it("stays within the 48-char client_order_id bound even for long ids", () => {
    const longId = "recommendation-".repeat(10); // 150 chars
    const id = makeClientTestId(longId, "iron_condor");
    expect(id.length).toBeLessThanOrEqual(48);
    expect(makeClientTestId(longId, "iron_condor")).toBe(id);
  });
});
