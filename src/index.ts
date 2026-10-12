import { routeAgentEmail, getAgentByName, routeAgentRequest } from "agents";
import {
  createSecureReplyEmailResolver,
} from "agents/email";
import type { Env } from "./types";
import { createApp } from "./api";
import { CfmailAgentSQLite } from "./agent";
import { verifyAndParseWebhook } from "./webhooks";
import {
  handleAuthLogin,
  handleAuthCallback,
  handleAuthMe,
  handleAuthLogout,
} from "./auth";
import {
  A2A_CARD_PATHS,
  A2A_PAYMENTS_CARD_PATH,
  A2A_PAYMENTS_RPC_PATH,
  A2A_EMAIL_CARD_PATH,
  A2A_EMAIL_RPC_PATH,
  A2A_WEBHOOK_CARD_PATH,
  A2A_WEBHOOK_RPC_PATH,
  A2A_RPC_PATH,
  a2aAuthorised,
  cfmailCard,
  streamFromAsyncIterable,
} from "./a2a";
import { createCfmailMcpHandler } from "./mcp";
import { authorizeMcpRequest, timingSafeStringEqual } from "./mcp-auth";
import { handleResourceMetadata } from "./mcp-oauth";
import {
  AS_METADATA_PATH,
  AUTHORIZE_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
  handleAsMetadata,
  handleAuthorize,
  handleRegister,
  handleToken,
} from "./mcp-oauth-server";
import {
  verifySlackSignature,
  parseSlackEvent,
  sendSlackMessage,
  connectSlackSocketMode,
  type SlackEvent,
} from "./slack";

export { CfmailAgentSQLite, CfmailAgentSQLite as CfmailAgent };
export { PaymentsAgent } from "./payments-agent";
export { EmailAgent } from "./email-agent";
export { QAAgent } from "./qa-agent";
export { WebhookAgent } from "./webhook-agent";

