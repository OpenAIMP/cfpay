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

/**
 * Source with comments and string literals removed.
 *
 * Guards must assert on code. Matching raw text lets a doc comment satisfy - or
 * violate - a rule about behaviour, which is how the first version of the webhook
 * guards failed on their own module documentation.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

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
      "A2A_WEBHOOK_CARD_PATH",
      "A2A_WEBHOOK_RPC_PATH",
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
      "url.pathname === A2A_WEBHOOK_RPC_PATH",
      "url.pathname === A2A_WEBHOOK_CARD_PATH",
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
    expect(a2a).toContain("export function webhookCard(");
  });

  it("gates every A2A endpoint behind the credential", () => {
    // Three endpoints, three gates. An ungated endpoint spends Workers AI tokens or
    // sends mail on the operator's account.
    const gates = index.match(/a2aAuthorised\(request, env\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(4);
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
    { binding: "WEBHOOK_AGENT", cls: "WebhookAgent" },
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

describe("the Slack boundary is enforced by absence, not by a check", () => {
  const sagent = readCode("src/slack-agent.ts");

  it("exposes no A2A path to posting", () => {
    // The control is the missing switch case. A guard that a check exists would be
    // weaker: a check can be removed or bypassed, an absent operation cannot be.
    expect(sagent).toContain('case "slack.list"');
    for (const forbidden of ["slack.post", "slack.notify", "slack.send"]) {
      const postCase = new RegExp(
        'case "' + forbidden + '":[\\s\\S]{0,200}?await this\\.(postMessage|notifyViaWebhook)',
      );
      expect(sagent, forbidden + " must not map to a write").not.toMatch(postCase);
    }
  });

  it("never returns the bot token from an operation", () => {
    // Scoped to handleA2AMessage, which is the boundary. A file-wide regex is wrong
    // here: the token MUST be readable inside the agent to call Slack at all, so
    // matching any `return ... botToken` flags the private accessor and the status
    // method's field name rather than a disclosure - which is exactly what the first
    // version of this guard did.
    const start = sagent.indexOf("async handleA2AMessage(");
    const end = sagent.indexOf("\n  }\n", sagent.indexOf("default:", start));
    expect(start, "handleA2AMessage must exist").toBeGreaterThan(-1);
    const boundary = sagent.slice(start, end > start ? end : undefined);
    expect(boundary.length).toBeGreaterThan(0);

    // No reference to the credential, or to the accessor that yields it, anywhere on
    // the A2A path. botTokenStatus is fine: it answers whether one exists, not what.
    expect(boundary).not.toMatch(/\.botToken\b/);
    expect(boundary).not.toMatch(/\bbotTokenForUse\b/);
    expect(boundary).toContain("botTokenStatus");

    // The accessor is private, so the only way to use the token is to ask it to post.
    expect(sagent).toContain("private botTokenForUse()");
  });

  it("does not call back into the monolith", () => {
    expect(sagent).not.toMatch(/CfmailAgent\b\s*\./);
    expect(sagent).not.toMatch(/\bsendOutboundEmail\s*\(/);
  });
});
describe("the webhook boundary is enforced in code, not assumed", () => {
  const wagent = readCode("src/webhook-agent.ts");
  const whelpers = read("src/webhooks.ts");

  it("keeps signature verification outside the agent", () => {
    // An A2A caller cannot mint a provider HMAC. If verification ever moved behind
    // the agent, a bearer token would substitute for a provider signature and any
    // credential holder could forge a GitHub or Stripe delivery.
    expect(whelpers).toContain("export async function verifyAndParseWebhook(");
    // Assert on the IMPORT, which is what would actually pull verification in.
    expect(wagent, "the agent must not import verification").not.toMatch(
      /from\s+"\.\/webhooks"/,
    );
    expect(wagent, "the agent must not call verification").not.toMatch(
      /\bverifyAndParseWebhook\s*\(/,
    );
  });

  it("never lets an external caller claim a GitHub delivery id", () => {
    // Honouring a caller-supplied delivery id would let external input suppress a
    // genuine GitHub delivery by pre-registering its id.
    expect(wagent).toContain("webhook.receive");
    // Structural, not prose: the caller's delivery id must never be READ, and the
    // deliveryId slot passed to recordEvent must be undefined. Asserting on a comment
    // broke the moment comments were stripped for the other guards - the comment and
    // the code could have disagreed.
    expect(wagent, "must not read a caller-supplied delivery id").not.toMatch(
      /args\.deliveryId/,
    );
    expect(wagent, "recordEvent must get no delivery id from this path").toMatch(
      /recordEvent\([\s\S]*?args\.payload \?\? null,\s*undefined,\s*undefined,?\s*\)/,
    );
  });

  it("does not call back into the monolith", () => {
    // A callback would deadlock: the monolith's sendOutboundEmail calls EmailAgent,
    // so if cfmail awaited an A2A call to Webhook and Webhook called cfmail, the pair
    // would hang. The resource moved; the fan-out did not.
    // A doc comment naming the monolith is fine; calling it is not.
    expect(wagent, "must not reach the monolith binding").not.toMatch(/CfmailAgent\b\s*\./);
    expect(wagent, "must not send mail itself").not.toMatch(/\bsendOutboundEmail\s*\(/);
    expect(wagent, "must not fulfil payments itself").not.toMatch(/\bhandleStripeWebhook\s*\(/);
  });
});
describe("the agent-tool primitive stays wired", () => {
  // agentTool requires a chat-capable child, which means Think. Think extends Agent, so
  // the @callable() surface and A2A inherited unchanged - which is why both the
  // deterministic path and this dispatch path can coexist.
  const emailAgent = read("src/email-agent.ts");
  const tools = read("src/agent-tools.ts");

  it("re-bases EmailAgent on Think without losing its capability surface", () => {
    expect(emailAgent).toContain("extends Think<")
    // Think's required members. Without them the class does not satisfy the base.
    expect(emailAgent).toContain("override getModel()")
    expect(emailAgent).toContain("override getSystemPrompt()")
    expect(emailAgent).toContain("override getTools()")
    // The re-base must not cost the resource its methods: agentTool dispatches the
    // SAME agent, so every existing caller still has to reach it.
    for (const method of ["recordInbound", "listEmails", "emailTotals", "sendQuota", "sendThroughAgent", "handleA2A"]) {
      expect(emailAgent, method + " must survive the Think re-base").toContain("async " + method + "(")
    }
  });

  it("exposes the email agent through agentTool", () => {
    expect(tools).toContain("agentTool")
    expect(tools).toContain('from "agents/agent-tools"')
    expect(tools).toContain("export const emailAgentTool")
    // The child must be the EmailAgent class, not a lookalike.
    expect(tools).toContain("agentTool<typeof emailInput>(EmailAgent,")
  });
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
