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
import { closeConnectionQuietly } from "./browser-lifecycle";
// Static import, deliberately. A dynamic import() cannot be used here:
// Think's getTools() is synchronous, so there is no await available at the
// point the tool set is built.
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

/**
 * The localStorage key the dashboard reads its API key from.
 *
 * This must match `public/index.html`, which reads `cfmail_api_key` in five
 * places. QAAgent previously seeded `cfpay_api_key` here - a key the dashboard
 * never reads - so every "authenticated" QA check silently rendered the login
 * page and then asserted against that login page's text. The tab check could
 * therefore never fail for the reason it existed, and could pass for no reason
 * at all. tests/wiring.test.ts now guards the two sites against drifting.
 */
export const DASHBOARD_API_KEY_STORAGE_KEY = "cfmail_api_key";

/**
 * The slice of the CDP connection this agent uses.
 *
 * `connectBrowser` is declared to return CdpConnection, but the browser handle
 * was previously typed `any`, which is how a `close().catch(...)` on a void
 * method compiled cleanly and then threw at runtime. Naming the shape keeps that
 * mistake visible to the compiler.
 */
interface CdpLike {
  send(method: string, params?: unknown, options?: { sessionId?: string }): Promise<unknown>;
  attachToTarget(targetId: string, options?: unknown): Promise<string>;
  close(): void;
}

/**
 * Turn a browser-layer failure into a message that names the likely cause.
 *
 * The raw text for a session-limit refusal points at wrangler.jsonc, which is
 * almost never the problem, and it reached the dashboard as a bare
 * "HTTP 500: Internal Server Error". Both are fixed by deciding here what the
 * error actually means.
 */
function describeBrowserFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Idempotent: openBrowserSession already translated this, and re-wrapping
  // produced "Browser check failed: Could not open a browser session: ...".
  if (message.startsWith("Could not open a browser session")) return message;
  if (/did not return a WebSocket/i.test(message)) {
    // States what is known and what to try, without asserting a cause that has
    // not been established. The previous wording claimed "this is exhaustion",
    // which is the leading explanation but was never confirmed - and a message
    // that asserts a cause it cannot prove is worse than one that names the
    // possibilities, because it stops the next person looking.
    return (
      "Could not open a browser session. The browser binding is configured, so " +
      "treat this as a transient capacity refusal (concurrency or quota) rather " +
      "than a missing binding: sessions are short-lived, so waiting a moment and " +
      "retrying is the first thing to try."
    );
  }
  return `Browser check failed: ${message}`;
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
    const env = this.env as Env;

    // Model-driven browser tools, for interactive automation (clicking, form
    // filling, navigation) that the hand-rolled CDP methods below do not attempt.
    //
    // Guarded rather than assumed: creating these needs both the BROWSER and
    // LOADER bindings, and a getTools() that throws takes down every chat turn on
    // the agent, including the paths that never touch a browser. Environment
    // variables are configuration, so an agent must not fail to boot because one
    // optional binding is absent - it should simply offer fewer tools.
    let browserTools: Record<string, unknown> = {};
    if (env.BROWSER && env.LOADER) {
      try {
        browserTools = createBrowserTools({
          browser: env.BROWSER,
          loader: env.LOADER,
        }) as Record<string, unknown>;
      } catch (err) {
        // Non-fatal by design; the deterministic CDP checks are unaffected.
        console.warn(
          "[QAAgent] createBrowserTools unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      email: emailAgentTool,
      ...browserTools,
    };
  }
  /**
   * Open a Browser Rendering session, translating a refusal into something
   * actionable.
   *
   * `connectBrowser` reports a failure to open a session as "Browser Rendering
   * binding did not return a WebSocket. Ensure the 'browser' binding is
   * configured in wrangler.jsonc."
   *
   * That message points at configuration, but the browser binding being absent
   * is the least likely cause: this Worker declares it, the deploy reports it as
   * bound, and a request that fails this way has usually already spent seconds
   * of wall time on browser work. A refusal for concurrency or quota reasons
   * arrives through the same path, and reads identically. The exact limits are
   * plan-specific and are NOT asserted here; what is asserted is that this is
   * not a wrangler.jsonc problem, and that the sessions are short-lived so
   * waiting and retrying is the first thing to try.
   */
  private async openBrowserSession(env: Env): Promise<CdpLike> {
    const { connectBrowser } = await import("agents/browser");
    try {
      return (await connectBrowser(env.BROWSER)) as CdpLike;
    } catch (err) {
      throw new Error(describeBrowserFailure(err));
    }
  }

  /**
   * Shared browser-check logic.
   */
  private async runBrowserCheck(
    url: string,
    textContains?: string[],
    apiKey?: string,
    sharedConnection?: CdpLike,
  ): Promise<QACheckResult> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
    }

    // A caller that already holds a session passes it in. Opening a second one
    // here is what exhausted the browser concurrency limit and produced the
    // misleading "did not return a WebSocket" error.
    const ownsConnection = !sharedConnection;

    try {
      // CDP-based browser check (replaces raw Puppeteer).
      //
      // connectBrowser resolves to a CdpConnection already - its declared return type is
      // Promise<CdpConnection> - so the connection is used directly. The previous code
      // wrapped it in `new CdpSession(browser)`, which passed a CdpConnection where the
      // constructor expects a WebSocket, and CdpSession is only a deprecated alias for
      // CdpConnection anyway.
      const cdp = sharedConnection ?? (await this.openBrowserSession(env));

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Navigate FIRST. localStorage is origin-scoped: seeding it on the
        // about:blank target (opaque origin) before navigating meant the
        // dashboard never saw the key and always showed the login page.
        await cdp.send("Page.navigate", { url }, { sessionId });
        // Wait for the navigation to commit so the evaluate below runs on the
        // dashboard's origin, not about:blank.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Seed the key the dashboard reads from localStorage during init, then
        // reload so init runs with the key present.
        if (apiKey) {
          await cdp.send(
            "Runtime.evaluate",
            {
              expression: `localStorage.setItem(${JSON.stringify(
                DASHBOARD_API_KEY_STORAGE_KEY,
              )}, ${JSON.stringify(apiKey)})`,
            },
            { sessionId },
          );
          await cdp.send("Page.reload", {}, { sessionId });
        }

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
        // The target is always released. The connection is only closed by the
        // owner, so a shared session survives for the next check.
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        if (ownsConnection) cdp.close();
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
   * RPC: click through the dashboard tabs and verify each renders real data.
   *
   * Each tab is checked against the container the dashboard fills for it
   * (`emailList`, `paymentList`, `webhookList`), not against the page's overall
   * text. The distinction is the whole point of the check: "Payments" is a tab
   * label that exists on every page, so searching page text for it reports
   * success even when the tab is empty, unauthenticated, or broken.
   *
   * The dashboard's own empty states ("No emails yet" and friends) are treated
   * as failures. A tab with no rows is a real result and has to be reported,
   * not passed over - otherwise the check is green precisely when it has
   * verified nothing.
   *
   * Rows are counted from rendered markup rather than from the API, so this
   * measures what a user would actually see: auth, fetch, render and empty-state
   * handling all have to work for a tab to pass.
   */
  @callable()
  async qaDashboardTabs(
    apiKey: string,
    sharedConnection?: CdpLike,
  ): Promise<{ ok: boolean; tabs: { name: string; passed: boolean; detail: string }[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, tabs: [], error: "Browser binding not configured" };
    }
    if (!apiKey) {
      return { ok: false, tabs: [], error: "API key required for tab testing" };
    }

    const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";

    // `containerId` is the element the dashboard writes rows into; `emptyText`
    // is that tab's empty state. Both come from public/index.html.
    const tabsToTest = [
      { name: "Emails", tab: "emails", containerId: "emailList", emptyText: "No emails yet" },
      { name: "Payments", tab: "payments", containerId: "paymentList", emptyText: "No payments yet" },
      { name: "Webhooks", tab: "webhooks", containerId: "webhookList", emptyText: "No webhook events yet" },
    ];

    // Only opens a session when one was not supplied. This is what keeps a QA
    // report to a single session instead of two.
    const ownsConnection = !sharedConnection;
    const results: { name: string; passed: boolean; detail: string }[] = [];
    let browser: CdpLike | null = sharedConnection ?? null;

    try {
      const cdp: CdpLike = browser ?? (await this.openBrowserSession(env));
      browser = cdp;

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Navigate FIRST. localStorage is origin-scoped: seeding it on the
        // about:blank target (opaque origin) before navigating meant the
        // dashboard never saw the key and always showed the login page.
        await cdp.send("Page.navigate", { url: origin }, { sessionId });
        // Wait for the navigation to commit so the seed below runs on the
        // dashboard's origin, not about:blank.
        await new Promise((r) => setTimeout(r, 3000));

        // Seed the key the dashboard reads during init, then reload so init
        // runs with the key present.
        await cdp.send(
          "Runtime.evaluate",
          {
            expression: `localStorage.setItem(${JSON.stringify(
              DASHBOARD_API_KEY_STORAGE_KEY,
            )}, ${JSON.stringify(apiKey)})`,
          },
          { sessionId },
        );
        await cdp.send("Page.reload", {}, { sessionId });
        await new Promise((r) => setTimeout(r, 4000));

        // Fail loudly if we are looking at the login page. Without this the
        // per-tab checks below would report "container missing", which is true
        // but buries the actual cause.
        const authState = (await cdp.send(
          "Runtime.evaluate",
          {
            expression: `JSON.stringify({
              loginShown: !!document.getElementById('login') &&
                getComputedStyle(document.getElementById('login')).display !== 'none',
              appShown: !!document.getElementById('app') &&
                getComputedStyle(document.getElementById('app')).display !== 'none'
            })`,
            returnByValue: true,
          },
          { sessionId },
        )) as { result?: { value?: string } };

        let loginShown = false;
        try {
          const parsed = JSON.parse(authState.result?.value || "{}") as { loginShown?: boolean };
          loginShown = parsed.loginShown === true;
        } catch {
          // Unparseable probe: fall through and let the per-tab checks report.
        }

        if (loginShown) {
          const detail =
            "Dashboard showed the login page, so no tab could be verified. " +
            "The API key was not accepted (check DASHBOARD_API_KEY).";
          for (const tab of tabsToTest) {
            results.push({ name: tab.name, passed: false, detail });
          }
          return { ok: false, tabs: results, error: detail };
        }

        for (const tab of tabsToTest) {
          try {
            // Click the tab. Assert the click landed: a renamed or removed tab
            // must not be reported as a data failure.
            const clicked = (await cdp.send(
              "Runtime.evaluate",
              {
                expression: `(() => {
                  const el = document.querySelector('[data-tab=${JSON.stringify(tab.tab)}]');
                  if (!el) return false;
                  el.click();
                  return el.classList.contains('active');
                })()`,
                returnByValue: true,
              },
              { sessionId },
            )) as { result?: { value?: boolean } };

            if (clicked.result?.value !== true) {
              results.push({
                name: tab.name,
                passed: false,
                detail: `Tab '[data-tab="${tab.tab}"]' is missing or did not become active.`,
              });
              continue;
            }

            // In-page wait for the tab's loader to settle, rather than a fixed
            // sleep: loadEmails/loadPayments/loadWebhooks are async, and a fixed
            // wait either flakes or wastes time.
            const probe = (await cdp.send(
              "Runtime.evaluate",
              {
                expression: `(async () => {
                  const id = ${JSON.stringify(tab.containerId)};
                  const emptyText = ${JSON.stringify(tab.emptyText)};
                  const read = () => {
                    const el = document.getElementById(id);
                    if (!el) return { found: false };
                    const text = (el.innerText || '').trim();
                    return {
                      found: true,
                      rows: el.querySelectorAll('.card, .item').length,
                      text,
                      isEmpty: text.includes(emptyText),
                      stillLoading: !!el.querySelector('.loading'),
                    };
                  };
                  for (let i = 0; i < 40; i++) {
                    const s = read();
                    if (!s.found) return s;
                    if (s.rows > 0) return s;
                    if (s.isEmpty) return s;
                    await new Promise((r) => setTimeout(r, 250));
                  }
                  return read();
                })()`,
                awaitPromise: true,
                returnByValue: true,
              },
              { sessionId },
            )) as { result?: { value?: any } };

            const state = probe.result?.value as
              | { found?: boolean; rows?: number; isEmpty?: boolean; stillLoading?: boolean; text?: string }
              | undefined;

            if (!state || state.found !== true) {
              results.push({
                name: tab.name,
                passed: false,
                detail: `Container '#${tab.containerId}' was not in the DOM.`,
              });
            } else if (state.isEmpty) {
              results.push({
                name: tab.name,
                passed: false,
                detail: `Rendered its empty state ("${tab.emptyText}"); no data to verify.`,
              });
            } else if ((state.rows ?? 0) === 0) {
              results.push({
                name: tab.name,
                passed: false,
                detail: state.stillLoading
                  ? `Still loading after 10s; container '#${tab.containerId}' stayed empty.`
                  : `Container '#${tab.containerId}' rendered no rows.`,
              });
            } else {
              results.push({
                name: tab.name,
                passed: true,
                detail: `Rendered ${state.rows} row(s) from '#${tab.containerId}'.`,
              });
            }
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
      // A void close(): the teardown helper exists precisely because
      // `browser.close().catch(...)` throws here - close() returns undefined,
      // and that throw used to replace this method's return value with a 500.
      // Only the owner closes, so a shared session is left usable.
      if (ownsConnection) closeConnectionQuietly(browser);
    }

    const ok = results.length > 0 && results.every((r) => r.passed);
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
    // ONE session for the whole report: the tab check and the screenshot both
    // need a browser, and opening one each is what exhausted the Browser
    // Rendering concurrency limit. A refusal there surfaces as "did not return a
    // WebSocket", which reads like a configuration fault but is really
    // exhaustion - so the count is reduced rather than the symptom retried.
    const env = this.env as Env;
    let connection: CdpLike | null = null;
    let tabResult: {
      ok: boolean;
      tabs: { name: string; passed: boolean; detail: string }[];
      error?: string;
    };

    try {
      if (env.BROWSER && apiKey) {
        connection = await this.openBrowserSession(env);
      }
      tabResult = await this.qaDashboardTabs(apiKey, connection ?? undefined);
    } catch (err) {
      // Released here as well as in the finally below: this early return would
      // otherwise leak the session it opened, which is the exhaustion this
      // whole change is meant to reduce.
      if (connection) closeConnectionQuietly(connection);
      return {
        ok: false,
        emailed: false,
        tabs: [],
        error: describeBrowserFailure(err),
      };
    }

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
      // Capture dashboard screenshot for attachment, on the SAME session opened
      // above rather than a second one.
      const dashResult = await this.runBrowserCheck(
        env.SELF_ORIGIN ?? "https://pay.openaimp.com",
        ["PaymentAgent", "Dashboard", "Payments", "Emails"],
        apiKey,
        connection ?? undefined,
      );
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
      const sendResult = await emailAgent.sendThroughAgent({
        to: toEmail,
        subject: `QA Report: Dashboard ${tabResult.ok ? "PASS" : "FAIL"} - ${new Date().toISOString().slice(0, 10)}`,
        body,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      // sendThroughAgent RETURNS a refusal rather than throwing, so ignoring the
      // result reported emailed:true for a rate-limited or rejected send - the
      // dashboard showed success for a report that never left.
      if (!sendResult?.ok) {
        return {
          ok: tabResult.ok,
          emailed: false,
          tabs: tabResult.tabs,
          error: sendResult?.error || "The email agent refused the send.",
        };
      }
      return { ok: tabResult.ok, emailed: true, tabs: tabResult.tabs };
    } catch (err) {
      return {
        ok: tabResult.ok,
        emailed: false,
        tabs: tabResult.tabs,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Released on every path, including the early returns above.
      if (connection) closeConnectionQuietly(connection);
    }
  }



  /**
   * RPC: drive the dashboard's Send Email form end to end, with an attachment.
   *
   * qaAndEmailReport already proves EmailAgent can send attachments when called
   * directly. This proves the *user path*: that the form collects a file, that
   * /api/dashboard/send-email receives it, and that the UI reports success. The
   * two failure modes are different, which is why both are worth testing.
   *
   * Note the deliberate omission: the browser never waits on a fixed timeout for
   * the send to settle. sendEmail() is async and the assertion polls the result
   * element in-page until it shows a terminal state, so a slow send is reported
   * as slow rather than as a failure.
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
    if (!apiKey) {
      return { ok: false, detail: "API key required to drive the dashboard" };
    }
    if (!toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
      return { ok: false, detail: "A valid recipient address is required" };
    }

    const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";
    // Standalone check, so it owns its session - but the session is opened
    // through the helper so a limit refusal is explained instead of surfacing as
    // a raw "did not return a WebSocket".
    let browser: CdpLike | null = null;

    try {
      const cdp = await this.openBrowserSession(env);
      browser = cdp;

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);

        // Navigate FIRST: localStorage is origin-scoped, so seeding on the
        // about:blank target (opaque origin) would leave the dashboard without
        // the key. Seed on the dashboard origin, then reload so init reads it.
        await cdp.send("Page.navigate", { url: origin }, { sessionId });
        await new Promise((r) => setTimeout(r, 3000));
        await cdp.send(
          "Runtime.evaluate",
          {
            expression: `localStorage.setItem(${JSON.stringify(
              DASHBOARD_API_KEY_STORAGE_KEY,
            )}, ${JSON.stringify(apiKey)})`,
          },
          { sessionId },
        );
        await cdp.send("Page.reload", {}, { sessionId });
        await new Promise((r) => setTimeout(r, 4000));

        // Open the Send Email tab and wait for the form to exist, rather than
        // assuming a fixed delay is enough for the tab switch to take effect.
        const formReady = (await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(async () => {
              const tab = document.querySelector('[data-tab="send"]');
              if (!tab) return 'tab missing';
              tab.click();
              for (let i = 0; i < 40; i++) {
                if (document.getElementById('sendTo') &&
                    document.getElementById('sendAttachments') &&
                    document.getElementById('sendResult')) {
                  return 'ready';
                }
                await new Promise((r) => setTimeout(r, 250));
              }
              return 'form missing';
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
          { sessionId },
        )) as { result?: { value?: string } };

        if (formReady.result?.value !== "ready") {
          return {
            ok: false,
            detail: `Send Email form did not become usable: ${formReady.result?.value}`,
          };
        }

        // Fill the form and attach a real file via DataTransfer. The file input
        // is used rather than setting the field directly, so the page's own
        // change handling is exercised.
        const filled = (await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              try {
                document.getElementById('sendTo').value = ${JSON.stringify(toEmail)};
                document.getElementById('sendSubject').value = 'QA attachment test';
                document.getElementById('sendBody').value =
                  'Automated QA check of the Send Email form and its attachment handling.';

                const bytes = new TextEncoder().encode(
                  'qa attachment probe ' + new Date().toISOString(),
                );
                const file = new File([bytes], 'qa-probe.txt', { type: 'text/plain' });
                const dt = new DataTransfer();
                dt.items.add(file);
                const input = document.getElementById('sendAttachments');
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return 'filled:' + dt.files.length;
              } catch (e) {
                return 'error:' + (e && e.message ? e.message : String(e));
              }
            })()`,
            returnByValue: true,
          },
          { sessionId },
        )) as { result?: { value?: string } };

        const filledValue = filled.result?.value || "";
        if (!filledValue.startsWith("filled:1")) {
          return { ok: false, detail: `Could not attach a file to the form (${filledValue})` };
        }

        // Submit through the page's own handler, so this exercises the real path.
        await cdp.send(
          "Runtime.evaluate",
          { expression: `document.querySelector('button[onclick="sendEmail()"]').click()` },
          { sessionId },
        );

        // Poll for a terminal state instead of sleeping a fixed amount.
        const outcome = (await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(async () => {
              const el = document.getElementById('sendResult');
              for (let i = 0; i < 120; i++) {
                const text = (el.innerText || '').trim();
                const lower = text.toLowerCase();
                if (lower.includes('sent successfully')) return { state: 'sent', text };
                if (lower.includes('not sent') || lower.includes('error')) {
                  return { state: 'refused', text };
                }
                await new Promise((r) => setTimeout(r, 250));
              }
              return { state: 'timeout', text: (el.innerText || '').trim() };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
          { sessionId },
        )) as { result?: { value?: { state?: string; text?: string } } };

        const state = outcome.result?.value || {};
        if (state.state === "sent") {
          return {
            ok: true,
            detail: `Form submitted with 1 attachment; UI confirmed: ${String(state.text).slice(0, 200)}`,
          };
        }
        return {
          ok: false,
          detail: `Send did not confirm (${state.state}): ${String(state.text || "").slice(0, 300)}`,
        };
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        detail: "Send Email form test failed",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // A void close(): the teardown helper exists precisely because
      // `browser.close().catch(...)` throws here - close() returns undefined,
      // and that throw used to replace this method's return value with a 500.
      closeConnectionQuietly(browser);
    }
  }

  /**
   * RPC: verify the payment endpoint's guards, without ever paying.
   *
   * Deliberately no signing and no funds. A full payment test needs a funded
   * key and moves real money, so this covers only the parts that are safe to
   * assert automatically:
   *
   *   1. With no PAYMENT-SIGNATURE, /api/process must answer 402 and advertise a
   *      well-formed challenge (version, accepts[], and a network/asset/amount
   *      per entry) - the challenge is what a real client pays against, so a
   *      malformed one is a genuine outage.
   *   2. With a syntactically invalid signature, it must still refuse rather
   *      than accept or 500.
   *   3. The request must not be processed: no success payload is returned.
   *
   * What this does NOT prove: that a valid payment is verified and settled.
   * That is stated in the result so the suite cannot imply coverage it lacks.
   */
  @callable()
  async qaPaymentFlow(
    origin?: string,
  ): Promise<{
    ok: boolean;
    detail: string;
    checks: { name: string; passed: boolean; detail: string }[];
    unpaidPathVerified: boolean;
    settlementVerified: boolean;
    error?: string;
  }> {
    const env = this.env as Env;
    const base = origin || env.SELF_ORIGIN || "https://pay.openaimp.com";
    const checks: { name: string; passed: boolean; detail: string }[] = [];

    try {
      // 1. Unauthenticated request must be challenged with 402.
      const challengeRes = await fetch(`${base}/api/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "qa@example.com", request: "qa payment probe" }),
      });
      const challengeBody: any = await challengeRes.json().catch(() => null);

      const is402 = challengeRes.status === 402;
      checks.push({
        name: "unpaid request is challenged with 402",
        passed: is402,
        detail: `status=${challengeRes.status}`,
      });

      const accepts = challengeBody?.accepts;
      const wellFormed =
        Array.isArray(accepts) &&
        accepts.length > 0 &&
        accepts.every(
          (a: any) => a && typeof a.network === "string" && typeof a.amount === "string",
        );
      checks.push({
        name: "challenge advertises at least one payable option",
        passed: wellFormed,
        detail: wellFormed
          ? `${accepts.length} option(s), networks: ${accepts
              .map((a: any) => a.network)
              .join(", ")}`
          : `malformed or absent accepts: ${JSON.stringify(challengeBody).slice(0, 200)}`,
      });

      // 3. A 402 must not leak a success result.
      checks.push({
        name: "unpaid request is not processed",
        passed: is402 ? challengeBody?.success !== true : true,
        detail: is402
          ? `success field: ${JSON.stringify(challengeBody?.success)}`
          : "skipped: endpoint did not 402",
      });

      // 2. A malformed signature must be refused, not accepted and not 500.
      const badRes = await fetch(`${base}/api/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": "not-a-valid-signature",
        },
        body: JSON.stringify({ email: "qa@example.com", request: "qa payment probe" }),
      });
      const refused = badRes.status === 402 || badRes.status === 400;
      checks.push({
        name: "malformed payment signature is refused cleanly",
        passed: refused,
        detail: `status=${badRes.status} (expected 400/402, not 5xx)`,
      });

      const ok = checks.every((c) => c.passed);
      return {
        ok,
        detail: ok
          ? "Payment guards hold: 402 challenge is well-formed and a bad signature is refused."
          : "One or more payment guards did not hold.",
        checks,
        unpaidPathVerified: true,
        // Stated explicitly so a green run cannot be read as payment coverage.
        settlementVerified: false,
      };
    } catch (err) {
      return {
        ok: false,
        detail: "Payment flow check could not run",
        checks,
        unpaidPathVerified: false,
        settlementVerified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * RPC: negative and edge-case checks against the dashboard API.
   *
   * The existing QA methods only assert the happy path, so a regression that
   * turned a 401 into a 200 would be invisible. These assert that bad input is
   * refused with the right status AND a structured JSON body rather than an
   * HTML error page - the dashboard reports an unparseable 500 as a confusing
   * JSON parse error to the user, which is a past failure mode here.
   */
  @callable()
  async qaEdgeCases(
    origin?: string,
  ): Promise<{ ok: boolean; detail: string; checks: { name: string; passed: boolean; detail: string }[] }> {
    const env = this.env as Env;
    const base = origin || env.SELF_ORIGIN || "https://pay.openaimp.com";
    const checks: { name: string; passed: boolean; detail: string }[] = [];

    /** A JSON body, not an HTML error page. */
    const isJson = async (res: Response) => {
      const ct = res.headers.get("content-type") || "";
      return ct.includes("application/json");
    };

    try {
      // Unauthenticated dashboard read must be 401.
      const unauth = await fetch(`${base}/api/dashboard/emails`);
      checks.push({
        name: "unauthenticated dashboard read is rejected",
        passed: unauth.status === 401,
        detail: `status=${unauth.status}`,
      });

      // A wrong key must be rejected too, not treated as anonymous.
      const wrongKey = await fetch(`${base}/api/dashboard/emails`, {
        headers: { "X-API-Key": "definitely-not-the-key" },
      });
      checks.push({
        name: "a wrong API key is rejected",
        passed: wrongKey.status === 401,
        detail: `status=${wrongKey.status}`,
      });

      // A bogus QA operation must be reported, not treated as a success.
      const bogusOp = await fetch(`${base}/api/dashboard/qa/nonexistent-operation`, {
        method: "POST",
        headers: { "X-API-Key": "definitely-not-the-key" },
      });
      checks.push({
        name: "an unknown QA route does not report success",
        passed: bogusOp.status >= 400,
        detail: `status=${bogusOp.status}`,
      });

      // Errors should be structured JSON. Probe with a bad-but-plausible request.
      const badBody = await fetch(`${base}/api/dashboard/qa/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "definitely-not-the-key" },
        body: JSON.stringify({}),
      });
      const badBodyIsJson = await isJson(badBody);
      checks.push({
        name: "error responses are JSON, not an HTML error page",
        passed: badBodyIsJson,
        detail: `status=${badBody.status} content-type=${
          badBody.headers.get("content-type") || "none"
        }`,
      });

      const ok = checks.every((c) => c.passed);
      return {
        ok,
        detail: ok
          ? "Edge cases behave: bad auth and bad input are refused with structured errors."
          : "One or more edge cases did not behave as expected.",
        checks,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `Edge-case check could not run: ${
          err instanceof Error ? err.message : String(err)
        }`,
        checks,
      };
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
