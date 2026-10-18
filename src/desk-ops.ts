/**
 * desk.* A2A operations for the host agent (CfmailAgentSQLite).
 *
 * Issue #242 P0: moved here verbatim from src/agent.ts so that file's
 * push payload stays under the connector size limit. No behavior change.
 *
 * The desk.* operations are report-only analysis pipelines: they spend
 * Workers AI tokens and persist hunt/run records, but they place no
 * orders and send nothing.
 */
import { a2aErrorCode } from "./errors";
import type { HuntRequest, StoredHunt } from "./opportunity-hunt";
import { listTools } from "./public-mcp";
import type { McpSession, McpTool } from "./public-mcp";

/**
 * The host slice the desk.* operations need. The host class satisfies
 * this structurally; the operations never touch the rest of the agent.
 */
export interface DeskHost {
  getPublicToken(): Promise<string | null>;
  getPublicModel(): Promise<string | null>;
  runOpportunityHunt(
    token: string,
    request: HuntRequest,
    tools: McpTool[],
    session: McpSession,
    model?: string | null,
  ): Promise<{ hunt: StoredHunt; answer: string; model: string }>;
  runAutopilot(
    token: string,
    goal: string,
    tools: McpTool[],
    session: McpSession,
    model?: string | null,
  ): Promise<{ answer: string; model: string; cost: unknown; autopilot: { id: string } }>;
}

/** Reply shape: matches the host's handleA2AMessage contract. */
export interface DeskReply {
  text: string;
  data?: unknown;
}

export type DeskBackend =
  | { ok: true; token: string; tools: McpTool[]; session: McpSession; model: string | null }
  | { ok: false; code: "PUBLIC_NOT_CONNECTED" | "PUBLIC_NO_TOOLS" };

/**
 * Resolve the stored Public token, its MCP tools, and the saved model
 * for the desk.* A2A operations - the same path the dashboard routes
 * take (api.ts), but in-process since the A2A call already runs on the
 * host. Named failure codes match the public error catalog.
 */
export async function deskBackend(host: DeskHost): Promise<DeskBackend> {
  const token = await host.getPublicToken();
  if (!token) return { ok: false, code: "PUBLIC_NOT_CONNECTED" };
  const session: McpSession = {};
  const tools = await listTools(token, session);
  if (tools.length === 0) return { ok: false, code: "PUBLIC_NO_TOOLS" };
  return { ok: true, token, tools, session, model: await host.getPublicModel() };
}

/**
 * desk.hunt - the opportunity hunt (src/opportunity-hunt.ts) as an A2A
 * operation, so scheduled goals can invoke it through the orchestrator.
 * Same request shape as POST /api/public/opportunity-hunt.
 */
export async function deskHunt(
  host: DeskHost,
  args: Record<string, any>,
  text: string,
): Promise<DeskReply> {
  const budget = Number(args.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      text: "desk.hunt needs a positive budget.",
      data: { ok: false, error: "invalid_budget", code: "VALIDATION_FAILED" },
    };
  }
  const request: HuntRequest = {
    budget,
    maxRiskPct: args.maxRiskPct !== undefined ? Number(args.maxRiskPct) : undefined,
    maxUnderlyingPct: args.maxUnderlyingPct !== undefined ? Number(args.maxUnderlyingPct) : undefined,
    horizonDays: args.horizonDays !== undefined ? Number(args.horizonDays) : undefined,
    symbols: Array.isArray(args.symbols) ? args.symbols.map((s: unknown) => String(s).toUpperCase()) : undefined,
  };
  const backend = await deskBackend(host);
  if (!backend.ok) {
    return {
      text: `desk.hunt cannot run: ${backend.code}`,
      data: { ok: false, error: backend.code.toLowerCase(), code: backend.code },
    };
  }
  try {
    const result = await host.runOpportunityHunt(
      backend.token,
      request,
      backend.tools,
      backend.session,
      backend.model,
    );
    return {
      text: result.answer,
      data: {
        ok: true,
        huntId: result.hunt.id,
        trades: result.hunt.plan.trades.length,
        unsized: result.hunt.plan.unsized.length,
        model: result.model,
      },
    };
  } catch (error) {
    return {
      text: "Hunt failed: " + String(error),
      data: { ok: false, error: "hunt_failed", code: a2aErrorCode(error) },
    };
  }
}

/**
 * desk.autopilot - the goal-oriented autopilot pipeline
 * (src/public-autopilot.ts) as an A2A operation. Same machinery as
 * POST /api/public/chat with autopilot: true.
 */
export async function deskAutopilot(
  host: DeskHost,
  args: Record<string, any>,
  text: string,
): Promise<DeskReply> {
  const goal = String(args.goal || args.question || text || "").trim();
  if (!goal) {
    return {
      text: "desk.autopilot needs a goal or question.",
      data: { ok: false, error: "missing_goal", code: "VALIDATION_FAILED" },
    };
  }
  const backend = await deskBackend(host);
  if (!backend.ok) {
    return {
      text: `desk.autopilot cannot run: ${backend.code}`,
      data: { ok: false, error: backend.code.toLowerCase(), code: backend.code },
    };
  }
  try {
    const result = await host.runAutopilot(
      backend.token,
      goal,
      backend.tools,
      backend.session,
      backend.model,
    );
    return {
      text: result.answer,
      data: { ok: true, runId: result.autopilot.id, model: result.model, cost: result.cost },
    };
  } catch (error) {
    return {
      text: "Autopilot run failed: " + String(error),
      data: { ok: false, error: "autopilot_failed", code: a2aErrorCode(error) },
    };
  }
}
