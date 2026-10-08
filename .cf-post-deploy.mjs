// Observe what /mcp actually does after the deploy, without asserting.
// Polls until the response changes from "wide open" (200 with no auth), then
// reports the settled state. The token value is supplied via the environment so
// no credential appears in this file.
const BASE = "https://pay.openaimp.com";
const TOKEN = process.env.CF_TEST_MCP_TOKEN || "";

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const BODY = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
});

async function probe(auth) {
  const headers = { ...H };
  if (auth) headers.Authorization = "Bearer " + auth;
  try {
    const r = await fetch(BASE + "/mcp", { method: "POST", headers, body: BODY });
    return r.status;
  } catch {
    return -1;
  }
}

const deadline = Date.now() + 6 * 60 * 1000;
let noAuth = await probe(null);
console.log("initial no-auth status:", noAuth, "(200 = guard not live yet)");

while (Date.now() < deadline) {
  noAuth = await probe(null);
  if (noAuth !== 200) {
    console.log("changed at", new Date().toISOString(), "-> no-auth status:", noAuth);
    break;
  }
  await new Promise((r) => setTimeout(r, 15000));
}

// Let the secrets step finish (it runs after the deploy step).
await new Promise((r) => setTimeout(r, 20000));

const final = {
  noAuth: await probe(null),
  wrongToken: await probe("definitely-wrong-token-value"),
  emptyToken: await probe(""),
};
if (TOKEN) final.realToken = await probe(TOKEN);

console.log("\n=== settled state ===");
for (const [k, v] of Object.entries(final)) {
  const meaning =
    v === 200 ? "SERVED" : v === 401 ? "refused (unauthorized)" : v === 503 ? "refused (misconfigured)" : "unexpected";
  console.log(`  ${k.padEnd(12)} -> ${v}  ${meaning}`);
}
