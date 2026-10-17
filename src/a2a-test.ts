/**
 * A2A endpoint tests: probe every agent's A2A surface the way an
 * external A2A caller would - over HTTP, through the real routing,
 * auth, transport, and executor. Per surface: the agent card must be
 * served, an unauthenticated dispatch must be refused (401), and an
 * authenticated message/send with no operation must return the
 * capability's snapshot reply (the read-only default every capability
 * implements). Nothing here can mutate state: no operation is named,
 * and the chat surfaces only ever phrase the snapshot.
 */

export interface A2AEndpoint {
  agent: string;
  rpc: string;
  card: string;
}

export const A2A_ENDPOINTS: A2AEndpoint[] = [
  { agent: "CFmail (host)", rpc: "/a2a", card: "/.well-known/agent-card.json" },
  { agent: "Payments", rpc: "/a2a/payments", card: "/a2a/payments/agent-card.json" },
  { agent: "Email", rpc: "/a2a/email", card: "/a2a/email/agent-card.json" },
  { agent: "Webhooks", rpc: "/a2a/webhooks", card: "/a2a/webhooks/agent-card.json" },
  { agent: "Slack", rpc: "/a2a/slack", card: "/a2a/slack/agent-card.json" },
  { agent: "QA", rpc: "/a2a/qa", card: "/a2a/qa/agent-card.json" },
  { agent: "Chat (host surface)", rpc: "/a2a/chat", card: "/a2a/chat/agent-card.json" },
  { agent: "Voice", rpc: "/a2a/voice", card: "/a2a/voice/agent-card.json" },
  { agent: "Search", rpc: "/a2a/search", card: "/a2a/search/agent-card.json" },
  { agent: "Orchestrator", rpc: "/a2a/orchestrator", card: "/a2a/orchestrator/agent-card.json" },
];

export interface A2ARow {
  agent: string;
  rpc: string;
  cardOk: boolean;
  cardName?: string;
  cardDescription?: string;
  cardSkills?: { id: string; name: string; tags?: string[] }[];
  unauthStatus: number;
  dispatchOk: boolean;
  reply?: string;
  ok: boolean;
  detail: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(doFetch: FetchFn, url: string, init: RequestInit, ms = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one A2A surface: card, unauthenticated refusal, snapshot dispatch. */
export async function testA2AEndpoint(
  origin: string,
  key: string,
  ep: A2AEndpoint,
  doFetch: FetchFn = fetch,
): Promise<A2ARow> {
  const problems: string[] = [];
  // 1. The agent card is public and must be served.
  let cardOk = false;
  let cardName: string | undefined;
  let cardDescription: string | undefined;
  let cardSkills: A2ARow["cardSkills"];
  try {
    const res = await fetchWithTimeout(doFetch, origin + ep.card, {});
    const json = (await res.json().catch(() => null)) as {
      name?: string;
      description?: string;
      skills?: { id?: string; name?: string; tags?: string[] }[];
    } | null;
    cardName = typeof json?.name === "string" ? json.name : undefined;
    cardDescription = typeof json?.description === "string" ? json.description : undefined;
    if (Array.isArray(json?.skills)) {
      cardSkills = json.skills
        .filter((s) => s && typeof s.name === "string")
        .map((s) => ({ id: String(s.id ?? ""), name: s.name as string, tags: Array.isArray(s.tags) ? s.tags.map(String) : undefined }));
    }
    cardOk = res.status === 200 && !!cardName;
    if (!cardOk) problems.push(`card: status ${res.status}${cardName ? "" : ", no name"}`);
  } catch (err) {
    problems.push(`card: ${String(err).slice(0, 80)}`);
  }
  // 2. An unauthenticated dispatch must be refused with 401.
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "a2a-test",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: `a2a-test-${ep.rpc}`,
        parts: [{ kind: "text", text: "status" }],
      },
    },
  });
  let unauthStatus = 0;
  try {
    const res = await fetchWithTimeout(doFetch, origin + ep.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    unauthStatus = res.status;
    if (unauthStatus !== 401) problems.push(`unauthenticated dispatch: expected 401, got ${unauthStatus}`);
  } catch (err) {
    problems.push(`unauthenticated dispatch: ${String(err).slice(0, 80)}`);
  }
  // 3. An authenticated dispatch with no operation returns the
  // capability's snapshot reply (a Message with a text part).
  let dispatchOk = false;
  let reply: string | undefined;
  try {
    const res = await fetchWithTimeout(doFetch, origin + ep.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
    });
    const json = (await res.json().catch(() => null)) as {
      result?: { kind?: string; parts?: { kind?: string; text?: string }[] };
    } | null;
    const text = (json?.result?.parts || [])
      .filter((p) => p.kind === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")
      .trim();
    dispatchOk = res.status === 200 && json?.result?.kind === "message" && text.length > 0;
    if (dispatchOk) reply = text.slice(0, 140);
    else problems.push(`dispatch: status ${res.status}${text ? "" : ", no reply text"}`);
  } catch (err) {
    problems.push(`dispatch: ${String(err).slice(0, 80)}`);
  }
  return {
    agent: ep.agent,
    rpc: ep.rpc,
    cardOk,
    cardName,
    cardDescription,
    cardSkills,
    unauthStatus,
    dispatchOk,
    reply,
    ok: problems.length === 0,
    detail: problems.join("; ") || "card served, 401 without auth, snapshot reply received",
  };
}

/** Probe every surface, sequentially (they share one Worker). */
export async function runA2AEndpointTests(
  origin: string,
  key: string,
  doFetch: FetchFn = fetch,
): Promise<A2ARow[]> {
  const rows: A2ARow[] = [];
  for (const ep of A2A_ENDPOINTS) {
    rows.push(await testA2AEndpoint(origin, key, ep, doFetch));
  }
  return rows;
}

/** The email: one line per surface, the reply preview as evidence. */
export function composeA2AEmail(rows: A2ARow[]): { subject: string; body: string; allOk: boolean } {
  const passed = rows.filter((r) => r.ok).length;
  const allOk = passed === rows.length;
  const lines = [
    `A2A endpoint test - ${new Date().toISOString()}`,
    "",
    "Every agent's A2A surface was probed the way an external A2A caller would use it: the agent card must be served, an unauthenticated dispatch must be refused (401), and an authenticated message/send with no operation must return the capability's snapshot reply. All probes are read-only.",
    "",
    ...rows.map(
      (r) =>
        `${r.ok ? "PASS" : "FAIL"}  ${r.agent} - ${r.detail}` +
        (r.reply ? `\n      reply: "${r.reply}"` : ""),
    ),
    "",
    allOk
      ? `All ${rows.length} A2A surfaces are responding correctly.`
      : `${passed}/${rows.length} surfaces passed - see the FAIL lines above.`,
  ];
  return {
    subject: `A2A Endpoint Test: ${allOk ? "PASS" : "FAIL"} - ${passed}/${rows.length} surfaces responding`,
    body: lines.join("\n"),
    allOk,
  };
}
