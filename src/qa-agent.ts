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
import { emailAgentTool } from "./agent-tools";
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
   * No tools of its own: this agent IS the tool. It exposes capabilities through
   * @callable() methods and A2A, which does not require an AI SDK tool set.
   * (Browser CDP is used directly in runBrowserCheckCDP below for deterministic checks.)
   */
  override getTools() {
    // EmailAgent as a tool: QAAgent can dispatch email sends via the Think framework.
    // This makes the email capability available for LLM-driven dispatch.
    return {
      email: emailAgentTool,
    };
  }
  /**
   * Shared browser-check logic.
   */
  private async runBrowserCheck(
    url: string,
    textContains?: string[],
    apiKey?: string,
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
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Set API key in localStorage before navigating (dashboard reads it from there)
        if (apiKey) {
          await cdp.send(
            "Runtime.evaluate",
            {
              expression: `localStorage.setItem("cfpay_api_key", ${JSON.stringify(apiKey)})`,
            },
            { sessionId },
          );
        }

        // Navigate to the URL
        await cdp.send("Page.navigate", { url }, { sessionId });
        // Wait for page load
        await new Promise((resolve) => setTimeout(resolve, 4000));

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
    checks?: { textContains?: string[]; apiKey?: string },
  ): Promise<QACheckResult> {
    const result = await this.runBrowserCheck(url, checks?.textContains, checks?.apiKey);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard(apiKey?: string): Promise<QACheckResult> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    // Check for authenticated dashboard content (not just login page)
    const result = await this.runBrowserCheck(
      origin,
      ["PaymentAgent", "Dashboard", "Payments", "Emails"],
      apiKey,
    );
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    return result;
  }

  /**
   * RPC: click through dashboard tabs and verify each loads data.
   * Tests: Payments, Emails, Webhooks tabs.
   */
  @callable()
  async qaDashboardTabs(
    apiKey: string,
  ): Promise<{ ok: boolean; tabs: { name: string; passed: boolean; detail: string }[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, tabs: [], error: "Browser binding not configured" };
    }
    if (!apiKey) {
      return { ok: false, tabs: [], error: "API key required for tab testing" };
    }

    const origin = (env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    const tabsToTest = [
      { name: "Payments", selector: '[data-tab="payments"]', expectText: ["Payment", "Amount", "Status"] },
      { name: "Emails", selector: '[data-tab="emails"]', expectText: ["Email", "Subject", "From"] },
      { name: "Webhooks", selector: '[data-tab="webhooks"]', expectText: ["Webhook", "Event", "URL"] },
    ];

    let browser: any = null;
    const results: { name: string; passed: boolean; detail: string }[] = [];

    try {
      const { connectBrowser } = await import("agents/browser");
      browser = await connectBrowser(env.BROWSER);
      const cdp = browser; // connectBrowser returns CdpConnection directly

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Set auth
        await cdp.send(
          "Runtime.evaluate",
          { expression: `localStorage.setItem("cfpay_api_key", ${JSON.stringify(apiKey)})` },
          { sessionId },
        );
        await cdp.send("Page.navigate", { url: origin }, { sessionId });
        await new Promise((r) => setTimeout(r, 4000));

        for (const tab of tabsToTest) {
          try {
            // Click the tab
            await cdp.send(
              "Runtime.evaluate",
              {
                expression: `document.querySelector('${tab.selector}')?.click()`,
              },
              { sessionId },
            );
            await new Promise((r) => setTimeout(r, 2000));

            // Get page text after click
            const { root } = (await cdp.send("DOM.getDocument", {}, { sessionId })) as any;
            const { outerHTML } = (await cdp.send(
              "DOM.getOuterHTML",
              { nodeId: root.nodeId },
              { sessionId },
            )) as any;
            const text = outerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

            const found = tab.expectText.filter((t) => text.includes(t));
            const passed = found.length > 0;
            results.push({
              name: tab.name,
              passed,
              detail: passed
                ? `Found: ${found.join(", ")}`
                : `Missing expected text. Page had ${text.length} chars.`,
            });
          } catch (err) {
            results.push({
              name: tab.name,
              passed: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        tabs: results,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (browser && typeof browser.close === "function") {
        await browser.close().catch(() => {});
      }
    }

    const ok = results.every((r) => r.passed);
    return { ok, tabs: results };
  }

  /**
   * RPC: run dashboard QA checks and email a plain-text report.
   * Uses EmailAgent as a tool (via DO RPC) to send the report.
   * EmailAgent sends text only (no HTML/attachments), so the report is plain text.
   */
  @callable()
  async qaAndEmailReport(
    apiKey: string,
    toEmail: string,
  ): Promise<{ ok: boolean; emailed: boolean; tabs: any[]; error?: string }> {
    const tabResult = await this.qaDashboardTabs(apiKey);

    const tabLines = tabResult.tabs
      .map((t: any) => `- ${t.name}: ${t.passed ? "PASS" : "FAIL"} - ${t.detail}`)
      .join("\n");
    const body = [
      `QA Dashboard Report - ${new Date().toISOString()}`,
      ``,
      `Overall: ${tabResult.ok ? "PASS" : "FAIL"}`,
      ``,
      `Tab Results:`,
      tabLines,
      ``,
      `Dashboard: https://pay.openaimp.com`,
      ``,
      `Generated by QAAgent autonomous QA`,
    ].join("\n");

    try {
      // Through the shared helper rather than getAgentByName directly. That call was also
      // not awaited, so the stub it returned was a Promise: .sendThroughAgent would have
      // been undefined at runtime and the catch would have reported emailed:false, which
      // is why this report never actually arrived.
      const { emailAgentStub } = await import("./email-tool");
      const emailAgent = emailAgentStub(this.env as Env);
      if (!emailAgent) {
        return {
          ok: tabResult.ok,
          emailed: false,
          tabs: tabResult.tabs,
          error: "The email agent is unavailable, so the report was not sent.",
        };
      }
      // Capture dashboard screenshot for attachment
      const dashResult = await this.qaDashboard(apiKey);
      const attachments: { filename: string; type: string; content: string }[] = [];
      if (dashResult.screenshot) {
        // screenshot is data:image/png;base64,... — strip prefix for attachment
        const base64 = dashResult.screenshot.split(',')[1] || dashResult.screenshot;
        attachments.push({
          filename: `qa-dashboard-${new Date().toISOString().slice(0, 10)}.png`,
          type: 'image/png',
          content: base64,
        });
      }
      await emailAgent.sendThroughAgent({
        to: toEmail,
        subject: `QA Report: Dashboard ${tabResult.ok ? "PASS" : "FAIL"} - ${new Date().toISOString().slice(0, 10)}`,
        body,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      return { ok: tabResult.ok, emailed: true, tabs: tabResult.tabs };
    } catch (err) {
      return {
        ok: tabResult.ok,
        emailed: false,
        tabs: tabResult.tabs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * RPC: Test email attachments via the dashboard UI.
   * Uses CDP to fill the Send Email form, attach a test file, submit, and verify.
   * This is a true end-to-end UI test of the attachment flow.
   */
  @callable()
  async testEmailAttachmentUI(
    apiKey: string,
    toEmail: string,
  ): Promise<{ ok: boolean; detail: string; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, detail: "Browser binding not configured" };
    }

    let browser: any = null;
    try {
      const { connectBrowser } = await import("agents/browser");
      browser = await connectBrowser(env.BROWSER);
      const cdp = browser;

      // Create target and navigate to dashboard
      const { targetId } = await cdp.send("Target.createTarget", {
        url: "about:blank",
      });
      const sessionId = await cdp.attachToTarget(targetId);

      // Helper to send CDP commands to the session
      const send = (method: string, params: any = {}) =>
        cdp.send(method, { sessionId, ...params });

      // Navigate to dashboard
      await send("Page.navigate", { url: "https://pay.openaimp.com" });
      await new Promise((r) => setTimeout(r, 3000));

      // Set API key in localStorage and reload
      await send("Runtime.evaluate", {
        expression: `localStorage.setItem('cfpay_api_key', '${apiKey}')`,
      });
      await send("Page.navigate", { url: "https://pay.openaimp.com" });
      await new Promise((r) => setTimeout(r, 3000));

      // Click the Send Email tab (find by text or data attribute)
      await send("Runtime.evaluate", {
        expression: `
          (() => {
            const tabs = document.querySelectorAll('[data-tab], .tab, button');
            for (const tab of tabs) {
              if (tab.textContent.toLowerCase().includes('send')) {
                tab.click();
                return true;
              }
            }
            return false;
          })()
        `,
      });
      await new Promise((r) => setTimeout(r, 1000));

      // Fill the form and create a test attachment via DataTransfer
      const testContent = btoa("QA test attachment - " + new Date().toISOString());
      await send("Runtime.evaluate", {
        expression: `
          (() => {
            document.getElementById('sendTo').value = '${toEmail}';
            document.getElementById('sendSubject').value = 'QA Attachment Test';
            document.getElementById('sendBody').value = 'Testing email attachments via QAAgent UI automation.';
            // Create a test file
            const content = atob('${testContent}');
            const blob = new Blob([content], { type: 'text/plain' });
            const file = new File([blob], 'qa-test.txt', { type: 'text/plain' });
            const dt = new DataTransfer();
            dt.items.add(file);
            document.getElementById('sendAttachments').files = dt.files;
            // Trigger change event
            document.getElementById('sendAttachments').dispatchEvent(new Event('change'));
            return true;
          })()
        `,
      });
      await new Promise((r) => setTimeout(r, 500));

      // Click send
      await send("Runtime.evaluate", {
        expression: `document.querySelector('button[onclick="sendEmail()"]').click()`,
      });
      await new Promise((r) => setTimeout(r, 5000));

      // Check for success message
      const result = await send("Runtime.evaluate", {
        expression: `document.getElementById('sendResult').innerText`,
      });
      const text = result.result?.value || "";

      await send("Target.closeTarget", { targetId });

      if (text.toLowerCase().includes("success")) {
        return { ok: true, detail: "Email with attachment sent via UI. " + text };
      } else {
        return { ok: false, detail: "UI did not show success. Result: " + text };
      }
    } catch (err) {
      return {
        ok: false,
        detail: "UI test failed",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
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
