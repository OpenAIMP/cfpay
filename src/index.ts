import { routeAgentEmail, getAgentByName, routeAgentRequest } from "agents";
import { errorBody, errorResponse, errorResponseAs, errorStatus, mapUnknownError } from "./errors";
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
  handleGoogleAuthLogin,
  handleGoogleAuthCallback,
  handleAuthMe,
  handleAuthLogout,
} from "./auth";
import {
  A2A_CARD_PATHS,
  A2A_FLEET_INDEX_PATH,
  A2A_PAYMENTS_CARD_PATH,
  A2A_PAYMENTS_RPC_PATH,
  A2A_EMAIL_CARD_PATH,
  A2A_EMAIL_RPC_PATH,
  A2A_WEBHOOK_CARD_PATH,
  A2A_WEBHOOK_RPC_PATH,
  A2A_SLACK_CARD_PATH,
  A2A_SLACK_RPC_PATH,
  A2A_QA_CARD_PATH,
  A2A_QA_RPC_PATH,
  A2A_CHAT_CARD_PATH,
  A2A_CHAT_RPC_PATH,
  A2A_VOICE_CARD_PATH,
  A2A_VOICE_RPC_PATH,
  A2A_SEARCH_CARD_PATH,
  A2A_SEARCH_RPC_PATH,
  A2A_ORCHESTRATOR_CARD_PATH,
  A2A_ORCHESTRATOR_RPC_PATH,
  A2A_SCHEDULED_CARD_PATH,
  A2A_SCHEDULED_RPC_PATH,
  A2A_AUTOPILOT_CARD_PATH,
  A2A_AUTOPILOT_RPC_PATH,
  A2A_RPC_PATH,
  cfmailCard,
  fleetCardIndex,
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
  parseSlackEvent,
  sendSlackMessage,
  connectSlackSocketMode,
  type SlackEvent,
} from "./slack";
import { verifySlackSignature } from "./slack-verify";
// WS1 aspects (issue #252): error classification + structured logging at the
// A2A dispatch seams. Response bodies stay byte-identical; the aspect adds
// the correlation header and emits one event per dispatch.
import {
  resolveCorrelationId,
  withCorrelationHeader,
  replaceTracePart,
} from "./aspect-logging";
import { beginA2AAspect } from "./aspect-error";
import { ensureAccountingSink } from "./identity-sink";
// P3 tenancy (issue #252, design §4): per-credential tenant resolution at
// the A2A edge, tenant-aware dispatch, and FGA enforcement at the branch
// layer. RPC stubs stay raw — never Proxy-wrapped (self-heal #301).
import { resolveA2AIdentity, type A2AIdentity } from "./a2a-identity";
import {
  dispatchToTenantInstance,
  CrossTenantDispatchError,
} from "./tenant-dispatch";
import {
  OPERATOR_TENANT_ID,
  resolveTenantInstance,
  tenantOfInstance,
  type ResolvedTenant,
} from "./tenancy";
import {
  emitAuthzDecision,
  enforceAuthz,
  findOperationDeclaration,
  instantiateDeclaration,
  type AuthzIdentity,
} from "./aspect-authz";
import { a2aOperationFromBody, qaOperationAccess } from "./a2a-ops";
import { resolveMcpIdentity } from "./mcp-auth";

export { CfmailAgentSQLite, CfmailAgentSQLite as CfmailAgent };
export { PaymentsAgent } from "./payments-agent";
export { EmailAgent } from "./email-agent";
export { WebhookAgent } from "./webhook-agent";
export { SlackAgent } from "./slack-agent";
export { QAAgent } from "./qa-agent";
export { ChatAgent } from "./chat-agent";
export { VoiceAgent } from "./voice-agent";
export { SearchAgent } from "./search-agent";
export { OrchestratorAgent } from "./orchestrator-agent";
export { ScheduledAgent } from "./scheduled-agent";
export { AutopilotAgent } from "./autopilot-agent";
export { IdentityAgent } from "./identity-agent";
export { TradeWorkflow } from "./trade-workflow";
export { EvidenceWorkflow } from "./evidence-workflow";

