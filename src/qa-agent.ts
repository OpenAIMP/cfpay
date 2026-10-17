/** QAAgent: drives a real browser to check pages and report pass/fail. */
import { crawlUrlKey, evidenceCollectorScript, pageEntriesOf, parsePageEvidence, sha256Hex, summarizeBaselines, summarizeEvidence, viewportListOf } from "./ux-audit-spec";
import { genericTabProbeExpression, genericTabVerdict, knownTabExpectations, mergeDiscoveredTabs } from "./tab-coverage";
import { openProfileConnection, profileRowClear, profileRowGet, profileRowSet, profileSessionAlive } from "./browser-profile";
import { composeA2AEmail, runA2AEndpointTests } from "./a2a-test";
import type { A2ARow } from "./a2a-test";
import type { BaselineResult, PageEvidence, UxAuditSpec, UxAuditStep, UxRuleProfile } from "./ux-audit-spec";
export type { UxAuditSpec, UxAuditStep, UxRuleProfile } from "./ux-audit-spec";
import { callable } from "agents";
import { emailAgentTool } from "./agent-tools";
import { Think } from "@cloudflare/think";
import { closeConnectionQuietly } from "./browser-lifecycle";
// Static import, deliberately. A dynamic import() cannot be used here:
// Think's getTools() is synchronous, so there is no await available at the
// point the tool set is built.
import { createBrowserTools } from "agents/browser/ai";
import { budgetSynthesis, contextWindowFor, defaultModelId, normaliseToolCalls, readCompletion } from "./models";
import {
  INVESTIGATE_MAX_CALLS,
  INVESTIGATE_MAX_TURNS,
  INVESTIGATE_SYSTEM,
  clampInvestigateInput,
  investigateToolSpecs,
  pageStateExpression,
} from "./investigate";
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
 * One live-view event for a QA run (issue #88): broadcast over the
 * agent WebSocket so the QA tab's panel can show the run working -
 * steps, verdicts, screenshots. Keyed by a caller-minted run id.
 */
export interface QALiveEvent {
  seq: number;
  ts: string;
  kind: "step" | "screenshot" | "result" | "frame";
  label: string;
  detail?: string;
  ok?: boolean;
  skipped?: boolean;
  /** data: URI; screenshot and frame events only. */
  image?: string;
}

/** The localStorage key the dashboard reads its API key from (must match index.html). */
export const DASHBOARD_API_KEY_STORAGE_KEY = "cfmail_api_key";

/** The UX audit's design rules (issue #91): data, so changing one is a reviewed code change. */
export const UX_RULES = {
  /** WCAG AA minimum contrast ratio for normal text. */
  contrastNormal: 4.5,
  /** WCAG AA minimum contrast ratio for large text (>= 24px, or >= 18.66px bold). */
  contrastLarge: 3,
  /** Minimum interactive target dimension in CSS px, in both dimensions. */
  minTargetPx: 44,
};

/** Per-target rule profile for the generalized audit (issue #94). */
/**
 * The in-page UX probe for qaUxAudit: one evaluate measuring
 * everything the audit's rules need from the rendered view, returned
 * as data; verdicts are computed in the agent from that data.
 */
function uxProbeExpression(profile?: UxRuleProfile): string {
  const normal = profile?.contrastNormal ?? UX_RULES.contrastNormal;
  const large = profile?.contrastLarge ?? UX_RULES.contrastLarge;
  const minPx = profile?.minTargetPx ?? UX_RULES.minTargetPx;
  const ignored = profile?.ignoreSelectors ?? [];
  return `(() => {
    const NORMAL = ${normal};
    const LARGE = ${large};
    const MINPX = ${minPx};
    const IGNORED = ${JSON.stringify(ignored)};
    const isIgnored = (el) => {
      for (const sel of IGNORED) {
        try { if (el.closest(sel)) return true; } catch (e) { /* a bad selector in a profile skips itself */ }
      }
      return false;
    };
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
    };
    const describe = (el) => {
      const t = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 36);
      return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (t ? ' "' + t + '"' : "");
    };
    const parseRGB = (c) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
      if (!m) return null;
      const parts = m[1].split(",").map((x) => parseFloat(x));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const bgOf = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const b = parseRGB(getComputedStyle(n).backgroundColor);
        if (b && b.a > 0) return b;
        n = n.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratioOf = (fg, bg) => {
      const l1 = lum(fg);
      const l2 = lum(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    let textChecked = 0;
    const contrastBad = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el)) continue;
      if (isIgnored(el)) continue;
      let own = false;
      for (const nd of el.childNodes) {
        if (nd.nodeType === 3 && nd.textContent.trim().length > 0) { own = true; break; }
      }
      if (!own) continue;
      const st = getComputedStyle(el);
      const size = parseFloat(st.fontSize) || 16;
      const weight = parseInt(st.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const fg = parseRGB(st.color);
      if (!fg) continue;
      textChecked++;
      const r = ratioOf(fg, bgOf(el));
      const need = large ? LARGE : NORMAL;
      if (r < need && contrastBad.length < 24) {
        contrastBad.push({ el: describe(el), ratio: Math.round(r * 100) / 100, need: need });
      }
    }
    const interactive = Array.from(document.querySelectorAll('a, button, input, select, textarea, [data-tab], [role="button"]')).filter(vis);
    const targetBad = [];
    for (const el of interactive) {
      if (isIgnored(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.width < MINPX || r.height < MINPX) && targetBad.length < 24) {
        targetBad.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(vis).map((h) => parseInt(h.tagName.slice(1), 10));
    const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    const overlaps = [];
    const rects = interactive.filter((el) => !isIgnored(el)).slice(0, 80).map((el) => ({ d: describe(el), r: el.getBoundingClientRect() }));
    for (let i = 0; i < rects.length && overlaps.length < 8; i++) {
      for (let j = i + 1; j < rects.length && overlaps.length < 8; j++) {
        const a = rects[i].r;
        const b = rects[j].r;
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller > 0 && (ix * iy) / smaller > 0.25) overlaps.push(rects[i].d + " overlaps " + rects[j].d);
      }
    }
    const imgBad = Array.from(document.querySelectorAll("img")).filter((im) => im.getAttribute("alt") === null && !isIgnored(im)).map((im) => (im.getAttribute("src") || "img").slice(-40));
    const firstBtn = Array.from(document.querySelectorAll(".btn, button")).filter(vis)[0];
    const btnStyle = firstBtn ? (() => { const st = getComputedStyle(firstBtn); return { bg: st.backgroundColor, color: st.color, fontSize: st.fontSize }; })() : null;
    const firstH1 = Array.from(document.querySelectorAll("h1")).filter(vis)[0];
    const h1Style = firstH1 ? (() => { const st = getComputedStyle(firstH1); return { fontFamily: st.fontFamily, fontSize: st.fontSize }; })() : null;
    return { textChecked: textChecked, contrastBad: contrastBad, targetChecked: interactive.length, targetBad: targetBad, headings: headings, overflowPx: overflowPx, overlaps: overlaps, imgBad: imgBad, btnStyle: btnStyle, h1Style: h1Style };
  })()`;
}

/**
 * Turn per-page probe measurements into findings for the generalized
 * audit (issue #94) - the same rules qaUxAudit computes for the
 * dashboard, plus design-token conformance. Pure.
 */
function summarizeUxProbes(
  probes: { view: string; data: any }[],
  rules: { minTargetPx: number; expectedButtonBg?: string },
): { name: string; passed: boolean; detail: string }[] {
  const findings: { name: string; passed: boolean; detail: string }[] = [];
  const summarize = (items: string[]): string =>
    items.slice(0, 3).join("; ") + (items.length > 3 ? `; +${items.length - 3} more` : "");

  const contrastBad = probes.flatMap((p) =>
    (p.data.contrastBad ?? []).map((b: any) => `${p.view}: ${b.el} at ${b.ratio}:1 (needs ${b.need}:1)`),
  );
  const textChecked = probes.reduce((n, p) => n + (p.data.textChecked ?? 0), 0);
  findings.push({
    name: "Contrast (WCAG AA)",
    passed: contrastBad.length === 0,
    detail:
      contrastBad.length === 0
        ? `${textChecked} text elements across ${probes.length} pages meet AA ratios.`
        : summarize(contrastBad),
  });

  const targetBad = probes.flatMap((p) =>
    (p.data.targetBad ?? []).map((b: any) => `${p.view}: ${b.el} is ${b.w}x${b.h}px`),
  );
  const targetChecked = probes.reduce((n, p) => n + (p.data.targetChecked ?? 0), 0);
  findings.push({
    name: "Target size",
    passed: targetBad.length === 0,
    detail:
      targetBad.length === 0
        ? `${targetChecked} interactive elements across ${probes.length} pages are at least ${rules.minTargetPx}px in both dimensions.`
        : summarize(targetBad),
  });

  const headingIssues: string[] = [];
  for (const p of probes) {
    const levels: number[] = p.data.headings ?? [];
    const h1s = levels.filter((l) => l === 1).length;
    if (h1s !== 1) headingIssues.push(`${p.view}: ${h1s} visible h1 elements (expected exactly 1)`);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        headingIssues.push(`${p.view}: heading level skips h${levels[i - 1]} to h${levels[i]}`);
      }
    }
  }
  findings.push({
    name: "Heading hierarchy",
    passed: headingIssues.length === 0,
    detail:
      headingIssues.length === 0
        ? `Exactly one h1 and no skipped levels across ${probes.length} pages.`
        : summarize(headingIssues),
  });

  const sigOf = (p: any): string | null =>
    p.data.btnStyle
      ? `${p.data.btnStyle.bg}|${p.data.btnStyle.color}|${p.data.btnStyle.fontSize}`
      : null;
  const sigs = probes
    .map((p) => ({ view: p.view, sig: sigOf(p) }))
    .filter((x) => x.sig !== null);
  const distinctSigs = new Set(sigs.map((x) => x.sig));
  findings.push({
    name: "Style consistency",
    passed: sigs.length > 0 && distinctSigs.size === 1,
    detail:
      sigs.length === 0
        ? "No primary button was visible on any page to compare."
        : distinctSigs.size === 1
          ? `Primary button style is identical across ${sigs.length} pages.`
          : `Primary button style differs across pages (${sigs.map((x) => x.view).join(", ")}).`,
  });

  const layoutIssues: string[] = [
    ...probes
      .filter((p) => (p.data.overflowPx ?? 0) > 0)
      .map((p) => `${p.view}: horizontal overflow of ${p.data.overflowPx}px`),
    ...probes.flatMap((p) => (p.data.overlaps ?? []).map((o: string) => `${p.view}: ${o}`)),
  ];
  findings.push({
    name: "Layout integrity",
    passed: layoutIssues.length === 0,
    detail:
      layoutIssues.length === 0
        ? "No horizontal overflow and no overlapping interactive elements on any page."
        : summarize(layoutIssues),
  });

  const imgBad = probes.flatMap((p) =>
    (p.data.imgBad ?? []).map((src: string) => `${p.view}: img ${src} has no alt attribute`),
  );
  findings.push({
    name: "Image alt text",
    passed: imgBad.length === 0,
    detail:
      imgBad.length === 0
        ? "Every rendered image carries an alt attribute."
        : summarize(imgBad),
  });

  if (rules.expectedButtonBg) {
    const expected = rules.expectedButtonBg.trim().toLowerCase();
    const offenders = probes
      .filter(
        (p) => !p.data.btnStyle || p.data.btnStyle.bg.trim().toLowerCase() !== expected,
      )
      .map(
        (p) =>
          `${p.view}: ${p.data.btnStyle ? p.data.btnStyle.bg : "no primary button found"}`,
      );
    findings.push({
      name: "Design token conformance",
      passed: offenders.length === 0,
      detail:
        offenders.length === 0
          ? `Primary button background matches the declared token on all ${probes.length} pages.`
          : summarize(offenders),
    });
  }

  return findings;
}

