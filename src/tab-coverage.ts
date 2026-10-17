/**
 * Dashboard tab coverage for qaDashboardTabs (issue #102: DOM tab
 * discovery). The four data tabs carry specific expectations; every
 * other tab the dashboard actually renders is discovered from the DOM
 * and verified generically, so a new tab gains coverage the day it
 * ships instead of waiting for a hardcoded list to be updated.
 * SDK-free: unit-tested directly.
 */

export interface TabExpectation {
  name: string;
  tab: string;
  containerId: string;
  emptyText: string;
  rowSelector?: string;
  /** True for DOM-discovered tabs verified by the generic probe. */
  generic?: boolean;
}

/**
 * The tabs with specific data expectations. `containerId` is the
 * element the dashboard writes rows into; `emptyText` is that tab's
 * empty state. Both come from public/index.html.
 */
export function knownTabExpectations(): TabExpectation[] {
  return [
    { name: "Emails", tab: "emails", containerId: "emailList", emptyText: "No emails yet" },
    { name: "Payments", tab: "payments", containerId: "paymentList", emptyText: "No payments yet" },
    { name: "Webhooks", tab: "webhooks", containerId: "webhookList", emptyText: "No webhook events yet" },
    // The Public tab's data surface for this check is the strategy
    // questions library: server-served, rendered as <details> groups
    // (not .card rows), and independent of the Public.com connection -
    // the desk endpoints themselves are covered by the post-deploy
    // suite's desk section. The screenshot is the point: the report
    // gains the trading view as its fifth attachment.
    {
      name: "Public",
      tab: "public",
      containerId: "publicQuestions",
      emptyText: "No questions available",
      rowSelector: "details",
    },
  ];
}

/**
 * Merge the known expectations with the tab keys discovered in the
 * dashboard DOM: known tabs keep their order and expectations; each
 * extra discovered key becomes a generic expectation, in DOM order.
 */
export function mergeDiscoveredTabs(known: TabExpectation[], discovered: string[]): TabExpectation[] {
  const out = [...known];
  const have = new Set(known.map((t) => t.tab));
  for (const raw of discovered) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || have.has(key)) continue;
    have.add(key);
    out.push({
      name: key === "qa" ? "QA" : key.charAt(0).toUpperCase() + key.slice(1),
      tab: key,
      containerId: "",
      emptyText: "",
      generic: true,
    });
  }
  return out;
}

/** The generic probe for a discovered tab: does its panel render content? */
export function genericTabProbeExpression(tabKey: string): string {
  return `(async () => {
    const read = () => {
      const p = document.getElementById(${JSON.stringify(tabKey)});
      if (!p) return { found: false };
      const visible = getComputedStyle(p).display !== 'none';
      return {
        found: true,
        visible,
        textLength: (p.innerText || '').trim().length,
        rows: p.querySelectorAll('.card, .item, details, tr').length,
        controls: p.querySelectorAll('input, select, textarea, button').length,
      };
    };
    for (let i = 0; i < 16; i++) {
      const s = read();
      if (!s.found) return s;
      if (s.visible && (s.textLength > 20 || s.rows > 0 || s.controls > 0)) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return read();
  })()`;
}

/** Verdict for a discovered tab's generic probe. */
export function genericTabVerdict(
  tab: TabExpectation,
  probe: { found?: boolean; visible?: boolean; textLength?: number; rows?: number; controls?: number } | null | undefined,
): { passed: boolean; detail: string } {
  if (!probe || probe.found !== true) {
    return { passed: false, detail: `Panel '#${tab.tab}' was not in the DOM.` };
  }
  if (probe.visible !== true) {
    return { passed: false, detail: `Panel '#${tab.tab}' did not become visible after clicking its tab.` };
  }
  const textLength = probe.textLength ?? 0;
  const rows = probe.rows ?? 0;
  const controls = probe.controls ?? 0;
  if (textLength > 20 || rows > 0 || controls > 0) {
    return {
      passed: true,
      detail: `Discovered in the DOM; panel rendered (${textLength} chars, ${rows} row(s), ${controls} control(s)).`,
    };
  }
  return { passed: false, detail: `Panel '#${tab.tab}' rendered no content.` };
}
