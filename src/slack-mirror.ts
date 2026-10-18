/**
 * Slack history mirrors between the host and SlackAgent (issue #262).
 *
 * Lives here — not in src/agent.ts — because that file sits at the push-size
 * ceiling and cannot grow. The host and the dashboard API import these small
 * functions instead of carrying the logic inline.
 *
 * Mirrored records share the host record's id, so the dashboard feed (which
 * merges both stores) dedups them instead of showing every inbound event twice.
 */
import { getAgentByName } from "agents";
import { buildSlackRecord } from "./slack-record";
import type { SlackEvent } from "./slack";
import type { EmailRecord, Env, SlackVia } from "./types";

/** The host's inbound record for a Slack event, labeled with its transport. */
export function buildInboundSlackRecord(
  event: SlackEvent,
  aiResponse: string,
  via: SlackVia,
): EmailRecord {
  return buildSlackRecord({
    user: event.user,
    channel: event.channel,
    text: event.text,
    aiResponse,
    direction: "inbound",
    via,
  });
}

/** Mirror one record into SlackAgent's history (slack.list reads that store). */
export async function mirrorToSlackAgent(env: Env, record: EmailRecord): Promise<void> {
  try {
    const stub = (await getAgentByName((env as any).SLACK_AGENT as any, "slack")) as any;
    await stub.recordMessage(
      record.from.replace(/^slack:/, ""),
      record.to.replace(/^slack:/, ""),
      record.body,
      record.aiResponse,
      {
        id: record.id,
        direction: record.direction,
        via: record.via,
        mechanism: record.mechanism,
      },
    );
  } catch (err) {
    console.error("Slack history mirror failed:", err);
  }
}

/** Record a dashboard notifySlack send in SlackAgent's history. Best-effort. */
export async function recordNotifySlackToAgent(env: Env, message: string): Promise<void> {
  try {
    const stub = (await getAgentByName((env as any).SLACK_AGENT as any, "slack")) as any;
    await stub.recordMessage("webhook", "webhook", message, undefined, {
      direction: "outbound",
      via: "dashboard",
      mechanism: "webhook",
    });
  } catch (err) {
    console.error("Slack notifySlack mirror failed:", err);
  }
}
