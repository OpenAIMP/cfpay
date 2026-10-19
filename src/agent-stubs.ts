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