const app = createApp();

/**
 * qa stays the operator singleton, but a user-tenant caller only gets
 * read-class operations (design §4: per-tenant QA is a named P4). The
 * operator keeps full access. Unknown operations deny by default.
 */
async function qaReadOnlyGate(
  identity: A2AIdentity,
  body: unknown,
  correlationId: string,
  env: Env,
): Promise<Response | null> {
  if (identity.tenantId === OPERATOR_TENANT_ID) return null;
  const op = a2aOperationFromBody(body);
  const allowed = qaOperationAccess(op) === "read";
  emitAuthzDecision(
    a2aAuthzIdentity(identity),
    { objectType: "qa", objectId: "singleton", relation: allowed ? "viewer" : "operator" },
    {
      allow: allowed,
      decision: {
        relation: allowed ? "viewer" : "operator",
        object: "qa:singleton",
        allow: allowed,
      },
    },
    { correlationId, env },
  );
  if (allowed) return null;
  return errorResponseAs(
    "INSUFFICIENT_SCOPE",
    "The QA agent is operator-scoped: tenant callers may only run read-class operations.",
  );
}
/** Map an A2A edge identity onto the authz aspect's identity shape. */
function a2aAuthzIdentity(id: A2AIdentity): AuthzIdentity {
  if (id.source === "jwt") {
    return {
      kind: "jwt",
      tenantId: id.tenantId,
      userId: id.jti ?? id.userId,
      role: "viewer",
      tokenId: id.jti,
    };
  }
  if (id.source === "session") {
    return { kind: "session", tenantId: id.tenantId, userId: id.userId, role: "owner" };
  }
  return {
    kind: "operator",
    tenantId: OPERATOR_TENANT_ID,
    userId: OPERATOR_TENANT_ID,
    role: "operator",
  };
}

/**
 * One A2A RPC branch, P3 shape (issue #252, design §4):
 * resolve the calling tenant from the credential (401 when none), run the
 * optional per-branch gate, then dispatch to the tenant's instance through
 * the single tenant-dispatch seam. The branch layer is also where the
 * branch-specific FGA gates live (qa read-only, slack.post,
 * orchestrator.run) — the decision is made here on values that cross the
 * wire, never inside a Proxy around the stub (self-heal #301).
 */
async function a2aBranch(
  request: Request,
  env: Env,
  correlationId: string,
  opts: {
    agent: string;
    binding: string;
    base: string;
    /**
     * Optional gate run after identity resolution, before dispatch.
     * Return a Response to short-circuit (e.g. 403), or null to continue.
     */
    gate?: (
      identity: A2AIdentity,
      body: unknown,
      correlationId: string,
    ) => Promise<Response | null>;
  },
): Promise<Response> {
  const identity = await resolveA2AIdentity(request, env);
  if (!identity) {
    return errorResponseAs("UNAUTHORIZED", "Unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  // WS1 aspects (issue #252): one structured event per dispatch,
  // correlation id minted once per HTTP request in the fetch wrapper.
  const a2aAspect = beginA2AAspect(env, correlationId, { agent: opts.agent, identity });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON");
  }
  if (opts.gate) {
    const gated = await opts.gate(identity, body, correlationId);
    if (gated) return gated;
  }
  try {
    // replaceTracePart: a _trace part arriving in the body is stripped —
    // the edge-resolved trace is the only one the receiver sees, so a
    // replayed cross-tenant trace can never pollute the event stream.
    const outcome = (await dispatchToTenantInstance({
      env,
      binding: opts.binding,
      base: opts.base,
      tenant: identity,
      trace: a2aAspect.trace,
      origin: new URL(request.url).origin,
      body: replaceTracePart(body, a2aAspect.trace),
    })) as {
      streamed?: boolean;
      events?: unknown[];
      result?: unknown;
    };
    if (!outcome) return a2aAspect.respond(errorResponse("NO_HANDLER"));
    if (outcome.streamed) {
      const events = Array.isArray(outcome.events) ? outcome.events : [];
      return a2aAspect.respond(
        streamFromAsyncIterable(
          (async function* () {
            for (const e of events) yield e;
          })(),
        ),
      );
    }
    return a2aAspect.respond(
      new Response(JSON.stringify(outcome.result), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }),
    );
  } catch (err) {
    if (err instanceof CrossTenantDispatchError) {
      return a2aAspect.respond(
        errorResponseAs("INSUFFICIENT_SCOPE", "Cross-tenant dispatch rejected"),
      );
    }
    return a2aAspect.fail(err);
  }
}

