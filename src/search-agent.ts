import { callable } from "agents";
import type { Connection } from "agents";
import { Think } from "@cloudflare/think";
import type { Env } from "./types";
import { defaultModelId } from "./models";
import { normalizeAnswer, normalizeSearch, type SearchOutcome } from "./search-results";
import { selfProvisionOwnTenant } from "./tenant-provision";
import { stampTenantOnConnection } from "./tenant-connection";

// SearchAgent (issue #170): Cloudflare AI Search as its own
// capability agent, with the full surface set the other agents
// have - Think base, agent-as-a-tool registration, A2A card and
// dispatch, a dashboard route, and a snapshot that reports its
// configuration honestly.
//
// Per the Cloudflare docs it queries an AI Search instance through
// the ai_search_namespaces binding: env.AI_SEARCH.get(name). The
// instance itself (its data source: a website, an R2 bucket, or
// uploaded files) is created in the Cloudflare dashboard; the name
// comes from AI_SEARCH_INSTANCE, defaulting to "cfpay". Until an
// instance with that name exists, queries surface the platform's
// not-found error verbatim and the snapshot says so.
//
// The agent's one job is retrieval over the owner's indexed
// content. It does not generate answers from its own knowledge:
// searchAsk returns the instance's chat completion, which is
// grounded in the retrieved chunks it also returns.

const ASK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface SearchSnapshot {
  agent: string;
  instance: string;
  configured: boolean;
  instances: string[];
}

export class SearchAgent extends Think<Env> {
  /**
   * Issue #315: a tenant instance can wake without any in-process dispatch
   * (the /agents/* WebSocket path), so it seeds its own FGA tuple here.
   * Idempotent; operator no-op; failures never block startup (the dispatch
   * seam retries and the FGA layer denies by default).
   */
  async onStart(): Promise<void> {
    await selfProvisionOwnTenant({ env: this.env, ctx: this.ctx });
  }

  /**
   * Issue #316: bind the resolved tenant/user to this socket's connection
   * state (SDK connection.setState, functional updater — existing
   * connection state is preserved, never clobbered). Defense-in-depth
   * BEHIND the /agents/* edge 401/403: the edge still guards the door;
   * this stamps identity on the connection itself so WS-path handling can
   * attribute per message. First stamp wins; operator singletons stay
   * unstamped; stamping never throws and never blocks connect.
   */
  async onConnect(
    connection: Connection,
    context: { request: Request },
  ): Promise<void> {
    await stampTenantOnConnection({ env: this.env, ctx: this.ctx }, connection);
    await super.onConnect?.(connection, context);
  }
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the search capability agent for this Worker.",
      "You retrieve from the owner's AI Search knowledge base and report what it contains: search.query returns the retrieved chunks, search.ask returns the grounded answer with its chunks.",
      "Never invent content the index did not return. An unconfigured or empty index is reported as such, not filled in.",
    ].join(" ");
  }

  override getTools(): Record<string, never> {
    return {};
  }

  private instanceName(): string {
    return (this.env.AI_SEARCH_INSTANCE || "").trim() || "cfpay";
  }

  /** Names of the instances in the bound namespace (best effort). */
  private async listInstances(): Promise<string[]> {
    try {
      const res = await this.env.AI_SEARCH.list();
      const items = (res as { instances?: { id?: string }[] } | null)?.instances;
      return Array.isArray(items) ? items.map((i) => String(i?.id ?? "")).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** Configuration state: which instance this agent targets and whether it exists. */
  @callable()
  async searchSnapshot(): Promise<SearchSnapshot> {
    const instance = this.instanceName();
    const instances = await this.listInstances();
    return { agent: "search", instance, configured: instances.includes(instance), instances };
  }

  /** Retrieval only: the chunks the index returns for a query. */
  @callable()
  async searchQuery(query: string, limit?: number): Promise<SearchOutcome & { error?: string }> {
    const q = String(query || "").trim();
    if (!q) return { query: q, chunks: [], error: "search.query needs a query." };
    try {
      const instance = this.env.AI_SEARCH.get(this.instanceName());
      const raw = await instance.search({
        query: q,
        ai_search_options: { retrieval: { max_num_results: Math.min(Math.max(limit ?? 5, 1), 10) } },
      });
      return normalizeSearch(raw, q);
    } catch (err) {
      return { query: q, chunks: [], error: String(err) };
    }
  }

  /** Retrieval + generation: the grounded answer and the chunks behind it. */
  @callable()
  async searchAsk(query: string): Promise<SearchOutcome & { error?: string }> {
    const q = String(query || "").trim();
    if (!q) return { query: q, chunks: [], error: "search.ask needs a query." };
    try {
      const instance = this.env.AI_SEARCH.get(this.instanceName());
      const raw = await instance.chatCompletions({
        messages: [{ role: "user", content: q }],
        model: ASK_MODEL,
        ai_search_options: { retrieval: { max_num_results: 5 } },
      });
      return normalizeAnswer(raw, q);
    } catch (err) {
      return { query: q, chunks: [], error: String(err) };
    }
  }

  /** Aggregate state for A2A callers: configuration only, no index contents. */
  async a2aSnapshot(): Promise<SearchSnapshot> {
    return this.searchSnapshot();
  }

  /** A2A entry point, mirroring the other capability agents. */
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, searchCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, searchCard(origin), {
      card: searchCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    }, { agentName: "search", env: this.env });
    return await handleCollecting(a2a.transport, body);
  }

  /** Route one A2A message: search.query / search.ask; no operation = snapshot. */
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
    const args = (dataPart?.data as any) ?? {};
    if (op === "search.query") {
      const r = await this.searchQuery(String(args.query || ""), args.limit);
      return {
        text: r.error
          ? `Search failed: ${r.error}`
          : `${r.chunks.length} chunk(s) for "${r.query}": ` +
            r.chunks.map((c) => c.text.slice(0, 160)).join(" | "),
        data: r,
      };
    }
    if (op === "search.ask") {
      const r = await this.searchAsk(String(args.query || ""));
      return {
        text: r.error ? `Search failed: ${r.error}` : (r.answer ?? "No answer generated."),
        data: r,
      };
    }
    if (op && op !== "search.summary") {
      return { text: `Unknown operation: ${op}`, data: { ok: false, error: "unknown_operation" } };
    }
    const snapshot = await this.a2aSnapshot();
    return {
      text:
        `Search status. Instance "${snapshot.instance}" ` +
        (snapshot.configured ? "is configured." : "is NOT configured yet - create it in the Cloudflare dashboard (AI > AI Search).") +
        ` Namespace holds ${snapshot.instances.length} instance(s).`,
      data: snapshot,
    };
  }
}
