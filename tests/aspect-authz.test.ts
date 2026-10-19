import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  checkAuthz,
  declarationCount,
  emitAuthzDecision,
  findHttpDeclaration,
  findOperationDeclaration,
  identityFromTrace,
  resolveAuthzIdentity,
  type AuthzDeclaration,
} from "../src/aspect-authz";
import {
  setAspectEventSink,
  setOutcomeLedgerSink,
  type AspectEvent,
} from "../src/aspect-logging";
import { instanceFor, tenantIdFor, userIdFor } from "../src/tenancy";

// Issue #252 (design §2.4/§4): the authorization aspect's seam is live in
// P1 with the owner-tenant bootstrap; the tuple graph populates in P2/P3.
// Deny-by-default is structural.

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

describe("identity resolution (P1)", () => {
  it("resolves to the operator tenant", () => {
    expect(resolveAuthzIdentity()).toEqual({
      kind: "operator",
      tenantId: "operator",
      userId: "operator",
      role: "operator",
    });
  });

  it("a trace for the operator tenant binds the operator", () => {
    const id = identityFromTrace({
      correlationId: "c",
      tenantId: "operator",
      userId: "operator",
    });
    expect(id.role).toBe("operator");
  });

  it("a non-operator trace binds a viewer (deny-by-default)", () => {
    const id = identityFromTrace({
      correlationId: "c",
      tenantId: "tenant_x",
      userId: "usr_x",
    });
    expect(id.role).toBe("viewer");
  });
});

describe("checks (P1)", () => {
  const decl: AuthzDeclaration = {
    objectType: "scheduled_goal",
    objectId: "42",
    relation: "owner",
  };

  it("the operator is allowed on every declaration", () => {
    const check = checkAuthz(resolveAuthzIdentity(), decl);
    expect(check.allow).toBe(true);
    expect(check.decision).toEqual({
      relation: "owner",
      object: "scheduled_goal:42",
      allow: true,
    });
  });

  it("a non-operator identity is denied", () => {
    const check = checkAuthz(
      { kind: "session", tenantId: "tenant_x", userId: "usr_x", role: "viewer" },
      decl,
    );
    expect(check.allow).toBe(false);
    expect(check.decision.allow).toBe(false);
  });
});

describe("declaration register", () => {
  it("declares the HTTP check points", () => {
    expect(findHttpDeclaration("POST", "/api/public/trades/:id/decision")).toMatchObject({
      objectType: "trade_proposal",
      relation: "approver",
    });
    expect(findHttpDeclaration("POST", "/api/dashboard/scheduled-goals")).toMatchObject({
      objectType: "tenant",
      relation: "owner",
    });
    expect(findHttpDeclaration("DELETE", "/api/dashboard/scheduled-goals/:id")).toMatchObject({
      objectType: "scheduled_goal",
      relation: "owner",
    });
    expect(findHttpDeclaration("POST", "/api/dashboard/autopilot/objective")).toBeTruthy();
    expect(findHttpDeclaration("POST", "/api/dashboard/mcp/tokens")).toBeTruthy();
  });

  it("returns null for undeclared routes", () => {
    expect(findHttpDeclaration("GET", "/api/errors.json")).toBeNull();
  });

  it("declares the operation check points (activated P2/P3)", () => {
    expect(findOperationDeclaration("cfpay_autopilot_run_cycle")).toMatchObject({
      relation: "actor_for",
    });
    expect(findOperationDeclaration("orchestrator.run")).toMatchObject({ relation: "owner" });
    expect(findOperationDeclaration("slack.post")).toMatchObject({ relation: "owner" });
  });

  it("carries the full register (5 HTTP + 3 operations)", () => {
    expect(declarationCount()).toBe(8);
  });
});

describe("authz decisions are accounting events", () => {
  const decl: AuthzDeclaration = {
    objectType: "tenant",
    objectId: "operator",
    relation: "owner",
  };

  it("an allow emits authz.allow in the AspectEvent shape", () => {
    const identity = resolveAuthzIdentity();
    const check = checkAuthz(identity, decl);
    emitAuthzDecision(identity, decl, check, { correlationId: "corr-1", env: {} });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      operation: "authz.allow",
      outcome: "ok",
      correlationId: "corr-1",
      authDecision: { relation: "owner", object: "tenant:operator", allow: true },
    });
    // Same shape reaches the accounting sink unchanged.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual(captured[0]);
  });

  it("a deny emits authz.deny with the deny trail", () => {
    const identity = {
      kind: "session" as const,
      tenantId: "tenant_x",
      userId: "usr_x",
      role: "viewer" as const,
    };
    const check = checkAuthz(identity, decl);
    emitAuthzDecision(identity, decl, check, { correlationId: "corr-2", env: {} });
    expect(captured[0]).toMatchObject({
      operation: "authz.deny",
      outcome: "denied",
      level: "warn",
      authDecision: { allow: false },
    });
    expect(ledger).toHaveLength(1);
  });
});

describe("tenancy skeleton (P1)", () => {
  it("the operator tenant is the only tenant", () => {
    expect(tenantIdFor()).toBe("operator");
    expect(userIdFor()).toBe("operator");
  });

  it("instanceFor is the identity on the operator tenant", () => {
    expect(instanceFor("scheduler")).toBe("scheduler");
    expect(instanceFor("scheduler", "operator")).toBe("scheduler");
  });

  it("instanceFor namespaces future tenants", () => {
    expect(instanceFor("scheduler", "usr_9f3a")).toBe("scheduler:usr_9f3a");
  });
});