/**
 * FGA gate for one write-class A2A operation at the branch layer (design
 * §2.4/§5.4). JWT callers are checked against the actor_for tuple their
 * issuance seeded; operator/session callers against the owner tuple on
 * their tenant. Deny → 403; the allow/deny decision is emitted to the
 * accounting store in both cases.
 */
async function branchWriteGate(
  env: Env,
  operation: string,
  identity: A2AIdentity,
  correlationId: string,
): Promise<Response | null> {
  const declaration = findOperationDeclaration(operation);
  if (!declaration) return null;
  const authz = a2aAuthzIdentity(identity);
  const decl =
    identity.source === "jwt"
      ? { objectType: "tenant", objectId: identity.tenantId, relation: "actor_for" }
      : instantiateDeclaration(declaration, { tenantId: identity.tenantId });
  const check = await enforceAuthz(authz, decl, {
    correlationId,
    identityEnv: env,
    env,
  });
  if (check.allow) return null;
  return errorResponseAs("INSUFFICIENT_SCOPE", `Not authorized for ${operation}`);
}

/**
 * /agents/* websocket identity (issue #252 P3, design §4): the dashboard
 * key (query `token`, Bearer, or X-API-Key) → operator tenant; an
 * app_session cookie → that user's tenant (NEW in P3 — the per-user
 * dashboard socket); otherwise unauthenticated.
 */
