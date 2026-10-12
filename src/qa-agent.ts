/**
 * QAAgent — autonomous QA agent implemented with Cloudflare Think.
 *
 * Part of issue #42 (Think migration). This agent uses browser tools
 * (Puppeteer via the BROWSER binding) to load pages, extract text,
 * take screenshots, and report pass/fail.
 *
 * It is designed to be invoked as a tool by a parent Think agent via
 * `agentTool(QAAgent, ...)` (see agents-as-tools example).
 */
import { Think } from "@cloudflare/think";
import { callable } from "agents";
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "./types";

export class QAAgent extends Think<Env> {
  override getModel() {
    // Use the same model family as the main agent chat.
    return "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
  }

  override getSystemPrompt(): string {
    return [
      "You are a QA agent. Your job is to verify web pages work correctly.",
      "Given a URL, use your browser tools to:",
      "1. Load the page",
      "2. Extract the visible text",
      "3. Take a screenshot",
      "4. Check that expected text is present",
      "Report PASS or FAIL with details for each check.",
    ].join("\n");
  }

  override getTools() {
    const env = this.env as Env;
    return {
      browseAndCheck: tool({
        description:
          "Load a URL in a headless browser, extract text, take a screenshot, and check for expected text.",
        inputSchema: z.object({
          url: z.string().url().describe("The URL to check"),
          textContains: z
            .array(z.string())
            .optional()
            .describe("Text snippets that must be present on the page"),
        }),
        execute: async ({ url, textContains }) => {
          return this.runBrowserCheck(url, textContains);
        },
      }),
    };
  }

  /**
   * Shared browser-check logic used by both the Think tool and the @callable RPC.
   */
  private async runBrowserCheck(url: string, textContains?: string[]) {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, url, textLength: 0, error: "Browser binding not configured" };
    }
    const puppeteer = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.default.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = (await page.evaluate(() => document.body.innerText)) as string;
      const shot = (await page.screenshot()) as Uint8Array;
      let binary = "";
      for (let i = 0; i < shot.length; i++) binary += String.fromCharCode(shot[i]);
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
   * RPC entry point for dashboard/API use (until parent migrates to Think
   * and can use agentTool() directly).
   */
  @callable()
  async qaCheck(
    url: string,
    checks?: { textContains?: string[] },
  ): Promise<{
    ok: boolean;
    url: string;
    textLength: number;
    screenshot?: string;
    checks?: { name: string; passed: boolean }[];
    error?: string;
  }> {
    return this.runBrowserCheck(url, checks?.textContains);
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard() {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    return this.runBrowserCheck(origin, ["PaymentAgent"]);
  }
}
