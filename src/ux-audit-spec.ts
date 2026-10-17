/**
 * The UX audit's target-spec types and the pure spec/crawl helpers
 * (issue #94). Kept SDK-free so unit tests can import them without
 * dragging in the Agents runtime; src/qa-agent.ts re-exports the
 * types so existing references keep working.
 */
export interface UxRuleProfile {
  contrastNormal?: number;
  contrastLarge?: number;
  minTargetPx?: number;
  ignoreSelectors?: string[];
  expectedButtonBg?: string;
}

/**
 * A target spec for qaUxAuditUrl (issue #94): what to audit, how to get
 * in, when a page counts as settled, and which rules apply. Credentials
 * are referenced by the caller (their own session values), never stored.
 */
/** One interaction applied to a page before it is measured (issue #94 step 2). */
export interface UxAuditStep {
  /** CSS selector of the element to click (a tab, an expander, a toggle). */
  click: string;
}

export interface UxAuditSpec {
  /**
   * Absolute URLs to audit; all must share the first page's origin. An
   * entry may be `{ url, steps }` to interact with that page (click
   * through states) before it is measured.
   */
  pages: Array<string | { url: string; steps?: UxAuditStep[] }>;
  /**
   * Same-origin crawl (step 2): after each audited page, follow its
   * same-origin links breadth-first and audit those pages too. Seeds
   * are depth 0. The total page cap (8) still applies - browser budget.
   */
  crawl?: { maxPages?: number; maxDepth?: number };
  auth?: {
    mode: "none" | "localStorage" | "headers";
    /** Seeded on the origin before the page loop (mode: localStorage). */
    localStorage?: Record<string, string>;
    /** Sent on every request of the session (mode: headers). */
    headers?: Record<string, string>;
  };
  /**
   * Capture console errors, failed requests, and Web Vitals per page
   * (issue #102 evidence pack). Default true; false skips the injected
   * collector and its findings entirely.
   */
  evidence?: boolean;
  /**
   * Measure every page at each of these viewports (issue #102):
   * findings are reported per page per viewport (label suffix
   * "@ name"). At most 3 are honored; sizes clamp to 320..2560.
   * Absent/empty = one default (un-emulated) pass, as before.
   */
  viewports?: { name: string; width: number; height: number }[];
  /**
   * Visual baselines (issue #102): "record" stores each measured
   * view's screenshot hash as its baseline; "compare" fails the
   * Visual baselines finding for any view whose screenshot hash
   * differs from the recorded one. Exact-change detection (a hash),
   * not perceptual diffing - any pixel change counts as changed.
   */
  baselines?: "record" | "compare";
  /**
   * Run inside the persistent browser profile (issue #102) when one
   * is active - the stored Browser Run session's cookies/storage -
   * instead of a fresh throwaway session.
   */
  profile?: boolean;
  /** Audit a page once this selector exists; default: readyState complete. */
  settleSelector?: string;
  settleTimeoutMs?: number;
  rules?: UxRuleProfile;
}

/** A spec page entry, normalized: bare strings get no steps. */
export interface AuditPageEntry {
  url: string;
  steps: UxAuditStep[];
}

/**
 * Normalize a spec's page entries (issue #94 step 2). Bad entries drop
 * out rather than failing the run; steps are capped at 5 per page and
 * click selectors at 200 chars, so a malformed spec stays cheap.
 */
export function pageEntriesOf(spec: UxAuditSpec | null | undefined): AuditPageEntry[] {
  const raw = Array.isArray(spec?.pages) ? spec.pages : [];
  const out: AuditPageEntry[] = [];
  for (const p of raw) {
    if (typeof p === "string") {
      if (p.length > 0) out.push({ url: p, steps: [] });
      continue;
    }
    if (p && typeof p === "object" && typeof p.url === "string" && p.url.length > 0) {
      const steps: UxAuditStep[] = [];
      if (Array.isArray(p.steps)) {
        for (const s of p.steps) {
          if (s && typeof s === "object" && typeof s.click === "string" && s.click.length > 0) {
            steps.push({ click: s.click.slice(0, 200) });
          }
          if (steps.length >= 5) break;
        }
      }
      out.push({ url: p.url, steps });
    }
  }
  return out;
}

/**
 * The crawl identity of a link found on an audited page: its normalized
 * URL when it is an http(s) page on the audit's origin, else null.
 * Fragments are stripped (same page, another anchor is not a new page);
 * query strings are kept (they can be different pages).
 */
export function crawlUrlKey(raw: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.origin !== origin) return null;
  u.hash = "";
  return u.href;
}

/** One page's harvested evidence (issue #102). */
export interface PageEvidence {
  view: string;
  console: { level: string; text: string }[];
  requests: { url: string; status: number }[];
  vitals: { lcp: number; cls: number; fcp: number };
}