const app = createApp();

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Remote MCP server (Streamable HTTP, unauthenticated in phase 1). Handled
    // before the /mcp prefix check below so this exact path wins; the legacy
    // "/mcp/tools/process" route still falls through to the Hono app.
    // OAuth 2.1 authorization server for /mcp (metadata, DCR, authorize,
    // token). Every path 404s unless MCP_OAUTH_DISCOVERY is enabled.
    if (url.pathname === AS_METADATA_PATH) {
      return handleAsMetadata(request, env);
    }
    if (url.pathname === REGISTER_PATH) {
      return handleRegister(request, env);
    }
    if (url.pathname === AUTHORIZE_PATH) {
      return handleAuthorize(request, env);
    }
    if (url.pathname === TOKEN_PATH) {
      return handleToken(request, env);
    }
    // Protected Resource Metadata for /mcp (RFC 9728). Served only when
    // MCP_OAUTH_DISCOVERY is enabled; otherwise it 404s.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return handleResourceMetadata(request, env);
    }

    // GitHub OAuth sign-on for the dashboard (additive; API-key auth untouched).
    if (url.pathname === "/auth/login") {
      return handleAuthLogin(request, env);
    }
    if (url.pathname === "/auth/callback") {
      return handleAuthCallback(request, env);
    }
    if (url.pathname === "/auth/me") {
      return handleAuthMe(request);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request);
    }

    // A2A protocol (agent-to-agent).
    //
    // The agent card is public because A2A clients discover by fetching it and it
    // carries no data. The JSON-RPC endpoint requires a bearer credential: every
    // call spends Workers AI tokens and this is a live payment system, so it is
    // gated the same way /mcp is.
    if (A2A_CARD_PATHS.includes(url.pathname)) {
      return new Response(JSON.stringify(cfmailCard(url.origin)), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Payments capability: its own agent card and its own /a2a endpoint.
    //
    // Separate paths from the monolith so an A2A client can discover the
    // payments agent specifically rather than getting one card that speaks for
    // everything. The gate is the same credential.
    if (url.pathname === A2A_PAYMENTS_CARD_PATH) {
      const { paymentsCard } = await import("./a2a");
      return new Response(JSON.stringify(paymentsCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_PAYMENTS_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!a2aAuthorised(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
      }
      let pbody: unknown;
      try { pbody = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }
      const pStub = env.PAYMENTS_AGENT.get(env.PAYMENTS_AGENT.idFromName("payments")) as any;
      try {
        const outcome = await pStub.handleA2A(pbody, url.origin);
        if (!outcome) return new Response(JSON.stringify({ error: "No handler" }), { status: 500 });
        if (outcome.streamed) {
          const events = Array.isArray(outcome.events) ? outcome.events : [];
          return streamFromAsyncIterable((async function* () { for (const e of events) yield e; })());
        }
        return new Response(JSON.stringify(outcome.result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    // Email capability: its own agent card and its own /a2a endpoint.
    //
    // Extracted so any agent in this Worker sends mail through one tool rather than
    // reaching into the monolith's state. Same credential gate as the others, and the
    // agent itself caps how many sends that credential buys per hour.
    if (url.pathname === A2A_EMAIL_CARD_PATH) {
      const { emailCard } = await import("./a2a");
      return new Response(JSON.stringify(emailCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_EMAIL_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!a2aAuthorised(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
      }
      let ebody: unknown;
      try { ebody = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }
      const eStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName("email")) as any;
      try {
        const outcome = await eStub.handleA2A(ebody, url.origin);
        if (!outcome) return new Response(JSON.stringify({ error: "No handler" }), { status: 500 });
        if (outcome.streamed) {
          const events = Array.isArray(outcome.events) ? outcome.events : [];
          return streamFromAsyncIterable((async function* () { for (const e of events) yield e; })());
        }
        return new Response(JSON.stringify(outcome.result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }
    // Webhook channel: its own card and its own /a2a endpoint.
    //
    // Provider signatures are still verified at this edge, before any A2A call, so a
    // bearer credential can never stand in for a provider signature.
    if (url.pathname === A2A_WEBHOOK_CARD_PATH) {
      const { webhookCard } = await import("./a2a");
      return new Response(JSON.stringify(webhookCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_WEBHOOK_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!a2aAuthorised(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
      }
      let wbody: unknown;
      try { wbody = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }
      const wStub = env.WEBHOOK_AGENT.get(env.WEBHOOK_AGENT.idFromName("webhooks")) as any;
      try {
        const outcome = await wStub.handleA2A(wbody, url.origin);
        if (!outcome) return new Response(JSON.stringify({ error: "No handler" }), { status: 500 });
        if (outcome.streamed) {
          const events = Array.isArray(outcome.events) ? outcome.events : [];
          return streamFromAsyncIterable((async function* () { for (const e of events) yield e; })());
        }
        return new Response(JSON.stringify(outcome.result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }
    if (url.pathname === A2A_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
          },
        });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!a2aAuthorised(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
        });
      }

      // Handling runs inside the Durable Object, which owns the SQL handle the
      // task store needs. The origin is passed through so the agent card carries
      // the host the client actually called - the SDK validates against it.
      const agentId = env.CfmailAgent.idFromName("agent");
      const doStub = env.CfmailAgent.get(agentId) as any;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }

      try {
        const outcome = await doStub.handleA2A(body, url.origin);
        if (!outcome) {
          return new Response(JSON.stringify({ error: "No handler" }), { status: 500 });
        }
        // The DO cannot return a stream across RPC, so it collects events and we
        // frame them as SSE here when the method was a streaming one.
        if (outcome.streamed) {
          const events = Array.isArray(outcome.events) ? outcome.events : [];
          return streamFromAsyncIterable((async function* () { for (const e of events) yield e; })());
        }
        return new Response(JSON.stringify(outcome.result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    if (url.pathname === "/mcp") {
      const unauthorized = await authorizeMcpRequest(request, env);
      if (unauthorized) return unauthorized;
      return createCfmailMcpHandler(env)(request, env, ctx);
    }

    // Webhook routes — verified events are handled on the canonical central
    // instance (plus Slack conversation routing below).
    if (request.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const verified = await verifyAndParseWebhook(request.clone(), env);
      if (!verified) {
        return new Response("Invalid signature", { status: 401 });
      }

      // Forward to the canonical agent instance. webhooks.ts derives a
      // per-provider instance name (repo full_name, Stripe customer id, Slack
      // team/channel), but the dashboard, REST API and MCP server all read the
      // "agent" instance — so routing by that derived name recorded verified
      // events into a Durable Object nothing ever displayed.
      // Use idFromName directly: getAgentByName resolves to a different
      // instance than the dashboard reads. No RPC needed here (dedupe is inside the DO).
      const agentId = env.CfmailAgent.idFromName("agent");
      const agent = env.CfmailAgent.get(agentId);

      // Slack message events also become a conversation in the Slack tab:
      // handleSlackEvent records them on this same central instance (which the
      // live state sync broadcasts to the dashboard without a reload) and
      // replies in the channel. Slash commands, interactivity and
      // url_verification payloads skip this and are handled by the agent's
      // onRequest → processWebhookEvent (which replies via response_url).
      if (verified.provider === "slack") {
        const slackEvent = parseSlackEvent(verified.payload);
        if (slackEvent && !slackEvent.bot_id && slackEvent.text) {
          try {
            await (agent as any).handleSlackEvent(slackEvent);
          } catch (err) {
            console.error("Failed to handle Slack message event:", err);
          }
        }
      }

      // Bypass DO fetch (SDK throws before onRequest); use RPC instead.
      // verified.payload is already parsed and signature-checked.
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => { headers[k] = v; });
      try {
        const result = await (agent as any).handleWebhookRpc(
          verified.provider,
          verified.payload,
          headers,
        );
        return new Response(result.message, { status: result.status });
      } catch (err) {
        console.error("Webhook RPC failed:", err);
        return new Response("Webhook processing failed", { status: 500 });
      }
    }

    // HTTP webhook endpoint (legacy Slack apps)
    if (url.pathname === "/slack/events") {
      return handleSlackWebhook(request, env);
    }

    // Slack OAuth install callback
    if (url.pathname === "/slack/install") {
      return handleSlackInstall(request, env);
    }

    if (
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/mcp") ||
      url.pathname === "/health" ||
      url.pathname === "/ws" ||
      // Public.com sign-in (OAuth connect/callback) and the client metadata
      // document the authorization server fetches to identify this client.
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/.well-known/oauth-client-id-metadata-document"
    ) {
      return app.fetch(request, env, ctx);
    }

    // Agent routes (/agents/*) with authentication hooks.
    // onBeforeConnect: verifies `token` query parameter (WebSocket connections)
    // onBeforeRequest: verifies `Authorization: Bearer <token>` or `X-API-Key` header
    // Both validate against DASHBOARD_API_KEY.
    const agentResponse = await routeAgentRequest(request, env, {
      onBeforeConnect: async (req: Request) => {
        const token = new URL(req.url).searchParams.get("token");
        if (!token || !timingSafeStringEqual(token, env.DASHBOARD_API_KEY ?? "")) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
      onBeforeRequest: async (req: Request) => {
        const auth = req.headers.get("Authorization");
        const apiKey = req.headers.get("X-API-Key");
        const token = auth?.replace("Bearer ", "");
        if (
          (!token || !timingSafeStringEqual(token, env.DASHBOARD_API_KEY ?? "")) &&
          (!apiKey || !timingSafeStringEqual(apiKey, env.DASHBOARD_API_KEY ?? ""))
        ) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    if (agentResponse) {
      return agentResponse;
    }

    return env.ASSETS.fetch(request);
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const secureReplyResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET,
      {
        maxAge: 7 * 24 * 60 * 60,
        onInvalidSignature: (email, reason) => {
          console.warn(`Invalid secure-reply signature from ${email.from}: ${reason}`);
        },
      },
    );

    // Every inbound message is handled by the canonical "agent" instance: the
    // one the dashboard, REST API and MCP server all read, and the only instance
    // whose state-sync socket the dashboard listens on.
    //
    // This used to fall back to createAddressBasedEmailResolver("CfmailAgent"),
    // which routes on the local part (info@cfmail... -> instance "info"). Mail
    // was stored durably on that instance and the reply went out normally, but
    // nothing broadcast to the dashboard, so new mail only appeared after a
    // manual reload. The secure-reply path is kept: it validates a signed
    // header and is how an agent-initiated thread returns to its instance.
    // A message with no signed header cannot be routed to a specific instance,
    // so it goes to the canonical one rather than being dropped.
    await routeAgentEmail(message, env, {
      resolver: async (email) => {
        const secureResult = await secureReplyResolver(email, env);
        if (secureResult) return secureResult;

        return { agentName: "CfmailAgent", agentId: "agent" };
      },
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handle HTTP webhook events from legacy Slack apps.
 */
async function handleSlackWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") || "";
  const signature = request.headers.get("X-Slack-Signature") || "";

  // Verify first: the body is unauthenticated at this point and may contain
  // third-party content that should not reach the logs.
  if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, timestamp, body, signature))) {
    console.error("Slack signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("Slack webhook verified, payload bytes:", body.length);

  const parsed = JSON.parse(body);
  console.log("Slack event type:", parsed.type);

  if (parsed.type === "url_verification") {
    return Response.json({ challenge: parsed.challenge });
  }

  const event = parseSlackEvent(parsed);
  console.log("Parsed event:", event);

  if (!event || event.bot_id) {
    console.log("Skipping event:", !event ? "no event" : "bot message");
    return new Response("OK", { status: 200 });
  }

  // Skip events without text (app_home_opened, reactions, etc.)
  if (!event.text) {
    console.log("Skipping: no text in event");
    return new Response("OK", { status: 200 });
  }

  console.log("Processing Slack message from:", event.user, "text:", event.text);

  const agentId = env.CfmailAgent.idFromName("agent");
  const agent = env.CfmailAgent.get(agentId) as any;

  await agent.handleSlackEvent(event);

  return new Response("OK", { status: 200 });
}

/** HTML error page for the Slack install flow. */
function slackInstallErrorPage(message: string): Response {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slack install failed</title></head>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem">` +
      `<h1>Slack install failed</h1><p>${safe}</p></body></html>`,
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Slack OAuth install flow.
 *
 * GET /slack/install (no params) starts the flow by redirecting to Slack.
 * Slack then redirects back here with ?code=, which is exchanged for a bot
 * token and stored on the canonical agent instance. The redirect_uri is
 * derived from the request origin so staging/preview deployments work too.
 */
async function handleSlackInstall(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const redirectUri = requestUrl.origin + "/slack/install";
  const code = requestUrl.searchParams.get("code");

  // Callback branch: exchange the authorization code for a bot token.
  if (code) {
    const clientId = (env.SLACK_CLIENT_ID ?? "").trim();
    const clientSecret = (env.SLACK_CLIENT_SECRET ?? "").trim();
    if (!clientId || !clientSecret) {
      return slackInstallErrorPage(
        "Slack OAuth is not configured: set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.",
      );
    }
    let data: any;
    try {
      const res = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      data = await res.json();
    } catch (err) {
      return slackInstallErrorPage(
        `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!data?.ok || typeof data?.access_token !== "string" || !data.access_token) {
      return slackInstallErrorPage(
        `Slack refused the authorization code: ${data?.error ?? "unknown error"}`,
      );
    }
    const agent = await getAgentByName(env.CfmailAgent as any, "agent");
    const stored = await (agent as any).setSlackBotToken(data.access_token);
    if (!stored?.success) {
      return slackInstallErrorPage("Could not store the Slack bot token.");
    }
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slack installed</title></head>` +
        `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem">` +
        `<h1>Slack installed</h1><p>The CFmail agent can now post to Slack. You can close this tab.</p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  // Start branch: redirect to Slack for authorization.
  const clientId = (env.SLACK_CLIENT_ID ?? "").trim();
  if (!clientId) {
    return slackInstallErrorPage("Slack OAuth is not configured: set SLACK_CLIENT_ID.");
  }
  const scopes = "chat:write,chat:write.public,app_mentions:read,im:write,im:history";
  const authorizeUrl =
    "https://slack.com/oauth/v2/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  return Response.redirect(authorizeUrl, 302);
}
