/**
 * The email tool, as one shared definition.
 *
 * Every agent in this Worker reaches email through here rather than through its own
 * copy of the send logic. The point of a tool is that the capability has one
 * definition: if sending needs a rate limit, a guard against mailing ourselves, or a
 * new field, that change lands once and every caller inherits it.
 *
 * Two ways in, same destination:
 *   - `callEmailAgent` over A2A, an HTTP JSON-RPC message to the endpoint the email
 *     card advertises. This is the contract a third-party agent would use.
 *   - `emailAgentStub` over direct Durable Object RPC, for agents inside this Worker
 *     where a network hop and JSON round trip would be pure overhead.
 *
 * Both end in the same method on the same Durable Object, so switching between them
 * cannot change behaviour.
 */

import type { Env } from "./types";
import { A2A_EMAIL_RPC_PATH } from "./a2a";

/**
 * The tool as a model sees it.
 *
 * Shaped as a JSON-schema function definition so it can be handed to a model's tool
 * list directly, or adapted to a framework primitive without touching the
 * implementation behind it.
 */
export const emailToolDefinition = {
  name: "email",
  description: [
    "Send email and inspect the mail history that this Worker owns.",
    "",
    "Operations:",
    "  email.summary  totals and recent subjects",
    "  email.totals   received / sent / stored counts",
    "  email.list     recent messages, without bodies",
    "  email.quota    remaining sends in the current window",
    "  email.send     send a message; requires to, subject and body",
    "",
    "Sends are rate limited per hour. A refused send returns ok:false with a reason;",
    "do not retry it unchanged.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["email.summary", "email.totals", "email.list", "email.quota", "email.send"],
      },
      to: { type: "string", description: "Recipient. Required for email.send." },
      subject: { type: "string", description: "Subject. Required for email.send." },
      body: { type: "string", description: "Plain-text body. Required for email.send." },
      direction: { type: "string", enum: ["inbound", "outbound"], description: "Filter for email.list." },
      limit: { type: "integer", description: "Max rows for email.list, up to 100." },
    },
    required: ["operation"],
  },
} as const;

export interface EmailToolResult {
  text: string;
  data?: Record<string, unknown>;
}

/**
 * The Durable Object stub, or null when the binding is absent.
 *
 * Callers treat null as "fall back to sending directly", so a rolling deploy that
 * has not yet bound this class does not lose mail.
 */
export function emailAgentStub(env: Env): any | null {
  const ns = (env as any).EMAIL_AGENT;
  if (!ns) return null;
  try {
    return ns.get(ns.idFromName("email"));
  } catch {
    return null;
  }
}

/**
 * Call the email tool over A2A.
 *
 * Returns null when the call could not be completed, so a caller can decide whether
 * to fall back. An explicit refusal is returned, not thrown as a transport failure:
 * conflating the two is what made a reused payment look like an unreachable agent.
 */
export async function callEmailAgent(
  env: Env,
  operation: string,
  args: Record<string, unknown>,
  text: string,
): Promise<EmailToolResult | null> {
  const origin = (env as any).SELF_ORIGIN || "https://pay.openaimp.com";
  const key = (env as any).DASHBOARD_API_KEY || "";
  if (!key) return null;

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text }, { kind: "data", data: { operation, ...args } }],
      },
    },
  };

  try {
    const res = await fetch(origin + A2A_EMAIL_RPC_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("A2A call to email agent failed:", res.status);
      return null;
    }

    const raw = await res.text();
    const parsed = raw.trim().startsWith("{")
      ? JSON.parse(raw)
      : (function () {
          const frames = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
          for (let i = frames.length - 1; i >= 0; i--) {
            try { return JSON.parse(frames[i].slice(5).trim()); } catch { /* keep looking */ }
          }
          return null;
        })();
    if (!parsed) return null;

    const result = parsed.result ?? parsed;
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    const dataArtifact = artifacts.find((a: any) =>
      Array.isArray(a?.parts) && a.parts.some((p: any) => p && p.kind === "data"),
    );
    const dataPart = dataArtifact?.parts?.find((p: any) => p && p.kind === "data");

    const history = Array.isArray(result?.history) ? result.history : [];
    const lastAgent = [...history].reverse().find((m: any) => m && m.role === "agent");
    const textOut = (Array.isArray(lastAgent?.parts) ? lastAgent.parts : [])
      .filter((x: any) => x && x.kind === "text" && typeof x.text === "string")
      .map((x: any) => x.text as string)
      .join("\n")
      .trim();

    return { text: textOut, data: dataPart?.data };
  } catch (error) {
    console.error("A2A call to email agent threw:", error);
    return null;
  }
}