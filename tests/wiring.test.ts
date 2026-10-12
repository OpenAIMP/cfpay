/**
 * Structural regression guards for the multi-agent wiring.
 *
 * These exist because every loss during the multi-agent work was invisible to both
 * the type checker and the unit tests, and was only ever found by a live probe
 * against production:
 *
 *   - getPaymentTotals was deleted while api.ts still called it. The call reached the
 *     Durable Object through an any-typed stub, so the missing method compiled and
 *     passed tests, then failed at runtime with "The RPC receiver does not implement
 *     the method". The dashboard reported 0 with no error shown.
 *   - The email A2A routes were dropped while the agent class, the binding and the
 *     export all survived, so nothing could reach a working agent.
 *   - The whole email-tool wiring disappeared the same way.
 *
 * A missing route and a missing @callable() method are both structurally valid code,
 * so no amount of type checking finds them. Asserting the wiring itself does.
 *
 * These read source files rather than importing the Worker: importing an entrypoint
 * that declares Durable Object classes has side effects, and the point here is to
 * check that declarations still exist, not to exercise behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("agent wiring survives refactors", () => {
  const agent = read("src/agent.ts");

  it("keeps the ledger read and totals methods on the monolith", () => {
    // Both are called by api.ts through an any-typed stub, so their absence cannot be
    // detected by the compiler and shows up only as a runtime RPC error.
    expect(agent).toContain("async getPayments(");
    expect(agent).toContain("async getPaymentTotals(");
    expect(agent).toContain("migrateLegacyPayments");
  });

  it("exposes every RPC-reachable method with @callable()", () => {
    // Without the decorator the method is not on the Durable Object's RPC surface at
    // all, and an any-typed caller cannot tell until it fails at runtime. This is the
    // exact bug that made the dashboard read 0 payments.
    const reachable = ["getPayments", "getPaymentTotals", "getEmails", "sendOutboundEmail"];
    for (const method of reachable) {
      // The decorator must DIRECTLY precede its method. Allowing a gap let a preceding
      // method's @callable() satisfy this, so the check passed with the decorator
      // removed - verified by mutation, which is how the looseness was found.
      const declaration = new RegExp(
        "@callable\\(\\)\\s*async\\s+" + method + "\\s*\\(",
      );
      expect(agent, `${method} must be @callable() or callers fail at runtime`).toMatch(
        declaration,
      );
    }
  });

  it("keeps the email tool wired, not just declared", () => {
    // The definition existing is not enough; the previous loss left the module on disk
    // while every reference to it had been removed from the agent.
    // Both halves: the tool must be DECLARED and DISPATCHED. Checking only for the
    // identifier passed while the dispatch was removed, because the method
    // declaration still contains the name - found by mutation, not by reading.
    expect(agent).toContain("name: emailToolDefinition.name");
    expect(agent).toContain("private async callEmailTool(");
    expect(agent, "the email tool must be dispatched in the tool loop").toContain(
      "await this.callEmailTool(",
    );
    expect(existsSync(join(root, "src/email-tool.ts"))).toBe(true);
    expect(existsSync(join(root, "src/email-agent.ts"))).toBe(true);
  });

  it("does not swallow ledger errors into a silent zero", () => {
    const api = read("src/api.ts");
    // The catch that hid the outage for an unknown length of time. A total that
    // silently becomes 0 is worse than an error, because nothing signals the reader to
    // look further.
    expect(api).not.toMatch(/getPaymentTotals\(\)\s*\r?\n?\s*\.catch\(\(\)\s*=>/);
    expect(api).toContain("getPaymentTotals");
  });
});

describe("A2A routing stays complete", () => {
  const index = read("src/index.ts");
  const a2a = read("src/a2a.ts");

  it("routes every agent's card and endpoint", () => {
    // Each agent needs both halves. A survivor-without-route is the failure mode that
    // left /a2a/email returning 404 for an agent that existed and worked.
    const required = [
      "A2A_CARD_PATHS",
      "A2A_RPC_PATH",
      "A2A_PAYMENTS_CARD_PATH",
      "A2A_PAYMENTS_RPC_PATH",
      "A2A_EMAIL_CARD_PATH",
      "A2A_EMAIL_RPC_PATH",
      "a2aAuthorised",
    ];
    for (const name of required) {
      expect(index, `${name} must be handled in the Worker`).toContain(name);
    }

    // Each agent's card and endpoint must be COMPARED against the request path. A
    // constant that exists but is never matched against url.pathname is exactly the
    // state that left /a2a/email returning 404 while the agent worked.
    const routed = [
      "url.pathname === A2A_RPC_PATH",
      "url.pathname === A2A_PAYMENTS_RPC_PATH",
      "url.pathname === A2A_EMAIL_RPC_PATH",
      "url.pathname === A2A_PAYMENTS_CARD_PATH",
      "url.pathname === A2A_EMAIL_CARD_PATH",
      "A2A_CARD_PATHS.includes(url.pathname)",
    ];
    for (const route of routed) {
      expect(index, `${route} must exist in the router`).toContain(route);
    }
  });

  it("declares a card for all three agents", () => {
    expect(a2a).toContain("export function cfmailCard(");
    expect(a2a).toContain("export function paymentsCard(");
    expect(a2a).toContain("export function emailCard(");
  });

  it("gates every A2A endpoint behind the credential", () => {
    // Three endpoints, three gates. An ungated endpoint spends Workers AI tokens or
    // sends mail on the operator's account.
    const gates = index.match(/a2aAuthorised\(request, env\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(3);
  });
});

describe("every declared agent is reachable", () => {
  const types = read("src/types.ts");
  const wrangler = read("wrangler.jsonc");
  const index = read("src/index.ts");

  // Binding name -> class, the pairing that makes an agent instantiable.
  const agents = [
    { binding: "CfmailAgent", cls: "CfmailAgentSQLite" },
    { binding: "PAYMENTS_AGENT", cls: "PaymentsAgent" },
    { binding: "EMAIL_AGENT", cls: "EmailAgent" },
  ];

  for (const { binding, cls } of agents) {
    it(`${binding} is typed, bound and exported`, () => {
      expect(types, `${binding} must be on Env`).toContain(binding);
      // The binding must name the class Cloudflare should instantiate.
      expect(wrangler).toContain(`"name": "${binding}"`);
      expect(wrangler).toContain(`"class_name": "${cls}"`);
      // A Durable Object class that is not exported from the entrypoint fails to
      // deploy, which is a whole-deploy failure rather than a partial one.
      expect(index, `${cls} must be exported from the entrypoint`).toMatch(
        new RegExp(`export\\s*\\{[^}]*\\b${cls}\\b|export\\s+class\\s+${cls}`),
      );
    });

    it(`${binding} has a migration entry`, () => {
      // A class with no migration cannot be instantiated in production; the error is
      // only visible at deploy or first use. Read the whole migrations array rather
      // than pattern-matching a single entry, so a reformat does not break this.
      // Slice the array itself, not the whole file: every class name also appears in
      // the bindings block, so a whole-file check would pass even with no migration.
      const start = wrangler.indexOf('"migrations"');
      const open = wrangler.indexOf("[", start);
      const close = wrangler.indexOf("\n  ]", open);
      const migrations = start >= 0 && open > start && close > open
        ? wrangler.slice(open, close)
        : "";
      expect(migrations.length, "migrations array must exist").toBeGreaterThan(0);
      expect(migrations, `${cls} must appear in a migration`).toContain(cls);
    });
  }
});

describe("pinned versions stay coherent", () => {
  const pkg = JSON.parse(read("package.json"));

  it("pins the MCP client to the version agents declares as a peer", () => {
    // agents@0.28 peers on this EXACTLY, and its mcp entry points import it directly.
    // A dependabot bump here is not free: it changes the peer graph, and the failure
    // mode is a bundling error that a typecheck does not catch.
    expect(pkg.dependencies["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe("2.0.0");
  });

  it("keeps the dashboard client pinned to the Worker's agents version", () => {
    // If these drift the socket still connects and onStateUpdate silently never fires,
    // so the dashboard goes stale rather than failing.
    const html = read("public/index.html");
    const clientPin = html.match(/agents@([0-9]+\.[0-9]+\.[0-9]+)\/client/);
    expect(clientPin, "the dashboard must import the agents client").not.toBeNull();

    const declared = pkg.dependencies.agents.replace(/^[\^~]/, "");
    expect(
      clientPin?.[1],
      "index.html and package.json must name the same agents version",
    ).toBe(declared);
  });
});