/**
 * The slice of the CDP connection this agent uses. Naming the shape
 * keeps void-close mistakes visible to the compiler (a `close().catch`
 * on the real void method once compiled clean and threw at runtime).
 */
interface CdpLike {
  send(method: string, params?: unknown, options?: { sessionId?: string }): Promise<unknown>;
  attachToTarget(targetId: string, options?: unknown): Promise<string>;
  close(): void;
}

/** Name a browser failure's likely cause (the raw refusal text misleads). */
/** True for the "did not return a WebSocket" capacity refusal. */
function isCapacityRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /did not return a WebSocket/i.test(message);
}

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
      "than a missing binding: sessions are short-lived, and one automatic " +
      "retry was already attempted. Waiting a few minutes before trying again " +
      "is the next thing to try."
    );
  }
  return `Browser check failed: ${message}`;
}

export class QAAgent extends Think<Env> {
  /** Last run, for the A2A summary. Not persisted: it is a convenience, not a record. */
  private lastRun: QACheckResult | null = null;
  private lastRunAt = "";

  /**
   * Live-view run buffers (issue #88), in memory only and bounded
   * per run and across runs.
   */
  private liveRuns = new Map<string, { seq: number; events: QALiveEvent[]; startedAt: number }>();

  /* ---------------------------- Think surface ---------------------------- */

  /**
   * Used only when a host dispatches this agent through agentTool();
   * the model is never in the pass/fail path (checks are deterministic).
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

  /** No tools of its own: this agent IS the tool (capabilities via @callable + A2A). */
  override getTools() {
    // EmailAgent as a tool: QAAgent can dispatch email sends via the Think framework.
    // This makes the email capability available for LLM-driven dispatch.
    const env = this.env as Env;

    // Model-driven browser tools, guarded: creating them needs the
    // BROWSER and LOADER bindings, and a throwing getTools() would take
    // down every chat turn - an absent optional binding must simply
    // mean fewer tools, never a failed boot.
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
   * Open a Browser Rendering session, translating a refusal into
   * something actionable. Retries once after a wait on a capacity
   * refusal (see isCapacityRefusal); other errors surface at once.
   */
  private async openBrowserSession(env: Env): Promise<CdpLike> {
    const { connectBrowser } = await import("agents/browser");
    try {
      return (await connectBrowser(env.BROWSER)) as CdpLike;
    } catch (err) {
      // One automatic retry (20s) on a capacity refusal; see
      // isCapacityRefusal. Non-capacity errors fail fast.
      if (isCapacityRefusal(err)) {
        await new Promise((r) => setTimeout(r, 20000));
        try {
          return (await connectBrowser(env.BROWSER)) as CdpLike;
        } catch (retryErr) {
          throw new Error(describeBrowserFailure(retryErr));
        }
      }
      throw new Error(describeBrowserFailure(err));
    }
  }

  /**
   * Navigate to the dashboard, then seed its API key, then reload so
   * init reads it. Order matters: localStorage is origin-scoped, so
   * seeding on about:blank leaves checks asserting against the login
   * page (the PR #74 bug).
   */
  private async navigateAndSeed(cdp: CdpLike, sessionId: string, origin: string, key: string): Promise<void> {
    await cdp.send("Page.navigate", { url: origin }, { sessionId });
    await new Promise((r) => setTimeout(r, 3000));
    await cdp.send("Runtime.evaluate", { expression: `localStorage.setItem(${JSON.stringify(DASHBOARD_API_KEY_STORAGE_KEY)}, ${JSON.stringify(key)})` }, { sessionId });
    await cdp.send("Page.reload", {}, { sessionId });
    await new Promise((r) => setTimeout(r, 4000));
  }

  /**
   * Shared browser-check logic.
   */
  private async runBrowserCheck(
    url: string,
    textContains?: string[],
    apiKey?: string,
    sharedConnection?: CdpLike,
    liveRunId?: string,
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
      // CDP-based browser check. connectBrowser resolves to a
      // CdpConnection directly - use it as-is (a previous version
      // double-wrapped it in the deprecated CdpSession alias).
      const cdp = sharedConnection ?? (await this.openBrowserSession(env));

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      let stopFrames: () => void = () => {};
      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, liveRunId);

        this.emitLive(liveRunId, { kind: "step", label: "Loading page", detail: url });

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
          this.emitLive(liveRunId, { kind: "step", label: "Signed in with the dashboard key" });
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
        this.emitLive(liveRunId, { kind: "screenshot", label: "Page screenshot", image: screenshot });

        const checks =
          textContains?.map((needle) => ({
            name: `text contains "${needle}"`,
            passed: text.includes(needle),
          })) ?? [];
        const ok = checks.every((c) => c.passed);
        return { ok, url, textLength: text.length, screenshot, checks };
      } finally {
        stopFrames();
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
   * Record and broadcast one live-view event (issue #88). No-ops without a
   * run id, and never throws: the live view is an observer, and an observer
   * failure must not fail the check it is watching.
   */
  private emitLive(
    runId: string | undefined,
    ev: { kind: QALiveEvent["kind"]; label: string; detail?: string; ok?: boolean; skipped?: boolean; image?: string },
  ): void {
    if (!runId) return;
    try {
      if (ev.kind === "frame") {
        // Broadcast only, never buffered or sequenced: at ~100 KB a
        // frame, buffering would evict the run's steps from the replay
        // buffer, and a seq would break the panel's dedupe. A late
        // watcher simply gets the next frame within a second.
        this.broadcast(
          JSON.stringify({
            type: "qa-live",
            runId,
            event: { ...ev, ts: new Date().toISOString() },
          }),
        );
        return;
      }
      let run = this.liveRuns.get(runId);
      if (!run) {
        run = { seq: 0, events: [], startedAt: Date.now() };
        this.liveRuns.set(runId, run);
        // Keep only the newest few runs; the panel watches one at a time.
        while (this.liveRuns.size > 4) {
          const oldest = this.liveRuns.keys().next().value;
          if (oldest === undefined || oldest === runId) break;
          this.liveRuns.delete(oldest);
        }
      }
      const event: QALiveEvent = { ...ev, seq: ++run.seq, ts: new Date().toISOString() };
      run.events.push(event);
      if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
      this.broadcast(JSON.stringify({ type: "qa-live", runId, event }));
    } catch {
      // Deliberately swallowed: see the doc comment above.
    }
  }

  /** Live frame stream (issue #88): ~1fps capture polling; returns the stop fn. */
  private startFrameStream(
    cdp: CdpLike,
    sessionId: string,
    runId?: string,
  ): () => void {
    if (!runId) return () => {};
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const shot = (await cdp.send(
          "Page.captureScreenshot",
          { format: "png" },
          { sessionId },
        )) as { data?: string } | null;
        if (!stopped && shot?.data) {
          this.emitLive(runId, {
            kind: "frame",
            label: "Live frame",
            image: `data:image/png;base64,${shot.data}`,
          });
        }
      } catch {
        // Silent by design: see the doc comment above.
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, 1000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** RPC: a run's live events after `sinceSeq` (the panel's poll backstop). */
  @callable()
  async qaLiveSnapshot(
    runId: string,
    sinceSeq = 0,
  ): Promise<{ known: boolean; events: QALiveEvent[]; latestSeq: number }> {
    const run = this.liveRuns.get(runId);
    if (!run) return { known: false, events: [], latestSeq: sinceSeq };
    return {
      known: true,
      events: run.events.filter((e) => e.seq > sinceSeq),
      latestSeq: run.seq,
    };
  }

  /**
   * RPC: run a QA check against a URL.
   */
  @callable()
  async qaCheck(
    url: string,
    checks?: { textContains?: string[]; apiKey?: string; runId?: string },
  ): Promise<QACheckResult> {
    const runId = checks?.runId;
    this.emitLive(runId, { kind: "step", label: "Running QA check", detail: url });
    const result = await this.runBrowserCheck(url, checks?.textContains, checks?.apiKey, undefined, runId);
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    this.emitLive(runId, {
      kind: "result",
      label: result.ok ? "QA check passed" : "QA check failed",
      ok: result.ok,
      detail: result.error ?? `${result.textLength} chars extracted`,
    });
    return result;
  }

  /** RPC: check the dashboard itself. */
  @callable()
  async qaDashboard(apiKey?: string, runId?: string): Promise<QACheckResult> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    this.emitLive(runId, { kind: "step", label: "Checking this dashboard" });
    // Check for authenticated dashboard content (not just login page)
    const result = await this.runBrowserCheck(
      origin,
      ["PaymentAgent", "Dashboard", "Payments", "Emails"],
      apiKey,
      undefined,
      runId,
    );
    this.lastRun = result;
    this.lastRunAt = new Date().toISOString();
    this.emitLive(runId, {
      kind: "result",
      label: result.ok ? "Dashboard check passed" : "Dashboard check failed",
      ok: result.ok,
      detail: result.error ?? `${result.textLength} chars extracted`,
    });
    return result;
  }

  /**
   * RPC: click through the dashboard tabs and verify each renders real
   * data. Known tabs are checked against their containers (see
   * src/tab-coverage.ts); tabs discovered in the DOM are verified
   * generically. One session for the whole run.
   */
  @callable()
  async qaDashboardTabs(
    apiKey: string,
    sharedConnection?: CdpLike,
    captureScreenshots?: boolean,
    runId?: string,
  ): Promise<{ ok: boolean; tabs: { name: string; passed: boolean; detail: string; screenshot?: string }[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, tabs: [], error: "Browser binding not configured" };
    }
    if (!apiKey) {
      return { ok: false, tabs: [], error: "API key required for tab testing" };
    }

    const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";

    let tabsToTest = knownTabExpectations();

    // Live view (issue #88): when a dashboard run is watching, capture the
    // per-tab screenshots the panel displays even when the caller did not
    // ask for them for a report.
    const wantShots = captureScreenshots === true || !!runId;
    this.emitLive(runId, { kind: "step", label: "Verifying tab data" });

    // Only opens a session when one was not supplied. This is what keeps a QA
    // report to a single session instead of two.
    const ownsConnection = !sharedConnection;
    const results: { name: string; passed: boolean; detail: string; screenshot?: string }[] = [];
    // Every verdict also goes to the live panel when a run is watching, so
    // the watcher sees each tab's result as it lands rather than at the end.
    const pushResult = (r: { name: string; passed: boolean; detail: string; screenshot?: string }) => {
      results.push(r);
      this.emitLive(runId, {
        kind: "result",
        label: `${r.name}: ${r.passed ? "PASS" : "FAIL"}`,
        ok: r.passed,
        detail: r.detail,
      });
    };
    let browser: CdpLike | null = sharedConnection ?? null;
    let stopFrames: () => void = () => {};

    try {
      const cdp: CdpLike = browser ?? (await this.openBrowserSession(env));
      browser = cdp;

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, runId);

        this.emitLive(runId, { kind: "step", label: "Loading dashboard" });

        await this.navigateAndSeed(cdp, sessionId, origin, apiKey);

        // Fail loudly on the login page: otherwise the per-tab checks
        // report "container missing" and bury the actual cause.
        const authState = (await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({ loginShown: !!document.getElementById('login') && getComputedStyle(document.getElementById('login')).display !== 'none', appShown: !!document.getElementById('app') && getComputedStyle(document.getElementById('app')).display !== 'none' })`, returnByValue: true }, { sessionId })) as { result?: { value?: string } };

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
            pushResult({ name: tab.name, passed: false, detail });
          }
          return { ok: false, tabs: results, error: detail };
        }

        // DOM tab discovery (issue #102): every tab the dashboard
        // renders joins the run - known tabs with their expectations,
        // the rest verified generically - so new tabs gain coverage
        // without a code change here.
        const disc = (await cdp.send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll("[data-tab]")).map((el) => el.getAttribute("data-tab"))`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: string[] } } | null;
        const discovered = Array.isArray(disc?.result?.value) ? disc.result.value : [];
        tabsToTest = mergeDiscoveredTabs(tabsToTest, discovered);
        if (tabsToTest.length > 4) {
          this.emitLive(runId, { kind: "step", label: `Discovered ${tabsToTest.length} tabs in the DOM`, detail: tabsToTest.map((t) => t.name).join(", ") });
        }

