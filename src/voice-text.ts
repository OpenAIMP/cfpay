// Speakable-text shaping for the voice agent (issue #168).
//
// The desk's answers are markdown built for screens - headers, bold,
// links, tables. Spoken aloud they are noise, so the voice agent's
// onTurn returns a plain-prose version: markdown stripped, table
// pipes flattened to commas, and the result capped at a sentence
// boundary (a spoken answer is a summary; the full text stays in
// the Public tab). Pure and SDK-free so vitest can cover it.

const MAX_SPOKEN_CHARS = 700;

export function speakable(text: string, maxChars = MAX_SPOKEN_CHARS): string {
  let t = String(text || "");
  // Drop table separator rows, then flatten remaining pipes to commas
  // (tidied per line so a row reads "NVDA, 218.4", not ", NVDA , ...").
  t = t.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ");
  t = t.replace(/\s*\|\s*/g, ", ");
  t = t.replace(/^,\s*/gm, "").replace(/,\s*$/gm, "");
  // Images and links keep their text, lose their syntax.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Emphasis, headings, blockquotes, code ticks, list bullets.
  t = t.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  t = t.replace(/`{1,3}/g, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  // Lines that do not end a sentence get one, so flattened table rows
  // and list items do not run together when spoken.
  t = t.replace(/([^.!?:])\n+/g, "$1. ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const head = end > 200 ? cut.slice(0, end + 1) : cut.trim();
  return head + " The full answer is in the Public tab.";
}
