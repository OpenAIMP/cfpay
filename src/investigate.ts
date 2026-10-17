/**
 * The agentic investigation's pure pieces (issue #102): the tool set the
 * model drives the browser with, its system prompt, the page-state
 * probe, and input clamping. SDK-free so unit tests can import them;
 * the CDP execution lives in src/qa-agent.ts (qaInvestigate), using the
 * same hand-rolled connectBrowser pattern as the deterministic checks -
 * NOT createBrowserTools(), which needs the LOADER binding that the
 * Free plan cannot deploy (error 10195).
 */

/** Bounds: an investigation is a browser session, and browser minutes
 *  are the scarcest resource on the Free plan. */
export const INVESTIGATE_MAX_TURNS = 8;
export const INVESTIGATE_MAX_CALLS = 12;

export const INVESTIGATE_SYSTEM = [
  "You are a QA investigator operating a real browser through tools.",
  "Investigate the user's question about the page: open, click, type, and inspect until you can answer from what you actually observed.",
  "Rules:",
  "- Ground every claim in tool output. Never report a pass, a text, or a state you did not observe.",
  "- Prefer page_state to see where you are; its elements list gives selectors you can click or type into.",
  "- Work within the tool budget: be decisive, do not re-open the same page or repeat a click that already worked.",
  "- When you can answer, call report with your findings: what you did, what you observed, and the answer to the question, citing the evidence (page text, element labels, URLs).",
  "- If something cannot be done (element missing, page failed), say so in the report instead of guessing.",
].join("\n");

/** The browser tools offered to the model, in Workers AI tool-spec shape. */
export function investigateToolSpecs() {
  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  });
  return [
    fn("navigate", "Navigate the browser to an http(s) URL. Returns the new page state.", {
      url: { type: "string", description: "Absolute http(s) URL." },
    }, ["url"]),
    fn("click", "Click the element matching a CSS selector. Returns the page state after the click.", {
      selector: { type: "string", description: "CSS selector, e.g. one from page_state's elements." },
    }, ["selector"]),
    fn("type", "Type text into an input or textarea matching a CSS selector.", {
      selector: { type: "string", description: "CSS selector of the field." },
      text: { type: "string", description: "Text to enter." },
    }, ["selector", "text"]),
    fn("evaluate", "Run a JavaScript expression in the page and return its value (stringified, capped). Use for targeted DOM questions page_state does not answer.", {
      expression: { type: "string", description: "A JavaScript expression (not a statement block)." },
    }, ["expression"]),
    fn("page_state", "Return the current page state: URL, title, visible text excerpt, and the interactive elements with selectors.", {}, []),
    fn("screenshot", "Capture a screenshot of the current page (shown in the live panel as evidence).", {}, []),
    fn("report", "Finish the investigation with your findings. Call this when you can answer the question.", {
      findings: { type: "string", description: "What you did, what you observed, and the answer, citing evidence." },
    }, ["findings"]),
  ];
}

/**
 * The page-state probe: one evaluate that summarizes the rendered page
 * for the model - where it is, what it says, and what can be acted on.
 * Written without template literals, matching the other in-page probes.
 */
export function pageStateExpression(): string {
  return `(() => {
    const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 1800);
    const els = [];
    const nodes = document.querySelectorAll("a, button, input, select, textarea, [data-tab], [role='button']");
    for (let i = 0; i < nodes.length && els.length < 40; i++) {
      const el = nodes[i];
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += "#" + el.id;
      else if (el.getAttribute("data-tab")) sel += "[data-tab='" + el.getAttribute("data-tab") + "']";
      else if (el.className && typeof el.className === "string") sel += "." + el.className.trim().split(/\\s+/).join(".");
      const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 60);
      els.push({ sel: sel, tag: el.tagName.toLowerCase(), label: label });
    }
    return JSON.stringify({ url: location.href, title: document.title, text: text, elements: els });
  })()`;
}

/** Validate and bound an investigation request before any browser opens. */
export function clampInvestigateInput(
  question: unknown,
  url: unknown,
): { question: string; url: string } | { error: string } {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) return { error: "A question is required." };
  if (q.length > 500) return { error: "Question is too long (500 chars max)." };
  const u = typeof url === "string" ? url.trim() : "";
  if (!/^https?:\/\//.test(u)) return { error: "A starting http(s) URL is required." };
  try {
    new URL(u);
  } catch {
    return { error: `Invalid URL: ${u}` };
  }
  return { question: q, url: u };
}
