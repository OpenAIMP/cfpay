/**
 * QAAgent — autonomous QA agent using Cloudflare Browser Tools (CDP).
 *
 * Uses `createBrowserTools` from `agents/browser/ai` for CDP-based browser
 * automation instead of raw Puppeteer. This gives the agent access to
 * `browser_execute`, `browser_markdown`, `browser_extract`, etc.
 *
 * Extends Think, which makes it chat-capable and a valid child for agentTool().
 * Reachable three ways: direct @callable() RPC, A2A operation at /a2a/qa,
 * and dispatch from a host agent's tool list.
 */
import { callable } from "agents";
import { Think } from "@cloudflare/think";
import { createBrowserTools } from "agents/browser/ai";
import { defaultModelId } from "./models";
import type { Env } from "./types";

export interface QACheckResult {
  ok: boolean;
  url: string;
  textLength: number;
  screenshot?: string;
  checks?: { name: string; passed: boolean }[];
  error?: string;
}

export class QAAgent extends Think<Env> {
  /** Last run, for the A2A summary. Not persisted: it is a convenience, not a record. */
  private lastRun: QACheckResult | null = null;
  private lastRunAt = "";

  /* ---------------------------- Think surface ---------------------------- */

  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the QA capability agent for this Worker.",
      "You load a page and report what it actually did: whether it loaded, how much text it produced, and whether each expected string was present.",
      "Never report a pass you did not observe. A page that failed to load is a failure, not an absence of evidence.",
      "You have browser tools (browser_execute, browser_markdown, browser_extract) that let you drive a real Chrome browser via CDP.",
    ].join(" ");
  }

  /**
   * Browser tools via CDP. These let the model (or programmatic callers)
   * drive a real browser: navigate, extract content, screenshot, interact.
   */
  override getTools() {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return {};
    }
    try {
      return createBrowserTools({
        ctx: this.ctx,
        browser: env.BROWSER,
        // LOADER is optional; without it, sessions are one-shot
        loader: (env as any).LOADER,
      }) as Record<string, never>;
    } catch {
      // If browser tools can't initialize (e.g. missing LOADER), fall back to empty.
      // The @callable() methods below use direct CDP as a fallback.
      return {};
    }
  }

  /**
   * Run a browser QA check using CDP directly.
   * This is the deterministic path used by @callable() methods.
   */
  private async runBrowserCheckCDP(
    url: string,
    textContains?: string[],
  ): Promise<QACheckResult> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
    }

    try {
      // Use the browser tools' underlying CDP session for a one-shot check.
      // We use browser_execute-style CDP commands directly for determinism.
      const { connectBrowser, CdpSession } = await import("agents/browser");
      const browser = await connectBrowser(env.BROWSER);
      const cdp = new CdpSession(browser);

      // Create a target (tab) with the URL
      const { targetId } = (await cdp.send("Target.createTarget", {
        url,
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Wait for page load
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Get document and extract text
        const { root } = (await cdp.send("DOM.getDocument", {}, { sessionId })) as {
          root: { nodeId: number };
        };
        const { outerHTML } = (await cdp.send(
          "DOM.getOuterHTML",
          { nodeId: root.nodeId },
          { sessionId },
        )) as { outerHTML: string };

        // Extract text content (strip tags)
        const text = outerHTML
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        // Take screenshot
        const { data: screenshotData } = (await cdp.send(
          "Page.captureScreenshot",
          { format: "png" },
          { sessionId },
        )) as { data: string };
        const screenshot = `data:image/png;base64,${screenshotData}`;

        const checks =
          textContains?.map((needle) => ({
            name: `text contains "${needle}"`,
            passed: text.includes(needle),
          })) ?? [];
        const ok = checks.every((c) => c.passed);

        return { ok, url, textLength: text.length, screenshot, checks };
      } finally {
        // Clean up the target
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        url,
        textLength: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * RPC: run a QA check against a URL.
   */
  @callable()
  async qaCheck(
    url: string,
    checks?: { textContains?: string[] },
  ): Promise<QACheckResult> {
    const result = await this.runBrowserCheckCDP(url, checks?.textContains);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard(): Promise<QACheckResult> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    const result = await this.runBrowserCheckCDP(origin, ["PaymentAgent"]);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /* --------------------------------- A2A ---------------------------------- */

  @callable()
  async a2aSnapshot(): Promise<{ lastOk: boolean | null; lastUrl: string; lastRunAt: string }> {
    const last = this.lastRun;
    return {
      lastOk: last ? last.ok : null,
      lastUrl: last ? last.url : "",
      lastRunAt: last ? this.lastRunAt : "",
    };
  }

  @callable()
  async handleA2A(body: unknown, origin: string): Promise<unknown> {
    const { createA2ATransport, handleCollecting, qaCard } = await import("./a2a");
    const a2a = createA2ATransport(this.ctx.storage.sql, origin, qaCard(origin), {
      card: qaCard,
      handle: (message: any, context: { taskId: string; contextId: string }) =>
        this.handleA2AMessage(message, context),
    });
    return await handleCollecting(a2a.transport, body);
  }

  async handleA2AMessage(
    message: any,
    context: { taskId: string; contextId: string },
  ): Promise<{ text: string; data?: unknown }> {
    const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];

    const text = parts
      .filter((x) => x && x.kind === "text" && typeof x.text === "string")
      .map((x) => x.text as string)
      .join("\n")
      .trim();

    const dataPart = parts.find((x) => x && x.kind === "data" && x.data && typeof x.data === "object");
    const op = dataPart ? String((dataPart.data as any).operation || "") : "";

    if (!op) {
      const snapshot = await this.a2aSnapshot();
      return {
        text:
          text ||
          (snapshot.lastRunAt
            ? "Last QA check: " + (snapshot.lastOk ? "passed" : "failed") + " at " + snapshot.lastRunAt
            : "No QA check has run yet."),
        data: snapshot,
      };
    }

    const args = (dataPart?.data as any) ?? {};
    switch (op) {
      case "qa.summary":
        return { text: "QA status.", data: await this.a2aSnapshot() };

      case "qa.check": {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//.test(url)) {
          return { text: "qa.check needs an http(s) url.", data: { ok: false, error: "bad_url" } };
        }
        const result = await this.qaCheck(url, args.checks);
        return {
          text: result.ok
            ? "QA check passed for " + url + " (" + result.textLength + " chars of text)."
            : "QA check failed for " + url + (result.error ? ": " + result.error : "."),
          data: result,
        };
      }

      case "qa.dashboard": {
        const result = await this.qaDashboard();
        return {
          text: result.ok ? "Dashboard check passed." : "Dashboard check failed: " + (result.error || "check strings absent"),
          data: result,
        };
      }

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["qa.summary", "qa.check", "qa.dashboard"],
          },
        };
    }
  }
}
