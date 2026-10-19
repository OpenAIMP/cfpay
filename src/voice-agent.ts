import { Think } from "@cloudflare/think";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import type { Env } from "./types";
import { defaultModelId } from "./models";
import { speakable } from "./voice-text";

// Voice channel for the Public.com desk (issue #168), built on the
// documented @cloudflare/voice mixin: Workers AI speech-to-text
// (Deepgram Flux) and text-to-speech (Deepgram Aura) on the existing
// AI binding - no new keys. The base is Think composed with the
// voice mixin (issue #173): the mixin owns the voice frames on the
// socket and forwards everything else to the base handler, so the
// agent carries the standard Think surface (model, prompt, tools)
// alongside the channel. Everything else follows the other
// capability agents: its own DO binding, its own A2A card and
// dispatch, and a read-only snapshot for A2A callers.
//
// The agent's one job is the voice channel. The answers come from
// the desk pipeline itself, reached in-process through the host
// agent's deskAsk callable (issue #269, remainder) - so a spoken
// question gets exactly the typed pipeline's answer, including its
// guard rails: order-placing calls still become approval-gated
// proposals there, never executions. The old HTTP self-fetch of the
// Worker's own public-chat route is gone (that path is a 522 in the
// fetch-handler context; see issue #264).
const VoiceBase = withVoice(Think);

export class VoiceAgent extends VoiceBase<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the voice capability agent for this Worker: the spoken channel to the Public.com desk.",
      "voice.snapshot reports the state of the current voice conversation (counts only); voice.ask takes a question, runs it through the desk pipeline, and returns the speakable answer text.",
      "You never execute trades: the desk pipeline turns order-placing requests into approval-gated proposals, exactly as it does for typed questions.",
    ].join(" ");
  }

  override getTools(): Record<string, never> {
    return {};
  }

  /** Run one question through the desk pipeline; returns speakable prose. */
  async answerQuestion(question: string): Promise<string> {
    try {
      // In-process RPC to the host (issue #269, remainder): the same
      // pipeline as the public-chat HTTP route, without the HTTP round
      // trip. Failure mapping mirrors the route's: 409 -> not-connected,
      // 502 -> generic desk failure, transport throw -> unreachable.
      // P3 tenancy (issue #252): the voice instance's own tenant host
      // (`agent:<uid>`), parsed from its instance name.
      const { hostStubFor } = await import("./agent-stubs");
      const { ownTenantId } = await import("./tenancy");
      const host = await hostStubFor(this.env, ownTenantId(this.ctx.id.name));
      const result = (await host.deskAsk(question)) as
        | { ok: true; answer: string }
        | { ok: false; code: string };
      if (!result.ok) {
        if (result.code === "NOT_CONNECTED") {
          return "The Public dot com desk is not connected yet. Connect it in the Public tab first, then ask me again.";
        }
        return "The trading desk could not answer that just now. The details are in the Public tab.";
      }
      if (!result.answer) {
        return "The trading desk could not answer that just now. The details are in the Public tab.";
      }
      return speakable(result.answer);
    } catch {
      return "I could not reach the trading desk just now.";
    }
  }

  async onTurn(transcript: string, _context: VoiceTurnContext): Promise<string> {
    const question = String(transcript || "").trim();
    if (!question) return "I did not catch that - could you say it again?";
    return this.answerQuestion(question);
  }

  /** Aggregate state for A2A callers: counts only, no transcript contents. */
  async a2aSnapshot(): Promise<{ agent: string; messages: number; lastRole?: string }> {
    const history = this.getConversationHistory(1000);
    return {
      agent: "voice",
      messages: history.length,
      lastRole: history[history.length - 1]?.role,
    };
  }

  /** A2A entry point, mirroring QAAgent.handleA2A. */
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, voiceCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, voiceCard(origin), {
      card: voiceCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    }, { agentName: "voice", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: voice.ask runs the desk pipeline; no operation = snapshot. */
  async handleA2AMessage(
    message: any,
    // Unused: each call is self-contained. Kept to satisfy the interface.
    _context: { taskId: string; contextId: string },
  ): Promise<{ text: string; data?: unknown }> {
    const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
    const dataPart = parts.find(
      (x) => x && x.kind === "data" && x.data && typeof x.data === "object",
    );
    const op = dataPart ? String((dataPart.data as any).operation || "") : "";
    if (op === "voice.ask") {
      const question = String((dataPart.data as any).question || "").trim();
      if (!question) return { text: "voice.ask needs a question." };
      const reply = await this.answerQuestion(question);
      return { text: reply, data: { spoken: reply } };
    }
    if (op && op !== "voice.snapshot") {
      return { text: `Unknown operation: ${op}` };
    }
    const snapshot = await this.a2aSnapshot();
    return {
      text: `Voice desk status. ${snapshot.messages} message(s) in the current conversation.`,
      data: snapshot,
    };
  }
}
