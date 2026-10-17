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
