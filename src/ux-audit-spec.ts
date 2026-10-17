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