async function agentsSocketIdentity(req: Request, env: Env): Promise<ResolvedTenant | null> {
  const expected = (env.DASHBOARD_API_KEY ?? "").trim();
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const apiKey = req.headers.get("X-API-Key") ?? "";
  if (expected) {
    for (const presented of [token, bearer, apiKey]) {
      if (presented && timingSafeStringEqual(presented, expected)) {
        return { tenantId: OPERATOR_TENANT_ID, userId: OPERATOR_TENANT_ID, identityKind: "operator" };
      }
    }
  }
  try {
    const { getSessionUserFromRequest } = await import("./auth");
    const sess = await getSessionUserFromRequest(req, env);
    if (sess) {
      return { tenantId: sess.tenantId, userId: sess.userId, identityKind: "session" };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * /agents/* tenant-vs-path check (issue #252 P3, design §4): the
 * credential's tenant must match the instance named in the path. The
 * operator tenant may open singletons only (e.g. `qa`, `desk`, `agent`);
 * a user tenant may open only its own `<base>:<uid>` instances. Paths
 * without an instance segment pass through to the SDK untouched.
 */
function agentsInstanceAllowed(identity: ResolvedTenant, req: Request): boolean {
  let segs: string[];
  try {
    segs = new URL(req.url).pathname.split("/").filter(Boolean);
  } catch {
    return false;
  }
  if (segs[0] !== "agents" || segs.length < 3) return true;
  let instance: string;
  try {
    instance = decodeURIComponent(segs[2]);
  } catch {
    return false;
  }
  const { tenantId } = tenantOfInstance(instance);
  if (identity.tenantId === OPERATOR_TENANT_ID) {
    return tenantId === OPERATOR_TENANT_ID;
  }
  return tenantId === identity.tenantId;
}

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
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
    // Google sign-on for the dashboard (issue #252 P2): session-based,
    // tenant-aware; the app session is the new preferred path.
    if (url.pathname === "/auth/google/login") {
      return handleGoogleAuthLogin(request, env);
    }
    if (url.pathname === "/auth/google/callback") {
      return handleGoogleAuthCallback(request, env);
    }
    if (url.pathname === "/auth/me") {
      return handleAuthMe(request, env);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request, env);
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

    // Fleet card index (issue #254): the machine-readable discovery
    // document enumerating every agent's card. Public like the cards.
    if (url.pathname === A2A_FLEET_INDEX_PATH) {
      return new Response(JSON.stringify(fleetCardIndex(url.origin)), {
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
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "payments",
        binding: "PAYMENTS_AGENT",
        base: "payments",
      });
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
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "email",
        binding: "EMAIL_AGENT",
        base: "email",
      });
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
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "webhooks",
        binding: "WEBHOOK_AGENT",
        base: "webhooks",
      });
    }
    // Slack channel: its own card and its own /a2a endpoint.
    //
    // Reads only. Posting has no route here and no A2A operation, so a shared bearer
    // credential cannot speak in the workspace.
    if (url.pathname === A2A_SLACK_CARD_PATH) {
      const { slackCard } = await import("./a2a");
      return new Response(JSON.stringify(slackCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_SLACK_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "slack",
        binding: "SLACK_AGENT",
        base: "slack",
        gate: async (identity, body, cid) => {
          const op = a2aOperationFromBody(body);
          if (
            op === "slack.post" ||
            op === "slack.postFile" ||
            op === "slack.notify" ||
            op === "slack.send"
          ) {
            return branchWriteGate(env, "slack.post", identity, cid);
          }
          return null;
        },
      });
    }
    // QA capability: its own card and its own /a2a endpoint.
    //
    // Credentialed, and stated as outbound on the card: qa.check makes this Worker load
    // a caller-chosen URL in a real browser.
    if (url.pathname === A2A_QA_CARD_PATH) {
      const { qaCard } = await import("./a2a");
      return new Response(JSON.stringify(qaCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_QA_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "qa",
        binding: "QA_AGENT",
        base: "qa",
        gate: (identity, body, cid) => qaReadOnlyGate(identity, body, cid, env),
      });
    }
    // Voice channel (issue #168): its own card and its own /a2a endpoint.
    if (url.pathname === A2A_VOICE_CARD_PATH) {
      const { voiceCard } = await import("./a2a");
      return new Response(JSON.stringify(voiceCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_VOICE_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "voice",
        binding: "VOICE_AGENT",
        base: "desk",
      });
    }
    // Search capability (issue #170): its own card and its own /a2a endpoint.
    if (url.pathname === A2A_SEARCH_CARD_PATH) {
      const { searchCard } = await import("./a2a");
      return new Response(JSON.stringify(searchCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_SEARCH_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "search",
        binding: "SEARCH_AGENT",
        base: "search",
      });
    }
    // Orchestrator (issue #180): its own card and its own /a2a endpoint.
    if (url.pathname === A2A_ORCHESTRATOR_CARD_PATH) {
      const { orchestratorCard } = await import("./a2a");
      return new Response(JSON.stringify(orchestratorCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_ORCHESTRATOR_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "orchestrator",
        binding: "ORCHESTRATOR_AGENT",
        base: "orchestrator",
        gate: async (identity, body, cid) => {
          if (a2aOperationFromBody(body) === "orchestrator.run") {
            return branchWriteGate(env, "orchestrator.run", identity, cid);
          }
          return null;
        },
      });
    }
    // Scheduled (issue #213): its own card and its own /a2a endpoint.
    if (url.pathname === A2A_SCHEDULED_CARD_PATH) {
      const { scheduledCard } = await import("./a2a");
      return new Response(JSON.stringify(scheduledCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_SCHEDULED_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "scheduled",
        binding: "SCHEDULED_AGENT",
        base: "scheduler",
      });
    }
    // Autopilot (issue #242 P1): the standing portfolio-objective owner.
    if (url.pathname === A2A_AUTOPILOT_CARD_PATH) {
      const { autopilotCard } = await import("./a2a");
      return new Response(JSON.stringify(autopilotCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_AUTOPILOT_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "autopilot",
        binding: "AUTOPILOT_AGENT",
        base: "autopilot",
      });
    }
    // Chat channel: its own card and its own /a2a endpoint.
    //
    // Most operations are counts; chat.transcript returns one sender's conversation
    // and is a disclosure, so it requires naming the sender rather than defaulting.
    if (url.pathname === A2A_CHAT_CARD_PATH) {
      const { chatCard } = await import("./a2a");
      return new Response(JSON.stringify(chatCard(url.origin)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === A2A_CHAT_RPC_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" },
        });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "chat",
        binding: "CHAT_AGENT",
        base: "chat",
      });
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
      // P3 tenancy (issue #252): the calling tenant is resolved from
      // the credential; dispatch goes to the tenant's instance.
      return a2aBranch(request, env, correlationId, {
        agent: "host",
        binding: "CfmailAgent",
        base: "agent",
      });
    }

    if (url.pathname === "/mcp") {
      const unauthorized = await authorizeMcpRequest(request, env);
      if (unauthorized) return unauthorized;
      // P3 tenancy (issue #252, design §4): the dispatch tenant comes from
      // the token claims (JWT → tenant_id bound to sub); every other
      // credential — and the anonymous handshake — stays operator-scoped.
      const mcpIdentity = await resolveMcpIdentity(request, env);
      return createCfmailMcpHandler(env, mcpIdentity)(request, env, ctx);
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
      // P3 tenancy: provider webhooks carry no user credential, so they
      // land on the operator tenant — resolveTenantInstance keeps the
      // singleton for the operator (and honors TENANT_CUTOVER).
      const agentId = env.CfmailAgent.idFromName(
        resolveTenantInstance("agent", OPERATOR_TENANT_ID, env),
      );
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
        if (result.challenge) {
          return new Response(JSON.stringify({ challenge: result.challenge }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
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
    // P3 tenancy (issue #252, design §4): the credential resolves to a
    // tenant (dashboard key → operator; app_session cookie → that user),
    // and the instance named in the path must belong to that tenant —
    // operator opens singletons, users open only their own `<base>:<uid>`.
    // A valid credential on another tenant's instance is 403, not 401.
    const agentResponse = await routeAgentRequest(request, env, {
      onBeforeConnect: async (req: Request) => {
        const identity = await agentsSocketIdentity(req, env);
        if (!identity) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!agentsInstanceAllowed(identity, req)) {
          return new Response("Forbidden", { status: 403 });
        }
      },
      onBeforeRequest: async (req: Request) => {
        const identity = await agentsSocketIdentity(req, env);
        if (!identity) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!agentsInstanceAllowed(identity, req)) {
          return new Response("Forbidden", { status: 403 });
        }
      },
    });
    if (agentResponse) {
      return agentResponse;
    }

    return env.ASSETS.fetch(request);
}

// WS1 aspects (issue #252, design §2): the correlation id is minted once per
// HTTP request and stamped on every response. The fetch body itself emits
// the per-operation events at the A2A dispatch seams.
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Issue #252 P2: wire the aspect accounting feed to the IdentityAgent's
    // durable store, once per isolate.
    ensureAccountingSink(env);
    const correlationId = resolveCorrelationId(request);
    const res = await handleFetch(request, env, ctx, correlationId);
    return withCorrelationHeader(res, correlationId);
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

  // P3 tenancy: the legacy Slack webhook carries no user credential — it
  // lands on the operator tenant's host instance (singleton, unchanged).
  const agentId = env.CfmailAgent.idFromName(
    resolveTenantInstance("agent", OPERATOR_TENANT_ID, env),
  );
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
    // P3 tenancy: the Slack install flow is operator-scoped — the bot token
    // lands on the operator tenant's host instance (singleton, unchanged).
    const agent = await getAgentByName(
      env.CfmailAgent as any,
      resolveTenantInstance("agent", OPERATOR_TENANT_ID, env),
    );
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

// createBrowserTools() spawns its execution sandbox as a facet of this class, and
// Cloudflare resolves the facet by looking for a class exported from the entry
// module. Without this export the tools are constructed but the first execution
// fails at runtime, which no type check can catch.
export { CodemodeRuntime } from "@cloudflare/codemode";
