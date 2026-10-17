import { Hono } from "hono";
import { safeStringify } from "./browser-lifecycle";
import Stripe from "stripe";
import type { Env, PaymentClaim, StripeConfig } from "./types";
import { renderStripeReturnPage } from "./stripe-return-page";
import { ZERO_ADDRESS, formatAmount, formatEthAmount, parsePaymentClaim, parsePaymentConfig, verifyTestnetPayment } from "./payments";
import { CfmailAgentSQLite as CfmailAgent, PAYMENT_CLAIM_REUSED_PREFIX } from "./agent";
import { getAgentByName } from "agents";
import { timingSafeStringEqual } from "./mcp-auth";
import { getOAuthUserFromRequest } from "./auth";
import {
  PUBLIC_MCP_URL,
  callTool,
  listTools,
  mcpCall,
  type McpSession,
} from "./public-mcp";
import {
  extractAccountId,
  extractExpirations,
  matchProp,
  missingRequired,
  parseSymbolsParam,
  parseToolJson,
  pickArgs,
  schemaProps,
} from "./public-data";
import {
  DEFAULT_PUBLIC_OAUTH_SCOPES,
  buildAuthorizeUrl,
  PUBLIC_OAUTH_CLIENT_PATH,
  clientMetadataDocument,
  codeChallengeFor,
  createPkceSession,
  discoverAuthorizationServer,
  exchangeCode,
  isFreshPending,
  isOwnClientId,
  stateMatches,
} from "./public-oauth";
import { defaultModelId, listModels, resolveModelId } from "./models";
import questionLibrary from "./questions.json";

/**
 * Best-effort per-IP rate limiter for the unauthenticated /api/stripe/checkout
 * endpoint. Memory is per-isolate, so load spread across isolates is not
 * counted together; for robust protection, add a Cloudflare Rate Limiting rule
 * on /api/stripe/checkout instead.
 */
const STRIPE_CHECKOUT_LIMIT = 10;
const STRIPE_CHECKOUT_WINDOW_MS = 60_000;
const stripeCheckoutHits = new Map<string, number[]>();

function isStripeCheckoutRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - STRIPE_CHECKOUT_WINDOW_MS;
  const recent = (stripeCheckoutHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= STRIPE_CHECKOUT_LIMIT) {
    stripeCheckoutHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  stripeCheckoutHits.set(ip, recent);
  // Bound the map itself: drop IPs with no recent hits.
  if (stripeCheckoutHits.size > 2000) {
    for (const [key, times] of stripeCheckoutHits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) stripeCheckoutHits.delete(key);
    }
  }
  return false;
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * Shown when Public.com refuses this client_id.
   *
   * Verified against production. Public.com's authorization server rejects every
   * client_id not registered with them: an opaque id, a URL, their own origin, and
   * the client_id Anthropic uses for Claude. A Client ID Metadata Document is
   * refused too, even though their metadata advertises
   * client_id_metadata_document_supported, and serving a valid document at the
   * client_id URL does not help. There is no registration endpoint either, so a
   * client cannot be created programmatically.
   *
   * Consequence: sign-in cannot be provisioned from this Worker. Claude works
   * because it is a client registered with Public.com, not because of a mechanism
   * that can be reused here.
   */
  const PUBLIC_CLIENT_REJECTED_MESSAGE = [
    "Public.com will not authorise this application.",
    "",
    "Their authorization server accepts only clients registered with them directly,",
    "and provides no endpoint to register one. A Client ID Metadata Document is not",
    "accepted either, despite their metadata advertising support for it.",
    "",
    "To use Public.com here, connect with a personal access token on the Public tab:",
    "create one on the API settings page of your Public account and paste it there.",
    "That path is verified working.",
    "",
    "Or connect Public.com straight to Claude, ChatGPT or Perplexity, which they",
    "support as first-party clients:",
    "https://public.com/api/docs/templates/hosted-mcp",
  ].join("\n");

  async function requireAuth(c: any, next: any) {
    // Dual auth: existing API-key sign-on OR GitHub OAuth session.
    // API-key path is unchanged; OAuth is purely additive.
    const presented = c.req.header("X-API-Key") ?? "";
    if (c.env.DASHBOARD_API_KEY && timingSafeStringEqual(presented, c.env.DASHBOARD_API_KEY)) {
      return next();
    }
    // Fall back to OAuth session cookie.
    const oauthUser = await getOAuthUserFromRequest(c.req.raw);
    if (oauthUser) {
      return next();
    }
    // Fail closed: neither valid API key nor valid OAuth session.
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ---------------------------------------------------------------------------
  // Public.com chat.
  //
  // Two ways to connect, both ending with the credential held on the agent
  // instance and never sent back to the browser:
  //
  //   1. "Connect Public" (preferred) - OAuth 2.1 with PKCE S256. The user is
  //      redirected to Public's own sign-in page and lands back on the chat.
  //      The public client identifies via a Client ID Metadata Document served
  //      by this Worker (Public's AS supports CIDMD, publishes no DCR endpoint).
  //   2. A pasted personal access token - the documented fallback.
  //
  // Order-placing tools are refused in the model loop unless PUBLIC_ALLOW_TRADING
  // is set: their guide warns that a trade placed through an MCP client is a real
  // order using real money, so read-only is the default posture. The OAuth
  // scopes requested here are read-only as well.
  // ---------------------------------------------------------------------------

  // Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).
  // Only this deployment's own client_id is ever described.
  app.get(PUBLIC_OAUTH_CLIENT_PATH, (c) => {
    const origin = new URL(c.req.url).origin;
    return new Response(JSON.stringify(clientMetadataDocument(origin)), {
      status: 200,
      headers: {
        // Must be JSON: the authorization server parses this to learn the
        // redirect URIs for the client_id it was given.
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // Compatibility: the earlier revision served the same document here behind a
  // client_id query parameter. Kept so an already-registered client_id still
  // resolves, but it is not the URL we advertise.
  app.get("/.well-known/oauth-client-id-metadata-document", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(clientMetadataDocument(origin));
  });

  // Start the sign-in: discover the authorization server, store the PKCE
  // session on the agent instance, and send the user to Public's login page.
  app.get("/auth/public/connect", async (c) => {
    // Browser navigation cannot send headers; the dashboard passes its own key
    // as ?key=, the same pattern the WebSocket state sync uses.
    const presented = c.req.query("key") ?? "";
    if (!c.env.DASHBOARD_API_KEY || !timingSafeStringEqual(presented, c.env.DASHBOARD_API_KEY)) {
      return c.text("Unauthorized", 401);
    }

    const origin = new URL(c.req.url).origin;
    const redirectUri = origin + "/auth/public/callback";
    // Must equal `iss` in the document; the AS compares the two.
    const clientId = clientMetadataDocument(origin).iss;

    try {
      const as = await discoverAuthorizationServer(PUBLIC_MCP_URL);
      const pending = await createPkceSession(clientId, as, redirectUri);
      const challenge = await codeChallengeFor(pending.codeVerifier);
      const url = buildAuthorizeUrl(
        as,
        clientId,
        redirectUri,
        pending.state,
        challenge,
        DEFAULT_PUBLIC_OAUTH_SCOPES,
        PUBLIC_MCP_URL,
      );
      // Probe the authorize endpoint before sending the browser to it.
      //
      // Public.com rejects a client_id it has not registered with a bare
      // invalid_request, and calling it is the only way to know. Checking here
      // turns a dead-end JSON error on Public's site into an explanation on ours.
      try {
        const probe = await fetch(url, { redirect: "manual" });
        if (probe.status === 400 && (await probe.text()).includes("client_id")) {
          return c.text(PUBLIC_CLIENT_REJECTED_MESSAGE, 502);
        }
      } catch {
        // Not conclusive: fall through so a transient error cannot block sign-in.
      }

      const agent = getAgent(c);
      await agent.setPublicOAuthPending(pending);
      return c.redirect(url, 302);
    } catch (err) {
      return c.text(
        "Could not start the Public.com sign-in: " + String(err) +
          "\n\nYou can still connect with a personal access token on the Public tab.",
        502,
      );
    }
  });

  // OAuth callback. Gated by the state parameter stored before the redirect,
  // not by the dashboard key (Public redirects here without one).
  app.get("/auth/public/callback", async (c) => {
    const agent = getAgent(c);
    const pending = await agent.getPublicOAuthPending();
    const fail = (message: string) => c.text(message, 400);

    if (c.req.query("error")) {
      const detail = c.req.query("error_description") || c.req.query("error") || "denied";
      await agent.clearPublicOAuthPending();
      return fail("Public.com authorization was not completed: " + detail);
    }

    const code = c.req.query("code");
    if (!code) {
      await agent.clearPublicOAuthPending();
      return fail("Missing authorization code.");
    }

    if (!isFreshPending(pending) || !stateMatches(c.req.query("state"), pending.state)) {
      await agent.clearPublicOAuthPending();
      return fail("Invalid or expired OAuth state. Start again from the Public tab.");
    }

    try {
      const previous = await agent.getPublicOAuthRecord();
      const tokens = await exchangeCode(pending, code, previous?.revocationEndpoint);
      // Verify before saving: a credential that cannot list tools is not useful.
      const tools = await listTools(tokens.accessToken, {});
      await agent.savePublicOAuthTokens(tokens);
      // Back to the chat interface, on the Public tab.
      return c.redirect("/?tab=public&connected=" + tools.length, 303);
    } catch (err) {
      return c.text(
        "Public.com sign-in failed while exchanging the code: " + String(err) +
          "\n\nYou can still connect with a personal access token on the Public tab.",
        502,
      );
    }
  });

  app.get("/api/public/status", requireAuth, async (c) => {
    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    const method = token ? await agent.getPublicTokenSource() : null;
    const stored = await agent.getPublicModel();
    return c.json({
      connected: Boolean(token),
      // "oauth" = signed in with Connect Public; "token" = pasted key.
      method,
      model: resolveModelId(stored),
      modelIsDefault: !stored,
      // Shown so the user can confirm which credential is active.
      tokenHint: token ? token.slice(0, 4) + "..." + token.slice(-4) : null,
      allowTrading: allowTrading(c.env),
      mcpUrl: PUBLIC_MCP_URL,
    });
  });

  app.post("/api/public/connect", requireAuth, async (c) => {
    const body = await c.req.json<{ token?: string }>();
    const token = (body.token || "").trim();
    if (!token) return c.json({ error: "An access token is required." }, 400);

    // Verify before storing: a token that cannot list tools is not useful, and
    // storing it first would make the UI claim a connection that does not work.
    try {
      const tools = await listTools(token, {});
      const agent = getAgent(c);
      await agent.setPublicToken(token);
      return c.json({ ok: true, toolCount: tools.length, tools: tools.map((t) => t.name) });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/public/disconnect", requireAuth, async (c) => {
    const agent = getAgent(c);
    // Best-effort revocation of the OAuth grant, then drop both credentials.
    try {
      const record = await agent.getPublicOAuthRecord();
      if (record?.accessToken && record.revocationEndpoint) {
        await fetch(record.revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: record.accessToken,
            client_id: record.clientId,
          }).toString(),
        }).catch(() => {});
      }
    } catch {
      /* the token set is dropped below regardless */
    }
    await agent.clearPublicOAuthTokens();
    await agent.clearPublicToken();
    return c.json({ ok: true });
  });

  app.get("/api/public/tools", requireAuth, async (c) => {
    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    if (!token) return c.json({ error: "Not connected." }, 409);
    try {
      const tools = await listTools(token, {});
      // Full definitions, not just names: the Public tab renders these as a
      // grid (name, description, parameters from the input schema) so what
      // each tool does - and what it takes - is readable in the UI, not only
      // visible to the model.
      return c.json({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema ?? null,
        })),
      });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // Trade proposals awaiting (or past) a human decision. Listing is open to
  // any authenticated dashboard user; deciding is the approval action itself,
  // so it goes through the agent, which delivers the decision to the waiting
  // workflow. Execution happens in the workflow, never in these routes.
  // Autopilot run history (issue #107): the persisted Goal -> Planner ->
  // Queue -> Executor -> Verifier state, newest first.
  app.get("/api/public/autopilot-runs", requireAuth, async (c) => {
    const agent = getAgent(c);
    return c.json({ runs: await agent.listAutopilotRuns() });
  });

  // One run's Sessions transcript (agents/sessions), recorded by the pipeline.
  app.get("/api/public/autopilot-runs/:id/session", requireAuth, async (c) => {
    const agent = getAgent(c);
    return c.json({ messages: await agent.getAutopilotRunSession(c.req.param("id")) });
  });

  // Trading desk data reads (issue #112 part 2): the desk's panels call
  // the MCP tools directly — no model in the path, so the numbers on the
  // desk are the tools' own. Parameter names are mapped onto each tool's
  // live inputSchema (see src/public-data.ts); a required parameter that
  // cannot be mapped is reported by name, never guessed.
  const asData = (text: string): { data: unknown; raw?: string } => {
    const parsed = parseToolJson(text);
    return parsed === undefined ? { data: null, raw: text } : { data: parsed };
  };

  app.get("/api/public/quotes", requireAuth, async (c) => {
    const symbols = parseSymbolsParam(c.req.query("symbols"));
    if (!symbols.length) {
      return c.json({ error: "Pass ?symbols=NVDA,AMD with at least one valid symbol." }, 400);
    }
    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    if (!token) {
      return c.json({ error: "Not connected to Public.com. Paste an access token first." }, 409);
    }
    try {
      const session: McpSession = {};
      const tools = await listTools(token, session);
      const tool = tools.find((t) => t.name === "get_quotes");
      if (!tool) {
        return c.json({ error: "Public.com did not offer get_quotes for this account." }, 502);
      }
      const declared = Object.keys(schemaProps(tool.inputSchema).properties).join(", ");
      const list = pickArgs(tool.inputSchema, {
        symbols: { names: ["symbols", "tickers"], value: symbols },
      });
      let payload: { data: unknown; raw?: string };
      if (list.matched.symbols) {
        payload = asData(await callTool(token, "get_quotes", list.args, session));
      } else {
        const probe = pickArgs(tool.inputSchema, {
          symbol: { names: ["symbol", "ticker"], value: symbols[0] },
        });
        if (!probe.matched.symbol) {
          return c.json(
            { error: "get_quotes declares no symbols/symbol parameter (it declares: " + declared + ")." },
            502,
          );
        }
        const rows: unknown[] = [];
        for (const s of symbols) {
          const one = pickArgs(tool.inputSchema, {
            symbol: { names: ["symbol", "ticker"], value: s },
          });
          const parsed = parseToolJson(await callTool(token, "get_quotes", one.args, session));
          rows.push({ symbol: s, quote: parsed === undefined ? null : parsed });
        }
        payload = { data: rows };
      }
      return c.json({ tool: "get_quotes", symbols, ...payload, fetchedAt: new Date().toISOString() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/public/portfolio", requireAuth, async (c) => {
    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    if (!token) {
      return c.json({ error: "Not connected to Public.com. Paste an access token first." }, 409);
    }
    try {
      const session: McpSession = {};
      const tools = await listTools(token, session);
      const tool = tools.find((t) => t.name === "get_portfolio");
      if (!tool) {
        return c.json({ error: "Public.com did not offer get_portfolio for this account." }, 502);
      }
      const args: Record<string, unknown> = {};
      const { properties, required } = schemaProps(tool.inputSchema);
      const acctProp = matchProp(properties, ["accountId", "account_id", "account", "accountNumber"]);
      if (acctProp && required.includes(acctProp)) {
        const accounts = parseToolJson(await callTool(token, "get_accounts", {}, session));
        const accountId = extractAccountId(accounts);
        if (!accountId) {
          return c.json(
            { error: "get_portfolio requires an account id, but none could be read from get_accounts." },
            502,
          );
        }
        args[acctProp] = accountId;
      }
      const missing = missingRequired(tool.inputSchema, args);
      if (missing.length) {
        return c.json(
          { error: "get_portfolio requires unsupported parameters: " + missing.join(", ") + "." },
          502,
        );
      }
      const payload = asData(await callTool(token, "get_portfolio", args, session));
      return c.json({ tool: "get_portfolio", ...payload, fetchedAt: new Date().toISOString() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/public/chain", requireAuth, async (c) => {
    const symbol = (c.req.query("symbol") || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(symbol)) {
      return c.json({ error: "Pass ?symbol=SMH (and optionally &expiry=YYYY-MM-DD)." }, 400);
    }
    let expiry = c.req.query("expiry") || "";
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return c.json({ error: "expiry must be YYYY-MM-DD." }, 400);
    }
    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    if (!token) {
      return c.json({ error: "Not connected to Public.com. Paste an access token first." }, 409);
    }
    try {
      const session: McpSession = {};
      const tools = await listTools(token, session);
      const chainTool = tools.find((t) => t.name === "get_option_chain");
      if (!chainTool) {
        return c.json({ error: "Public.com did not offer get_option_chain for this account." }, 502);
      }
      // The option tools require the account id (production-verified:
      // get_option_expirations rejects a symbol-only call with
      // "account_id: Field required"). In chat the model resolves it
      // conversationally; here it is resolved explicitly, the same way
      // /api/public/portfolio does. Mapped on below only where a tool's
      // schema actually declares it.
      const accounts = parseToolJson(await callTool(token, "get_accounts", {}, session));
      const accountId = extractAccountId(accounts);
      const accountSpec: Record<string, { names: string[]; value: unknown }> = accountId
        ? { account: { names: ["account_id", "accountId", "account", "accountNumber"], value: accountId } }
        : {};
      const symbolNames = ["symbol", "ticker", "underlying", "underlyingSymbol", "underlying_symbol"];
      const expiryNames = ["expiration", "expirationDate", "expiry", "expiration_date", "date"];
      // Resolve an expiry when the caller did not give one. Every failure
      // mode is named in resolutionNote: if the chain call below cannot
      // proceed without an expiry, the 502 carries the note, so the
      // response itself says which assumption about the tool was wrong.
      let expirations: string[] = [];
      let resolutionNote = "";
      if (!expiry) {
        const expTool = tools.find((t) => t.name === "get_option_expirations");
        if (!expTool) {
          resolutionNote = "get_option_expirations was not offered for this account";
        } else {
          const expPick = pickArgs(expTool.inputSchema, {
            symbol: { names: symbolNames, value: symbol },
            ...accountSpec,
          });
          if (!expPick.matched.symbol) {
            const declared = Object.keys(schemaProps(expTool.inputSchema).properties).join(", ");
            resolutionNote = "get_option_expirations declares no symbol parameter (it declares: " + declared + ")";
          } else {
            const text = await callTool(token, "get_option_expirations", expPick.args, session);
            expirations = extractExpirations(parseToolJson(text));
            if (expirations.length) {
              expiry = expirations[0];
            } else {
              resolutionNote = "get_option_expirations answered with no readable dates: " + text.slice(0, 200);
            }
          }
        }
      }
      // With an expiry, map it on; without one, call symbol-only — chain
      // tools commonly default to the nearest expiry when theirs is
      // optional. missingRequired below is the guard: if the tool REQUIRES
      // an expiry and none could be resolved, the call never happens.
      const picked = pickArgs(chainTool.inputSchema, {
        symbol: { names: symbolNames, value: symbol },
        ...accountSpec,
        ...(expiry ? { expiration: { names: expiryNames, value: expiry } } : {}),
      });
      if (!picked.matched.symbol) {
        const declared = Object.keys(schemaProps(chainTool.inputSchema).properties).join(", ");
        return c.json(
          { error: "get_option_chain declares no symbol parameter (it declares: " + declared + ")." },
          502,
        );
      }
      const missing = missingRequired(chainTool.inputSchema, picked.args);
      if (missing.length) {
        return c.json(
          {
            error:
              "get_option_chain requires " + missing.join(", ") +
              ", and no expiration could be resolved for " + symbol +
              (resolutionNote ? " (" + resolutionNote + ")" : "") +
              (!accountId && missing.includes("account_id")
                ? " No account id could be read from get_accounts."
                : "") + ".",
          },
          502,
        );
      }
      const payload = asData(await callTool(token, "get_option_chain", picked.args, session));
      return c.json({
        tool: "get_option_chain",
        symbol,
        expiry: expiry || null,
        expirations,
        ...(expiry ? {} : { note: resolutionNote || "expiration not specified; the tool's default was used" }),
        ...payload,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/public/trades", requireAuth, async (c) => {
    const agent = getAgent(c);
    const proposals = await agent.listTradeProposals();
    return c.json({ proposals });
  });

  app.post("/api/public/trades/:id/decision", requireAuth, async (c) => {
    const body = await c.req
      .json<{ approved?: boolean; notes?: string }>()
      .catch(() => ({}) as { approved?: boolean; notes?: string });
    if (typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required." }, 400);
    }
    const agent = getAgent(c);
    try {
      const proposal = await agent.decideTradeProposal(c.req.param("id"), body.approved, body.notes);
      return c.json({ proposal });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // The catalogue the picker renders. Read-only, no credentials involved.
  // tradingEnabled rides along so the dashboard can show the deployment's
  // live trading state on the status card instead of static copy.
  app.get("/api/public/models", requireAuth, async (c) => {
    const agent = getAgent(c);
    const stored = await agent.getPublicModel();
    return c.json({
      models: listModels(),
      defaultModel: defaultModelId(),
      selected: resolveModelId(stored),
      isDefault: !stored,
      tradingEnabled: allowTrading(c.env),
    });
  });

  app.post("/api/public/model", requireAuth, async (c) => {
    const body = await c.req.json<{ model?: string }>();
    const requested = (body.model || "").trim();
    if (!requested) {
      // Clearing the choice returns to the configured default.
      const agent = getAgent(c);
      await agent.setPublicModel("");
      return c.json({ ok: true, model: defaultModelId(), isDefault: true });
    }
    const chosen = resolveModelId(requested);
    if (chosen !== requested) {
      return c.json(
        { error: "Unknown model: " + requested + ". Pick one from /api/public/models." },
        400,
      );
    }
    const agent = getAgent(c);
    await agent.setPublicModel(chosen);
    return c.json({ ok: true, model: chosen, isDefault: false });
  });

  // The question library, so the UI can render it without duplicating the text
  // and so it can be edited in one place. Read-only, no credentials involved.
  // Summary of what the agent holds, for the A2A executor. Read-only and
  // deliberately aggregate: no email bodies, no addresses, no tx hashes.
  app.get("/api/a2a/snapshot", requireAuth, async (c) => {
    const agent = getAgent(c);
    return c.json(await agent.a2aSnapshot());
  });

  app.get("/api/public/questions", requireAuth, async (c) => {
    return c.json(questionLibrary);
  });

  app.post("/api/public/chat", requireAuth, async (c) => {
    const body = await c.req.json<{ message?: string; autopilot?: boolean }>();
    const message = (body.message || "").trim();
    if (!message) return c.json({ error: "message is required" }, 400);

    const agent = getAgent(c);
    const token = await agent.getPublicToken();
    if (!token) return c.json({ error: "Not connected to Public.com. Paste an access token first." }, 409);

    try {
      const session: McpSession = {};
      const tools = await listTools(token, session);
      if (tools.length === 0) return c.json({ error: "Public.com returned no tools for this account." }, 502);
      const storedModel = await agent.getPublicModel();
      if (body.autopilot) {
        const result = await agent.runAutopilot(token, message, tools, session, storedModel);
        return c.json({ ...result, finishReason: "autopilot" });
      }
      const { answer, trace, model, cost, finishReason } = await agent.answerInstrumentQuestion(
        token,
        message,
        tools,
        session,
        storedModel,
      );
      return c.json({ answer, trace, model, cost, finishReason });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });
  function getAgent(c: any) {
    const agentId = c.env.CfmailAgent.idFromName("agent");
    return c.env.CfmailAgent.get(agentId) as any;
  }

  /**
   * The QA agent stub.
   *
   * Async, because getAgentByName resolves to Promise<DurableObjectStub<T>>. It is not
   * marked async and then unwrapped with `as any`: that cast is what let four callers read
   * properties of a Promise without the compiler objecting, so every QA route threw a
   * TypeError and returned a plain-text 500 the dashboard could not parse.
   */
  /**
   * Serialize a QA result, turning a serialization failure into a named 500.
   *
   * c.json() serializes inside Hono, AFTER the handler returns, so a plain
   * try/catch around it would not catch a failure - the response would still be
   * an opaque 500 with no explanation, which is the situation this replaces.
   * Serializing here keeps the failure inside the try.
   *
   * The stringify is a CHECK, not a transformation: the original value is
   * still what gets sent, so this cannot alter the payload (a JSON round-trip
   * would silently drop undefined fields, which is why it is not used).
   *
   * The log line matters as much as the response: without the culprit and a
   * bounded preview, the only evidence is "500" and the cause has to be
   * guessed. safeStringify is used because stringifying the value that just
   * failed to serialize would throw again and destroy the diagnostic.
   */
  function jsonOr500(c: any, result: unknown, label: string) {
    try {
      JSON.stringify(result);
      return c.json(result as any);
    } catch (e) {
      console.error(
        `Failed to serialize QA result (${label}):`,
        e instanceof Error ? e.message : e,
        safeStringify(result),
      );
      return c.json({ error: "Failed to serialize result", route: label }, 500);
    }
  }

  async function getQAAgent(c: any) {
    // Awaiting is the fix: getAgentByName resolves to Promise<DurableObjectStub<T>>, and
    // the previous version returned that Promise while callers used it as a stub. Every QA
    // route then read a property of a Promise, threw, and Hono turned it into a plain-text
    // 500 that the dashboard reported as a JSON parse error.
    //
    // The result is narrowed to the methods this file calls rather than written as
    // getAgentByName<Env, QAAgent>: that form makes the compiler expand QAAgent (which
    // references Env) against Env (which references QA_AGENT) until it reports TS2589.
    const stub = await getAgentByName(c.env.QA_AGENT as any, "qa");
    return stub as unknown as {
      qaCheck(url: string, checks?: { textContains?: string[]; apiKey?: string; runId?: string }): Promise<unknown>;
      qaDashboard(apiKey?: string, runId?: string): Promise<unknown>;
      qaDashboardTabs(
        apiKey: string,
        sharedConnection?: unknown,
        captureScreenshots?: boolean,
        runId?: string,
      ): Promise<{ ok: boolean; tabs: { name: string; passed: boolean; detail: string }[]; error?: string }>;
      qaUxAudit(
        apiKey: string,
        runId?: string,
      ): Promise<{ ok: boolean; checks: { name: string; passed: boolean; detail: string }[]; error?: string }>;
      qaUxAuditUrl(
        spec: any,
        runId?: string,
      ): Promise<{ ok: boolean; checks: { name: string; passed: boolean; detail: string }[]; pagesAudited: string[]; error?: string }>;
      qaInvestigate(
        question: string,
        url: string,
        runId?: string,
      ): Promise<{
        ok: boolean;
        answer?: string;
        steps: { tool: string; detail: string }[];
        url: string;
        model: string;
        error?: string;
      }>;
      qaAndEmailReport(
        apiKey: string,
        toEmail: string,
        runId?: string,
      ): Promise<{ ok: boolean; emailed: boolean; tabs: unknown[]; error?: string }>;
      testEmailAttachmentUI(
        apiKey: string,
        toEmail: string,
        runId?: string,
      ): Promise<{ ok: boolean; detail: string; error?: string }>;
      qaPaymentFlow(origin?: string): Promise<{
        ok: boolean;
        detail: string;
        checks: { name: string; passed: boolean; detail: string }[];
        unpaidPathVerified: boolean;
        settlementVerified: boolean;
        error?: string;
      }>;
      qaEdgeCases(origin?: string): Promise<{
        ok: boolean;
        detail: string;
        checks: { name: string; passed: boolean; detail: string }[];
      }>;
      qaFullSuite(
        apiKey: string,
        toEmail?: string,
        runId?: string,
      ): Promise<{
        ok: boolean;
        checks: { name: string; passed: boolean; detail: string; skipped?: boolean }[];
        emailed: boolean;
        error?: string;
      }>;
    };
  }


  // Read-only by default. Their server can place real orders; enabling this is a
  // deliberate opt-in via the Worker secret PUBLIC_ALLOW_TRADING.
  /** Read-only unless PUBLIC_ALLOW_TRADING is explicitly "true" on the Worker. */
  function allowTrading(env: Env): boolean {
    return String((env as any).PUBLIC_ALLOW_TRADING || "").trim().toLowerCase() === "true";
  }

  function getPaymentConfig(env: Env) {
    return parsePaymentConfig(env.PAYMENT_CONFIG);
  }

  /**
   * Card pricing and credentials. Card checkout is disabled unless both the
   * secret key and a usable config are present, matching the fail-closed
   * convention used by the other optional integrations.
   */
  function getStripeConfig(env: Env): StripeConfig | null {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_CONFIG) return null;
    try {
      const parsed = JSON.parse(env.STRIPE_CONFIG) as Partial<StripeConfig>;
      if (
        typeof parsed.priceId !== "string" ||
        parsed.priceId.length === 0 ||
        typeof parsed.amountCents !== "number" ||
        !Number.isInteger(parsed.amountCents) ||
        parsed.amountCents <= 0 ||
        typeof parsed.currency !== "string" ||
        parsed.currency.length === 0
      ) {
        return null;
      }
      return {
        priceId: parsed.priceId,
        amountCents: parsed.amountCents,
        currency: parsed.currency.toLowerCase(),
      };
    } catch {
      return null;
    }
  }

  function getStripe(env: Env): Stripe {
    // createFetchHttpClient keeps requests on the Workers fetch implementation.
    return new Stripe(env.STRIPE_SECRET_KEY as string, {
      httpClient: Stripe.createFetchHttpClient(),
    });
  }

  /** Stripe errors can echo request detail; never surface a key. */
  function safeStripeError(error: unknown): string {
    const message = error instanceof Error ? error.message : "Unknown Stripe error";
    return message.replace(/sk_[A-Za-z0-9_]+/g, "sk_[redacted]").slice(0, 300);
  }

  /** Opaque, unguessable id correlating a checkout with its webhook. */
  function generateRequestId(): string {
    return "cfm_" + crypto.randomUUID().replace(/-/g, "");
  }


  function buildPaymentChallenge(env: Env, description: string, origin: string) {
    const config = getPaymentConfig(env);
    const accepts = [];

    for (const [network, options] of Object.entries(config.networks)) {
      if (options.ethAmount) {
        accepts.push({
          scheme: "exact",
          network,
          asset: ZERO_ADDRESS,
          amount: options.ethAmount,
          payTo: env.PAY_TO_ADDRESS,
          maxTimeoutSeconds: 3600,
          extra: { label: "ETH", name: options.name || network },
        });
      }
      if (options.usdc && options.usdcAmount) {
        accepts.push({
          scheme: "exact",
          network,
          asset: options.usdc,
          amount: options.usdcAmount,
          payTo: env.PAY_TO_ADDRESS,
          maxTimeoutSeconds: 3600,
          extra: { label: "USDC", name: options.name || network },
        });
      }
    }

    const challenge = {
      x402Version: 2,
      resource: {
        url: `${origin}/api/process`,
        description: description,
        mimeType: "application/json",
      },
      accepts,
    };
    const encoded = btoa(JSON.stringify(challenge));
    return {
      "PAYMENT-REQUIRED": encoded,
      "x-payment-required": encoded,
    };
  }

  async function verifyPayment(
    env: Env,
    paymentHeader: string,
    challenge: unknown,
    claim: PaymentClaim,
  ): Promise<{ verified: boolean; receipt?: string; error?: string }> {
    if (claim.network === "eip155:84532" || claim.network === "eip155:11155111") {
      try {
        await verifyTestnetPayment(claim);
        return {
          verified: true,
          receipt: btoa(JSON.stringify({
            verified: true,
            network: claim.network,
            txHash: claim.txHash,
            testnet: true,
            timestamp: Date.now(),
          })),
        };
      } catch (error) {
        console.warn("Testnet on-chain payment verification failed:", error);
        return {
          verified: false,
          error: error instanceof Error ? error.message : "Testnet payment verification failed.",
        };
      }
    }

    const facilitatorUrl = env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    try {
      const parsedFacilitatorUrl = new URL(facilitatorUrl);
      if (parsedFacilitatorUrl.protocol !== "https:") {
        return { verified: false, error: "The x402 facilitator URL must use HTTPS." };
      }
      const response = await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentHeader,
          paymentRequirements: challenge,
        }),
      });
      const result = await response.json().catch(() => null) as {
        isValid?: boolean;
        invalidReason?: string;
        reason?: string;
        receipt?: string;
      } | null;
      if (!response.ok) {
        return {
          verified: false,
          error: result?.invalidReason || result?.reason || `Facilitator verification failed [HTTP ${response.status}].`,
        };
      }
      if (result?.isValid !== true) {
        return {
          verified: false,
          error: result?.invalidReason || result?.reason || "Facilitator did not confirm the payment.",
        };
      }
      return {
        verified: true,
        receipt: result.receipt || btoa(JSON.stringify({ verified: true, timestamp: Date.now() })),
      };
    } catch (error) {
      console.error("Facilitator verification failed:", error);
      return {
        verified: false,
        error: error instanceof Error ? error.message : "Facilitator verification is unavailable.",
      };
    }
  }

  function buildPaymentResponse(receipt: string) {
    return {
      "PAYMENT-RESPONSE": receipt,
      "x-payment-response": receipt,
    };
  }

  async function verifyRequestPayment(
    env: Env,
    paymentHeader: string,
    description: string,
    origin: string,
  ): Promise<{ verified: true; claim: PaymentClaim; receipt: string } | { verified: false; error: string }> {
    let claim: PaymentClaim;
    try {
      claim = parsePaymentClaim(paymentHeader, env);
    } catch (error) {
      return {
        verified: false,
        error: error instanceof Error ? error.message : "Invalid payment signature.",
      };
    }
    const challengeHeaders = buildPaymentChallenge(env, description, origin);
    const challenge = JSON.parse(atob(challengeHeaders["PAYMENT-REQUIRED"])) as unknown;
    const verification = await verifyPayment(env, paymentHeader, challenge, claim);
    if (!verification.verified) {
      return { verified: false, error: verification.error || "Payment verification failed." };
    }
    return {
      verified: true,
      claim,
      receipt: verification.receipt || btoa(JSON.stringify({ verified: true, timestamp: Date.now() })),
    };
  }

  app.get("/health", (c) => {
    return c.json({ status: "ok", service: "cfmail-agent", version: "10.0.0" });
  });


  // ---------------------------------------------------------------------------
  // Stripe card payments
  // ---------------------------------------------------------------------------

  /**
   * Create a hosted Checkout Session for one request.
   *
   * The amount comes from server config, never from the client. The request
   * text is held in Durable Object state against a requestId rather than being
   * passed to Stripe, so the return path never trusts client input.
   */
  app.post("/api/stripe/checkout", async (c) => {
    // Best-effort per-IP throttling for this unauthenticated endpoint.
    const clientIp =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown";
    if (isStripeCheckoutRateLimited(clientIp)) {
      return c.json({ error: "Too many requests. Please try again in a minute." }, 429);
    }

    const config = getStripeConfig(c.env);
    if (!config) {
      return c.json(
        { error: "Card payments are not configured on this deployment." },
        503,
      );
    }

    let body: { email?: unknown; request?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const request = typeof body.request === "string" ? body.request.trim() : "";

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.json({ error: "A valid email address is required." }, 400);
    }
    if (!request) {
      return c.json({ error: "A request description is required." }, 400);
    }
    if (request.length > 2000) {
      return c.json({ error: "Request is too long." }, 400);
    }

    const requestId = generateRequestId();
    const agent = getAgent(c);

    const intent = await agent.createStripeCheckoutIntent(requestId, email, request);
    if (!intent || !intent.ok) {
      return c.json(
        { error: (intent && intent.error) || "Could not start a checkout." },
        409,
      );
    }

    // Absolute base URL for links handed to Stripe. Explicit config wins;
    // otherwise fall back to the request's own origin (same pattern as the
    // x402 payment challenge).
    const stripeBaseUrl = (c.env.APP_BASE_URL || new URL(c.req.url).origin).replace(/\/$/, "");

    try {
      const stripe = getStripe(c.env);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: config.priceId, quantity: 1 }],
        customer_email: email,
        client_reference_id: requestId,
        metadata: { cfmail_source: "cfmail", cfmail_request_id: requestId },
        success_url:
          `${stripeBaseUrl}/api/stripe/return?request_id=` +
          requestId +
          `&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${stripeBaseUrl}/?checkout=cancelled`,
      });

      if (!session.url) {
        return c.json({ error: "Stripe did not return a checkout URL." }, 502);
      }

      await agent.attachStripeSession(requestId, session.id, session.url);

      return c.json({ url: session.url, requestId, sessionId: session.id });
    } catch (error) {
      console.error("Stripe checkout creation failed:", safeStripeError(error));
      return c.json({ error: "Could not create the checkout session." }, 502);
    }
  });

  /**
   * Where Stripe sends the browser after payment.
   *
   * Display only: it deliberately does NOT fulfil. A browser redirect is not
   * proof of payment, so the work is done solely by the signed webhook.
   */
  app.get("/api/stripe/return", async (c) => {
    const requestId = c.req.query("request_id") || "";
    const agent = getAgent(c);
    const state = requestId ? await agent.getStripeCheckoutStatus(requestId) : null;

    const found = Boolean(state && state.found);
    const fulfilled = Boolean(found && state && state.status === "fulfilled");

    return c.html(renderStripeReturnPage({ requestId, found, fulfilled }));
  });
  app.post("/api/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, c.env.PAYMENT_DESCRIPTION, new URL(c.req.url).origin),
      );
    }
    const verification = await verifyRequestPayment(
      c.env,
      paymentHeader,
      c.env.PAYMENT_DESCRIPTION,
      new URL(c.req.url).origin,
    );
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    let result;
    try {
      result = await agent.processPaidRequest(body.email, body.request, verification.claim);
    } catch (err) {
      // A replayed (already-consumed) claim is rejected by the agent. Fail
      // closed with 409 rather than a generic 500.
      if (err instanceof Error && err.message.startsWith(PAYMENT_CLAIM_REUSED_PREFIX)) {
        return c.json(
          {
            error: "Payment already used",
            details: err.message.slice(PAYMENT_CLAIM_REUSED_PREFIX.length).trim(),
          },
          409,
        );
      }
      throw err;
    }
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({ success: true, receipt: result });
  });

  app.get("/api/emails", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, "Access to stored email history", new URL(c.req.url).origin),
      );
    }
    const verification = await verifyRequestPayment(
      c.env,
      paymentHeader,
      "Access to stored email history",
      new URL(c.req.url).origin,
    );
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const agent = getAgent(c);
    const emails = await agent.getEmails(null, 50);
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({ emails });    
  });

  app.post("/mcp/tools/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, "Process email request via MCP tool", new URL(c.req.url).origin),
      );
    }
    const verification = await verifyRequestPayment(
      c.env,
      paymentHeader,
      "Process email request via MCP tool",
      new URL(c.req.url).origin,
    );
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    let result;
    try {
      result = await agent.processPaidRequest(body.email, body.request, verification.claim);
    } catch (err) {
      // A replayed (already-consumed) claim is rejected by the agent. Fail
      // closed with 409 rather than a generic 500.
      if (err instanceof Error && err.message.startsWith(PAYMENT_CLAIM_REUSED_PREFIX)) {
        return c.json(
          {
            error: "Payment already used",
            details: err.message.slice(PAYMENT_CLAIM_REUSED_PREFIX.length).trim(),
          },
          409,
        );
      }
      throw err;
    }
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({
      content: [
        { type: "text", text: `Processed and sent email response to ${body.email}` },
      ],
      receipt: result,
    });
  });

  app.get("/api/dashboard/stats", requireAuth, async (c) => {
    try {
      const agent = getAgent(c);
      const state = await agent.getDashboardData();
      // Payment counts come from the ledger, not from this instance's counters: the
      // payments agent owns the ledger now, and the local counters stopped moving
      // when the split happened, which is why the dashboard read zero.
      const totals = await agent.getPaymentTotals().catch((error: unknown) => {
        // Logged, never silent. A swallowed error here is exactly how the dashboard
        // reported 0 payments with no way to tell a broken read from an empty ledger.
        console.error("Dashboard payment totals failed:", error);
        return { received: 0, sent: 0, stored: 0 };
      });
      const firstNetwork = Object.values(getPaymentConfig(c.env).networks)[0];
      const totalRevenue = firstNetwork?.usdcAmount
        ? `${formatAmount(firstNetwork.usdcAmount).replace("$", "")} USDC per request`
        : firstNetwork?.ethAmount
          ? `${formatEthAmount(firstNetwork.ethAmount)} ETH per request`
          : "N/A";
      // Mail counts come from the mail resource for the same reason the payment
      // counts come from the ledger: this instance's own counters only see mail that
      // it handled, so they under-report once another agent owns the resource.
      const emailTotals = await agent.getEmailTotals().catch((error: unknown) => {
        console.error("Dashboard email totals failed:", error);
        return { received: 0, sent: 0, stored: 0 };
      });
      return c.json({
        totalEmailsReceived: emailTotals.received,
        totalEmailsSent: emailTotals.sent,
        totalPaymentsReceived: totals.received,
        totalPaymentsSent: totals.sent,
        totalRevenue,
      });
    } catch (error: any) {
      console.error("Dashboard stats error:", error);
      return c.json({ error: error.message || "Failed to load stats" }, 500);
    }
  });

  app.get("/api/dashboard/emails", requireAuth, async (c) => {
    const direction = c.req.query("direction") || null;
    const agent = getAgent(c);
    const emails = await agent.getEmailsExcludingSlack(direction, 100);
    return c.json({ emails });
  });

  app.get("/api/dashboard/payments", requireAuth, async (c) => {
    const direction = c.req.query("direction") || null;
    const agent = getAgent(c);
    const payments = await agent.getPayments(direction, 100);
    return c.json({ payments });
  });

  app.post("/api/dashboard/send-email", requireAuth, async (c) => {
    const body = await c.req.json<{
      to: string;
      subject: string;
      body: string;
      attachments?: { filename: string; type: string; content: string }[];
    }>();
    // Through the shared helper, which is how every other caller reaches this agent.
    // The direct getAgentByName form was not awaited, so it returned a Promise: the
    // compiler rejected it and at runtime .sendThroughAgent would have been undefined,
    // failing the send rather than reporting why.
    const { emailAgentStub } = await import("./email-tool");
    const emailAgent = emailAgentStub(c.env as any);
    if (!emailAgent) {
      return c.json({ error: "The email agent is unavailable, so nothing was sent." }, 503);
    }
    const result = await emailAgent.sendThroughAgent({
      to: body.to,
      subject: body.subject,
      body: body.body,
      // Optional: absent means a plain send, which is the common case. The agent
      // validates the caps and refuses an oversized message with a named reason
      // before any send is attempted.
      attachments: body.attachments,
    });
    return c.json(result);
  });

  app.post("/api/dashboard/chat", requireAuth, async (c) => {
    const body = await c.req.json<{ message: string }>();
    const agent = getAgent(c);
    // chatRpc, not chat: Think owns `chat` as its streaming turn API.
    const result = await agent.chatRpc(body.message);
    return c.json(result);
  });

  // WebSocket endpoint for real-time updates.
  //
  // This hands the raw request to the Durable Object, which exposes the entire
  // @callable RPC surface — including payExternalEndpoint, which spends real
  // funds. It must therefore be authenticated. Browsers cannot set headers on a
  // WebSocket handshake, so the dashboard passes the same DASHBOARD_API_KEY it
  // already uses for the REST routes as a ?token= query parameter; the header is
  // accepted too for non-browser clients.
  app.get("/ws", async (c) => {
    const upgradeHeader = c.req.header("Upgrade");
    if (upgradeHeader !== "websocket") {
      return c.text("Expected Upgrade: websocket", 426);
    }

    const presented = c.req.header("X-API-Key") ?? c.req.query("token") ?? "";

    // Fail closed: an unset key must never match an empty presented value.
    if (!c.env.DASHBOARD_API_KEY || !timingSafeStringEqual(presented, c.env.DASHBOARD_API_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const agentId = c.env.CfmailAgent.idFromName("agent");
    const agent = c.env.CfmailAgent.get(agentId) as any;
    return agent.fetch(c.req.raw);
  });

  app.get("/api/dashboard/payment-config", requireAuth, async (c) => {
    const config = getPaymentConfig(c.env);
    const accepts = [];
    for (const [network, options] of Object.entries(config.networks)) {
      if (options.ethAmount) {
        accepts.push({
          label: "ETH",
          network,
          networkName: options.name || network,
          chainId: options.chainId,
          asset: ZERO_ADDRESS,
          amount: options.ethAmount,
          formatted: `${formatEthAmount(options.ethAmount)} ETH`,
        });
      }
      if (options.usdc && options.usdcAmount) {
        accepts.push({
          label: "USDC",
          network,
          networkName: options.name || network,
          chainId: options.chainId,
          asset: options.usdc,
          amount: options.usdcAmount,
          formatted: `${formatAmount(options.usdcAmount)} USDC`,
        });
      }
    }

    const [defaultOption] = accepts;
    return c.json({
      payTo: c.env.PAY_TO_ADDRESS,
      network: defaultOption?.network,
      asset: defaultOption?.asset,
      amount: defaultOption?.amount,
      formattedAmount: defaultOption?.formatted,
      description: c.env.PAYMENT_DESCRIPTION,
      facilitator: c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      accepts,
    });
  });

  app.get("/api/dashboard/slack", requireAuth, async (c) => {
    const agent = getAgent(c);
    const messages = await agent.getSlackMessages(100);
    return c.json({ messages });
  });


  app.get("/api/dashboard/webhooks", requireAuth, async (c) => {
    const provider = c.req.query("provider") || null;
    const agent = getAgent(c);
    const events = await agent.getWebhookEvents(provider, 100);
    return c.json({ events });
  });

  // Autonomous QA (issue #32): run a browser check against a URL.
  app.post("/api/dashboard/qa/check", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = body.url as string;
    if (!url || !/^https?:\/\//.test(url)) {
      return c.json({ error: "Valid http(s) url required" }, 400);
    }
    // X-API-Key is what the dashboard sends and what requireAuth checks. Reading
    // Authorization instead meant this was always undefined, so the QA check ran with no
    // key at all. The Authorization header is kept as a fallback for non-browser callers.
    const presented = c.req.header("X-API-Key") || "";
    const bearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || bearer || undefined;
    const qaAgent = await getQAAgent(c);
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.qaCheck(url, { ...body.checks, apiKey, ...(runId ? { runId } : {}) });
    return c.json(result);
  });

  // Autonomous QA: check the dashboard itself.
  app.post("/api/dashboard/qa/dashboard", requireAuth, async (c) => {
    // X-API-Key is what the dashboard sends and what requireAuth checks. Reading
    // Authorization instead meant this was always undefined, so the QA check ran with no
    // key at all. The Authorization header is kept as a fallback for non-browser callers.
    const presented = c.req.header("X-API-Key") || "";
    const bearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || bearer || undefined;
    const qaAgent = await getQAAgent(c);
    const body = await c.req.json().catch(() => ({}));
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.qaDashboard(apiKey, runId);
    return c.json(result);
  });

  app.post("/api/dashboard/qa/tabs", requireAuth, async (c) => {
    // X-API-Key is what the dashboard sends and what requireAuth checks. Reading
    // Authorization instead meant this was always undefined, so the QA check ran with no
    // key at all. The Authorization header is kept as a fallback for non-browser callers.
    const presented = c.req.header("X-API-Key") || "";
    const bearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || bearer || undefined;
    const qaAgent = await getQAAgent(c);
    if (!apiKey) {
      // No key to give the browser: this request authenticated by OAuth session. The tab
      // check needs one because it seeds localStorage before navigating, so without it
      // the check would visit the login page and report a confusing failure.
      return c.json(
        { error: "The tab check needs an X-API-Key header; session auth is not enough." },
        400,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.qaDashboardTabs(apiKey, undefined, undefined, runId);
    return c.json(result);
  });

  // Deterministic UX audit (issue #91): drives the dashboard like the tab
  // check and measures the rendered views against UX_RULES. Needs the key
  // for the same reason the tab check does — it seeds localStorage before
  // navigating — so session auth alone is not enough.
  app.post("/api/dashboard/qa/ux-audit", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const presented = c.req.header("X-API-Key") || "";
    const authHeader = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || authHeader || undefined;
    if (!apiKey) {
      return c.json(
        { error: "The UX audit needs an X-API-Key header; session auth is not enough." },
        400,
      );
    }
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const qaAgent = await getQAAgent(c);
    const result = await qaAgent.qaUxAudit(apiKey, runId);
    return c.json(result);
  });

  // Generalized UX audit (issue #94, step 1): audit any single-origin
  // target from a spec in the body — pages, auth mode, settle rule, rule
  // profile. Auth values in the spec are the caller's own session
  // material for the target; they are passed to the agent and not stored.
  app.post("/api/dashboard/qa/ux-audit-url", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const spec = body.spec;
    if (!spec || !Array.isArray(spec.pages) || spec.pages.length === 0) {
      return c.json(
        { error: "Body must carry spec.pages: at least one URL, all on one origin." },
        400,
      );
    }
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const qaAgent = await getQAAgent(c);
    const result = await qaAgent.qaUxAuditUrl(spec, runId);
    return c.json(result);
  });

  // Agentic investigation (issue #102): a question + start URL; the
  // QAAgent's model drives a real browser and reports findings. The
  // investigation itself is credential-free - it never sees this key.
  app.post("/api/dashboard/qa/investigate", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === "string" ? body.question : "";
    const url = typeof body.url === "string" ? body.url : "";
    if (!question || !url) {
      return c.json({ error: "Body must carry question and url." }, 400);
    }
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const qaAgent = await getQAAgent(c);
    const result = await qaAgent.qaInvestigate(question, url, runId);
    return c.json(result);
  });

  app.post("/api/dashboard/qa/email-report", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const toEmail = body.toEmail as string;
    if (!toEmail || !/^[^@]+@[^@]+$/.test(toEmail)) {
      return c.json({ error: "Valid toEmail required" }, 400);
    }
    // X-API-Key is what the dashboard sends and what requireAuth checks. Reading
    // Authorization instead meant this was always undefined, so the QA check ran with no
    // key at all. The Authorization header is kept as a fallback for non-browser callers.
    const presented = c.req.header("X-API-Key") || "";
    const bearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || bearer || undefined;
    if (!apiKey) {
      return c.json({ error: "API key required" }, 401);
    }
    const qaAgent = await getQAAgent(c);
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.qaAndEmailReport(apiKey, toEmail, runId);
    return jsonOr500(c, result, "qa/email-report");
  });



  // Drives the dashboard's Send Email form in a real browser, including an
  // attachment. Authenticated, and the recipient is a REQUIRED caller-supplied
  // parameter rather than a constant, so this can never mail a hard-coded
  // address and a caller must state where the test mail goes.
  app.post("/api/dashboard/qa/test-attachment", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const toEmail = body.toEmail as string;
    if (!toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
      return c.json({ error: "A valid toEmail is required" }, 400);
    }
    const presented = c.req.header("X-API-Key") || "";
    const bearer = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || bearer || undefined;
    if (!apiKey) {
      return c.json({ error: "API key required" }, 401);
    }
    const qaAgent = await getQAAgent(c);
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.testEmailAttachmentUI(apiKey, toEmail, runId);
    return c.json(result);
  });

  // Payment guards only. This route cannot move funds: qaPaymentFlow never signs
  // a transaction, it checks that an unpaid request is challenged and that a
  // malformed one is refused.
  app.post("/api/dashboard/qa/payment-flow", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const qaAgent = await getQAAgent(c);
    const result = await qaAgent.qaPaymentFlow(body.origin as string | undefined);
    return c.json(result);
  });

  // Negative and edge-case assertions.
  app.post("/api/dashboard/qa/edge-cases", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const qaAgent = await getQAAgent(c);
    const result = await qaAgent.qaEdgeCases(body.origin as string | undefined);
    return c.json(result);
  });

  // Full suite: runs every dashboard QA check in order and returns the
  // aggregate. The email-sending checks are skipped unless the caller supplies
  // a recipient, so this can never mail a hard-coded address.
  app.post("/api/dashboard/qa/full-suite", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const toEmail = (body.toEmail as string) || undefined;
    if (toEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
      return c.json({ error: "toEmail is not a valid email address" }, 400);
    }
    const presented = c.req.header("X-API-Key") || "";
    const authHeader = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const apiKey = presented || authHeader || undefined;
    if (!apiKey) {
      return c.json({ error: "API key required" }, 401);
    }
    const qaAgent = await getQAAgent(c);
    const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
    const result = await qaAgent.qaFullSuite(apiKey, toEmail, runId);
    return c.json(result);
  });

  // TEMPORARY DEBUG: inspect webhook DO state
  app.get("/api/dashboard/debug-webhooks", requireAuth, async (c) => {
    const agent = getAgent(c);
    const state = await agent.debugWebhookState();
    return c.json(state);
  });

  app.post("/api/dashboard/notify-slack", requireAuth, async (c) => {
    const body = await c.req.json<{ message: string }>();
    const agent = getAgent(c);
    const result = await agent.notifySlack(body.message);
    return c.json(result);
  });
  return app;
}