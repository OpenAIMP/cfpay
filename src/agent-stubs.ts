/**
 * Single-owner Durable Object stub resolutions (issue #269, cluster C7).
 *
 * Each helper resolves exactly one agent with one fixed instance name — the
 * same agent and the same name at every call site. Instance names are
 * Durable Object identity and must never change, so each one lives in
 * exactly one place.
 *
 * The `agents` SDK is imported dynamically inside each helper, never at the
 * top level: a static import would break Vitest for every module that
 * imports this one (a2a-dispatch.ts is imported by tests and must keep its
 * top level SDK-free).
 */
export async function qaAgentStub(env: any): Promise<any> {
  const { getAgentByName } = await import("agents");
  return (await getAgentByName(env.QA_AGENT as any, "qa")) as any;
}

export async function slackAgentStub(env: any): Promise<any> {
  const { getAgentByName } = await import("agents");
  return (await getAgentByName(env.SLACK_AGENT as any, "slack")) as any;
}

/**
 * The host (desk) agent's RPC-capable stub (issue #269, remainder).
 * Single instance, same name ("agent") as every other host resolution.
 * Used by the voice channel to reach the desk pipeline in-process.
 */
export async function hostStub(env: any): Promise<any> {
  const { getAgentByName } = await import("agents");
  return (await getAgentByName(env.CfmailAgent as any, "agent")) as any;
}

/**
 * The identity agent's RPC-capable stub (issue #252, P2).
 * Single instance, same name ("identity") as every other identity
 * resolution. Carries sessions, the accounting store, and authorization
 * tuples; reachable from the Worker edge and the API.
 */
export async function identityStub(env: any): Promise<any> {
  const { getAgentByName } = await import("agents");
  return (await getAgentByName(env.IDENTITY_AGENT as any, "identity")) as any;
}
