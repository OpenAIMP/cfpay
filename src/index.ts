import { routeAgentEmail } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
} from "agents/email";
import type { Env } from "./types";
import { createApp } from "./api";
import { CfmailAgent } from "./agent";

export { CfmailAgent };

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/mcp") || url.pathname === "/health") {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const secureReplyResolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
      maxAge: 7 * 24 * 60 * 60,
      onInvalidSignature: (email, reason) => {
        console.warn(`Invalid signature from ${email.from}: ${reason}`);
      },
    });
    const addressResolver = createAddressBasedEmailResolver("CfmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        const replyRouting = await secureReplyResolver(email, env);
        if (replyRouting) return replyRouting;
        return addressResolver(email, env);
      },
      onNoRoute: (email) => {
        console.warn(`No route found for email from ${email.from}`);
        email.setReject("Unknown recipient");
      },
    });
  },
} satisfies ExportedHandler<Env>;