/**
 * The evidence collector, injected with
 * Page.addScriptToEvaluateOnNewDocument so it is installed before any
 * page script runs: it wraps console.error/warn, window error events,
 * fetch/XHR (for failed requests), and PerformanceObserver (LCP / CLS /
 * FCP) into window.__qaEvidence. The SDK's CDP client drops protocol
 * events, so subscribing to Runtime.consoleAPICalled or Network events
 * can never deliver this data - in-page collection + evaluate harvest
 * is the working route. Written without template literals.
 */
export function evidenceCollectorScript(): string {
  return `(() => {
    if (window.__qaEvidence) return;
    const ev = { console: [], requests: [], vitals: { lcp: 0, cls: 0, fcp: 0 } };
    window.__qaEvidence = ev;
    const push = (arr, item) => { if (arr.length < 50) arr.push(item); };
    const origError = console.error ? console.error.bind(console) : null;
    console.error = function () {
      push(ev.console, { level: "error", text: Array.from(arguments).map(String).join(" ").slice(0, 200) });
      if (origError) origError.apply(null, arguments);
    };
    const origWarn = console.warn ? console.warn.bind(console) : null;
    console.warn = function () {
      push(ev.console, { level: "warn", text: Array.from(arguments).map(String).join(" ").slice(0, 200) });
      if (origWarn) origWarn.apply(null, arguments);
    };
    window.addEventListener("error", (e) => {
      push(ev.console, { level: "error", text: String((e && e.message) || "window error").slice(0, 200) });
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e ? e.reason : null;
      push(ev.console, { level: "error", text: ("unhandled rejection: " + String((r && r.message) || r)).slice(0, 200) });
    });
    if (window.fetch) {
      const origFetch = window.fetch.bind(window);
      window.fetch = function () {
        const a = arguments;
        const u = a[0] && a[0].url ? a[0].url : String(a[0]);
        return origFetch.apply(null, a).then((res) => {
          if (res && res.status >= 400) push(ev.requests, { url: String(u).slice(0, 160), status: res.status });
          return res;
        }, (err) => {
          push(ev.requests, { url: String(u).slice(0, 160), status: 0 });
          throw err;
        });
      };
    }
    if (window.XMLHttpRequest) {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__qaUrl = u; return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        const self = this;
        this.addEventListener("load", () => { if (self.status >= 400) push(ev.requests, { url: String(self.__qaUrl || "").slice(0, 160), status: self.status }); });
        this.addEventListener("error", () => { push(ev.requests, { url: String(self.__qaUrl || "").slice(0, 160), status: 0 }); });
        return origSend.apply(this, arguments);
      };
    }
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType === "largest-contentful-paint") ev.vitals.lcp = Math.round(e.startTime);
          else if (e.entryType === "layout-shift" && !e.hadRecentInput) ev.vitals.cls = Math.round((ev.vitals.cls + e.value) * 1000) / 1000;
          else if (e.entryType === "paint" && e.name === "first-contentful-paint") ev.vitals.fcp = Math.round(e.startTime);
        }
      });
      po.observe({ type: "largest-contentful-paint", buffered: true });
      po.observe({ type: "layout-shift", buffered: true });
      po.observe({ type: "paint", buffered: true });
    } catch (err) { /* vitals stay zero on engines without the API */ }
  })()`;
}

/** Sanitize one page's harvested evidence JSON into a PageEvidence. */
export function parsePageEvidence(view: string, raw: unknown): PageEvidence {
  const empty: PageEvidence = { view, console: [], requests: [], vitals: { lcp: 0, cls: 0, fcp: 0 } };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as any;
  const cons = Array.isArray(r.console)
    ? r.console
        .filter((c: any) => c && typeof c.text === "string")
        .slice(0, 20)
        .map((c: any) => ({ level: typeof c.level === "string" ? c.level : "error", text: c.text.slice(0, 200) }))
    : [];
  const reqs = Array.isArray(r.requests)
    ? r.requests
        .filter((x: any) => x && typeof x.url === "string")
        .slice(0, 20)
        .map((x: any) => ({ url: x.url.slice(0, 160), status: Number(x.status) || 0 }))
    : [];
  const v = r.vitals && typeof r.vitals === "object" ? r.vitals : {};
  return {
    view,
    console: cons,
    requests: reqs,
    vitals: { lcp: Number(v.lcp) || 0, cls: Number(v.cls) || 0, fcp: Number(v.fcp) || 0 },
  };
}

/**
 * Aggregate per-page evidence into findings: console errors and failed
 * requests gate; Web Vitals are reported (worst page per metric), not
 * gated - headless timings vary too much to fail a run on their own.
 */
