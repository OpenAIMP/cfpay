/**
 * QAAgent — autonomous QA agent.
 *
 * Part of issue #42 (Think migration). This agent uses browser tools
 * (Puppeteer via the BROWSER binding) to load pages, extract text,
 * take screenshots, and report pass/fail.
 *
 * Extends Think, which is what makes it chat-capable and therefore a valid child for
 * agentTool(). It is reachable three ways: a direct @callable() RPC, an A2A operation
 * at /a2a/qa, and a dispatch from a host agent's tool list.
 */
import { callable } from "agents";
import { Think } from "@cloudflare/think";
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

  /**
   * Used only when a host dispatches this agent through agentTool(). A QA check is a
   * deterministic browser run, not a conversation, so this model is never in the
   * pass/fail path - it exists because Think requires it and because a dispatched run
   * may need to phrase a finding.
   */
  override getModel(): string {
    return defaultModelId();
  }

  override getSystemPrompt(): string {
    return [
      "You are the QA capability agent for this Worker.",
      "You load a page and report what it actually did: whether it loaded, how much text it produced, and whether each expected string was present.",
      "Never report a pass you did not observe. A page that failed to load is a failure, not an absence of evidence.",
    ].join(" ");
  }

  /**
   * Browser tools via CDP. These give the model direct browser control
   * (browser_execute, browser_markdown, etc.) when dispatched via agentTool().
   * The @callable() methods below use direct CDP for deterministic checks.
   */
  override getTools() {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return {};
    }
    try {
      // Dynamic import to avoid breaking if agents/browser/ai isn't available
      const { createBrowserTools } = require("agents/browser/ai");
      return createBrowserTools({
        ctx: this.ctx,
        browser: env.BROWSER,
        loader: (env as any).LOADER,
      });
    } catch {
      return {};
    }
  }
  /**
   * Shared browser-check logic.
   */
  private async runBrowserCheck(
    url: string,
    textContains?: string[],
  ): Promise<QACheckResult> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
    }

    try {
      // CDP-based browser check (replaces raw Puppeteer).
      //
      // connectBrowser resolves to a CdpConnection already - its declared return type is
      // Promise<CdpConnection> - so the connection is used directly. The previous code
      // wrapped it in `new CdpSession(browser)`, which passed a CdpConnection where the
      // constructor expects a WebSocket, and CdpSession is only a deprecated alias for
      // CdpConnection anyway.
      const { connectBrowser } = await import("agents/browser");
      const cdp = await connectBrowser(env.BROWSER);

      const { targetId } = (await cdp.send("Target.createTarget", {
        url,
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);
        // Wait for page load
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const { root } = (await cdp.send("DOM.getDocument", {}, { sessionId })) as {
          root: { nodeId: number };
        };
        const { outerHTML } = (await cdp.send(
          "DOM.getOuterHTML",
          { nodeId: root.nodeId },
          { sessionId },
        )) as { outerHTML: string };

        const text = outerHTML
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

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
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        cdp.close();
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
    const result = await this.runBrowserCheck(url, checks?.textContains);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard(): Promise<QACheckResult> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    const result = await this.runBrowserCheck(origin, ["PaymentAgent"]);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /* --------------------------------- A2A ---------------------------------- */

  /**
   * Aggregate view for the A2A executor.
   *
   * Deliberately thin: a QA run produces a screenshot, and a screenshot is megabytes of
   * base64. Returning one from a status call would be a payload nobody asked for, so this
   * reports only whether the last check passed and when. A caller that wants the image
   * calls qa.check and gets it in the data artifact.
   */
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

  /**
   * Route one A2A message.
   *
   * `qa.check` makes the Worker fetch a URL and run a real browser against it, which is
   * the same capability shape as an SSRF: a caller chooses the destination and this
   * Worker goes there. It is behind the bearer credential like every other A2A call, and
   * it is bounded to http(s) - but a caller holding the credential can make the Worker
   * browse to an internal name. That is a real exposure of extraction, not a theoretical
   * one, and it is stated on the card rather than left for a reader to infer.
   */
  async handleA2AMessage(
    message: any,
    // Unused: each call is self-contained. Kept to satisfy the interface.
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
          // http(s) only: a bare host or any other scheme is refused rather than
          // guessed at, so a caller cannot reach file: or a protocol the browser
          // might resolve differently than intended.
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
        // Checks this Worker's own dashboard, which is the deployed page a user sees -
        // worth being able to assert remotely rather than only from a browser.
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
