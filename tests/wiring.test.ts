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

describe("the dashboard explains a spent payment instead of a generic failure", () => {
  const html = read("public/index.html");

  it("handles 409 explicitly", () => {
    // Before this, a 409 fell through to the generic branch, so a user whose FIRST
    // attempt succeeded was told their payment was unusable with no pointer to the
    // request that had been processed.
    expect(html).toContain("response.status === 409");
    expect(html).toMatch(/already been redeemed/);
  });

  it("does not offer a retry that cannot succeed", () => {
    // Re-presenting a spent claim can only produce the same 409, so the branch must
    // clear the pending payment rather than leaving the button offering a retry.
    const at = html.indexOf("response.status === 409");
    const block = html.slice(at, at + 1400);
    expect(block).toContain("pendingPayment = null");
    expect(block, "no continue/retry from a spent claim").not.toContain("continue;");
  });

  it("says what is known rather than what is assumed", () => {
    // A 409 proves the claim was spent, not that this session spent it. The copy must
    // not claim the request succeeded; it points at where to check.
    const at = html.indexOf("response.status === 409");
    const block = html.slice(at, at + 1400);
    expect(block).toMatch(/already processed/);
    expect(block).toMatch(/Payments tab/);
    expect(block, "must not assert success outright").not.toMatch(/success/i);
  });

  it("keeps the document well formed", () => {
    // A div-nesting mistake in this file once made the whole webhooks panel render
    // nothing, because an unclosed div pushed content inside a hidden ancestor.
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const opens = (stripped.match(/<div\b/g) || []).length;
    const closes = (stripped.match(/<\/div>/g) || []).length;
    expect(opens, "open and close div counts must match").toBe(closes);
  });
});
describe("a payment refusal is never reported as an unreachable agent", () => {
  const agent = readCode("src/agent.ts");

  it("itself distinguishes a refusal from an unreachable agent", () => {
    // The money bug: returning null for both meant a REFUSAL fell through to the RPC
    // path and presented the same payment twice. The dashboard then reported "Payment
    // already used" after the first attempt had already been charged and fulfilled.
    // This assertion exists because the fix was written once, lost in a concurrent
    // rewrite of this file, and only rediscovered by a user hitting the error again.
    const start = agent.indexOf("private async callPaymentsAgentOverA2A");
    expect(start, "the A2A client must exist").toBeGreaterThan(-1);
    const end = agent.indexOf("private paymentsAgent(", start);
    expect(end, "the client must end before paymentsAgent").toBeGreaterThan(start);
    const client = agent.slice(start, end);

    expect(client.length).toBeGreaterThan(0);
    expect(client, "must recognise the canonical reuse phrase").toMatch(
      /already been used|already been redeemed/,
    );
    expect(client, "must rethrow the prefix api.ts maps to 409").toContain(
      "PAYMENT_CLAIM_REUSED_PREFIX",
    );
    expect(client, "must return other refusals as data, not null").toMatch(
      /error: "refused"/,
    );
  });

  it("does not retry an explicit refusal over the RPC path", () => {
    // Falling through on a refusal presents the same payment to the same ledger again.
    const start = agent.indexOf("async processPaidRequest(");
    const proc = agent.slice(start, start + 4000);
    expect(proc, "a refusal must be raised, not retried").toMatch(
      /if \(data && data\.error\) \{[\s\S]{0,200}?throw new Error/,
    );
  });

  it("keeps no NUL bytes in any source file", () => {
    // Stray U+0000 made git treat agent.ts as BINARY, so `git diff` showed nothing for
    // it and three regressions in that file went unseen. A binary-looking source file
    // is what let the fix above vanish without a reviewable diff.
    for (const f of [
      "src/agent.ts",
      "src/api.ts",
      "src/email-agent.ts",
      "src/payments-agent.ts",
      "src/webhook-agent.ts",
      "src/slack-agent.ts",
      "src/index.ts",
      "src/a2a.ts",
    ]) {
      const raw = read(f);
      expect(raw.includes("\u0000"), f + " must not contain a NUL byte").toBe(false);
    }
  });
});
describe("every capability agent is a tool, and the model cannot spend by default", () => {
  const tools = readCode("src/agent-tools.ts");
  const host = readCode("src/agent.ts");
  const schemas = readCode("src/agent-tool-schemas.ts");

  it("declares a tool for all four capability agents", () => {
    for (const t of ["emailAgentTool", "paymentAgentTool", "webhookAgentTool", "slackAgentTool"]) {
      expect(tools, t + " must exist").toContain("export const " + t);
    }
    // Each must target the real class, not a lookalike.
    for (const cls of ["EmailAgent", "PaymentsAgent", "WebhookAgent", "SlackAgent"]) {
      // A regex rather than string surgery, which is how the first version broke.
      expect(tools, "must dispatch " + cls).toMatch(
        new RegExp("agentTool<[^>]*>\\(\\s*" + cls + "\\s*,"),
      );
    }
  });

  it("gates the payments tool behind an explicit opt-in", () => {
    // paymentAgentTool can run payment.process. Putting it in the tool list without a
    // gate would let the model choose to execute a paid request, which is authority
    // rather than convenience.
    expect(host).toContain("AGENT_TOOL_ALLOW_PAYMENTS");
    expect(host).toMatch(/AGENT_TOOL_ALLOW_PAYMENTS\s*===\s*"true"/);
    // Fail-closed: the payments spec must be inside the gate, not before it.
    const gateAt = host.indexOf('AGENT_TOOL_ALLOW_PAYMENTS === "true"');
    const paySpecAt = host.indexOf('name: "paymentAgent"');
    const emailSpecAt = host.indexOf('name: "emailAgent"');
    expect(gateAt, "the gate must exist").toBeGreaterThan(-1);
    expect(paySpecAt, "the payments spec must exist").toBeGreaterThan(-1);
    expect(gateAt, "the payments tool must be INSIDE the gate").toBeLessThan(paySpecAt);
    expect(emailSpecAt, "the ungated tools come first").toBeLessThan(gateAt);
  });

  it("keeps the Slack tool read-only", () => {
    // A model must not be able to reach a Slack post through a dispatched tool. The
    // control is the absent operation, not a check inside the child.
    const start = schemas.indexOf("slackAgentToolSchema");
    const block = schemas.slice(start, start + 700);
    for (const write of ["post", "send", "notify"]) {
      expect(block, "slack schema must not offer " + write).not.toMatch(
        new RegExp('"' + write + '\\.'),
      );
    }
  });

  it("dispatches through the framework primitive, not a bespoke call", () => {
    // runAgentTool is the framework's own dispatch: it owns the run registry, the child
    // chat turn and cancellation. A hand-rolled RPC call here would lose all three.
    expect(host).toContain("runAgentTool(target.cls");
    expect(host).toContain("AGENT_TOOL_DISPATCH");
    for (const name of ["emailAgent", "paymentAgent", "webhookAgent", "slackAgent"]) {
      expect(host, name + " must be routable").toContain(name + ":");
    }
  });

  it("reports every terminal status rather than an empty result", () => {
    // runAgentTool reports terminal states instead of throwing, so a silent empty
    // return would look to the model like success with no output.
    for (const status of ['"completed"', '"aborted"', '"interrupted"']) {
      expect(host).toContain("run.status === " + status);
    }
  });

  it("keeps every capability agent chat-capable", () => {
    // agentTool requires a chat-capable child, which is what Think supplies. All four
    // capability agents must be re-based or the tool cannot dispatch them.
    for (const f of ["src/payments-agent.ts", "src/webhook-agent.ts", "src/slack-agent.ts", "src/email-agent.ts"]) {
      expect(readCode(f), f + " must extend Think").toContain("extends Think<");
      expect(readCode(f), f + " needs the Think surface").toContain("override getModel()");
    }
  });
});
describe("chat is an operation, not a resource-less agent", () => {
  const agent = readCode("src/agent.ts");

  it("stays read-only: chat cannot act on any resource", () => {
    // Chat owns no state, so making it a fifth agent would mean a Durable Object with
    // nothing authoritative in it. It is an operation instead, and the operation must
    // not become a back door to the writes the other agents deliberately withhold.
    const start = agent.indexOf("async handleA2AMessage(");
    expect(start, "handleA2AMessage must exist").toBeGreaterThan(-1);
    const boundary = agent.slice(start, agent.indexOf("\n  async chat(", start));
    expect(boundary.length).toBeGreaterThan(0);

    for (const write of ["sendOutboundEmail", "notifySlack", "sendWebhook", "payExternalEndpoint"]) {
      expect(boundary, "chat must not call " + write).not.toMatch(
        new RegExp("\\b" + write + "\\s*\\("),
      );
    }
  });

  it("routes the three chat operations and refuses anything else", () => {
    const start = agent.indexOf("async handleA2AMessage(");
    const boundary = agent.slice(start);
    for (const op of ['case "chat.summary"', 'case "chat.facts"', 'case "chat.send"']) {
      expect(boundary).toContain(op);
    }
    expect(boundary).toContain("unknown_operation");
  });

  it("offers a path with no model in it", () => {
    // chat.facts returns the numbers with no inference, so a caller that wants a figure
    // does not have to pay for a model turn to get it - and cannot get a misphrased one.
    const start = agent.indexOf('case "chat.facts"');
    const end = agent.indexOf("case ", start + 10);
    const factsCase = agent.slice(start, end > start ? end : start + 400);
    expect(factsCase).toContain("a2aSnapshot");
    expect(factsCase).not.toMatch(/AI\.run|answerAboutState/);
  });

  it("keeps the plumbing helper that a card rewrite once deleted", () => {
    // A greedy edit removed isAsyncIterable along with a card. It compiled in tests,
    // which read files, and only failed at type check - the build is the guard.
    expect(read("src/a2a.ts")).toContain("function isAsyncIterable");
  });
});
describe("the email migration cannot double-count or absorb Slack", () => {
  const agent = readCode("src/agent.ts");
  const eagent = readCode("src/email-agent.ts");

  it("backfills once, guarded by a marker", () => {
    // The guard is a stored marker, not a per-read run. Without it every read would
    // re-adopt the monolith's history, which is the duplicate the migration exists to
    // avoid.
    expect(agent).toContain("emailsBackfilledAt");
    expect(agent).toMatch(/if\s*\(\(state as any\)\.emailsBackfilledAt\)\s*return/);
    expect(agent).toContain("migrateLegacyEmails");
  });

  it("keeps the marker unset when the backfill fails, so it retries", () => {
    // Marking a failed migration as done would strand the history permanently. The
    // marker is set on the success path only.
    const fn = agent.slice(
      agent.indexOf("private async migrateLegacyEmails"),
      agent.indexOf("async getEmailTotals"),
    );
    expect(fn).toMatch(/catch[\s\S]*?console\.error/);
    expect(fn, "the marker must be set only inside try").not.toMatch(
      /catch[\s\S]{0,200}?emailsBackfilledAt: new Date/,
    );
  });

  it("never adopts Slack messages into the mail resource", () => {
    // Slack conversations live in the monolith's emails[] with a slack: sender. Adopting
    // them here would recreate exactly the trap this split removes: every consumer of
    // mail having to filter them out.
    expect(eagent).toMatch(/startsWith\("slack:"\)/);
    const backfill = eagent.slice(
      eagent.indexOf("async backfillEmails"),
      eagent.indexOf("/* -------------------------------- send"),
    );
    expect(backfill).toContain("skipped++");
  });

  it("exposes the email totals method with @callable()", () => {
    // Reached through an any-typed stub from api.ts, so a missing decorator fails at
    // runtime with no build signal - the exact bug that made the dashboard read 0
    // payments.
    expect(agent).toMatch(/@callable\(\)\s*async getEmailTotals\s*\(/);
  });
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
