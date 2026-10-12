/**
 * QAAgent — autonomous QA agent.
 *
 * Part of issue #42 (Think migration). This agent uses browser tools
 * (Puppeteer via the BROWSER binding) to load pages, extract text,
 * take screenshots, and report pass/fail.
 *
 * Currently extends Agent (matching codebase pattern). Will migrate to
 * Think base class when the parent agent migrates (for agentTool support).
 */
import { Agent, callable } from "agents";
import type { Env } from "./types";

export interface QACheckResult {
  ok: boolean;
  url: string;
  textLength: number;
  screenshot?: string;
  checks?: { name: string; passed: boolean }[];
  error?: string;
}

export class QAAgent extends Agent<Env> {
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
    const puppeteer = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.default.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (await page.evaluate(`document.body.innerText`)) as string;
      const shot = (await page.screenshot()) as Uint8Array;
      let binary = "";
      for (let i = 0; i < shot.length; i++) binary += String.fromCharCode(shot[i]);
      // btoa is available in Workers runtime
      const screenshot = `data:image/png;base64,${btoa(binary)}`;
      await page.close();

      const checks =
        textContains?.map((needle) => ({
          name: `text contains "${needle}"`,
          passed: text.includes(needle),
        })) ?? [];
      const ok = checks.every((c) => c.passed);
      return { ok, url, textLength: text.length, screenshot, checks };
    } catch (err) {
      return {
        ok: false,
        url,
        textLength: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await browser.close();
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
    return this.runBrowserCheck(url, checks?.textContains);
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard(): Promise<QACheckResult> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    return this.runBrowserCheck(origin, ["PaymentAgent"]);
  }
}
