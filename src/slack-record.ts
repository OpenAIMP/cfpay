/**
 * Slack message records (issue #262).
 *
 * Pure, SDK-free module shared by SlackAgent (its own history store) and the host
 * (its `emails[]` store, which the dashboard Slack feed reads). Every Slack message
 * record is an EmailRecord carrying the label facets:
 *
 * - `direction`: inbound | outbound (already on EmailRecord)
 * - `via`: events | webhook | a2a | socket | dashboard
 * - `mechanism`: bot | webhook (outbound only — the transport that carried the post)
 *
 * The channel id keeps living where it always has: the `slack:<id>` prefix in
 * `from:`/`to:`. Labels carry routing metadata only — never credentials or tokens.
 * Omitted labels are absent from the record (never `undefined` keys), so unlabeled
 * records keep the exact legacy shape.
 */
import type { EmailRecord, SlackMechanism, SlackVia } from "./types";

export interface SlackRecordInput {
  /** Optional: share an id with a sibling record (host/SlackAgent mirrors dedup by id). */
  id?: string;
  /** Slack user id (inbound) or sender identity (outbound: "bot" | "webhook"). */
  user: string;
  /**
   * Slack channel id. The incoming-webhook path does not know its channel; pass ""
   * there — never invent one. Renders as an empty channel after the prefix strip.
   */
  channel: string;
  text: string;
  aiResponse?: string;
  direction?: EmailRecord["direction"];
  via?: SlackVia;
  mechanism?: SlackMechanism;
}

/** Build a labeled Slack message record. Defaults preserve the legacy record shape. */
export function buildSlackRecord(input: SlackRecordInput): EmailRecord {
  const record: EmailRecord = {
    id: input.id ?? `${Date.now()}-${crypto.randomUUID()}`,
    from: `slack:${input.user}`,
    to: `slack:${input.channel}`,
    subject: input.text.slice(0, 50),
    body: input.text,
    direction: input.direction ?? "inbound",
    receivedAt: new Date().toISOString(),
    paid: false,
  };
  if (input.aiResponse !== undefined) record.aiResponse = input.aiResponse;
  if (input.via !== undefined) record.via = input.via;
  if (input.mechanism !== undefined) record.mechanism = input.mechanism;
  return record;
}