export function summarizeEvidence(
  pages: PageEvidence[],
): { name: string; passed: boolean; detail: string }[] {
  if (pages.length === 0) return [];
  const findings: { name: string; passed: boolean; detail: string }[] = [];

  const errors: string[] = [];
  let warnCount = 0;
  for (const p of pages) {
    for (const c of p.console) {
      if (c.level === "error") errors.push(`${p.view}: ${c.text}`);
      else warnCount++;
    }
  }
  findings.push({
    name: "Console errors",
    passed: errors.length === 0,
    detail:
      errors.length === 0
        ? `No console errors on ${pages.length} page(s)${warnCount ? ` (${warnCount} warning(s))` : ""}.`
        : `${errors.length} console error(s): ${errors.slice(0, 4).join(" | ").slice(0, 380)}`,
  });

  const failed: string[] = [];
  for (const p of pages) {
    for (const r of p.requests) {
      failed.push(`${r.url} (${r.status === 0 ? "network error" : "HTTP " + r.status})`);
    }
  }
  findings.push({
    name: "Failed requests",
    passed: failed.length === 0,
    detail:
      failed.length === 0
        ? `No failed requests on ${pages.length} page(s).`
        : `${failed.length} failed request(s): ${failed.slice(0, 4).join(" | ").slice(0, 380)}`,
  });

  const worst = (key: "lcp" | "cls" | "fcp") =>
    pages.reduce((a, p) => (p.vitals[key] > a.vitals[key] ? p : a), pages[0]);
  const wl = worst("lcp");
  const wc = worst("cls");
  const wf = worst("fcp");
  const anyVitals = pages.some((p) => p.vitals.lcp > 0 || p.vitals.fcp > 0 || p.vitals.cls > 0);
  findings.push({
    name: "Web Vitals",
    passed: true,
    detail: anyVitals
      ? `Worst LCP ${(wl.vitals.lcp / 1000).toFixed(2)}s (${wl.view}), worst CLS ${wc.vitals.cls.toFixed(3)} (${wc.view}), worst FCP ${(wf.vitals.fcp / 1000).toFixed(2)}s (${wf.view}). Informational - not gated.`
      : "No vitals captured (pages may not expose the Performance APIs). Informational - not gated.",
  });
  return findings;
}

/** A sanitized audit viewport; width/height absent = no emulation. */
export interface AuditViewport {
  name: string;
  width?: number;
  height?: number;
}

/** The viewports an audit measures at: the spec's list, sanitized. */
export function viewportListOf(spec: UxAuditSpec): AuditViewport[] {
  const raw = Array.isArray(spec.viewports) ? spec.viewports : [];
  const out: AuditViewport[] = [];
  const names = new Set<string>();
  for (const v of raw) {
    if (out.length >= 3) break;
    const width = Math.round(Number((v as any)?.width) || 0);
    const height = Math.round(Number((v as any)?.height) || 0);
    if (width < 320 || width > 2560 || height < 320 || height > 2560) continue;
    const clean = typeof (v as any)?.name === "string" ? (v as any).name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) : "";
    const name = clean || `vp${out.length + 1}`;
    if (names.has(name)) continue;
    names.add(name);
    out.push({ name, width, height });
  }
  return out.length > 0 ? out : [{ name: "default" }];
}

/** SHA-256 (hex) of base64-decoded bytes - the baseline fingerprint. */
export async function sha256Hex(base64: string): Promise<string> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** One view's baseline outcome for an audit run. */
export interface BaselineResult {
  view: string;
  status: "recorded" | "match" | "changed" | "new" | "unavailable";
}

/**
 * Aggregate baseline outcomes into one finding. A changed view fails
 * it; a view with no baseline yet is reported, not failed (record
 * first, then compare).
 */
export function summarizeBaselines(
  results: BaselineResult[],
  mode: "record" | "compare",
): { name: string; passed: boolean; detail: string } {
  const changed = results.filter((r) => r.status === "changed").map((r) => r.view);
  const fresh = results.filter((r) => r.status === "new").map((r) => r.view);
  const matched = results.filter((r) => r.status === "match").length;
  const recorded = results.filter((r) => r.status === "recorded").length;
  if (mode === "record") {
    return {
      name: "Visual baselines",
      passed: results.every((r) => r.status === "recorded"),
      detail: `${recorded}/${results.length} view baseline(s) recorded (screenshot hashes). Future "compare" runs fail on any pixel change.`,
    };
  }
  const parts = [`${matched} view(s) match their baseline`];
  if (fresh.length > 0) parts.push(`${fresh.length} without a baseline (${fresh.slice(0, 3).join(", ")})`);
  if (changed.length > 0) parts.push(`CHANGED: ${changed.slice(0, 4).join(", ")}`);
  return {
    name: "Visual baselines",
    passed: changed.length === 0,
    detail: parts.join("; ") + ".",
  };
}
