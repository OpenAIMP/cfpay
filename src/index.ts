import { routeAgentEmail, getAgentByName, routeAgentRequest } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
} from "agents/email";
import type { Env } from "./types";
import { createApp } from "./api";
import { CfmailAgentSQLite } from "./agent";
import { verifyAndParseWebhook } from "./webhooks";
import { createCfmailMcpHandler } from "./mcp";
import { authorizeMcpRequest } from "./mcp-auth";
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
      const agent = await getAgentByName(env.CfmailAgent as any, "agent");

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

      return agent.fetch(request);
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
      url.pathname === "/ws"
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
        if (!token || token !== env.DASHBOARD_API_KEY) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
      onBeforeRequest: async (req: Request) => {
        const auth = req.headers.get("Authorization");
        const apiKey = req.headers.get("X-API-Key");
        const token = auth?.replace("Bearer ", "");
        if (
          (!token || token !== env.DASHBOARD_API_KEY) &&
          (!apiKey || apiKey !== env.DASHBOARD_API_KEY)
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

    const addressResolver = createAddressBasedEmailResolver("CfmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email) => {
        const secureResult = await secureReplyResolver(email, env);
        if (secureResult) return secureResult;
        return addressResolver(email, env);
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

/**
 * Slack OAuth install redirect.
 */
async function handleSlackInstall(request: Request, env: Env): Promise<Response> {
  const scopes = "chat:write,chat:write.public,app_mentions:read,im:write,im:history";
  const url = `https://slack.com/oauth/v2/authorize?client_id=${env.SLACK_CLIENT_ID}&scope=${scopes}&redirect_uri=https://pay.openaimp.com/slack/install`;
  return Response.redirect(url, 302);
}
