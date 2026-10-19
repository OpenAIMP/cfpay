import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CORRELATION_HEADER,
  accountingEvent,
  aspectsEnabled,
  emitAspectEvent,
  extractTracePart,
  isTraceData,
  mintCorrelationId,
  redactDetail,
  resolveCorrelationId,
  setAspectEventSink,
  setOutcomeLedgerSink,
  withCorrelationHeader,
  withTracePart,
  type AspectEvent,
  type AspectTrace,
} from "../src/aspect-logging";

// Issue #252 (design §2.2/§2.3/§7.1): the logging aspect's event schema,
// correlation propagation, the redaction suite, and the sink interface
// (IAAA "Accounting": console = transport copy, ledger sink = system of
// record).

const trace = (over: Partial<AspectTrace> = {}): AspectTrace => ({
  correlationId: "corr-1",
  tenantId: "operator",
  userId: "operator",
  ...over,
});

let captured: AspectEvent[];
let ledger: AspectEvent[];

beforeEach(() => {
  captured = [];
  ledger = [];
  setAspectEventSink((e) => captured.push(e));
  setOutcomeLedgerSink((e) => ledger.push(e));
});

afterEach(() => {
  setAspectEventSink(null);
  setOutcomeLedgerSink(null);
});

describe("correlation ids", () => {
  it("mints unique uuid-shaped ids", () => {
    const a = mintCorrelationId();
    const b = mintCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("honors an incoming X-Correlation-Id", () => {
    const req = new Request("https://x.test/", {
      headers: { [CORRELATION_HEADER]: "incoming-123" },
    });
    expect(resolveCorrelationId(req)).toBe("incoming-123");
  });

  it("mints when the header is absent or blank", () => {
    expect(resolveCorrelationId(new Request("https://x.test/"))).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    const blank = new Request("https://x.test/", {
      headers: { [CORRELATION_HEADER]: "   " },
    });
    expect(resolveCorrelationId(blank)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("caps an overlong incoming id", () => {
    const req = new Request("https://x.test/", {
      headers: { [CORRELATION_HEADER]: "x".repeat(500) },
    });
    expect(resolveCorrelationId(req)).toHaveLength(128);
  });
});

describe("LOG_ASPECTS kill flag", () => {
  it("is on by default and for arbitrary values", () => {
    expect(aspectsEnabled(undefined)).toBe(true);
    expect(aspectsEnabled(null)).toBe(true);
    expect(aspectsEnabled({})).toBe(true);
    expect(aspectsEnabled({ LOG_ASPECTS: "1" })).toBe(true);
    expect(aspectsEnabled({ LOG_ASPECTS: "true" })).toBe(true);
  });

  it("is off for 0/false/no/off (any case)", () => {
    for (const v of ["0", "false", "FALSE", "no", "off", " 0 "]) {
      expect(aspectsEnabled({ LOG_ASPECTS: v })).toBe(false);
    }
  });

  it("suppresses emission when off", () => {
    emitAspectEvent(
      {
        v: 1,
        ts: "t",
        level: "info",
        tenantId: "operator",
        userId: "operator",
        agent: "api",
        operation: "x",
        correlationId: "c",
        durationMs: 1,
        outcome: "ok",
      },
      { LOG_ASPECTS: "0" },
    );
    expect(captured).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });
});

describe("redaction suite (design §7.1 fixtures)", () => {
  const fixtures: [string, unknown][] = [
    ["presented DASHBOARD_API_KEY", { apiKey: "dash-secret-value-12345" }],
    ["MCP_JWT_SECRET", { jwtSecret: "super-secret-jwt-key" }],
    ["GitHub token", { token: "ghp_abcdefghijklmnopqrstuvwx" }],
    ["GitHub oauth token", "gho_abcdefghijklmnopqrstuvwx"],
    ["Google OAuth code", "4/0AVG7h1AbCdEfGhIjKlMnOpQrStUvWxYz"],
    ["SLACK_BOT_TOKEN", { slackBotToken: "xoxb-1234567890-abcdef" }],
    ["Stripe paymentIntentId", { paymentIntentId: "pi_3P8xYzAbCdEfGh12" }],
    ["raw Authorization header", { Authorization: "Bearer dash-secret-value" }],
    ["raw cookie", { cookie: "app_session=sess_abcdef123456" }],
    ["mail body", { body: "Dear user, your balance is $10" }],
    ["mail subject", { subject: "Your invoice" }],
    ["nested secret", { outer: { inner: { clientSecret: "shhh" } } }],
  ];

  for (const [label, value] of fixtures) {
    it(`redacts ${label}`, () => {
      const out = JSON.stringify(redactDetail(value));
      expect(out).not.toContain("dash-secret-value");
      expect(out).not.toContain("super-secret-jwt-key");
      expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
      expect(out).not.toContain("gho_abcdefghijklmnopqrstuvwx");
      expect(out).not.toContain("xoxb-1234567890-abcdef");
      expect(out).not.toContain("pi_3P8xYzAbCdEfGh12");
      expect(out).not.toContain("sess_abcdef123456");
      expect(out).not.toContain("Dear user");
      expect(out).not.toContain("Your invoice");
      expect(out).not.toContain("shhh");
    });
  }

  it("never throws on hostile input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redactDetail(circular)).not.toThrow();
    expect(() => redactDetail(Object.create(null))).not.toThrow();
  });

  it("keeps non-secret structure intact", () => {
    const out = redactDetail({ operation: "slack.post", count: 3 }) as Record<string, unknown>;
    expect(out).toEqual({ operation: "slack.post", count: 3 });
  });
});

describe("trace parts", () => {
  const body = {
    jsonrpc: "2.0",
    id: "1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        parts: [
          { kind: "text", text: "hello" },
          { kind: "data", data: { operation: "slack.post" } },
        ],
      },
    },
  };

  it("appends the private trace part and round-trips", () => {
    const traced = withTracePart(body, trace()) as typeof body;
    const parts = traced.params.message.parts;
    expect(parts).toHaveLength(3);
    const { trace: back, parts: stripped } = extractTracePart(parts);
    expect(back).toEqual(trace());
    expect(stripped).toHaveLength(2);
    expect(stripped.every((p: unknown) => !isTraceData((p as { data?: unknown }).data))).toBe(
      true,
    );
  });

  it("passes non-message bodies through unchanged", () => {
    expect(withTracePart(null, trace())).toBeNull();
    expect(withTracePart("nope", trace())).toBe("nope");
    expect(withTracePart({ params: {} }, trace())).toEqual({ params: {} });
  });

  it("returns null trace for bodies without one", () => {
    const { trace: t, parts } = extractTracePart([{ kind: "text", text: "x" }]);
    expect(t).toBeNull();
    expect(parts).toHaveLength(1);
  });

  it("does not mutate the original body", () => {
    const before = JSON.stringify(body);
    withTracePart(body, trace());
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("emission", () => {
  const base: AspectEvent = {
    v: 1,
    ts: "2026-10-18T00:00:00.000Z",
    level: "info",
    tenantId: "operator",
    userId: "operator",
    agent: "api",
    operation: "GET /api/test",
    correlationId: "corr-1",
    durationMs: 5,
    outcome: "ok",
  };

  it("delivers to the event sink with detail redacted", () => {
    emitAspectEvent({ ...base, detail: { apiKey: "dash-secret-value-12345" } }, {});
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).not.toContain("dash-secret-value");
    expect(captured[0].correlationId).toBe("corr-1");
  });

  it("feeds outcome events to the ledger sink (one stream, not two)", () => {
    emitAspectEvent(base, {});
    expect(ledger).toHaveLength(1);
    expect(ledger[0].operation).toBe("GET /api/test");
  });

  it("never throws, even with a hostile sink", () => {
    setAspectEventSink(() => {
      throw new Error("sink exploded");
    });
    expect(() => emitAspectEvent(base, {})).not.toThrow();
  });
});

describe("LOG_LEVEL config", () => {
  const info: AspectEvent = {
    v: 1,
    ts: "t",
    level: "info",
    tenantId: "operator",
    userId: "operator",
    agent: "api",
    operation: "x",
    correlationId: "c",
    durationMs: 1,
    outcome: "ok",
  };

  it("defaults to info", () => {
    emitAspectEvent({ ...info, level: "debug" }, {});
    expect(captured).toHaveLength(0);
    emitAspectEvent(info, {});
    expect(captured).toHaveLength(1);
  });

  it("warn suppresses info but passes warn and error", () => {
    const env = { LOG_LEVEL: "warn" };
    emitAspectEvent(info, env);
    emitAspectEvent({ ...info, level: "warn" }, env);
    emitAspectEvent({ ...info, level: "error" }, env);
    expect(captured.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("debug passes everything; unknown values fall back to info", () => {
    emitAspectEvent({ ...info, level: "debug" }, { LOG_LEVEL: "debug" });
    expect(captured).toHaveLength(1);
    emitAspectEvent({ ...info, level: "debug" }, { LOG_LEVEL: "verbose" });
    expect(captured).toHaveLength(1);
  });
});
describe("response header", () => {
  it("stamps the correlation id", () => {
    const res = withCorrelationHeader(new Response("ok"), "corr-9");
    expect(res.headers.get(CORRELATION_HEADER)).toBe("corr-9");
  });

  it("passes websocket upgrades through untouched", () => {
    // A 101 cannot be constructed in undici; the Upgrade header is the
    // equivalent signal and must also pass through.
    const up = new Response("ws", { status: 200, headers: { Upgrade: "websocket" } });
    expect(withCorrelationHeader(up, "corr-9")).toBe(up);
  });
});

describe("accounting events (IAAA)", () => {
  it("authz.deny is a denied warn event in the same shape", () => {
    const e = accountingEvent("authz.deny", {
      tenantId: "operator",
      userId: "operator",
      correlationId: "corr-1",
      authDecision: { relation: "owner", object: "tenant:operator", allow: false },
    });
    expect(e.operation).toBe("authz.deny");
    expect(e.outcome).toBe("denied");
    expect(e.level).toBe("warn");
    expect(e.authDecision).toEqual({
      relation: "owner",
      object: "tenant:operator",
      allow: false,
    });
    // Same shape: the accounting sink persists it unchanged.
    emitAspectEvent(e, {});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual(e);
  });

  it("authz.allow is an ok event", () => {
    const e = accountingEvent("authz.allow", {
      tenantId: "operator",
      userId: "operator",
      correlationId: "corr-1",
    });
    expect(e.outcome).toBe("ok");
    expect(e.level).toBe("info");
  });
});
