import { Hono } from "hono";
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
  listTools,
  mcpCall,
  type McpSession,
} from "./public-mcp";
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
      return c.json({ tools: tools.map((t) => ({ name: t.name, description: t.description || "" })) });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // The catalogue the picker renders. Read-only, no credentials involved.
  app.get("/api/public/models", requireAuth, async (c) => {
    const agent = getAgent(c);
    const stored = await agent.getPublicModel();
    return c.json({
      models: listModels(),
      defaultModel: defaultModelId(),
      selected: resolveModelId(stored),
      isDefault: !stored,
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
    const body = await c.req.json<{ message?: string }>();
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

  function getQAAgent(c: any) {
    return getAgentByName(c.env.QA_AGENT, "qa") as any;
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
    const body = await c.req.json<{ to: string; subject: string; body: string }>();
    const agent = getAgent(c);
    const result = await agent.sendOutboundEmail(body.to, body.subject, body.body);
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
    const authHeader = c.req.header("Authorization") || "";
    const apiKey = authHeader.replace(/^Bearer\s+/i, "") || undefined;
    const qaAgent = getQAAgent(c);
    const result = await qaAgent.qaCheck(url, { ...body.checks, apiKey });
    return c.json(result);
  });

  // Autonomous QA: check the dashboard itself.
  app.post("/api/dashboard/qa/dashboard", requireAuth, async (c) => {
    const authHeader = c.req.header("Authorization") || "";
    const apiKey = authHeader.replace(/^Bearer\s+/i, "") || undefined;
    const qaAgent = getQAAgent(c);
    const result = await qaAgent.qaDashboard(apiKey);
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