        this.emitLive(runId, { kind: "step", label: "Signed in — starting tab checks" });

        for (const tab of tabsToTest) {
          try {
            this.emitLive(runId, { kind: "step", label: `Checking ${tab.name} tab` });
            // Click the tab. Assert the click landed: a renamed or removed tab
            // must not be reported as a data failure.
            const clicked = (await cdp.send("Runtime.evaluate", { expression: `(() => { const el = document.querySelector('[data-tab=${JSON.stringify(tab.tab)}]'); if (!el) return false; el.click(); return el.classList.contains('active'); })()`, returnByValue: true }, { sessionId })) as { result?: { value?: boolean } };

            if (clicked.result?.value !== true) {
              pushResult({
                name: tab.name,
                passed: false,
                detail: `Tab '[data-tab="${tab.tab}"]' is missing or did not become active.`,
              });
              continue;
            }

            if (tab.generic) {
              const gp = (await cdp.send("Runtime.evaluate", { expression: genericTabProbeExpression(tab.tab), awaitPromise: true, returnByValue: true }, { sessionId })) as { result?: { value?: any } };
              const verdict = genericTabVerdict(tab, gp.result?.value);
              pushResult({ name: tab.name, passed: verdict.passed, detail: verdict.detail });
            } else {
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
                      rows: el.querySelectorAll(${JSON.stringify(tab.rowSelector ?? ".card, .item")}).length,
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
              pushResult({
                name: tab.name,
                passed: false,
                detail: `Container '#${tab.containerId}' was not in the DOM.`,
              });
            } else if (state.isEmpty) {
              pushResult({
                name: tab.name,
                passed: false,
                detail: `Rendered its empty state ("${tab.emptyText}"); no data to verify.`,
              });
            } else if ((state.rows ?? 0) === 0) {
              pushResult({
                name: tab.name,
                passed: false,
                detail: state.stillLoading
                  ? `Still loading after 10s; container '#${tab.containerId}' stayed empty.`
                  : `Container '#${tab.containerId}' rendered no rows.`,
              });
            } else {
              pushResult({
                name: tab.name,
                passed: true,
                detail: `Rendered ${state.rows} row(s) from '#${tab.containerId}'.`,
              });
            }
            }

            // Optional: keep a picture of the tab as it rendered, for the
            // emailed report. Best-effort — a failed capture never fails the
            // check itself.
            if (wantShots) {
              try {
                const { data } = (await cdp.send(
                  "Page.captureScreenshot",
                  { format: "png" },
                  { sessionId },
                )) as { data?: string };
                const last = results[results.length - 1];
                if (data && last) {
                  last.screenshot = data;
                  this.emitLive(runId, {
                    kind: "screenshot",
                    label: `${tab.name} tab`,
                    image: `data:image/png;base64,${data}`,
                  });
                }
              } catch {
                // Screenshot is evidence, not the assertion; ignore failures.
              }
            }
          } catch (err) {
            pushResult({
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
      stopFrames();
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
   * RPC: deterministic UX audit (issue #91): one session through the
   * dashboard (navigate, seed, reload, click the views), running the
   * UX probe at each and scoring the same rules as the generalized
   * audit.
   */
  @callable()
  async qaUxAudit(
    apiKey: string,
    runId?: string,
    sharedConnection?: CdpLike,
  ): Promise<{ ok: boolean; checks: { name: string; passed: boolean; detail: string }[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, checks: [], error: "Browser binding not configured" };
    }
    if (!apiKey) {
      return { ok: false, checks: [], error: "API key required for UX audit" };
    }
    const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";
    this.emitLive(runId, { kind: "step", label: "Running UX audit" });

    const views: { name: string; tab: string | null; containerId: string; emptyText: string }[] = [
      { name: "Dashboard home", tab: null, containerId: "", emptyText: "" },
      { name: "Emails", tab: "emails", containerId: "emailList", emptyText: "No emails yet" },
      { name: "Payments", tab: "payments", containerId: "paymentList", emptyText: "No payments yet" },
      { name: "Webhooks", tab: "webhooks", containerId: "webhookList", emptyText: "No webhook events yet" },
    ];

    const ownsConnection = !sharedConnection;
    let browser: CdpLike | null = sharedConnection ?? null;
    let stopFrames: () => void = () => {};
    const probes: { view: string; data: any }[] = [];
    const landings: { view: string; kind: string }[] = [];

    try {
      const cdp: CdpLike = browser ?? (await this.openBrowserSession(env));
      browser = cdp;

      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };

      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, runId);

        this.emitLive(runId, { kind: "step", label: "Loading dashboard" });
        await this.navigateAndSeed(cdp, sessionId, origin, apiKey);

        // Same loud failure as the tab check: auditing the login page would
        // produce confident, meaningless findings.
        const authState = (await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({ loginShown: !!document.getElementById('login') && getComputedStyle(document.getElementById('login')).display !== 'none', appShown: !!document.getElementById('app') && getComputedStyle(document.getElementById('app')).display !== 'none' })`, returnByValue: true }, { sessionId })) as { result?: { value?: string } };

        let loginShown = false;
        try {
          const parsed = JSON.parse(authState.result?.value || "{}") as { loginShown?: boolean };
          loginShown = parsed.loginShown === true;
        } catch {
          // Unparseable probe: fall through and let the views report.
        }

        if (loginShown) {
          const detail =
            "Dashboard showed the login page, so no view could be audited. " +
            "The API key was not accepted (check DASHBOARD_API_KEY).";
          return { ok: false, checks: [{ name: "Sign-in", passed: false, detail }], error: detail };
        }

        for (const view of views) {
          this.emitLive(runId, { kind: "step", label: `Auditing ${view.name}` });
          try {
            if (view.tab) {
              const clicked = (await cdp.send(
                "Runtime.evaluate",
                {
                  expression: `(() => {
                    const el = document.querySelector('[data-tab=${JSON.stringify(view.tab)}]');
                    if (!el) return false;
                    el.click();
                    return el.classList.contains('active');
                  })()`,
                  returnByValue: true,
                },
                { sessionId },
              )) as { result?: { value?: boolean } };

              if (clicked.result?.value !== true) {
                landings.push({ view: view.name, kind: "tab missing" });
                continue;
              }

              const settle = (await cdp.send(
                "Runtime.evaluate",
                {
                  expression: `(async () => {
                    const id = ${JSON.stringify(view.containerId)};
                    const emptyText = ${JSON.stringify(view.emptyText)};
                    const read = () => {
                      const el = document.getElementById(id);
                      if (!el) return { found: false };
                      const text = (el.innerText || '').trim();
                      return {
                        found: true,
                        rows: el.querySelectorAll('.card, .item').length,
                        isEmpty: text.includes(emptyText),
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

              const st = settle.result?.value as
                | { found?: boolean; rows?: number; isEmpty?: boolean }
                | undefined;
              const kind =
                !st || st.found !== true
                  ? "container missing"
                  : st.isEmpty
                    ? "empty state"
                    : (st.rows ?? 0) > 0
                      ? "rows"
                      : "unrecognized";
              landings.push({ view: view.name, kind });
            }

            const ux = (await cdp.send(
              "Runtime.evaluate",
              { expression: uxProbeExpression(), returnByValue: true },
              { sessionId },
            )) as { result?: { value?: any } };
            if (ux.result?.value) probes.push({ view: view.name, data: ux.result.value });

            // A picture of the view for the live panel, best-effort.
            try {
              const { data } = (await cdp.send(
                "Page.captureScreenshot",
                { format: "png" },
                { sessionId },
              )) as { data?: string };
              if (data) {
                this.emitLive(runId, {
                  kind: "screenshot",
                  label: `${view.name} view`,
                  image: `data:image/png;base64,${data}`,
                });
              }
            } catch {
              // Evidence for the panel, never the audit itself.
            }
          } catch (err) {
            // One view's probe failing must not abort the audit: record the
            // landing as unmeasurable and let the aggregation report it.
            if (view.tab) landings.push({ view: view.name, kind: "probe failed" });
            console.warn(
              `[QAAgent] UX audit probe failed for ${view.name}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        checks: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      stopFrames();
      if (ownsConnection) closeConnectionQuietly(browser);
    }

    const findings: { name: string; passed: boolean; detail: string }[] = [];
    const addFinding = (name: string, passed: boolean, detail: string) => {
      findings.push({ name, passed, detail });
      this.emitLive(runId, { kind: "result", label: name, ok: passed, detail });
    };
    const summarize = (items: string[]): string =>
      items.slice(0, 3).join("; ") + (items.length > 3 ? `; +${items.length - 3} more` : "");

    if (probes.length === 0) {
      addFinding("UX probe", false, "The probe returned no measurements for any view.");
      return { ok: false, checks: findings, error: "UX probe returned no data" };
    }

    // Contrast (WCAG AA), from computed styles.
    const contrastBad = probes.flatMap((p) =>
      (p.data.contrastBad ?? []).map((b: any) => `${p.view}: ${b.el} at ${b.ratio}:1 (needs ${b.need}:1)`),
    );
    const textChecked = probes.reduce((n, p) => n + (p.data.textChecked ?? 0), 0);
    addFinding(
      "Contrast (WCAG AA)",
      contrastBad.length === 0,
      contrastBad.length === 0
        ? `${textChecked} text elements across ${probes.length} views meet AA ratios.`
        : summarize(contrastBad),
    );

    // Interactive target size.
    const targetBad = probes.flatMap((p) =>
      (p.data.targetBad ?? []).map((b: any) => `${p.view}: ${b.el} is ${b.w}x${b.h}px`),
    );
    const targetChecked = probes.reduce((n, p) => n + (p.data.targetChecked ?? 0), 0);
    addFinding(
      "Target size",
      targetBad.length === 0,
      targetBad.length === 0
        ? `${targetChecked} interactive elements across ${probes.length} views are at least ${UX_RULES.minTargetPx}px in both dimensions.`
        : summarize(targetBad),
    );

    // Heading hierarchy per view.
    const headingIssues: string[] = [];
    for (const p of probes) {
      const levels: number[] = p.data.headings ?? [];
      const h1s = levels.filter((l) => l === 1).length;
      if (h1s !== 1) headingIssues.push(`${p.view}: ${h1s} visible h1 elements (expected exactly 1)`);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) {
          headingIssues.push(`${p.view}: heading level skips h${levels[i - 1]} to h${levels[i]}`);
        }
      }
    }
    addFinding(
      "Heading hierarchy",
      headingIssues.length === 0,
      headingIssues.length === 0
        ? `Exactly one h1 and no skipped levels across ${probes.length} views.`
        : summarize(headingIssues),
    );

    // Primary-button consistency across views: the same action should look
    // the same everywhere it appears.
    const sigOf = (p: any): string | null =>
      p.data.btnStyle
        ? `${p.data.btnStyle.bg}|${p.data.btnStyle.color}|${p.data.btnStyle.fontSize}`
        : null;
    const sigs = probes
      .map((p) => ({ view: p.view, sig: sigOf(p) }))
      .filter((x) => x.sig !== null);
    const distinctSigs = new Set(sigs.map((x) => x.sig));
    addFinding(
      "Style consistency",
      sigs.length > 0 && distinctSigs.size === 1,
      sigs.length === 0
        ? "No primary button was visible in any view to compare."
        : distinctSigs.size === 1
          ? `Primary button style is identical across ${sigs.length} views.`
          : `Primary button style differs across views (${sigs.map((x) => x.view).join(", ")}).`,
    );

    // Layout integrity: horizontal overflow + overlapping interactive elements.
    const layoutIssues: string[] = [
      ...probes
        .filter((p) => (p.data.overflowPx ?? 0) > 0)
        .map((p) => `${p.view}: horizontal overflow of ${p.data.overflowPx}px`),
      ...probes.flatMap((p) => (p.data.overlaps ?? []).map((o: string) => `${p.view}: ${o}`)),
    ];
    addFinding(
      "Layout integrity",
      layoutIssues.length === 0,
      layoutIssues.length === 0
        ? "No horizontal overflow and no overlapping interactive elements in any view."
        : summarize(layoutIssues),
    );

    // Image alt text.
    const imgBad = probes.flatMap((p) =>
      (p.data.imgBad ?? []).map((src: string) => `${p.view}: img ${src} has no alt attribute`),
    );
    addFinding(
      "Image alt text",
      imgBad.length === 0,
      imgBad.length === 0
        ? "Every rendered image carries an alt attribute."
        : summarize(imgBad),
    );

    // Tab landing pattern: every data tab must land on content or its
    // recognized empty state — the same two outcomes, uniformly.
    const badLandings = landings.filter((l) => l.kind !== "rows" && l.kind !== "empty state");
    addFinding(
      "Tab state pattern",
      landings.length === 3 && badLandings.length === 0,
      landings.length === 3 && badLandings.length === 0
        ? landings.map((l) => `${l.view}: ${l.kind}`).join(", ") +
            " — every data tab lands on content or its recognized empty state."
        : summarize(landings.map((l) => `${l.view}: ${l.kind}`)),
    );

    return { ok: findings.every((f) => f.passed), checks: findings };
  }

  /** Persistent browser profile (issue #102): see src/browser-profile.ts. */
  private profileRow(): { sessionId: string; createdAt: string } | null {
    return profileRowGet(this.ctx.storage.sql as never);
  }
  private async profileAlive(env: Env, sessionId: string): Promise<boolean> {
    return profileSessionAlive(env.BROWSER, sessionId);
  }
  private async openProfileSession(env: Env): Promise<CdpLike | null> {
    return (await openProfileConnection(env.BROWSER, this.ctx.storage.sql as never)) as CdpLike | null;
  }

  /**
   * RPC: manage the persistent browser profile (issue #102).
   * start creates a session at the maximum keep_alive and seeds the
   * dashboard sign-in into it; status reports liveness; stop deletes
   * the session. Audit/investigate runs opt into it per call.
   */
  @callable()
  async qaBrowserProfile(
    key: string,
    action: string,
    runId?: string,
  ): Promise<{ active: boolean; createdAt?: string; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) return { active: false, error: "Browser binding not configured" };
    const row = this.profileRow();
    if (action === "status") {
      if (!row) return { active: false };
      if (await this.profileAlive(env, row.sessionId)) return { active: true, createdAt: row.createdAt };
      profileRowClear(this.ctx.storage.sql as never);
      return { active: false };
    }
    if (action === "stop") {
      if (row) {
        try {
          const { deleteBrowserSession } = await import("agents/browser");
          await deleteBrowserSession(env.BROWSER, row.sessionId);
        } catch { /* already gone */ }
        profileRowClear(this.ctx.storage.sql as never);
      }
      return { active: false };
    }
    if (action !== "start") return { active: false, error: `Unknown action "${action}" (start | status | stop).` };
    if (row && (await this.profileAlive(env, row.sessionId))) return { active: true, createdAt: row.createdAt };
    let conn: CdpLike | null = null;
    try {
      const { createBrowserSession, connectBrowserSession } = await import("agents/browser");
      const info = await createBrowserSession(env.BROWSER, { keepAliveMs: 600000 });
      const createdAt = new Date().toISOString();
      profileRowSet(this.ctx.storage.sql as never, info.sessionId, createdAt);
      conn = (await connectBrowserSession(env.BROWSER, info.sessionId)) as CdpLike;
      const { targetId } = (await conn.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      try {
        const sessionId = await conn.attachToTarget(targetId);
        const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";
        await conn.send("Page.navigate", { url: origin }, { sessionId });
        await new Promise((r) => setTimeout(r, 3000));
        if (key) {
          await conn.send("Runtime.evaluate", { expression: `localStorage.setItem(${JSON.stringify(DASHBOARD_API_KEY_STORAGE_KEY)}, ${JSON.stringify(key)})` }, { sessionId });
          await conn.send("Page.reload", {}, { sessionId });
          await new Promise((r) => setTimeout(r, 3000));
        }
      } finally {
        await conn.send("Target.closeTarget", { targetId }).catch(() => {});
      }
      this.emitLive(runId, { kind: "result", label: "Browser profile started", ok: true, detail: "Signed-in session kept alive for reuse (10 min idle cap)." });
      return { active: true, createdAt };
    } catch (err) {
      return { active: false, error: describeBrowserFailure(err) };
    } finally {
      closeConnectionQuietly(conn);
    }
  }

  /**
   * A2A endpoint test email: probe every agent's A2A surface over HTTP
   * (card served, 401 without auth, snapshot reply with auth - all
   * read-only; see src/a2a-test.ts) and email the results.
   */
  @callable()
  async qaA2ATestEmail(
    apiKey: string,
    toEmail: string,
    runId?: string,
  ): Promise<{ ok: boolean; emailed: boolean; results: A2ARow[]; error?: string }> {
    const origin = (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com";
    const rows = await runA2AEndpointTests(origin, apiKey);
    const { subject, body, allOk } = composeA2AEmail(rows);
    this.emitLive(runId, {
      kind: "result",
      label: "A2A endpoint tests",
      ok: allOk,
      detail: `${rows.filter((r) => r.ok).length}/${rows.length} surfaces responding`,
    });
    const { emailAgentStub } = await import("./email-tool");
    const emailAgent = emailAgentStub(this.env as Env);
    if (!emailAgent) return { ok: allOk, emailed: false, results: rows, error: "Email agent unavailable" };
    const sendResult = await emailAgent.sendThroughAgent({ to: toEmail, subject, body });
    return {
      ok: allOk,
      emailed: !!sendResult?.ok,
      results: rows,
      error: sendResult?.ok ? undefined : sendResult?.error || "The email agent refused the send.",
    };
  }

  /** Render standalone HTML to a PDF (issue #135): Page.printToPDF on a data: URL. */
  @callable()
  async qaPrintPdf(html: string): Promise<{ ok: boolean; pdfBase64?: string; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) return { ok: false, error: "Browser binding not configured" };
    if (!html || html.length > 500_000) return { ok: false, error: "HTML missing or over the 500 KB print cap." };
    let pdfBrowser: CdpLike | null = null;
    try {
      const cdp = await this.openBrowserSession(env);
      pdfBrowser = cdp;
      const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      try {
        const sessionId = await cdp.attachToTarget(targetId);
        const bytes = new TextEncoder().encode(html);
        let bin = "";
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        await cdp.send("Page.navigate", { url: "data:text/html;base64," + btoa(bin) }, { sessionId });
        await new Promise((r) => setTimeout(r, 1500));
        const printed = (await cdp.send("Page.printToPDF", { printBackground: true }, { sessionId })) as { data?: string };
        if (!printed?.data) return { ok: false, error: "printToPDF returned no data." };
        return { ok: true, pdfBase64: printed.data };
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return { ok: false, error: describeBrowserFailure(err) };
    } finally {
      closeConnectionQuietly(pdfBrowser);
    }
  }

  /** Visual-baseline storage (issue #102): one hash per view label. */
  private baselineSql() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS ux_baselines (view TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at TEXT NOT NULL)");
    return sql;
  }
  private baselineHash(view: string): string | null {
    try {
      const rows = this.baselineSql().exec("SELECT hash FROM ux_baselines WHERE view = ?", view).toArray() as { hash?: string }[];
      return rows[0]?.hash ?? null;
    } catch { return null; }
  }
  private baselineStore(view: string, hash: string): boolean {
    try {
      this.baselineSql().exec("INSERT OR REPLACE INTO ux_baselines (view, hash, updated_at) VALUES (?, ?, ?)", view, hash, new Date().toISOString());
      return true;
    } catch { return false; }
  }

    /**
   * RPC: the generalized UX audit (issue #94, step 1): audits the
   * pages of one origin named by a target spec (public,
   * localStorage-seeded, or header-authed), with optional crawl,
   * per-page steps, viewports, evidence, and baselines (issue #102).
   */
  @callable()
  async qaUxAuditUrl(
    spec: UxAuditSpec,
    runId?: string,
  ): Promise<{ ok: boolean; checks: { name: string; passed: boolean; detail: string }[]; pagesAudited: string[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, checks: [], pagesAudited: [], error: "Browser binding not configured" };
    }
    const entriesIn = pageEntriesOf(spec);
    if (entriesIn.length === 0) {
      return { ok: false, checks: [], pagesAudited: [], error: "spec.pages must list at least one URL" };
    }
    let origin: string;
    try {
      origin = new URL(entriesIn[0].url).origin;
    } catch {
      return { ok: false, checks: [], pagesAudited: [], error: `Invalid URL: ${entriesIn[0].url}` };
    }
    for (const e of entriesIn) {
      let o: string;
      try {
        o = new URL(e.url).origin;
      } catch {
        return { ok: false, checks: [], pagesAudited: [], error: `Invalid URL: ${e.url}` };
      }
      if (o !== origin) {
        return {
          ok: false,
          checks: [],
          pagesAudited: [],
          error: `All pages must share one origin (${origin}); ${e.url} does not`,
        };
      }
    }
    // A runaway page list would burn the day's browser minutes; cap it.
    // Crawl (step 2) widens the queue from the seeds' links, never past
    // the same cap.
    const crawlOn = !!spec.crawl;
    const maxPages = Math.min(Math.max(Math.floor(spec.crawl?.maxPages ?? 8), 1), 8);
    const maxDepth = Math.min(Math.max(Math.floor(spec.crawl?.maxDepth ?? 1), 0), 2);
    const queue: { url: string; steps: UxAuditStep[]; depth: number }[] = entriesIn
      .slice(0, 8)
      .map((e) => ({ url: e.url, steps: e.steps, depth: 0 }));
    const seen = new Set(queue.map((q) => crawlUrlKey(q.url, origin) ?? q.url));
    let attempted = 0;
    const rules = {
      contrastNormal: spec.rules?.contrastNormal ?? UX_RULES.contrastNormal,
      contrastLarge: spec.rules?.contrastLarge ?? UX_RULES.contrastLarge,
      minTargetPx: spec.rules?.minTargetPx ?? UX_RULES.minTargetPx,
      ignoreSelectors: spec.rules?.ignoreSelectors ?? [],
      expectedButtonBg: spec.rules?.expectedButtonBg,
    };
    this.emitLive(runId, { kind: "step", label: `Running UX audit of ${origin}` });

    let browser: CdpLike | null = null;
    const probes: { view: string; data: any }[] = [];
    const evidencePages: PageEvidence[] = [];
    const evidenceOn = spec.evidence !== false;
    const viewports = viewportListOf(spec);
    const baselineMode = spec.baselines === "record" || spec.baselines === "compare" ? spec.baselines : null;
    const baselineResults: BaselineResult[] = [];
    const failures: string[] = [];
    try {
      let cdp = spec.profile ? await this.openProfileSession(env) : null;
      if (spec.profile && cdp) this.emitLive(runId, { kind: "step", label: "Using the persistent browser profile" });
      if (!cdp) cdp = await this.openBrowserSession(env);
      browser = cdp;
      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      let stopFrames: () => void = () => {};
      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, runId);

        if (spec.auth?.mode === "headers" && spec.auth.headers) {
          await cdp.send("Network.enable", {}, { sessionId }).catch(() => {});
          await cdp
            .send("Network.setExtraHTTPHeaders", { headers: spec.auth.headers }, { sessionId })
            .catch(() => {});
        }

        if (evidenceOn) {
          // Install the evidence collector before any navigation.
          await cdp.send("Page.enable", {}, { sessionId }).catch(() => {});
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: evidenceCollectorScript() }, { sessionId }).catch(() => {});
        }

        let seeded = false;
        while (queue.length > 0 && attempted < maxPages) {
          const entry = queue.shift()!;
          const pageUrl = entry.url;
          attempted++;
          let label = (() => {
            try {
              const u = new URL(pageUrl);
              return u.pathname === "/" ? u.origin : u.origin + u.pathname;
            } catch {
              return pageUrl;
            }
          })();
          const baseLabel = label;
          let shotData: string | undefined;
          this.emitLive(runId, { kind: "step", label: `Auditing ${label}` });
          for (const vp of viewports) {
            if (vp.width && vp.height) {
              await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 600 }, { sessionId }).catch(() => {});
            } else {
              await cdp.send("Emulation.clearDeviceMetricsOverride", {}, { sessionId }).catch(() => {});
            }
            label = vp.width ? `${baseLabel} @ ${vp.name}` : baseLabel;
            shotData = undefined;
          try {
            await cdp.send("Page.navigate", { url: pageUrl }, { sessionId });
            if (!seeded && spec.auth?.mode === "localStorage" && spec.auth.localStorage) {
              await new Promise((r) => setTimeout(r, 1500));
              await cdp.send("Runtime.evaluate", { expression: `(() => { const items = ${JSON.stringify(spec.auth.localStorage)}; for (const k of Object.keys(items)) localStorage.setItem(k, items[k]); })()` }, { sessionId });
              seeded = true;
              await cdp.send("Page.navigate", { url: pageUrl }, { sessionId });
            }

            // Settle: the caller's selector, else readyState complete.
            const settleTimeout = Math.min(Math.max(spec.settleTimeoutMs ?? 10000, 1000), 30000);
            const deadline = Date.now() + settleTimeout;
            for (;;) {
              const settleExpr = spec.settleSelector
                ? `!!document.querySelector(${JSON.stringify(spec.settleSelector)})`
                : `document.readyState === "complete"`;
              const st = (await cdp.send("Runtime.evaluate", { expression: settleExpr, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: boolean } } | null;
              if (st?.result?.value === true) break;
              if (Date.now() > deadline) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            await new Promise((r) => setTimeout(r, 500));

            // Interaction steps (step 2): click through the states the
            // caller asked about, then measure the resulting view. A
            // selector that matches nothing is a visible failure line,
            // never a silent skip.
            for (const step of entry.steps) {
              const clickExpr = `(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`;
              const cr = (await cdp.send("Runtime.evaluate", { expression: clickExpr, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: boolean } } | null;
              if (cr?.result?.value !== true) {
                failures.push(`${label}: step click "${step.click}" matched nothing`);
                continue;
              }
              this.emitLive(runId, { kind: "step", label: `Clicked ${step.click} on ${label}` });
              await new Promise((r) => setTimeout(r, 700));
            }

            // Crawl (step 2): harvest this page's same-origin links for
            // the queue, breadth-first, within the depth and page caps.
            if (crawlOn && vp === viewports[0] && entry.depth < maxDepth) {
              const lr = (await cdp.send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll("a[href]")).map((x) => x.href)`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: string[] } } | null;
              let added = 0;
              for (const h of lr?.result?.value ?? []) {
                const key = crawlUrlKey(h, origin);
                if (!key || seen.has(key) || seen.size >= maxPages) continue;
                seen.add(key);
                queue.push({ url: key, steps: [], depth: entry.depth + 1 });
                added++;
              }
              if (added > 0) {
                this.emitLive(runId, { kind: "step", label: `Crawl: +${added} page(s) from ${label}` });
              }
            }

            const ux = (await cdp.send("Runtime.evaluate", { expression: uxProbeExpression(rules), returnByValue: true }, { sessionId })) as { result?: { value?: any } };
            if (!ux.result?.value) {
              failures.push(`${label}: probe returned no data`);
              continue;
            }
            probes.push({ view: label, data: ux.result.value });

            if (evidenceOn) {
              const evRaw = (await cdp.send("Runtime.evaluate", { expression: `JSON.stringify(window.__qaEvidence || null)`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: string } } | null;
              try {
                evidencePages.push(parsePageEvidence(label, JSON.parse(evRaw?.result?.value || "null")));
              } catch {
                evidencePages.push(parsePageEvidence(label, null));
              }
            }

            try {
              const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" }, { sessionId })) as { data?: string };
              if (data) {
                shotData = data;
                this.emitLive(runId, { kind: "screenshot", label: `${label} view`, image: `data:image/png;base64,${data}` });
              }
            } catch {
              // Evidence for the panel, never the audit itself.
            }

            if (baselineMode && shotData) {
              try {
                const hash = await sha256Hex(shotData);
                const status = baselineMode === "record"
                  ? (this.baselineStore(label, hash) ? "recorded" : "unavailable")
                  : ((stored) => stored === null ? "new" : stored === hash ? "match" : "changed")(this.baselineHash(label));
                baselineResults.push({ view: label, status });
              } catch {
                baselineResults.push({ view: label, status: "unavailable" });
              }
            }
          } catch (err) {
            failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
          }
          }
        }
      } finally {
        stopFrames();
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        checks: [],
        pagesAudited: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      closeConnectionQuietly(browser);
    }

    if (probes.length === 0) {
      return {
        ok: false,
        checks: [],
        pagesAudited: [],
        error: `No page could be measured. ${failures.join("; ")}`,
      };
    }

    const findings: { name: string; passed: boolean; detail: string }[] = [];
    const addFinding = (name: string, passed: boolean, detail: string) => {
      findings.push({ name, passed, detail });
      this.emitLive(runId, { kind: "result", label: name, ok: passed, detail });
    };
    addFinding(
      "Coverage",
      failures.length === 0,
      failures.length === 0
        ? `${probes.length}/${attempted * viewports.length} page-measurements (${attempted} page(s)${viewports.length > 1 ? `, ${viewports.length} viewports` : ""}).`
        : `${probes.length}/${attempted * viewports.length} page-measurements; failed: ${failures.join("; ")}`,
    );
    if (crawlOn) {
      addFinding(
        "Crawl coverage",
        true,
        `${queue.length === 0 ? "Queue exhausted" : "Queue cut by cap"}: ${seen.size} unique page(s) known (${attempted} attempted, depth <= ${maxDepth}, cap ${maxPages}).`,
      );
    }
    for (const f of summarizeUxProbes(probes, rules)) {
      addFinding(f.name, f.passed, f.detail);
    }
    if (evidenceOn) {
      for (const f of summarizeEvidence(evidencePages)) addFinding(f.name, f.passed, f.detail);
    }
    if (baselineMode) {
      const f = summarizeBaselines(baselineResults, baselineMode);
      addFinding(f.name, f.passed, f.detail);
    }
    return {
      ok: findings.every((f) => f.passed),
      checks: findings,
      pagesAudited: probes.map((p) => p.view),
    };
  }


  /**
   * RPC: model-driven browser investigation (issue #102): the model
   * drives a real browser through hand-rolled CDP tools and reports
   * what it found. Credential-free - it never receives any auth.
   */
  @callable()
  async qaInvestigate(
    question: string,
    url: string,
    runId?: string,
    useProfile?: boolean,
  ): Promise<{
    ok: boolean;
    answer?: string;
    steps: { tool: string; detail: string }[];
    url: string;
    model: string;
    error?: string;
  }> {
    const input = clampInvestigateInput(question, url);
    if ("error" in input) {
      return { ok: false, steps: [], url: typeof url === "string" ? url : "", model: "", error: input.error };
    }
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, steps: [], url: input.url, model: "", error: "Browser binding not configured" };
    }
    const modelId = defaultModelId();
    const specs = investigateToolSpecs();
    const steps: { tool: string; detail: string }[] = [];
    this.emitLive(runId, { kind: "step", label: `Investigating: ${input.question}` });

    let browser: CdpLike | null = null;
    try {
      let cdp = useProfile ? await this.openProfileSession(env) : null;
      if (useProfile && cdp) this.emitLive(runId, { kind: "step", label: "Using the persistent browser profile" });
      if (!cdp) cdp = await this.openBrowserSession(env);
      browser = cdp;
      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      let stopFrames: () => void = () => {};
      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, runId);

        const pageState = async (): Promise<string> => {
          const r = (await cdp
            .send("Runtime.evaluate", { expression: pageStateExpression(), returnByValue: true }, { sessionId })
            .catch(() => null)) as { result?: { value?: string } } | null;
          return typeof r?.result?.value === "string" ? r.result.value : "(page state unavailable)";
        };

        const runTool = async (name: string, args: any): Promise<string> => {
          switch (name) {
            case "navigate": {
              const target = typeof args?.url === "string" ? args.url : "";
              if (!/^https?:\/\//.test(target)) return "Refused: navigate needs an http(s) URL.";
              await cdp.send("Page.navigate", { url: target }, { sessionId });
              await new Promise((r) => setTimeout(r, 1500));
              return pageState();
            }
            case "click": {
              const sel = typeof args?.selector === "string" ? args.selector : "";
              const expr = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`;
              const cr = (await cdp
                .send("Runtime.evaluate", { expression: expr, returnByValue: true }, { sessionId })
                .catch(() => null)) as { result?: { value?: boolean } } | null;
              if (cr?.result?.value !== true) return `No element matches selector ${JSON.stringify(sel)}.`;
              await new Promise((r) => setTimeout(r, 700));
              return pageState();
            }
            case "type": {
              const sel = typeof args?.selector === "string" ? args.selector : "";
              const text = typeof args?.text === "string" ? args.text : "";
              const expr = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set; if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
              const tr = (await cdp
                .send("Runtime.evaluate", { expression: expr, returnByValue: true }, { sessionId })
                .catch(() => null)) as { result?: { value?: boolean } } | null;
              return tr?.result?.value === true ? `Typed into ${sel}.` : `No element matches selector ${JSON.stringify(sel)}.`;
            }
            case "evaluate": {
              const expr = typeof args?.expression === "string" ? args.expression : "";
              if (!expr) return "evaluate needs an expression.";
              const er = (await cdp
                .send("Runtime.evaluate", { expression: expr, returnByValue: true }, { sessionId })
                .catch((e) => ({ evalError: String(e) }))) as any;
              if (er?.evalError) return "Evaluation failed: " + er.evalError;
              if (er?.exceptionDetails) return "Evaluation threw in the page.";
              const v = er?.result?.value;
              return (typeof v === "string" ? v : JSON.stringify(v ?? null)).slice(0, 3000);
            }
            case "page_state":
              return pageState();
            case "screenshot": {
              const shot = (await cdp
                .send("Page.captureScreenshot", { format: "png" }, { sessionId })
                .catch(() => ({ data: undefined }))) as { data?: string };
              if (shot.data) {
                this.emitLive(runId, {
                  kind: "screenshot",
                  label: "Investigator screenshot",
                  image: `data:image/png;base64,${shot.data}`,
                });
              }
              return shot.data ? "Screenshot captured (shown in the live panel)." : "Screenshot failed.";
            }
            default:
              return `Unknown tool: ${name}`;
          }
        };

        await cdp.send("Page.navigate", { url: input.url }, { sessionId });
        await new Promise((r) => setTimeout(r, 2000));
        const initialState = await pageState();
        steps.push({ tool: "navigate", detail: input.url });

        const messages: any[] = [
          { role: "system", content: INVESTIGATE_SYSTEM },
          {
            role: "user",
            content: `Question: ${input.question}\nThe browser is open on the start page. Its current state:\n${initialState}`,
          },
        ];
        const contextWindow = contextWindowFor(modelId);
        let answer: string | undefined;
        let calls = 0;
        for (let turn = 0; turn < INVESTIGATE_MAX_TURNS && calls < INVESTIGATE_MAX_CALLS && !answer; turn++) {
          let maxTokens = 1024;
          if (contextWindow) {
            const est = Math.ceil((JSON.stringify(messages).length + JSON.stringify(specs).length) / 3.5);
            maxTokens = Math.max(384, Math.min(1024, contextWindow - est - 512));
          }
          const response: any = await env.AI.run(
            modelId as never,
            { messages, tools: specs, max_tokens: maxTokens } as never,
          );
          const completion = readCompletion(response);
          const toolCalls = normaliseToolCalls(completion.toolCalls);
          if (toolCalls.length === 0) {
            answer = completion.text.trim() || undefined;
            break;
          }
          messages.push({ role: "assistant", content: completion.text, tool_calls: toolCalls });
          for (const call of toolCalls) {
            calls++;
            const name = call.function.name;
            let args: any = {};
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {
              args = {};
            }
            if (name === "report") {
              const findings =
                typeof args?.findings === "string" && args.findings.trim()
                  ? args.findings.trim()
                  : completion.text.trim() || "Investigation finished.";
              answer = findings;
              steps.push({ tool: "report", detail: findings.slice(0, 200) });
              messages.push({ role: "tool", content: "Report recorded.", tool_call_id: call.id });
              break;
            }
            const out = await runTool(name, args).catch(
              (e) => "Tool failed: " + (e instanceof Error ? e.message : String(e)),
            );
            steps.push({ tool: name, detail: out.slice(0, 200) });
            this.emitLive(runId, { kind: "step", label: `${name}: ${out.slice(0, 120)}` });
            messages.push({ role: "tool", content: out, tool_call_id: call.id });
          }
        }

        if (!answer) {
          const synth = await budgetSynthesis(env.AI, modelId, messages, contextWindow);
          if (synth) answer = synth.text;
        }
        if (!answer) {
          return {
            ok: false,
            steps,
            url: input.url,
            model: modelId,
            error:
              "The investigation spent its tool budget without reaching a report. The steps taken are in the result; a narrower question usually gets further.",
          };
        }
        this.emitLive(runId, { kind: "result", label: "Investigation complete", ok: true, detail: answer.slice(0, 200) });
        return { ok: true, answer, steps, url: input.url, model: modelId };
      } finally {
        stopFrames();
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        steps,
        url: input.url,
        model: modelId,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      closeConnectionQuietly(browser);
    }
  }

  /**
   * RPC: run dashboard QA checks and email a plain-text report with PNG
   * screenshots attached (dashboard home plus one per tab).
   * Uses EmailAgent as a tool (via DO RPC) to send the report.
   */
  @callable()
  async qaAndEmailReport(
    apiKey: string,
    toEmail: string,
    runId?: string,
    withInvestigation = true,
  ): Promise<{ ok: boolean; emailed: boolean; tabs: any[]; error?: string }> {
    // ONE session for the whole report: opening one session per check
    // is what exhausted the Browser Rendering concurrency limit.
    const env = this.env as Env;
    this.emitLive(runId, { kind: "step", label: "Building QA report with screenshots" });
    let connection: CdpLike | null = null;
    let tabResult: {
      ok: boolean;
      tabs: { name: string; passed: boolean; detail: string; screenshot?: string }[];
      error?: string;
    };

    try {
      if (env.BROWSER && apiKey) {
        connection = await this.openBrowserSession(env);
      }
      tabResult = await this.qaDashboardTabs(apiKey, connection ?? undefined, true, runId);
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

    let investigation: { question: string; answer: string; steps: number } | undefined;
    if (withInvestigation && !tabResult.ok) {
      investigation = await this.investigateFailure(
        "The dashboard tab checks in the QA report failed.",
        tabResult.tabs.filter((t: any) => !t.passed).map((t: any) => `${t.name} - ${t.detail}`),
        env.SELF_ORIGIN ?? "https://pay.openaimp.com",
        runId,
      );
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
      ...(investigation ? [``, `Automated investigation (model-driven, QAAgent):`, investigation.answer] : []),
      ``,
      `Screenshots of the dashboard and of each tab are attached.`,
      ``,
      `Dashboard: https://pay.openaimp.com`,
      ``,
      `Generated by QAAgent autonomous QA`,
    ].join("\n");

    try {
      // Through the shared helper: getAgentByName is async, and the
      // un-awaited stub is why this report once never arrived.
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
      // Dashboard screenshot for the attachment, on the SAME session.
      const dashResult = await this.runBrowserCheck(
        env.SELF_ORIGIN ?? "https://pay.openaimp.com",
        ["PaymentAgent", "Dashboard", "Payments", "Emails"],
        apiKey,
        connection ?? undefined,
        runId,
      );
      const attachments: { filename: string; type: string; content: string }[] = [];
      const dateStr = new Date().toISOString().slice(0, 10);
      if (dashResult.screenshot) {
        // screenshot is data:image/png;base64,... — strip prefix for attachment
        const base64 = dashResult.screenshot.split(',')[1] || dashResult.screenshot;
        attachments.push({
          filename: `qa-dashboard-${dateStr}.png`,
          type: 'image/png',
          content: base64,
        });
      }
      // One screenshot per tab, captured by qaDashboardTabs during the
      // click-through above (raw base64 from CDP, no prefix to strip).
      // DOM discovery can find more tabs than the email agent's
      // 5-attachment cap allows: attach in order and note the rest.
      for (const tab of tabResult.tabs) {
        if (tab.screenshot) {
          attachments.push({
            filename: `qa-${tab.name.toLowerCase()}-${dateStr}.png`,
            type: 'image/png',
            content: tab.screenshot,
          });
        }
      }
      let omittedShots = 0;
      if (attachments.length > 5) {
        omittedShots = attachments.length - 5;
        attachments.length = 5;
      }
      const finalBody = omittedShots > 0
        ? body + `\n\nNote: ${omittedShots} further tab screenshot(s) were captured but not attached (the email agent caps attachments at 5).`
        : body;
      this.emitLive(runId, { kind: "step", label: "Emailing the report", detail: toEmail });
      const sendResult = await emailAgent.sendThroughAgent({
        to: toEmail,
        subject: `QA Report: Dashboard ${tabResult.ok ? "PASS" : "FAIL"} - ${new Date().toISOString().slice(0, 10)}`,
        body: finalBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      // sendThroughAgent RETURNS a refusal rather than throwing, so ignoring the
      // result reported emailed:true for a rate-limited or rejected send - the
      // dashboard showed success for a report that never left.
      if (!sendResult?.ok) {
        this.emitLive(runId, {
          kind: "result",
          label: "Report not sent",
          ok: false,
          detail: sendResult?.error || "The email agent refused the send.",
        });
        return {
          ok: tabResult.ok,
          emailed: false,
          tabs: tabResult.tabs,
          error: sendResult?.error || "The email agent refused the send.",
        };
      }
      this.emitLive(runId, { kind: "result", label: "Report emailed", ok: true, detail: toEmail });
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
   * RPC: email five screenshots of the Autopilot Trading Desk (a
   * separate email from the QA report, which is unchanged): overview,
   * chat, autopilot runs, portfolio/chain rail, trade approvals.
   */
  @callable()
  async qaDeskSnapshotEmail(
    apiKey: string,
    toEmail: string,
    runId?: string,
  ): Promise<{ ok: boolean; emailed: boolean; shots: string[]; error?: string }> {
    const env = this.env as Env;
    if (!env.BROWSER) {
      return { ok: false, emailed: false, shots: [], error: "Browser binding not configured" };
    }
    if (!apiKey) {
      return { ok: false, emailed: false, shots: [], error: "API key required" };
    }
    if (!toEmail || !/^[^@]+@[^@]+$/.test(toEmail)) {
      return { ok: false, emailed: false, shots: [], error: "Valid toEmail required" };
    }
    const origin = env.SELF_ORIGIN ?? "https://pay.openaimp.com";
    this.emitLive(runId, { kind: "step", label: "Capturing Autopilot Trading Desk snapshots" });

    const shotSpecs: { name: string; anchor: string; fallbackAnchor?: string; label: string }[] = [
      { name: "overview", anchor: "publicDesk", label: "Desk overview - watchlist and status" },
      { name: "chat", anchor: "publicChatCard", label: "Trading chat and Ask composer" },
      { name: "runs", anchor: "deskRuns", label: "Autopilot runs" },
      { name: "portfolio", anchor: "deskPortfolio", label: "Portfolio and option chain rail" },
      { name: "approvals", anchor: "publicTradesCard", fallbackAnchor: "publicTradingTitle", label: "Trade approvals and trading status" },
    ];

    let browser: CdpLike | null = null;
    const attachments: { filename: string; type: string; content: string }[] = [];
    const shotNames: string[] = [];
    let deskSummary = "";
    try {
      const cdp = await this.openBrowserSession(env);
      browser = cdp;
      const { targetId } = (await cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      let stopFrames: () => void = () => {};
      try {
        const sessionId = await cdp.attachToTarget(targetId);
        stopFrames = this.startFrameStream(cdp, sessionId, runId);
        await cdp
          .send(
            "Emulation.setDeviceMetricsOverride",
            { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
            { sessionId },
          )
          .catch(() => {});

        await this.navigateAndSeed(cdp, sessionId, origin, apiKey);

        const loginCheck = (await cdp.send("Runtime.evaluate", { expression: `!!document.getElementById('login') && getComputedStyle(document.getElementById('login')).display !== 'none'`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: boolean } } | null;
        if (loginCheck?.result?.value === true) {
          return {
            ok: false,
            emailed: false,
            shots: [],
            error: "Dashboard showed the login page; the API key was not accepted.",
          };
        }

        // Open the Public tab and give the desk time to load its panels.
        await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(() => { const el = document.querySelector('[data-tab="public"]'); if (el) el.click(); return !!el; })()`,
            returnByValue: true,
          },
          { sessionId },
        );
        // Poll until the desk is visible and the watchlist has rendered
        // (or the wait budget ends - a disconnected desk still snapshots).
        const deadline = Date.now() + 15000;
        for (;;) {
          const ready = (await cdp.send("Runtime.evaluate", { expression: `(() => { const d = document.getElementById('publicDesk'); if (!d || getComputedStyle(d).display === 'none') return false; const w = document.getElementById('deskWatch'); return !!w && !/Loading/.test(w.innerText || ''); })()`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: boolean } } | null;
          if (ready?.result?.value === true) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }

        const summary = (await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({
                connected: !!document.getElementById('publicDesk') && getComputedStyle(document.getElementById('publicDesk')).display !== 'none',
                watch: (document.getElementById('deskWatch') ? document.getElementById('deskWatch').innerText : '').replace(/\\s+/g, ' ').slice(0, 280),
                portfolio: (document.getElementById('deskPortfolio') ? document.getElementById('deskPortfolio').innerText : '').replace(/\\s+/g, ' ').slice(0, 280),
                runs: (document.getElementById('deskRuns') ? document.getElementById('deskRuns').innerText : '').replace(/\\s+/g, ' ').slice(0, 280)
              })`, returnByValue: true }, { sessionId }).catch(() => null)) as { result?: { value?: string } } | null;
        deskSummary = summary?.result?.value ?? "";

        const dateStr = new Date().toISOString().slice(0, 10);
        for (const spec of shotSpecs) {
          const scrollExpr = `(() => {
            let el = document.getElementById(${JSON.stringify(spec.anchor)});
            if ((!el || el.offsetParent === null) && ${JSON.stringify(spec.fallbackAnchor ?? "")}) {
              el = document.getElementById(${JSON.stringify(spec.fallbackAnchor ?? "")});
            }
            if (el) { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -70); return true; }
            return false;
          })()`;
          await cdp
            .send("Runtime.evaluate", { expression: scrollExpr, returnByValue: true }, { sessionId })
            .catch(() => null);
          await new Promise((r) => setTimeout(r, 700));
          try {
            const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" }, { sessionId })) as { data?: string };
            if (data) {
              attachments.push({
                filename: `desk-${spec.name}-${dateStr}.png`,
                type: "image/png",
                content: data,
              });
              shotNames.push(spec.name);
              this.emitLive(runId, {
                kind: "screenshot",
                label: `Desk: ${spec.label}`,
                image: `data:image/png;base64,${data}`,
              });
            }
          } catch {
            // A missed view is noted in the manifest, never fatal.
          }
        }
      } finally {
        stopFrames();
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    } catch (err) {
      return {
        ok: false,
        emailed: false,
        shots: shotNames,
        error: describeBrowserFailure(err),
      };
    } finally {
      closeConnectionQuietly(browser);
    }

    if (attachments.length === 0) {
      return { ok: false, emailed: false, shots: [], error: "No desk screenshots could be captured." };
    }

    let desk: { connected?: boolean; watch?: string; portfolio?: string; runs?: string } = {};
    try {
      desk = JSON.parse(deskSummary || "{}");
    } catch {
      desk = {};
    }
    const manifest = shotSpecs
      .filter((s) => shotNames.includes(s.name))
      .map((s) => `- desk-${s.name}: ${s.label}`)
      .join("\n");
    const body = [
      `Autopilot Trading Desk Snapshot - ${new Date().toISOString()}`,
      ``,
      `Public.com connection: ${desk.connected ? "connected" : "NOT connected (desk panels hidden)"}`,
      ``,
      `Watchlist: ${desk.watch || "n/a"}`,
      ``,
      `Portfolio: ${desk.portfolio || "n/a"}`,
      ``,
      `Autopilot runs: ${desk.runs || "n/a"}`,
      ``,
      `Attached screenshots (${attachments.length}):`,
      manifest,
      ``,
      `Dashboard: ${origin}`,
      ``,
      `Generated by QAAgent`,
    ].join("\n");

    try {
      const { emailAgentStub } = await import("./email-tool");
      const emailAgent = emailAgentStub(this.env as Env);
      if (!emailAgent) {
        return { ok: false, emailed: false, shots: shotNames, error: "The email agent is unavailable." };
      }
      this.emitLive(runId, { kind: "step", label: "Emailing desk snapshots", detail: toEmail });
      const sendResult = await emailAgent.sendThroughAgent({
        to: toEmail,
        subject: `Autopilot Trading Desk Snapshot - ${new Date().toISOString().slice(0, 10)}`,
        body,
        attachments,
      });
      if (!sendResult?.ok) {
        return {
          ok: false,
          emailed: false,
          shots: shotNames,
          error: sendResult?.error || "The email agent refused the send.",
        };
      }
      this.emitLive(runId, { kind: "result", label: "Desk snapshot emailed", ok: true, detail: toEmail });
      return { ok: true, emailed: true, shots: shotNames };
    } catch (err) {
      return {
        ok: false,
        emailed: false,
        shots: shotNames,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

    /**
   * Failure follow-up (issue #102): hand a suite/report failure to
   * the agentic investigator (inside the browser profile when one is
   * active, so it sees the signed-in app). Best-effort.
   */
  private async investigateFailure(
    what: string,
    failures: string[],
    url: string,
    runId?: string,
  ): Promise<{ question: string; answer: string; steps: number } | undefined> {
    const question = `${what} Failing checks: ${failures.slice(0, 4).join("; ")}. Investigate, find the likely cause, and report what is broken and what evidence supports it.`;
    this.emitLive(runId, { kind: "step", label: "Investigating the failure", detail: failures.slice(0, 4).join("; ") });
    try {
      const inv = await this.qaInvestigate(question, url, runId, true);
      return inv.answer ? { question, answer: inv.answer, steps: inv.steps.length } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * RPC: run the full dashboard QA suite in order and return an
   * aggregate result - the "one button" equivalent of clicking every
   * QA button in turn. The two email-sending checks are skipped
   * unless a recipient is supplied.
   */
  @callable()
  async qaFullSuite(
    apiKey: string,
    toEmail?: string,
    runId?: string,
  ): Promise<{
    ok: boolean;
    checks: { name: string; passed: boolean; detail: string; skipped?: boolean }[];
    emailed: boolean;
    investigation?: { question: string; answer: string; steps: number };
    error?: string;
  }> {
    const checks: { name: string; passed: boolean; detail: string; skipped?: boolean }[] = [];
    const record = (
      name: string,
      r: { ok: boolean; detail?: string; error?: string },
    ) => {
      checks.push({ name, passed: r.ok, detail: r.error || r.detail || "" });
      this.emitLive(runId, {
        kind: "result",
        label: name,
        ok: r.ok,
        detail: r.error || r.detail || "",
      });
    };
    this.emitLive(runId, { kind: "step", label: "Running the full QA suite" });

    try {
      // 1. Dashboard smoke test.
      const dash = await this.qaDashboard(apiKey, runId);
      record("Check This Dashboard", {
        ok: dash.ok,
        detail: `${dash.textLength} chars extracted`,
        error: dash.error,
      });

      // 2. Tab click-through with data verification. The tab check narrates
      // itself to the live panel; the suite adds only the aggregate failure
      // line for the case where no tab ran at all.
      const tabs = await this.qaDashboardTabs(apiKey, undefined, undefined, runId);
      for (const t of tabs.tabs) {
        checks.push({ name: `Tab: ${t.name}`, passed: t.passed, detail: t.detail });
      }
      if (tabs.error && tabs.tabs.length === 0) {
        checks.push({ name: "Verify Tab Data", passed: false, detail: tabs.error });
        this.emitLive(runId, { kind: "result", label: "Verify Tab Data", ok: false, detail: tabs.error });
      }

      // 3. Payment guards (no browser session needed; HTTP-level checks).
      // Expand the sub-checks: a bare summary line hides which guard failed.
      const pay = await this.qaPaymentFlow();
      if (pay.checks.length > 0) {
        for (const c of pay.checks) {
          checks.push({ name: `Payment: ${c.name}`, passed: c.passed, detail: c.detail });
          this.emitLive(runId, { kind: "result", label: `Payment: ${c.name}`, ok: c.passed, detail: c.detail });
        }
      } else {
        record("Check Payment Guards", {
          ok: pay.ok,
          detail: pay.detail,
          error: pay.error,
        });
      }

      // 4. Edge cases (auth and error handling). Sub-checks expanded too.
      const edge = await this.qaEdgeCases();
      if (edge.checks.length > 0) {
        for (const c of edge.checks) {
          checks.push({ name: `Edge: ${c.name}`, passed: c.passed, detail: c.detail });
          this.emitLive(runId, { kind: "result", label: `Edge: ${c.name}`, ok: c.passed, detail: c.detail });
        }
      } else {
        record("Check Edge Cases", {
          ok: edge.ok,
          detail: edge.detail,
          error: (edge as { error?: string }).error,
        });
      }

      // 5 & 6. Real-email checks: skipped without an explicit recipient.
      let emailed = false;
      if (toEmail) {
        const att = await this.testEmailAttachmentUI(apiKey, toEmail, runId);
        record("Test Attachment via UI", {
          ok: att.ok,
          detail: att.detail,
          error: att.error,
        });
        const rep = await this.qaAndEmailReport(apiKey, toEmail, runId, false);
        emailed = rep.emailed;
        record("Email QA Report", {
          ok: rep.emailed,
          detail: rep.emailed ? "Report emailed with screenshots" : "Report not sent",
          error: rep.error,
        });
      } else {
        checks.push({
          name: "Test Attachment via UI",
          passed: true,
          skipped: true,
          detail: "Skipped: no recipient address provided (sends a real email).",
        });
        this.emitLive(runId, {
          kind: "result",
          label: "Test Attachment via UI",
          ok: true,
          skipped: true,
          detail: "Skipped: no recipient address provided (sends a real email).",
        });
        checks.push({
          name: "Email QA Report",
          passed: true,
          skipped: true,
          detail: "Skipped: no recipient address provided (sends a real email).",
        });
        this.emitLive(runId, {
          kind: "result",
          label: "Email QA Report",
          ok: true,
          skipped: true,
          detail: "Skipped: no recipient address provided (sends a real email).",
        });
      }

      const suiteOk = checks.filter((c) => !c.skipped).every((c) => c.passed);
      this.emitLive(runId, {
        kind: "result",
        label: suiteOk ? "Full suite passed" : "Full suite failed",
        ok: suiteOk,
      });
      let investigation: { question: string; answer: string; steps: number } | undefined;
      if (!suiteOk) {
        investigation = await this.investigateFailure(
          "The post-deploy QA full suite failed on the production dashboard.",
          checks.filter((c) => !c.skipped && !c.passed).map((c) => `${c.name} - ${c.detail}`),
          (this.env as Env).SELF_ORIGIN ?? "https://pay.openaimp.com",
          runId,
        );
      }
      return { ok: suiteOk, checks, emailed, investigation };
    } catch (err) {
      return {
        ok: false,
        checks,
        emailed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }



    /**
   * RPC: drive the dashboard's Send Email form end to end, with an
   * attachment - proof the UI path (not just the agent call) delivers
   * attachments intact.
   */
  @callable()
  async testEmailAttachmentUI(
    apiKey: string,
    toEmail: string,
    runId?: string,
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
    this.emitLive(runId, { kind: "step", label: "Driving the Send Email form", detail: toEmail });
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

        await this.navigateAndSeed(cdp, sessionId, origin, apiKey);

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
          this.emitLive(runId, {
            kind: "result",
            label: "Send Email form not usable",
            ok: false,
            detail: String(formReady.result?.value),
          });
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

        this.emitLive(runId, { kind: "step", label: "Form loaded" });

        const filledValue = filled.result?.value || "";
        if (!filledValue.startsWith("filled:1")) {
          this.emitLive(runId, {
            kind: "result",
            label: "Could not attach a file to the form",
            ok: false,
            detail: filledValue,
          });
          return { ok: false, detail: `Could not attach a file to the form (${filledValue})` };
        }
        this.emitLive(runId, { kind: "step", label: "Form filled; qa-probe.txt attached" });

        // Submit through the page's own handler, so this exercises the real path.
        await cdp.send(
          "Runtime.evaluate",
          { expression: `document.querySelector('button[onclick="sendEmail()"]').click()` },
          { sessionId },
        );
        this.emitLive(runId, { kind: "step", label: "Submitted; waiting for the send to confirm" });

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

        // One picture of the form as it settled, for the live panel.
        try {
          const { data } = (await cdp.send(
            "Page.captureScreenshot",
            { format: "png" },
            { sessionId },
          )) as { data?: string };
          if (data) {
            this.emitLive(runId, {
              kind: "screenshot",
              label: "Send Email form",
              image: `data:image/png;base64,${data}`,
            });
          }
        } catch {
          // Best-effort evidence for the panel; never fails the check.
        }

        const state = outcome.result?.value || {};
        if (state.state === "sent") {
          this.emitLive(runId, {
            kind: "result",
            label: "Attachment test passed",
            ok: true,
            detail: String(state.text).slice(0, 200),
          });
          return {
            ok: true,
            detail: `Form submitted with 1 attachment; UI confirmed: ${String(state.text).slice(0, 200)}`,
          };
        }
        this.emitLive(runId, {
          kind: "result",
          label: "Attachment test failed",
          ok: false,
          detail: `Send did not confirm (${state.state})`,
        });
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
   * RPC: verify the payment endpoint's guards, without ever paying
   * (no signing, no funds): no signature -> 402 + a well-formed
   * challenge (v2 base64 header, v1 body - both read); an invalid
   * signature still refuses; nothing is processed.
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

      // x402 v2: the challenge rides base64 in the PAYMENT-REQUIRED
      // header (the body is just an error stub); v1 used the body.
      // Read the header first, fall back to the body. (Reading only
      // the body false-failed this check
      // against a well-formed v2 challenge.)
      let challenge: any = null;
      let challengeSource = "body";
      const challengeHeader =
        challengeRes.headers.get("payment-required") ??
        challengeRes.headers.get("x-payment-required");
      if (challengeHeader) {
        try {
          challenge = JSON.parse(atob(challengeHeader));
          challengeSource = "PAYMENT-REQUIRED header";
        } catch {
          challenge = null;
        }
      }
      if (!challenge) challenge = challengeBody;

      const accepts = challenge?.accepts;
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
          ? `${accepts.length} option(s) via ${challengeSource}, networks: ${accepts
              .map((a: any) => a.network)
              .join(", ")}`
          : `malformed or absent accepts (checked ${challengeSource}): ${JSON.stringify(challenge).slice(0, 200)}`,
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
   * RPC: negative and edge-case checks against the dashboard API:
   * bad input must be refused with the right status AND a structured
   * JSON body, not an HTML error page (the happy-path-only suite
   * would never see a 401 quietly becoming a 200).
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
   * Aggregate view for the A2A executor. Deliberately thin: reports
   * only whether the last check passed and when - screenshots are
   * megabytes of base64 nobody asked a status call for.
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
   * Route one A2A message. Note the exposure, stated on the card:
   * `qa.check` makes the Worker browse to a caller-chosen URL (an
   * SSRF shape) - it is bearer-gated and bounded to http(s), but a
   * credential holder can make the Worker browse to an internal name.
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

      case "qa.ux_audit": {
        // Issue #94 step 3: the generalized audit as a service
        // operation; caller credentials ride in spec.auth and are
        // never stored or logged here.
        const spec = (args.spec ?? null) as UxAuditSpec | null;
        const specPages = Array.isArray(spec?.pages) ? spec.pages : [];
        if (!spec || specPages.length === 0) {
          return {
            text: "qa.ux_audit needs a spec with at least one page URL.",
            data: { ok: false, error: "bad_spec" },
          };
        }
        const pageUrlOf = (p: unknown): string =>
          typeof p === "string" ? p : ((p as { url?: unknown })?.url as string) ?? "";
        if (!specPages.every((p) => /^https?:\/\//.test(pageUrlOf(p)))) {
          // Same http(s)-only bound as qa.check, for the same reason.
          return {
            text: "qa.ux_audit pages must be http(s) URLs.",
            data: { ok: false, error: "bad_url" },
          };
        }
        const result = await this.qaUxAuditUrl(spec);
        if (result.error) {
          return { text: "UX audit could not run: " + result.error, data: result };
        }
        const failedNames = result.checks.filter((c) => !c.passed).map((c) => c.name);
        return {
          text: result.ok
            ? `UX audit passed on ${result.pagesAudited.length} page(s): all checks green.`
            : `UX audit on ${result.pagesAudited.length} page(s) found failing checks: ${failedNames.join(", ")}.`,
          data: result,
        };
      }

      case "qa.investigate": {
        // Issue #102: the agentic layer. A caller (host model, A2A peer,
        // or the API route) hands the agent a question and a start URL;
        // the agent's own model drives the browser and reports findings.
        const inv = clampInvestigateInput(args.question, args.url);
        if ("error" in inv) {
          return {
            text: "qa.investigate needs a question and a starting http(s) URL. " + inv.error,
            data: { ok: false, error: "bad_args" },
          };
        }
        const result = await this.qaInvestigate(inv.question, inv.url, undefined, args.profile === true);
        if (!result.ok) {
          return {
            text: "Investigation could not complete: " + (result.error ?? "unknown error"),
            data: result,
          };
        }
        return {
          text: `Investigation of ${inv.url} (${result.steps.length} steps): ${result.answer}`,
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

      case "qa.browser_profile": {
        // Issue #102: manage the persistent browser profile. The
        // dashboard key comes from the Worker's own env here - this
        // dispatch already ran behind the A2A bearer gate.
        const env2 = this.env as Env;
        const act = typeof args.action === "string" ? args.action : "status";
        const result = await this.qaBrowserProfile(env2.DASHBOARD_API_KEY ?? "", act);
        return {
          text: result.error
            ? "Browser profile: " + result.error
            : result.active
              ? `Browser profile is active (started ${result.createdAt ?? "earlier"}).`
              : "Browser profile is not active.",
          data: result,
        };
      }

      default:
        return {
          text: `Unknown operation: ${op}`,
          data: {
            ok: false,
            error: "unknown_operation",
            supported: ["qa.summary", "qa.check", "qa.dashboard", "qa.ux_audit", "qa.investigate", "qa.browser_profile"],
          },
        };
    }
  }
}
