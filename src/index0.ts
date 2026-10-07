import { routeAgentEmail } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
} from "agents/email";
import type { Env } from "./types";
import { createApp } from "./api";
import { CfmailAgentSQLite } from "./agent";

export { CfmailAgentSQLite, CfmailAgentSQLite as CfmailAgent };

const app = createApp();

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/mcp") ||
      url.pathname === "/health"
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
          console.warn(
            `Invalid secure-reply signature from ${email.from}: ${reason}`,
          );
        },
      },
    );

    const addressResolver = createAddressBasedEmailResolver("CfmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email) => {
        const secureResult = await secureReplyResolver(email, env);

        if (secureResult) {
          return secureResult;
        }

        return addressResolver(email, env);
      },
    });
  },
} satisfies ExportedHandler<Env>;
