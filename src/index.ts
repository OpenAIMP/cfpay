import { routeAgentEmail, getAgentByName } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
} from "agents/email";
import type { Env } from "./types";
import { createApp } from "./api";
import { CfmailAgentSQLite } from "./agent";
import { verifyAndParseWebhook } from "./webhooks";
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

    // Webhook routes — verify signature, then forward to the agent
    if (request.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const verified = await verifyAndParseWebhook(request.clone(), env);
      if (!verified) {
        return new Response("Invalid signature", { status: 401 });
      }
      // Slack URL verification or forward to the agent DO
      const agent = await getAgentByName(env.CfmailAgent as any, verified.agentName);
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

  console.log("Slack webhook received:", body);

  if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, timestamp, body, signature))) {
    console.error("Slack signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

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
