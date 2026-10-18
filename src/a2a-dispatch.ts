/**
 * The dashboard A2A dispatch route (issue #258).
 *
 * POST /api/dashboard/a2a/dispatch { surface, operation, params? }
 * dispatches a REAL JSON-RPC message/send to that agent's public A2A
 * endpoint through an HTTP self-fetch, using the exact same body shape
 * and reply parsing as scripts/qa-smoke.mjs section 14's a2aOp() - the
 * production-proven dispatch contract. The operation must be declared
 * in src/a2a-ops.ts for the surface, so the tester can only invoke
 * operations the agent's card advertises.
 *
 * Auth: behind the dashboard key (requireAuth), like every other
 * dashboard API route. The self-fetch presents the Worker's own
 * DASHBOARD_API_KEY to the A2A edge - the same credential an external
 * caller would use.
 */

import { A2A_OPS, A2A_SURFACE_RPC, type A2aSurfaceKey } from "./a2a-ops";
import { errorBody } from "./errors";

const SURFACE_KEYS = new Set<string>(Object.keys(A2A_OPS));

interface DispatchBody {
  surface?: unknown;
  operation?: unknown;
  params?: unknown;
}

function badRequest(c: any, detail: string) {
  return c.json({ ok: false, ...errorBody("VALIDATION_FAILED"), detail }, 400);
}

/** The text part of a non-streamed JSON-RPC reply envelope (smoke §14's replyText). */
function replyText(json: any): string {
  const parts = json?.result?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.kind === "text")
    .map((p) => String(p.text || ""))
    .join(" ");
}

/** The structured data part of a reply envelope (smoke §14's replyData). */
function replyData(json: any): unknown {
  const parts = json?.result?.parts;
  if (!Array.isArray(parts)) return null;
  const dataPart = parts.find((p) => p && p.kind === "data");
  return dataPart?.data ?? null;
}

export function registerA2ADispatch(app: any, requireAuth: any): void {
  app.post("/api/dashboard/a2a/dispatch", requireAuth, async (c: any) => {
    const body = (await c.req.json().catch(() => null)) as DispatchBody | null;
    const surface = typeof body?.surface === "string" ? body.surface : "";
    const operation = typeof body?.operation === "string" ? body.operation : "";
    const params: Record<string, unknown> =
      body?.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};

    if (!SURFACE_KEYS.has(surface)) {
      return badRequest(c, `unknown A2A surface: "${surface}"`);
    }
    const key = surface as A2aSurfaceKey;
    const spec = A2A_OPS[key].find((o) => o.operation === operation);
    if (!spec) {
      return badRequest(c, `unknown operation "${operation}" for surface "${surface}"`);
    }

    const origin = new URL(c.req.url).origin;
    const data = { operation, ...params };
    let res: Response;
    try {
      res = await fetch(`${origin}${A2A_SURFACE_RPC[key]}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.env.DASHBOARD_API_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `dash-${operation}`,
          method: "message/send",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: `dash-${Date.now()}`,
              parts: [{ kind: "data", data }],
            },
          },
        }),
      });
    } catch (err) {
      return c.json({ ok: false, surface, operation, status: 0, error: `dispatch fetch failed: ${String(err)}` });
    }

    const json = (await res.json().catch(() => null)) as any;
    if (res.status !== 200) {
      const text = replyText(json);
      const error =
        text || json?.error?.message || (typeof json?.error === "string" ? json.error : "") || `status=${res.status}`;
      return c.json({ ok: false, surface, operation, status: res.status, error });
    }
    return c.json({ ok: true, surface, operation, text: replyText(json), data: replyData(json) });
  });
}
