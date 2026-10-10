export interface SlackEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  // Fail closed: an absent or blank secret means the request cannot be
  // authenticated, so never derive a key from it. trim() keeps this consistent
  // with isConfiguredSecret() in webhooks.ts.
  if (!signingSecret || !signingSecret.trim() || !signature || !timestamp) {
    return false;
  }

  const sigBase = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBase));
  const computed = "v0=" + Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison, matching webhooks.ts.
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export async function sendSlackMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<boolean> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const data = await res.json() as any;
  return data.ok === true;
}

export function parseSlackEvent(body: any): SlackEvent | null {
  if (body.type === "event_callback" && body.event) {
    return body.event as SlackEvent;
  }
  return null;
}

export async function connectSlackSocketMode(
  appToken: string,
  onEvent: (event: SlackEvent) => Promise<void>,
): Promise<WebSocket> {
  const res = await fetch("https://slack.com/api/apps.connections.open", {
    headers: { Authorization: `Bearer ${appToken}` },
  });
  const data = await res.json() as any;

  if (!data.ok || !data.url) {
    throw new Error(`Failed to open Slack socket: ${data.error || "unknown"}`);
  }

  // Cloudflare Workers WebSocket: use fetch with Upgrade header
  const wsResponse = await fetch(data.url, {
    headers: { Upgrade: "websocket" },
  });

  const ws = wsResponse.webSocket;
  if (!ws) {
    throw new Error("Slack did not accept WebSocket upgrade");
  }

  ws.accept();

  ws.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data as string);

      if (payload.type === "hello") {
        console.log("Slack Socket Mode connected");
        return;
      }

      if (payload.type === "envelope" && payload.payload) {
        // Acknowledge the envelope
        ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));

        const innerPayload = payload.payload;

        if (innerPayload.type === "url_verification") {
          ws.send(JSON.stringify({
            envelope_id: payload.envelope_id,
            payload: { challenge: innerPayload.challenge },
          }));
          return;
        }

        if (innerPayload.type === "event_callback" && innerPayload.event) {
          const slackEvent = innerPayload.event as SlackEvent;
          if (!slackEvent.bot_id) {
            await onEvent(slackEvent);
          }
        }
      }
    } catch (err) {
      console.error("Slack socket message error:", err);
    }
  });

  ws.addEventListener("close", () => {
    console.log("Slack Socket Mode disconnected — will reconnect on next DO start");
  });

  ws.addEventListener("error", (err) => {
    console.error("Slack Socket Mode error:", err);
  });

  return ws;
}


export async function sendSlackMessageWithButton(
  token: string,
  channel: string,
  text: string,
  buttonText: string,
  buttonUrl: string,
  threadTs?: string,
): Promise<boolean> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: buttonText },
              url: buttonUrl,
              style: "primary",
            },
          ],
        },
      ],
    }),
  });
  const data = await res.json() as any;
  return data.ok === true;
}
