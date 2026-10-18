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
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

describe("ChatAgent owns the conversation resource", () => {
  const chat = readCode("src/chat-agent.ts");
  const agent = readCode("src/agent.ts");
  const tools = readCode("src/agent-tools.ts");
  const a2a = readCode("src/a2a.ts");
  const index = readCode("src/index.ts");

  it("is a full peer: Think, tool, A2A", () => {
    expect(chat, "must be a Think child").toContain("extends Think<");
    expect(chat).toContain("override getModel()");
    expect(chat).toContain("override getSystemPrompt()");
    expect(chat).toContain("override getTools()");
    expect(tools).toMatch(/agentTool<[^>]*>\(\s*ChatAgent\s*,/);
    expect(chat).toContain("async handleA2A(");
    expect(a2a).toContain("export function chatCard(");
    expect(index).toContain("A2A_CHAT_RPC_PATH");
    expect(index).toContain("A2A_CHAT_CARD_PATH");
  });

  it("does not call a model in its own reply path", () => {
    // The host owns model policy and the tool loop. A reply assembled here would have to
    // dispatch sibling agents from a sub-agent, which is a graph nobody can reason about.
    expect(chat, "must not run inference").not.toMatch(/AI\.run\(/);
  });

  it("does not call back into the monolith", () => {
    // cfmail's sendOutboundEmail reaches EmailAgent, so a callback while cfmail awaited an
    // A2A call here would deadlock the pair.
    expect(chat).not.toMatch(/CfmailAgent\b\s*\./);
    expect(chat).not.toMatch(/\bsendOutboundEmail\s*\(/);
  });

  it("keeps transcripts behind an explicit sender", () => {
    // A summary cannot leak a conversation by accident; a transcript has to be asked for.
    const start = chat.indexOf('case "chat.transcript"');
    const block = chat.slice(start, start + 700);
    expect(block).toContain("missing_sender");
    expect(block).toMatch(/if \(!senderId\)/);
  });

  it("does not put message bodies in the A2A summary", () => {
    // The summary may COUNT histories; it must not return their contents. Banned are
    // the array itself and the per-message fields, not the word - which appears
    // legitimately as `Object.keys(s.histories).length`. Testing for the word rather
    // than the property failed this guard on correct code.
    const start = chat.indexOf("async a2aSnapshot(");
    const end = chat.indexOf("async handleA2A(", start);
    const snap = chat.slice(start, end);
    expect(snap).toContain("senders");
    expect(snap, "must not return the history array").not.toMatch(/return[\s\S]*?histories\s*[,}]/);
    for (const field of ["content", "role", "timestamp"]) {
      expect(snap, "summary must not carry " + field).not.toMatch(
        new RegExp("\\b" + field + "\\b"),
      );
    }
  });

  it("is reached by dispatch, not by a bespoke hop", () => {
    // Chat is registered like every other capability agent, so the host reaches it the
    // same way. A separate RPC path would be the inconsistency this agent removes.
    expect(agent, "must be in the dispatch registry").toMatch(/chatAgent: \{ cls: ChatAgent/);
    expect(agent, "must be advertised").toContain('name: "chatAgent"');
    expect(agent, "must leave the model's tool set unpolluted").toContain("chatAgent: chatAgentTool");
  });

  it("delegates history reads and writes to the owner", () => {
    expect(agent, "must read history from the chat agent").toContain("await chatStub.getHistory(");
    expect(agent, "must write the turn there").toContain("await chatStub.recordTurn(");
    expect(agent).toContain("private chatAgent()");
    expect(agent).toContain("migrateLegacyChatHistory");
  });
});
describe("the chat path actually dispatches the capability agents", () => {
  const agent = readCode("src/agent.ts");

  it("runs a tool loop rather than a single model call", () => {
    // The agents were wired into getTools() and the tool list while nothing in the chat
    // path ever called runAgentTool, so they were offered but never used. A single model
    // call would answer a ledger question from the prompt instead of from the ledger.
    const start = agent.indexOf("async generateAIResponse(");
    const end = agent.indexOf("private isEmailCaptureMode(", start);
    expect(start).toBeGreaterThan(-1);
    const body = agent.slice(start, end);

    expect(body, "must loop").toMatch(/for \(let turn = 0; turn < \d+; turn\+\+\)/);
    expect(body, "must dispatch agent tools").toMatch(/await this\.dispatchAgentTool\(/);
    expect(body, "must normalise tool calls").toContain("normaliseToolCalls");
    expect(body, "must feed results back").toMatch(/role: "tool"/);
  });

  it("echoes the model's own tool calls back unchanged", () => {
    // Re-shaping them is what fails validation with AiError 8007.
    const start = agent.indexOf("async generateAIResponse(");
    const body = agent.slice(start, start + 7000);
    expect(body).toMatch(/tool_calls: toolCalls/);
  });

  it("does not hand the fallback model the tools", () => {
    // The fallback is a smaller model. A failed tool round should degrade to plain text,
    // not to a different set of capabilities the operator did not choose.
    const start = agent.indexOf("async generateAIResponse(");
    const body = agent.slice(start, start + 7000);
    const fallbackAt = body.indexOf("falling back without tools");
    expect(fallbackAt).toBeGreaterThan(-1);
    const after = body.slice(fallbackAt, fallbackAt + 400);
    expect(after, "the fallback call must omit tools").not.toContain("tools: toolSpecs");
  });

  it("names an unknown tool instead of returning an empty result", () => {
    const body = agent.slice(agent.indexOf("async generateAIResponse("), agent.indexOf("private isEmailCaptureMode("));
    expect(body).toContain("No such tool: ");
  });

  it("bounds the loop and says so rather than returning nothing", () => {
    const body = agent.slice(agent.indexOf("async generateAIResponse("), agent.indexOf("private isEmailCaptureMode("));
    expect(body).toMatch(/turn === \d+/);
    expect(body).toMatch(/ran out of steps/);
  });
});
describe("the tool list and the dispatch registry cannot drift apart", () => {
  const agent = readCode("src/agent.ts");

  it("registers a dispatch entry for every advertised agent tool", () => {
    // These are two halves of one wiring. QAAgent was added to the tool list and not to
    // the registry, so a model that called it fell through to the MCP path and failed as
    // an unknown tool: advertised but unreachable, which reads to a user as a broken agent.
    const advertised = [...agent.matchAll(/name: "(\w+Agent)"/g)].map((m) => m[1]);
    const registered = [...agent.matchAll(/^\s{2}(\w+Agent): \{ cls:/gm)].map((m) => m[1]);

    expect(advertised.length, "the tool list must advertise something").toBeGreaterThan(0);
    for (const name of advertised) {
      expect(registered, name + " is advertised but has no dispatch entry").toContain(name);
    }
  });

  it("points every registry entry at a class that exists", () => {
    // A registry entry naming a class that does not exist fails at runtime, not at build
    // time, because runAgentTool receives the class as a value.
    //
    // Search the source directory rather than deriving a filename: my first version
    // converted the class name to kebab case, which turned QAAgent into qaagent.ts and
    // reported a missing file for a class that is plainly there. Deriving a path from a
    // name is a guess; looking for the declaration is a check.
    const files = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
    const allSource = files.map((f) => readCode("src/" + f)).join("\n");

    const registered = [...agent.matchAll(/cls: (\w+?),/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    for (const cls of registered) {
      expect(allSource, cls + " must be declared somewhere in src").toMatch(
        new RegExp("class " + cls + "\\b"),
      );
    }
  });
});
describe("QAAgent is a full peer, and the chat rename holds", () => {
  const qa = readCode("src/qa-agent.ts");
  const tools = readCode("src/agent-tools.ts");
  const a2a = readCode("src/a2a.ts");
  const index = readCode("src/index.ts");
  const agent = readCode("src/agent.ts");

  it("is chat-capable, dispatchable, and A2A-reachable", () => {
    expect(qa, "must be a Think child").toContain("extends Think<");
    expect(qa).toContain("override getModel()");
    expect(qa).toContain("override getSystemPrompt()");
    expect(qa).toContain("override getTools()");
    expect(tools, "must be a tool target").toMatch(/agentTool<[^>]*>\(\s*QAAgent\s*,/);
    expect(qa, "must answer A2A").toContain("async handleA2A(");
    expect(a2a).toContain("export function qaCard(");
    for (const p of ['"A2A_QA_CARD_PATH"', '"A2A_QA_RPC_PATH"', '"url.pathname === A2A_QA_RPC_PATH"']) {
      expect(index, "route must exist: " + p).toContain(p.replace(/"/g, ""));
    }
  });

  it("keeps the A2A summary free of screenshots", () => {
    // A QA result carries a base64 screenshot. Returning that from a status call would be
    // megabytes nobody asked for, so the summary must report state, not payload.
    const start = qa.indexOf("async a2aSnapshot(");
    const end = qa.indexOf("async handleA2A(", start);
    const snap = qa.slice(start, end);
    expect(snap).toContain("lastOk");
    expect(snap, "must not return the screenshot in the summary").not.toContain("screenshot");
  });

  it("refuses a non-http(s) URL rather than guessing", () => {
    const start = qa.indexOf('case "qa.check"');
    const block = qa.slice(start, start + 700);
    expect(block).toMatch(/https\?:/);
    expect(block).toContain("bad_url");
  });

  it("keeps Think's chat and the dashboard's chat RPC separate", () => {
    // Think declares chat(userMessage, callback): Promise<void>. The dashboard's call is
    // request/response. Overriding Think's would keep the name and lose the framework's
    // chat machinery, so the two must not collide.
    expect(agent, "the RPC must not be named chat").not.toMatch(/^\s*async chat\(/m);
    expect(agent).toContain("async chatRpc(");
    expect(agent).toMatch(/@callable\(\)\s*async chatRpc\(/);
  });

  it("keeps the monolith a tool host and a Think agent", () => {
    expect(agent).toContain("extends Think<");
    expect(agent).toContain("override getTools(): ToolSet");
    // The host's own tool set must list the same children the custom loop advertises,
    // or the two dispatch paths drift.
    for (const t of ["emailAgentTool", "webhookAgentTool", "slackAgentTool", "qaAgentTool"]) {
      expect(agent, "tool set must include " + t).toContain(t);
    }
  });
});
describe("the send-email page agrees with the agent's response shape", () => {
  const html = read("public/index.html");
  const agent = readCode("src/email-agent.ts");
  const api = readCode("src/api.ts");

  it("reads `ok`, which is what sendThroughAgent returns", () => {
    // The UI checked `res.success` while the agent resolves to { ok, emailId, remaining,
    // error }. A field the server never sends meant every successful send was reported as a
    // failure, which invites a retry of something that already happened.
    const start = html.indexOf("async function sendEmail()");
    const block = html.slice(start, start + 1800);
    expect(agent).toMatch(/sendThroughAgent\(\s*input[\s\S]{0,400}?Promise<\{ ok: boolean/);
    expect(block, "must check ok").toMatch(/if \(res\.ok\)/);
    expect(block, "must not check a field the server does not send").not.toMatch(/res\.success/);
  });

  it("passes attachments through to the agent", () => {
    // The route originally dropped them: the request carried a list and the handler read
    // only to, subject and body, so a file was silently not sent.
    const start = api.indexOf('app.post("/api/dashboard/send-email"');
    const block = api.slice(start, start + 1400);
    expect(block, "the route must forward attachments").toContain("attachments: body.attachments");
    expect(block, "and reach the agent that supports them").toContain("emailAgentStub");
  });

  it("does not use an un-awaited getAgentByName", () => {
    // getAgentByName resolves to Promise<DurableObjectStub<T>>. Used without await, the stub
    // is a Promise and the method call on it is undefined - a type error and a runtime throw.
    // This mistake appeared in three files today; each is asserted here.
    for (const [file, src] of [
      ["src/api.ts", api],
      ["src/qa-agent.ts", readCode("src/qa-agent.ts")],
    ]) {
      const stray = [...src.matchAll(/=\s*getAgentByName\(/g)];
      for (const m of stray) {
        const lineStart = src.lastIndexOf("\n", m.index ?? 0) + 1;
        const line = src.slice(lineStart, (m.index ?? 0) + 40);
        expect(line, file + " line must await: " + line.trim()).toMatch(/await\s+getAgentByName/);
      }
    }
  });

  it("reports a refusal reason rather than a bare apology", () => {
    // A rate limit names its retry window and an oversized attachment names its size.
    const start = html.indexOf("async function sendEmail()");
    expect(start, "sendEmail must exist").toBeGreaterThan(-1);
    // Anchored on the next function rather than a character count: my first version used
    // a 2000-char window, the branch sat at 2100, and the guard reported a missing detail
    // that was plainly there.
    const next = html.indexOf("// Show selected file names", start);
    const block = html.slice(start, next > start ? next : undefined);
    expect(block, "must surface the agent's error text").toMatch(/res\.error/);
  });

  it("states the attachment limits before a file is chosen", () => {
    expect(html).toMatch(/Up to 5 files/);
  });
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
    // End anchor must be a method that exists. When this was `async chat(` and the
    // method was renamed, indexOf returned -1 and the slice covered nearly the whole
    // file - so the guard failed on unrelated code rather than on the boundary.
    const end = agent.indexOf("\n  async chatRpc(", start);
    expect(end, "the chat boundary must be locatable").toBeGreaterThan(start);
    const boundary = agent.slice(start, end);
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
describe("the Slack A2A boundary (owner's decision, issue #188)", () => {
  const sagent = readCode("src/slack-agent.ts");

  it("exposes posting over A2A: channel posts via the bot, no channel via the webhook", () => {
    // Posting over A2A was refused by name until the owner enabled
    // it (issue #188). This guard pins the NEW behavior so the
    // mapping cannot silently disappear again.
    expect(sagent).toContain('case "slack.list"');
    expect(sagent).toMatch(/case "slack\.post":[\s\S]{0,900}?await this\.postMessage/);
    expect(sagent).toMatch(/case "slack\.post":[\s\S]{0,900}?await this\.notifyViaWebhook/);
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

describe("the QA agent and the dashboard agree on their contract", () => {
  // These guards exist because the mismatch they cover was invisible to both the
  // compiler and the existing tests. QAAgent seeded the browser's localStorage
  // with "cfpay_api_key" while public/index.html reads "cfmail_api_key", so every
  // authenticated QA check rendered the login page and then asserted against that
  // login page's text. The check could not fail for the reason it existed, and
  // could pass without verifying anything.
  //
  // A key name and a DOM id are strings, so no type check can relate the two
  // files. Asserting the contract is the only thing that catches a drift.
  const qa = read("src/qa-agent.ts");
  const html = read("public/index.html");

  it("seeds the same localStorage key the dashboard reads", () => {
    const declared = qa.match(/DASHBOARD_API_KEY_STORAGE_KEY\s*=\s*"([^"]+)"/);
    expect(declared, "qa-agent.ts must declare the storage key as a constant").not.toBeNull();
    const key = declared?.[1] as string;

    // The dashboard must read that exact key. getItem is the read path that
    // matters: a set the dashboard never reads is the original bug.
    expect(html, `index.html must read localStorage key "${key}"`).toContain(
      `localStorage.getItem('${key}')`,
    );

    // ...and QAAgent must not seed a different key anywhere. This is the precise
    // regression: a second, hard-coded key name that the dashboard ignores.
    const seeded = [...qa.matchAll(/localStorage\.setItem\(\s*(?:"([^"]+)"|([A-Z_]+))/g)]
      .map((m) => m[1] ?? m[2])
      .filter((name) => name !== "DASHBOARD_API_KEY_STORAGE_KEY");
    expect(seeded, "qa-agent.ts must not hard-code a second localStorage key").toEqual([]);
  });

  it("checks the containers the dashboard actually populates", () => {
    // The tab check counts rows inside these container ids and treats the paired
    // empty-state text as a failure. If a container is renamed in index.html the
    // check would report "container missing" - true, but it would no longer be
    // measuring the thing it was written to measure.
    const contract: [string, string][] = [
      ["emailList", "No emails yet"],
      ["paymentList", "No payments yet"],
      ["webhookList", "No webhook events yet"],
    ];

    for (const [containerId, emptyText] of contract) {
      expect(qa, `the tab check must probe #${containerId}`).toContain(`containerId: "${containerId}"`);
      expect(html, `index.html must contain #${containerId}`).toContain(`id="${containerId}"`);
      expect(html, `index.html must still emit "${emptyText}"`).toContain(emptyText);
    }
  });

  it("keeps the tab check from passing on page-wide text alone", () => {
    // The old implementation scraped the whole document for words like "Payment"
    // and treated any hit as a pass. Those words live in the tab bar, so the
    // check passed on an empty or unauthenticated page. Guard against a return to
    // that shape: the tab check must count rendered rows.
    expect(qa).toContain("el.querySelectorAll('.card, .item').length");
    // And it must still report the login page explicitly rather than reporting a
    // missing container, which hides the real cause.
    expect(qa).toContain("Dashboard showed the login page");
  });
});

describe("the QA surface stays fully wired", () => {
  // The recurring failure in this area is a declaration that goes missing while
  // the code around it survives: a method body without its @callable() (which
  // broke CI outright), a QA method with no route, an agent method behind an
  // any-typed stub that no type check can relate to its caller. Source
  // assertions are what catch that.
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const html = read("public/index.html");

  /** Every @callable() must be IMMEDIATELY followed by its method signature. */
  it("keeps every @callable() attached to a method declaration", () => {
    const lines = qa.split("\n");
    const decorators = lines
      .map((line, i) => ({ line: line.trim(), i }))
      .filter((e) => e.line === "@callable()");
    expect(decorators.length).toBeGreaterThan(0);

    for (const { i } of decorators) {
      // No gap allowed: a blank line here means a body was orphaned, which is
      // exactly how the class stopped parsing.
      const next = (lines[i + 1] || "").trim();
      expect(
        /^(async|private async|protected async)\s+\w+\s*\(/.test(next),
        `the @callable() at line ${i + 1} must be directly followed by its method, got: ${next}`,
      ).toBe(true);
    }
  });

  it("exposes the send-email, payment and edge-case checks as RPC methods", () => {
    for (const method of ["testEmailAttachmentUI", "qaPaymentFlow", "qaEdgeCases"]) {
      expect(qa, `${method} must exist on QAAgent`).toContain("async " + method + "(");
    }
  });

  it("declares those methods on the narrowed stub api.ts actually calls through", () => {
    // getQAAgent returns an inline object type, NOT the QAAgent class, so a
    // method missing from that literal cannot be called and the failure is a
    // runtime RPC error rather than a compile error.
    for (const method of ["testEmailAttachmentUI", "qaPaymentFlow", "qaEdgeCases"]) {
      expect(api, `${method} must be declared on the getQAAgent stub type`).toContain(method + "(");
    }
  });

  it("routes every new QA method behind requireAuth", () => {
    const routes: [string, string][] = [
      ["/api/dashboard/qa/test-attachment", "testEmailAttachmentUI"],
      ["/api/dashboard/qa/payment-flow", "qaPaymentFlow"],
      ["/api/dashboard/qa/edge-cases", "qaEdgeCases"],
    ];
    for (const [route, method] of routes) {
      const pattern = new RegExp(
        'app\\.post\\(\\s*"' + route.replace(/[/-]/g, "\\$&") + '",\\s*requireAuth',
      );
      expect(api, `${route} must be a requireAuth POST`).toMatch(pattern);
      // Each route appears exactly once: a duplicated handler silently shadows.
      const occurrences = api.split(`"${route}"`).length - 1;
      expect(occurrences, `${route} must be registered exactly once`).toBe(1);
      expect(api, `${route} must reach ${method}`).toContain(method + "(");
    }
  });

  it("never hard-codes a recipient address for the send-mail check", () => {
    // The endpoint must take its recipient from the caller, so the repo carries
    // no real inbox and a deploy cannot mail someone by accident.
    expect(api).toContain("A valid toEmail is required");
    const hardCoded = api.match(/toEmail\s*=\s*"[^"]+@[^"]+"/);
    expect(hardCoded, "no hard-coded recipient may appear").toBeNull();
    const qaHardCoded = qa.match(/toEmail\s*(?::\s*string\s*)?=\s*"[^"]+@/);
    expect(qaHardCoded, "qa-agent.ts must not default a recipient").toBeNull();
  });

  it("refuses to sign or settle anything in the payment check", () => {
    // qaPaymentFlow is allowed to read a 402 challenge and nothing more. If a
    // future edit adds signing here it must be a deliberate, reviewed change.
    const start = qa.indexOf("async qaPaymentFlow(");
    expect(start).toBeGreaterThan(-1);
    const end = qa.indexOf("async qaEdgeCases(", start);
    const body = qa.slice(start, end > -1 ? end : undefined);
    for (const forbidden of ["sendTransaction", "writeContract", "PAYMENT_PRIVATE_KEY", "signTypedData"]) {
      expect(body, `qaPaymentFlow must not use ${forbidden}`).not.toContain(forbidden);
    }
    // It must still say what it does not prove.
    expect(body).toContain("settlementVerified: false");
  });

  it("wires the browser-tools infrastructure the tools depend on", () => {
    const wrangler = read("wrangler.jsonc");
    const types = read("src/types.ts");
    const index = read("src/index.ts");

    // The LOADER binding must NOT be declared on a Free-plan account: Dynamic
    // Workers require a paid plan, and declaring it made every production deploy
    // fail at the Cloudflare API with code 10195. `wrangler deploy --dry-run`
    // does not catch that, because it checks the binding's shape rather than the
    // account's entitlement. This asserts the reasoning still holds; if the
    // account moves to a paid plan, invert this deliberately.
    expect(
      wrangler,
      "worker_loaders must stay out of wrangler.jsonc while on the Free plan",
    ).not.toContain('"worker_loaders"');
    // The comment recording WHY must survive, so the next person does not
    // innocently re-add the binding and break the deploy again.
    expect(wrangler).toContain("Dynamic Workers require a PAID plan");
    // ...a type for it...
    expect(types, "Env must type the LOADER binding").toContain("LOADER?: WorkerLoader");
    // ...and the runtime class exported from the entry module, or the first
    // execution fails at runtime with nothing to catch it at build time.
    expect(index, "the entry must export CodemodeRuntime").toContain("CodemodeRuntime");
  });

  it("degrades without the browser bindings instead of throwing in getTools", () => {
    // getTools() runs on every chat turn, including turns that never touch a
    // browser. A throw here takes down the whole agent, so the bindings are
    // checked before use.
    const start = qa.indexOf("override getTools()");
    expect(start).toBeGreaterThan(-1);
    const body = qa.slice(start, qa.indexOf("private async runBrowserCheck", start));
    expect(body).toContain("env.BROWSER && env.LOADER");
    expect(body, "getTools must catch rather than propagate").toContain("catch");
  });

  it("gives every new QA button a handler that exists", () => {
    for (const fn of ["runQATabs", "runQAAttachment", "runQAPaymentFlow", "runQAEdgeCases"]) {
      expect(html, `index.html must define ${fn}`).toContain(`function ${fn}(`);
      expect(html, `${fn} must be reachable from a button`).toContain(`onclick="${fn}()"`);
    }
    // The send-mail button must take a recipient rather than a fixed address.
    expect(html).toContain("qaRecipient()");
  });
});

describe("the post-deploy QA job cannot break a deploy", () => {
  const workflow = read(".github/workflows/deploy.yml");

  it("runs only after the deploy succeeds", () => {
    expect(workflow).toContain("qa-smoke:");
    expect(workflow).toMatch(/qa-smoke:[\s\S]*?needs:\s*deploy/);
    // Main pushes only: a PR must not run QA against production.
    expect(workflow).toMatch(
      /qa-smoke:[\s\S]*?if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
    );
  });

  it("reads its credentials from secrets, never from the repo", () => {
    expect(workflow).toContain("secrets.DASHBOARD_API_KEY");
    expect(workflow).toContain("secrets.QA_TEST_EMAIL");
    // No literal key may be committed into the workflow.
    expect(workflow).not.toMatch(/DASHBOARD_API_KEY:\s*["'][^$]/);
  });

  it("keeps the mail-sending check opt-in", () => {
    // It sends real mail on every deploy, so it must be gated by a repository
    // variable rather than run unconditionally.
    expect(workflow).toContain("vars.QA_RUN_ATTACHMENT_CHECK");
    const smoke = read("scripts/qa-smoke.mjs");
    expect(smoke).toContain("RUN_ATTACHMENT");
    // And a skip must not be reported as a failure, or an unconfigured repo
    // would fail every deploy.
    expect(smoke).toContain("skipped: true");
    expect(smoke).toContain("process.exit(failed > 0 ? 1 : 0)");
  });
});

describe("browser teardown cannot fail a QA run", () => {
  // The outage this covers: `await browser.close().catch(...)` where close() is
  // declared `close(): void`. The throw happened in a `finally`, so it replaced
  // a completed QA run's result with an opaque 500 on the route.
  const qa = read("src/qa-agent.ts");

  it("does not call .catch() on a void close()", () => {
    // The precise anti-pattern. Matches the code form, not the doc comments that
    // explain why it is banned.
    const code = qa
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(
      /\.close\(\)\s*\.catch/.test(code),
      "a raw .close().catch() returns: close() is void, so .catch throws",
    ).toBe(false);
  });

  it("routes browser teardown through the tested helper", () => {
    expect(qa).toContain("closeConnectionQuietly");
    // Every browser teardown goes through the helper. Counted exactly, so both a
    // new raw close() and a removed release are caught.
    const uses = qa.split("closeConnectionQuietly(").length - 1;
    // Ten teardowns: the six deterministic flows, qaInvestigate
    // (issue #102), the desk snapshot email, the profile start, and
    // the PDF printer (issue #135).
    expect(uses, "every browser teardown must use the helper").toBe(10);
  });

  it("keeps the report's tab call inside a guard", () => {
    // It sat outside the try, so any rejection from qaDashboardTabs bypassed the
    // method's own error handling and reached the route as a 500. The guard now
    // also translates a browser refusal into an actionable message. The trailing
    // `true` is captureScreenshots: the report wants a PNG per tab.
    const start = qa.indexOf("async qaAndEmailReport(");
    const body = qa.slice(start, qa.indexOf("async testEmailAttachmentUI(", start));
    expect(body).toContain("this.qaDashboardTabs(apiKey, connection ?? undefined, true, runId)");
    // The catch immediately after the tab call must translate the failure.
    const catchAt = body.indexOf("} catch (err) {");
    expect(catchAt).toBeGreaterThan(-1);
    expect(body.slice(catchAt, catchAt + 400)).toContain("describeBrowserFailure(err)");
  });

  it("reports a refused send instead of claiming success", () => {
    // sendThroughAgent returns { ok:false } rather than throwing, so ignoring
    // the result reported emailed:true for a report that never left.
    expect(qa).toContain("sendResult?.ok");
    expect(qa).toContain("The email agent refused the send.");
  });
});

describe("the QA route names a serialization failure", () => {
  const api = read("src/api.ts");

  it("checks serializability inside the handler", () => {
    // c.json() serializes inside Hono AFTER the handler returns, so a try/catch
    // around it would catch nothing and the response would stay an opaque 500.
    expect(api).toContain("function jsonOr500(");
    expect(api).toContain('jsonOr500(c, result, "qa/email-report")');
  });

  it("cannot throw while reporting the failure", () => {
    // Stringifying the value that just failed to serialize would throw again.
    expect(api).toContain("safeStringify");
    expect(api).toContain("Failed to serialize QA result");
  });
});

describe("a QA report uses one browser session, not two", () => {
  // Each connectBrowser call consumes a Browser Rendering session against a
  // finite account limit. qaAndEmailReport used to open two - one for the tab
  // check, one for the screenshot - and the refusal surfaced as
  // "did not return a WebSocket", which points at wrangler.jsonc and sends you
  // to the wrong file. Sessions are now opened in exactly one place.
  const qa = read("src/qa-agent.ts");

  it("opens browser sessions through a single helper", () => {
    // Exactly two, both inside openBrowserSession: the first attempt and the
    // single capacity retry after a 20s wait. Every other call site goes through
    // the helper, which is what makes the session count auditable.
    const direct = qa.split("await connectBrowser(").length - 1;
    expect(direct, "every browser session must go through openBrowserSession").toBe(2);
    expect(qa).toContain("private async openBrowserSession(");
  });

  it("hands the report's session to both checks instead of opening its own", () => {
    // The two calls that used to each open a session must now receive one.
    expect(qa).toContain("this.qaDashboardTabs(apiKey, connection ?? undefined, true, runId)");
    expect(qa).toMatch(
      /runBrowserCheck\(\s*env\.SELF_ORIGIN[\s\S]{0,200}?connection \?\? undefined,\s*runId,?\s*\)/,
    );
  });

  it("closes only what it opened, so a shared session survives", () => {
    // runBrowserCheck and qaDashboardTabs must respect ownership, or the second
    // check would run against a closed connection.
    expect(qa).toContain("const ownsConnection = !sharedConnection");
    const guards = qa.split("if (ownsConnection)").length - 1;
    expect(guards, "every shared-session method must guard its close").toBe(3);
  });

  it("releases the report's session on every exit path", () => {
    // A leak here reintroduces the exhaustion being fixed, so the release must
    // exist in the finally AND before the early return in the catch.
    const start = qa.indexOf("async qaAndEmailReport(");
    const body = qa.slice(start, qa.indexOf("async testEmailAttachmentUI(", start));
    const releases = body.split("closeConnectionQuietly(connection)").length - 1;
    expect(releases, "both the early return and the finally must release").toBe(2);
    expect(body).toContain("} finally {");
  });

  it("explains a session-limit refusal instead of blaming the binding", () => {
    // The raw message names wrangler.jsonc; the account being out of sessions is
    // the usual cause. The translation must say so.
    expect(qa).toContain("describeBrowserFailure");
    // The message must point away from wrangler.jsonc without asserting a cause
    // that was never confirmed.
    expect(qa).toContain("treat this as a transient capacity refusal");
    expect(qa).toContain("rather");
    expect(qa).toContain("missing binding");
    // And it must be idempotent, so it cannot double-wrap into
    // "Browser check failed: Could not open a browser session: ...".
    expect(qa).toContain("message.startsWith(\"Could not open a browser session\")");
  });

  it("does not leak a session from the report's early-return path", () => {
    // The specific mistake made while writing this: the catch that handles a
    // failed tab check returned without closing the connection it had opened.
    const mStart = qa.indexOf("async qaAndEmailReport(");
    const mEnd = qa.indexOf("async testEmailAttachmentUI(", mStart);
    const report = qa.slice(mStart, mEnd);
    const tabCatchAt = report.indexOf("} catch (err) {");
    const tabCatch = report.slice(tabCatchAt, tabCatchAt + 400);
    expect(tabCatch, "the tab-check catch must release the session").toContain(
      "closeConnectionQuietly(connection)",
    );
  });
});

describe("the Public trade-approval workflow stays wired", () => {
  const agent = read("src/agent.ts");
  const api = read("src/api.ts");
  const workflow = read("src/trade-workflow.ts");
  const index = read("src/index.ts");
  const wrangler = read("wrangler.jsonc");
  const html = read("public/index.html");

  it("declares the workflow binding and exports the class", () => {
    expect(wrangler).toContain('"binding": "TRADE_WORKFLOW"');
    expect(wrangler).toContain('"class_name": "TradeWorkflow"');
    expect(index).toContain('export { TradeWorkflow } from "./trade-workflow"');
  });

  it("waits for a human decision before any side effect", () => {
    expect(workflow).toContain("waitForEvent");
    expect(workflow).toContain("executeTradeProposal");
    expect(workflow.indexOf("waitForEvent")).toBeLessThan(
      workflow.indexOf("executeTradeProposal"),
    );
  });

  it("turns an order-placing call into a proposal with its own workflow", () => {
    expect(agent).toContain("proposeTrade");
    expect(agent).toContain("runWorkflow(");
    expect(agent).toContain('"TRADE_WORKFLOW"');
    expect(agent).toContain("sendWorkflowEvent");
  });

  it("exposes the list and decision routes the card calls", () => {
    expect(api).toContain('"/api/public/trades"');
    expect(api).toContain('"/api/public/trades/:id/decision"');
    expect(api).toContain("listTradeProposals");
    expect(api).toContain("decideTradeProposal");
  });

  it("renders the approvals card with decision controls", () => {
    expect(html).toContain('id="publicTradesCard"');
    expect(html).toContain("loadPublicTrades");
    expect(html).toContain("decideTrade");
  });

  it("surfaces the live trading state on the models response and status card", () => {
    expect(api).toContain("tradingEnabled: allowTrading(c.env)");
    expect(html).toContain('id="publicTradingTitle"');
    expect(html).toContain('id="publicTradingBody"');
    expect(html).toContain("renderTradingStatus");
    expect(html).toContain("Trading enabled");
  });

  it("keeps execution fail-closed behind approval and the master switch", () => {
    const exec = agent.slice(agent.indexOf("async executeTradeProposal"));
    expect(exec).toContain("PUBLIC_ALLOW_TRADING");
    expect(exec).toContain('"executing"');
    expect(exec).toContain("getPublicToken()");
  });
});

describe("the QA live-view panel stays wired (issue #88)", () => {
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const html = read("public/index.html");

  it("emits live events from the checks and serves snapshots", () => {
    expect(qa).toContain("emitLive");
    expect(qa).toContain("qaLiveSnapshot");
    expect(qa).toContain('"qa-live"');
    expect(qa).toContain("this.broadcast(");
    // The observer must never fail the run it watches.
    expect(qa).toContain("never throws");
  });

  it("threads the run id from the dashboard routes into the checks", () => {
    expect(api).toContain("qaDashboard(apiKey, runId)");
    expect(api).toContain("qaDashboardTabs(apiKey, undefined, undefined, runId)");
    expect(api).toContain("qaAndEmailReport(apiKey, toEmail, runId)");
    expect(api).toContain("testEmailAttachmentUI(apiKey, toEmail, runId)");
    expect(api).toContain("qaFullSuite(apiKey, toEmail, runId)");
  });

  it("streams live frames during a watched run (interim for screencast)", () => {
    // The frame stream is capture polling, deliberately not startScreencast:
    // the SDK's CDP client drops protocol events, so screencast frames can
    // never arrive through the connection the checks use. Frames are
    // broadcast-only (never buffered or sequenced - either would break the
    // replay buffer or the panel's dedupe), and the stream is started and
    // stopped beside the session teardown in all six browser flows (the
    // four deterministic ones, the investigator, the desk snapshot).
    expect(qa).toContain("private startFrameStream(");
    expect(qa.split("stopFrames = this.startFrameStream").length - 1).toBe(6);
    expect(qa.split("stopFrames();").length - 1).toBe(6);
    const start = qa.indexOf("private emitLive(");
    const block = qa.slice(start, start + 2600);
    expect(block).toContain('ev.kind === "frame"');
    expect(html).toContain("ev.kind === 'frame'");
    expect(html).toContain("Live — streaming");
  });

  it("captures tab screenshots for a watching run even without a report", () => {
    expect(qa).toContain("wantShots");
    expect(qa).toContain("captureScreenshots === true || !!runId");
  });

  it("renders the panel and connects a socket to the QA agent", () => {
    expect(html).toContain('id="qaLivePanel"');
    expect(html).toContain('id="qaLiveSteps"');
    expect(html).toContain('id="qaLiveImg"');
    expect(html).toContain('id="qaLiveThumbs"');
    expect(html).toContain("qaLiveBegin");
    expect(html).toContain("qaLiveApply");
    // The socket's agent segment must be the binding's kebab form: the
    // SDK client converts "QAAgent" to "q-a-agent" while the server maps
    // the QA_AGENT binding to "qa-agent", and the two never route.
    expect(html).toContain('agent: "qa-agent"');
    expect(html).not.toContain('agent: "QAAgent"');
    expect(html).toContain('name: "qa"');
    expect(html).toContain("qaLiveWatch");
    expect(html).toContain("qaLiveSnapshot");
  });
});

describe("the QA UX audit stays wired (issue #91)", () => {
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const html = read("public/index.html");

  it("measures the rendered page against written rules, deterministically", () => {
    expect(qa).toContain("qaUxAudit");
    expect(qa).toContain("UX_RULES");
    expect(qa).toContain("uxProbeExpression");
    expect(qa).toContain("contrastNormal: 4.5");
    expect(qa).toContain("minTargetPx: 44");
  });

  it("is reachable from its route and its button", () => {
    expect(api).toContain('"/api/dashboard/qa/ux-audit"');
    expect(api).toContain("qaUxAudit(apiKey, runId)");
    expect(html).toContain("runQAUxAudit");
    expect(html).toContain("UX Audit");
  });
});

describe("the generalized UX audit stays wired (issue #94)", () => {
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const html = read("public/index.html");

  it("drives any single-origin target from a spec, with rule profiles", () => {
    expect(qa).toContain("qaUxAuditUrl");
    expect(qa).toContain("UxAuditSpec");
    expect(qa).toContain("summarizeUxProbes");
    expect(qa).toContain("ignoreSelectors");
    expect(qa).toContain("expectedButtonBg");
  });

  it("investigates failures automatically (issue #102 follow-up)", () => {
    const qaMod = read("src/qa-agent.ts");
    const smoke = read("scripts/qa-smoke.mjs");
    expect(qaMod).toContain("investigateFailure(");
    expect(qaMod).toContain("qaAndEmailReport(apiKey, toEmail, runId, false)");
    expect(smoke).toContain("/api/dashboard/qa/investigate");
    expect(smoke).toContain("/a2a/qa");
    expect(smoke).toContain("qa.ux_audit dispatch returns findings");
    expect(smoke).toContain("/api/dashboard/qa/desk-snapshot");
    expect(smoke).toContain("Autopilot Trading Desk snapshot email");
    expect(smoke).toContain("investigateFailures");
  });

  it("supports the persistent browser profile (issue #102)", () => {
    const qaMod = read("src/qa-agent.ts");
    const prof = read("src/browser-profile.ts");
    const api = read("src/api.ts");
    expect(prof).toContain("connectBrowserSession");
    expect(prof).toContain("browser_profile");
    expect(qaMod).toContain("qaBrowserProfile");
    expect(qaMod).toContain("openProfileSession");
    expect(api).toContain('"/api/dashboard/qa/browser-profile"');
    // The single-helper rule still holds: raw session creation stays
    // inside openBrowserSession; the profile path uses the *Session
    // variants, never a third connectBrowser call site.
    expect(qaMod.split("await connectBrowser(").length - 1).toBe(2);
  });

  it("supports visual baselines in the audit (issue #102)", () => {
    const specMod = read("src/ux-audit-spec.ts");
    expect(specMod).toContain("summarizeBaselines");
    expect(specMod).toContain('baselines?: "record" | "compare"');
    expect(qa).toContain("baselineStore");
    expect(qa).toContain("ux_baselines");
    expect(qa).toContain("summarizeBaselines(baselineResults, baselineMode)");
  });

  it("discovers dashboard tabs from the DOM (issue #102)", () => {
    const qaMod = read("src/qa-agent.ts");
    const cov = read("src/tab-coverage.ts");
    expect(cov).toContain("knownTabExpectations");
    expect(cov).toContain("mergeDiscoveredTabs");
    expect(qaMod).toContain("mergeDiscoveredTabs(tabsToTest, discovered)");
    expect(qaMod).toContain("genericTabProbeExpression");
    // The emailed report must respect the email agent's cap now that
    // discovery can find more tabs than it can attach.
    expect(qaMod).toContain("attachments.length = 5");
  });

  it("measures pages at multiple viewports (issue #102)", () => {
    const specMod = read("src/ux-audit-spec.ts");
    expect(specMod).toContain("viewportListOf");
    expect(specMod).toContain("viewports?:");
    expect(qa).toContain("Emulation.setDeviceMetricsOverride");
    expect(qa).toContain("viewportListOf(spec)");
  });

  it("captures console, network, and vitals evidence per page (issue #102)", () => {
    const specMod = read("src/ux-audit-spec.ts");
    expect(specMod).toContain("evidenceCollectorScript");
    expect(specMod).toContain("summarizeEvidence");
    expect(specMod).toContain("evidence?: boolean");
    expect(qa).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(qa).toContain("summarizeEvidence(evidencePages)");
  });

  it("crawls same-origin links and clicks through page states (step 2)", () => {
    // The spec carries crawl options and per-page steps; the agent
    // normalizes entries, follows same-origin links within caps, and a
    // step click that matches nothing is a visible failure line.
    const specMod = read("src/ux-audit-spec.ts");
    expect(specMod).toContain("crawl?: { maxPages?: number; maxDepth?: number }");
    expect(specMod).toContain("pageEntriesOf");
    expect(specMod).toContain("crawlUrlKey");
    expect(qa).toContain("matched nothing");
    expect(qa).toContain("Crawl coverage");
    const schemas = read("src/agent-tool-schemas.ts");
    expect(schemas).toContain("crawl");
    expect(schemas).toContain("steps");
  });

  it("is reachable from its route and the dashboard URL input", () => {
    expect(api).toContain('"/api/dashboard/qa/ux-audit-url"');
    expect(api).toContain("qaUxAuditUrl(spec, runId)");
    expect(html).toContain("runQAUxUrl");
    expect(html).toContain('id="qaUxUrl"');
    // The Audit URL box opens on the fixture page: one click is the
    // audit's self-test, with a known-correct expected result.
    expect(html).toContain('value="https://pay.openaimp.com/qa-fixture.html"');
  });
});

describe("the UX audit's self-test stays wired (post-deploy smoke)", () => {
  const smoke = read("scripts/qa-smoke.mjs");
  const fixture = read("public/qa-fixture.html");

  it("smoke-tests both audit endpoints after every deploy", () => {
    expect(smoke).toContain('"/api/dashboard/qa/ux-audit"');
    expect(smoke).toContain('"/api/dashboard/qa/ux-audit-url"');
    expect(smoke).toContain("qa-fixture.html");
  });

  it("the fixture plants exactly the violations the smoke expects", () => {
    expect(fixture).toContain('id="planted-faint"');
    expect(fixture).toContain('id="planted-tiny"');
    expect(fixture).toContain('id="planted-skip"');
    expect(fixture).toContain('id="planted-noalt"');
    expect(smoke).toContain("planted-faint");
    expect(smoke).toContain("planted-tiny");
  });
});

describe("the Public autopilot stays wired (issue #107)", () => {
  const agent = read("src/agent.ts");
  const api = read("src/api.ts");
  const idx = read("public/index.html");
  const ap = read("src/public-autopilot.ts");
  const pdata = read("public/public-data.js");
  const types = read("src/types.ts");
  const wrangler = read("wrangler.jsonc");

  it("the host agent injects its pieces into the pipeline", () => {
    expect(agent).toContain("async runAutopilot(");
    expect(agent).toContain("runAutopilotPipeline(");
    expect(agent).toContain("maxToolCalls: AUTOPILOT_STEP_TOOL_BUDGET");
    expect(agent).toContain("options?.maxToolCalls ?? 12");
  });

  it("the pipeline stages live in the contracts module", () => {
    expect(ap).toContain("export async function runAutopilotPipeline(");
    expect(ap).toContain("AUTOPILOT_PLANNER_SYSTEM");
    expect(ap).toContain("AUTOPILOT_VERIFIER_SYSTEM");
    expect(ap).toContain("AUTOPILOT_SYNTHESIS_SYSTEM");
    expect(ap).toContain("parseVerification(verifyText)");
    expect(ap).toContain("export const AUTOPILOT_MAX_STEPS = 6");
    expect(ap).toContain("export function parseVerification(");
  });

  it("runs persist in agent state and list through the API", () => {
    expect(agent).toContain("autopilotRuns");
    expect(agent).toContain("async listAutopilotRuns(");
    expect(api).toContain('"/api/public/autopilot-runs"');
    expect(api).toContain("agent.listAutopilotRuns()");
  });

  it("runs use typed agent state with a declared default (state lifecycle)", () => {
    expect(types).toContain("autopilotRuns?: AutopilotRun[]");
    expect(agent).toContain("autopilotRuns: []");
  });

  it("runs persist per-run in their own table, not the state blob (issue #110)", () => {
    expect(ap).toContain("export class AutopilotRunStore");
    expect(ap).toContain("autopilot_runs");
    expect(agent).toContain("new AutopilotRunStore(this.ctx.storage.sql)");
    expect(agent).not.toContain("autopilotRuns: list.slice");
  });

  it("the transcript refreshes verdict/answer and merges legacy runs (issue #110)", () => {
    expect(ap).toContain("session.updateMessage(message)");
    expect(ap).toContain("export function mergeAutopilotRuns(");
    expect(agent).toContain("mergeAutopilotRuns(");
  });

  it("run transcripts record into the Sessions store (sessions lifecycle)", () => {
    expect(ap).toContain("export async function recordRunToSession(");
    expect(ap).toContain('sessions.session(autopilotSessionId(run.id))');
    expect(agent).toContain("recordRunToSession(this.sessions, run)");
    expect(api).toContain('"/api/public/autopilot-runs/:id/session"');
    expect(api).toContain("agent.getAutopilotRunSession(");
  });

  it("agent tracing is enabled in the Worker config (observability)", () => {
    expect(wrangler).toMatch(/"traces":\s*{\s*"enabled": true/);
  });

  it("the autopilot trading desk wraps the public tab (issue #112)", () => {
    expect(idx).toContain('id="publicDesk"');
    expect(idx).toContain('id="deskWatch"');
    expect(idx).toContain('id="deskPortfolio"');
    expect(idx).toContain('id="deskChainSymbol"');
    expect(idx).toContain('id="deskRuns"');
    expect(idx).toContain('id="publicAutopilot" checked');
    expect(idx).toContain("deskRefreshAll();");
    expect(pdata).toContain("function deskRenderQuotes(");
    expect(pdata).toContain("function deskRenderChain(");
    expect(pdata).toContain("function deskPickContract(");
    expect(pdata).toContain("/api/public/quotes?symbols=");
    expect(pdata).toContain("/api/public/portfolio");
    expect(pdata).toContain("/api/public/chain?symbol=");
  });

  it("public answers render through the safe markdown subset (issue #112)", () => {
    expect(pdata).toContain("function renderMarkdownSafe(");
    expect(pdata).toContain("const lines = escapeHtml(");
    expect(idx).toContain("renderMarkdownSafe(res.answer");
    expect(idx).toContain("/public-data.js");
    expect(idx).not.toContain("escapeHtml(res.answer ||");
  });

  it("the answer contracts ask for a verdict line and a metrics table (issue #112)", () => {
    expect(agent).toContain("For comparisons, lead with a 'Verdict:");
    expect(ap).toContain("markdown table of the key metrics from the evidence");
  });

  it("the autopilot run card leads with a verdict banner (issue #112)", () => {
    expect(pdata).toContain("function autopilotVerdictBanner(");
    expect(pdata).toContain("Verified complete");
    expect(idx).toContain("autopilotVerdictBanner(run)");
  });

  it("the trading desk data endpoints read MCP tools directly (issue #112)", () => {
    expect(api).toContain('"/api/public/quotes"');
    expect(api).toContain('"/api/public/portfolio"');
    expect(api).toContain('"/api/public/chain"');
    expect(api).toContain('"get_quotes"');
    expect(api).toContain('"get_portfolio"');
    expect(api).toContain('"get_option_chain"');
    expect(api).toContain('"get_option_expirations"');
    expect(api).toContain('from "./public-data"');
  });

  it("public raw data is downloadable as JSON/CSV (issue #112)", () => {
    // The trace renderer and download helpers live in public-data.js
    // (moved when the trading desk landed); the page wires answers in.
    expect(pdata).toContain("function downloadPublicCall(");
    expect(pdata).toContain("function downloadPublicAll(");
    expect(pdata).toContain("raw data from Public.com");
    expect(pdata).toContain("function pTable(");
    expect(pdata).toContain("function pCsv(");
    // Since issue #133 the chat carries a summary + jump link and the
    // full trace (with these downloads) renders in the Logs view.
    expect(idx).toContain("deskTraceLink(answerIdx)");
    expect(pdata).toContain("renderToolTrace(entry.trace || [], idx)");
    expect(idx).toContain("pubData.push(");
  });

  it("the Public tab is split into nav views with a separate Logs view (issue #133)", () => {
    const pdata = read("public/public-data.js");
    const idx = read("public/index.html");
    expect(pdata).toContain("function deskShowView(");
    expect(pdata).toContain("function deskRenderLogs(");
    expect(pdata).toContain("function deskTraceLink(");
    expect(pdata).toContain("function deskSyncToolsView(");
    expect(pdata).toContain("move('publicDesk', 'trading')");
    expect(pdata).toContain("move('publicQuestionCard', 'questions')");
    expect(pdata).toContain("move('publicConnectedBox', 'status')");
    expect(idx).toContain("deskShowView('trading')");
  });

  it("screenshots and the hunt PDF mirror to Slack via the bot file API", () => {
    const qa = read("src/qa-agent.ts");
    const api = read("src/api.ts");
    const files = read("src/slack-files.ts");
    expect(files).toContain("files.getUploadURLExternal");
    expect(files).toContain("SLACK_QA_CHANNEL_ID");
    expect(qa).toContain("postFilesToSlack");
    expect(api).toContain("postFilesToSlack");
  });

  it("post-deploy PDF coverage is a real autopilot hunt, plus a summary email", () => {
    const qa = read("src/qa-agent.ts");
    const smoke = read("scripts/qa-smoke.mjs");
    // The synthetic print test was replaced by a real hunt (the
    // autopilot workflow's own output) per the owner's direction.
    expect(qa).not.toContain("qaPrintTestEmail");
    expect(smoke).toContain("Autopilot hunt report PDF email");
    expect(smoke).toContain("/api/dashboard/qa/autopilot-hunt-test");
    expect(qa).toContain("qaAutopilotHuntTest");
    expect(smoke).toContain("sendSummaryEmail");
    expect(smoke).toContain("/api/dashboard/send-email");
  });

  it("capacity wait-and-retry and the HTML summary are wired", () => {
    const smoke = read("scripts/qa-smoke.mjs");
    const emailAgent = read("src/email-agent.ts");
    expect(smoke).toContain("skipCapacity");
    expect(smoke).toContain("QA_CAPACITY_WAIT_MS");
    expect(smoke).toContain("summaryEmailHtml");
    expect(emailAgent).toContain("html?: string");
  });

  it("the Trading duo lives outside the legacy desk grid (issue #174)", () => {
    const pdata = read("public/public-data.js");
    expect(pdata).toContain("tradingSection.insertBefore(duo, tradingSection.firstChild)");
    expect(pdata).toContain("#publicInput{min-width:0;}");
    expect(pdata).toContain(".desk-duo>.card{min-width:0;}");
  });

  it("the desk uses the full width with a larger questions share (issue #171)", () => {
    const pdata = read("public/public-data.js");
    expect(pdata).toContain(".container:has(#public.active){max-width:none;}");
    expect(pdata).toContain("grid-template-columns:minmax(0,2fr) minmax(0,3fr)");
  });

  it("the Endpoints view displays each agent's card (issue #177)", () => {
    const pdata = read("public/public-data.js");
    const a2aTest = read("src/a2a-test.ts");
    expect(a2aTest).toContain("cardDescription");
    expect(a2aTest).toContain("cardSkills");
    expect(pdata).toContain("a2aCards");
    expect(pdata).toContain("deskA2ACardHtml");
  });

  it("the orchestrator agent is wired (issue #180)", () => {
    const agent = read("src/orchestrator-agent.ts");
    const idx = read("src/index.ts");
    const a2a = read("src/a2a.ts");
    const pdata = read("public/public-data.js");
    const core = read("src/orchestrate.ts");
    expect(agent).toContain("extends Think");
    expect(agent).toContain("handleA2A");
    expect(idx).toContain("OrchestratorAgent");
    expect(a2a).toContain("orchestratorCard");
    expect(a2a).toContain('"/a2a/orchestrator"');
    expect(core).toContain("OPERATION_CATALOG");
    expect(pdata).toContain("deskOrchestrateRun");
    expect(pdata).toContain("deskOrchSamples");
    expect(pdata).toContain("deskOrchSupervise");
    expect(read("src/orchestrator-agent.ts")).toContain("supervise");
    expect(read("src/orchestrator-agent.ts")).toContain("orchestrate_op_stats");
    expect(read("src/orchestrator-agent.ts")).toContain("readMemoryBrief");
    expect(pdata).toContain("Summarize the state of qa, search, and slack");
    expect(pdata).toContain("data-view=\"orchestrate\"");
  });

  it("the search agent is wired (issue #170)", () => {
    const agent = read("src/search-agent.ts");
    const idx = read("src/index.ts");
    const a2a = read("src/a2a.ts");
    const pdata = read("public/public-data.js");
    expect(agent).toContain("extends Think");
    expect(agent).toContain("AI_SEARCH");
    expect(idx).toContain("SearchAgent");
    expect(a2a).toContain("searchCard");
    expect(a2a).toContain('"/a2a/search"');
    expect(pdata).toContain("deskSearchRun");
    expect(pdata).toContain("Knowledge search");
  });

  it("vector memory is wired dark-safe into the orchestrator (issue #215)", () => {
    const memory = read("src/vector-memory.ts");
    const orch = read("src/orchestrator-agent.ts");
    const wrangler = read("wrangler.jsonc");
    expect(memory).toContain("export class VectorMemory");
    expect(memory).toContain("cfpay-memory");
    expect(memory).toContain("@cf/baai/bge-small-en-v1.5");
    // dark until configured: every entry point checks first
    expect(memory).toContain("if (!this.configured()) return { configured: false }");
    expect(orch).toContain('from "./vector-memory"');
    expect(orch).toContain("memoryBriefWithRecall");
    expect(orch).toContain("rememberJobInVectorMemory");
    // the binding ships only after the owner creates the index:
    // wrangler refuses to deploy a Vectorize binding whose index
    // does not exist (deploy run 39085164116), so it stays out of
    // wrangler.jsonc until then and the module runs dark.
    expect(wrangler).not.toContain('"index_name": "cfpay-memory"');
  });

  it("scoped JWTs are wired into MCP auth and issuance (issue #214)", () => {
    const auth = read("src/mcp-auth.ts");
    const jwt = read("src/mcp-jwt.ts");
    const api = read("src/api.ts");
    expect(jwt).toContain("export async function verifyToken");
    expect(jwt).toContain("mcp:tools:write");
    expect(auth).toContain('from "./mcp-jwt"');
    expect(auth).toContain('"jwt"');
    expect(auth).toContain("INSUFFICIENT_SCOPE");
    expect(api).toContain("/api/dashboard/mcp/tokens");
    expect(api).toContain("issueToken(secret");
  });

  it("the ScheduledAgent runs on the SDK native scheduler (issues #213, #226)", () => {
    const agent = read("src/scheduled-agent.ts");
    const index = read("src/index.ts");
    const wrangler = read("wrangler.jsonc");
    const api = read("src/api.ts");
    expect(agent).toContain("class ScheduledAgent extends Think");
    // the documented pattern: native schedules + a named callback,
    // woken by DO alarms - no Worker cron trigger, no tick scan
    expect(agent).toContain("SCHEDULE_CALLBACK, { goalId: row.id }");
    expect(agent).toContain("row.kind === \"once\" ? new Date(");
    expect(agent).toContain('const SCHEDULE_CALLBACK = "runScheduledGoal"');
    expect(agent).toContain("async runScheduledGoal(");
    // the A2A surface lives on the class - a rewrite that drops it
    // 500s every operation (issue #229); pin its presence
    expect(agent).toContain("async handleA2A(");
    expect(agent).toContain("async handleA2AMessage(");
    expect(agent).toContain("createA2ATransport");
    expect(agent).toContain("this.cancelSchedule(row.scheduleId)");
    expect(agent).toContain("orchestrator.run");
    expect(agent).not.toContain("scheduledTick");
    expect(index).toContain('export { ScheduledAgent } from "./scheduled-agent";');
    expect(index).toContain("A2A_SCHEDULED_RPC_PATH");
    expect(index).not.toContain("async scheduled(");
    expect(index).not.toContain("scheduledTick");
    expect(wrangler).toContain('"class_name": "ScheduledAgent"');
    expect(wrangler).toContain('"tag": "v12"');
    expect(wrangler).not.toContain('"crons"');
    expect(api).toContain("/api/dashboard/scheduled-goals");
    const catalog = read("src/orchestrate.ts");
    // plans may read, create, one-shot, and trigger (issue #232);
    // deleting a standing goal stays owner-only
    expect(catalog).toContain('"scheduled.create", "scheduled.once", "scheduled.trigger"');
    expect(catalog).not.toContain(String.raw`"scheduled.delete"`);
    // trigger-now + one-shot callables and their A2A operations
    expect(agent).toContain("async scheduledTrigger(");
    expect(agent).toContain("async scheduledOnce(");
    expect(agent).toContain("dispatchAndRecord");
    expect(agent).toContain('op === "scheduled.trigger"');
    expect(agent).toContain('op === "scheduled.once"');
    expect(api).toContain("scheduled-goals/:id/trigger");
    expect(api).toContain('body.kind === "once"');
  });

  it("model routing is wired into the orchestrator (issue #212)", () => {
    const orch = read("src/orchestrator-agent.ts");
    const routing = read("src/model-routing.ts");
    expect(routing).toContain("export async function runRouted");
    // the correction: 4006 is terminal, never routed around
    expect(routing).toContain("4006 is terminal, not retryable");
    expect(orch).toContain('from "./model-routing"');
    expect(orch).toContain("runRouted(task, (modelId) => this.rawModelText(modelId, prompt))");
    expect(orch).toContain('"supervise"');
    expect(orch).toContain('"synthesize"');
  });

  it("the budget guard gates the host's external payments (issue #211)", () => {
    const agent = read("src/agent.ts");
    const guard = read("src/budget-guard.ts");
    expect(guard).toContain("export function validateOutboundPayment");
    expect(guard).toContain("PER_CALL_CAP_EXCEEDED");
    expect(agent).toContain('from "./budget-guard"');
    // enforced inside the x402 validator, before signing
    expect(agent).toContain("budgetRefusal(budget.policy, budget.state, budgetRequest)");
    expect(agent).toContain("recordBudgetSpend(budgetSql, budget.policy, budget.state, budgetRequest)");
    expect(agent).toContain("async getBudget(");
    expect(agent).toContain("async setBudgetPolicy(");
  });

  it("the error catalog is wired front and back (issue #209)", () => {
    const api = read("src/api.ts");
    const pdata = read("public/public-data.js");
    const index = read("public/index.html");
    expect(api).toContain('from "./errors"');
    expect(api).toContain('"/api/errors.json"');
    expect(api).toContain("app.onError");
    expect(api).not.toContain("error: String(err)");
    expect(pdata).toContain("deskApiErrorText");
    expect(pdata).toContain("/api/errors.json");
    expect(index).toContain("deskApiErrorText(res)");
  });

  it("the voice agent is wired (issue #168)", () => {
    const voice = read("src/voice-agent.ts");
    const a2a = read("src/a2a.ts");
    const idx = read("src/index.ts");
    const wrangler = read("wrangler.jsonc");
    const pdata = read("public/public-data.js");
    const a2aTest = read("src/a2a-test.ts");
    expect(voice).toContain("withVoice");
    expect(voice).toContain("WorkersAIFluxSTT");
    expect(voice).toContain("WorkersAITTS");
    expect(voice).toContain("answerQuestion");
    expect(voice).toContain("withVoice(Think)");
    expect(read("src/agent-tools.ts")).toContain("voiceAgentTool");
    expect(read("src/agent.ts")).toContain('voiceAgent: { cls: VoiceAgent');
    expect(a2a).toContain("voiceCard");
    expect(a2a).toContain('A2A_VOICE_RPC_PATH = "/a2a/voice"');
    expect(idx).toContain('export { VoiceAgent } from "./voice-agent"');
    expect(wrangler).toContain('"class_name": "VoiceAgent"');
    expect(wrangler).toContain('"tag": "v9"');
    expect(pdata).toContain("deskToggleVoice");
    expect(pdata).toContain("cloud speech did not start");
    expect(pdata).toContain("/agents/voice-agent/desk");
    expect(pdata).toContain("start_call");
    expect(pdata).not.toContain("esm.sh/@cloudflare/voice");
    expect(pdata).toContain("webkitSpeechRecognition");
    expect(pdata).toContain("speechSynthesis");
    expect(pdata).toContain("voice.ask");
    expect(a2aTest).toContain('rpc: "/a2a/voice"');
  });

  it("the notification center is wired (issue #163)", () => {
    const pdata = read("public/public-data.js");
    expect(pdata).toContain("notifyInit");
    expect(pdata).toContain("notifyBadge");
    expect(pdata).toContain("toggleNotifyPanel");
    expect(pdata).toContain("refreshNotifications");
    expect(pdata).toContain("cfmail_notify_seen");
  });

  it("pending approvals notify the user (issue #161)", () => {
    const pdata = read("public/public-data.js");
    const host = read("src/agent.ts");
    expect(pdata).toContain("deskUpdateApprovalNotice");
    expect(pdata).toContain("deskLogsBadge");
    expect(pdata).toContain("deskApprovalNotice");
    expect(pdata).toContain("Review on the Logs page");
    expect(host).toContain("Trade approval pending");
  });

  it("desk UX round 4 is wired (issue #166)", () => {
    const pdata = read("public/public-data.js");
    expect(pdata).toContain("navBtn('hunt', 'Opportunity Hunt')");
    expect(pdata).toContain("moveCardOf('deskWatch', 'watchlist')");
    expect(pdata).toContain("deskSyncQuestionsClone");
    expect(pdata).toContain("deskQuestionsCloneHost");
    expect(pdata).not.toContain("deskWatchHost");
  });

  it("desk UX round 3 is wired (issue #159)", () => {
    const pdata = read("public/public-data.js");
    expect(pdata).toContain("navBtn('chain', 'Option Chain')");
    expect(pdata).toContain("moveCardOf('deskChain', 'chain')");
    expect(pdata).toContain("moveCardTo('deskRuns', logsDuo)");
    expect(pdata).toContain("deskLogsDuo");
    expect(pdata).toContain("desk-duo");
    expect(idx).toContain('onclick="deskLoadQuotes()"');
  });

  it("the desk layout refinements are wired (issue #152)", () => {
    const pdata = read("public/public-data.js");
    const qa = read("src/qa-agent.ts");
    const api = read("src/api.ts");
    // Nav views for watchlist / portfolio / endpoint tests.
    expect(pdata).toContain("navBtn('watchlist', 'Watchlist')");
    expect(pdata).toContain("navBtn('portfolio', 'Portfolio')");
    expect(pdata).toContain("navBtn('endpoints', 'Endpoints')");
    expect(pdata).toContain("moveCardOf('deskPortfolio', 'portfolio')");
    expect(pdata).toContain("moveCardOf('publicTradingTitle', 'status')");
    expect(pdata).toContain("desk-intro");
    // Endpoints view: probe route + callable + per-endpoint retest.
    expect(qa).toContain("qaA2AProbe");
    expect(api).toContain('"/api/dashboard/qa/a2a-probe"');
    expect(pdata).toContain("deskRunA2ATests(true)");
    // Chain: scrollable + CSV download; snapshot reveal hook.
    expect(pdata).toContain("#deskChain{max-height:");
    expect(pdata).toContain("deskDownloadChainCsv()");
    expect(pdata).toContain("window.deskReveal");
    expect(qa).toContain("window.deskReveal");
  });

  it("the A2A endpoint test email is wired (all agents, read-only probes)", () => {
    const qa = read("src/qa-agent.ts");
    const api = read("src/api.ts");
    const idx = read("public/index.html");
    const pdata = read("public/public-data.js");
    const smoke = read("scripts/qa-smoke.mjs");
    expect(qa).toContain("qaA2ATestEmail");
    expect(api).toContain('"/api/dashboard/qa/a2a-test"');
    expect(idx).toContain('onclick="emailA2ATest()"');
    expect(pdata).toContain("emailA2ATest()");
    expect(smoke).toContain("A2A endpoint test email");
  });

  it("desk view moves are section-scoped, never nav buttons (issue #133 fix)", () => {
    const pdata = read("public/public-data.js");
    // Nav buttons and view sections share data-view values; an
    // unscoped selector returns the button and the desk gets appended
    // inside it (the production "no left nav" bug).
    expect(pdata).toContain("section.desk-view[data-view=");
    expect(pdata).not.toContain("shell.querySelector('[data-view=");
    // Long panels scroll inside their cards instead of growing the page.
    expect(pdata).toContain("#deskRuns{max-height:");
    expect(pdata).toContain("#publicTrades{max-height:");
  });

  it("the opportunity hunt is wired end to end (issue #135)", () => {
    const agent = read("src/agent.ts");
    const api = read("src/api.ts");
    const pdata = read("public/public-data.js");
    expect(agent).toContain("runOpportunityHunt");
    expect(agent).toContain("sizePlan(candidates, spots, request)");
    expect(api).toContain('"/api/public/opportunity-hunt"');
    expect(api).toContain('"/api/public/opportunity-hunts/:id/report"');
    expect(pdata).toContain("runOpportunityHunt()");
    expect(pdata).toContain("huntCard");
    // Phase 2: the report as an emailed PDF (QAAgent prints, EmailAgent sends).
    const qaSrc = read("src/qa-agent.ts");
    expect(qaSrc).toContain("qaPrintPdf");
    expect(qaSrc).toContain("Page.printToPDF");
    expect(api).toContain('"/api/public/opportunity-hunts/:id/email"');
    expect(pdata).toContain("emailHuntReport(");
  });

  it("the Public tab's colors resolve through design tokens (issue #133)", () => {
    const idx = read("public/index.html");
    const pdata = read("public/public-data.js");
    expect(idx).toContain("--amber: #b45309");
    expect(idx).toContain("--gold: #d8a13c");
    expect(idx).toContain("--verified: #16a34a");
    expect(idx).toContain("--overlay: rgba(0,0,0,0.45)");
    // No raw theme literals left in the Public surfaces: the amber /
    // gold / verified colors and the overlay are token references now.
    // (Issue numbers in comments - #102, #112 - are not colors.)
    expect(pdata).not.toContain("#b45309");
    expect(pdata).not.toContain("#d8a13c");
    expect(pdata).not.toContain("#16a34a");
    const panel = idx.slice(idx.indexOf('id="public"'), idx.indexOf('id="qa"'));
    expect(panel).not.toContain("#b45309");
    expect(panel).not.toContain("rgba(0,0,0,0.45)");
    expect(panel).toContain("var(--amber)");
  });

  it("question group headers carry classification chips", () => {
    // The chips helper lives in the asset; the inline summary line calls
    // it, so the classification shows on the collapsed group header.
    expect(pdata).toContain("function questionGroupChips(");
    expect(idx).toContain("questionGroupChips(g)");
  });

  it("the reactive loop ends with a no-tools synthesis, not a dead end", () => {
    // On budget exhaustion the loop makes one final tool-less call so the
    // model answers from the evidence already gathered (finishReason
    // "budget_synthesis"); the canned message is only the fallback. The
    // old behaviour - 10 turns, then "I stopped after N tool calls" -
    // stranded comparison questions that had all the data they needed.
    expect(agent).toContain("budget_synthesis");
    expect(agent).toContain("budgetSynthesis(this.env.AI");
    expect(read("src/models.ts")).toContain("You have no tool calls left");
    // Pruning keeps the three most recent results whole and shortens
    // older ones to 1,500 chars; the original 400-char cut made option
    // chains useless mid-comparison and fed the re-pull loop.
    expect(agent).toContain("const keep = 3;");
    expect(agent).toContain("m.content.length > 1500");
  });

  it("the chat route branches on the autopilot flag", () => {
    expect(api).toContain("body.autopilot");
    expect(api).toContain("agent.runAutopilot(");
  });

  it("the Public tab carries the toggle and the run renderer", () => {
    expect(idx).toContain('id="publicAutopilot"');
    expect(idx).toContain("renderAutopilotRun(res.autopilot)");
    expect(idx).toContain("autopilot: useAutopilot");
  });
});

describe("the agentic investigation stays wired (issue #102)", () => {
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const schemas = read("src/agent-tool-schemas.ts");
  const inv = read("src/investigate.ts");

  it("the model drives hand-rolled CDP tools, not the LOADER path", () => {
    expect(qa).toContain("qaInvestigate");
    expect(qa).toContain("investigateToolSpecs()");
    expect(qa).toContain("pageStateExpression()");
    // The investigation is credential-free: it must never touch the
    // dashboard key (qaUxAudit's seeding pattern stays out of it).
    expect(inv).toContain("LOADER");
    expect(inv).toContain("INVESTIGATE_MAX_CALLS");
  });

  it("is reachable from the route, the tool schema, and the dispatch", () => {
    expect(api).toContain('"/api/dashboard/qa/investigate"');
    expect(api).toContain("qaInvestigate(question, url, runId, body.profile === true)");
    expect(schemas).toContain('"qa.investigate"');
    expect(qa).toContain('case "qa.investigate"');
  });
});

describe("the desk snapshot email stays wired", () => {
  const qa = read("src/qa-agent.ts");
  const api = read("src/api.ts");
  const html = read("public/index.html");
  const pdata = read("public/public-data.js");

  it("captures the five desk views and emails them as its own email", () => {
    expect(qa).toContain("qaDeskSnapshotEmail");
    for (const name of ["overview", "chat", "runs", "portfolio", "approvals"]) {
      expect(qa).toContain(`name: "${name}"`);
    }
    expect(qa).toContain("desk-${spec.name}-${dateStr}.png");
    expect(api).toContain('"/api/dashboard/qa/desk-snapshot"');
    expect(api).toContain("qaDeskSnapshotEmail(key, toEmail, runId)");
    expect(html).toContain('onclick="emailDeskSnapshot()"');
    expect(pdata).toContain("emailDeskSnapshot");
    // The QA report email is a different product and stays untouched:
    // its subject prefix must not leak into the snapshot path.
    expect(qa).toContain("Autopilot Trading Desk Snapshot");
  });
});
