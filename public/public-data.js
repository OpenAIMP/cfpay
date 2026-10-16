// Public tab presentation helpers (issue #112): the structured-outcome
// rendering for Public.com answers — the safe markdown subset and the
// autopilot verdict banner.
//
// This lives in its own asset because public/index.html is at the size
// limit of the tooling that ships it; the page loads this file with a
// plain <script src> tag ahead of its main inline script. Everything
// here is a global the inline script calls at runtime.
//
// escapeHtml is defined by the inline script and only CALLED from here
// at runtime (never at load), so the load order is safe.

// Safe markdown subset for Public answers: the model writes tables and
// verdicts that used to arrive as raw pipe text. The input is escaped
// FIRST via escapeHtml; afterwards only the constant tags below are
// emitted, so no raw HTML, link or image from model output can reach
// the page. Links are deliberately not rendered.
function renderMarkdownSafe(text) {
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = escapeHtml(text == null ? '' : String(text)).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      let rows = '';
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows += '<tr>' + cells(lines[i]).map((c) => '<td style="border:1px solid var(--border);padding:0.25rem 0.5rem;">' + c + '</td>').join('') + '</tr>'; i++; }
      out.push('<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:0.8rem;margin:0.4rem 0;"><thead><tr>' + head.map((c) => '<th style="border:1px solid var(--border);padding:0.25rem 0.5rem;text-align:left;">' + c + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push('<div style="font-weight:600;margin:0.55rem 0 0.2rem;">' + inline(h[2]) + '</div>'); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      let items = '';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items += '<li>' + inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>'; i++; }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + ' style="margin:0.3rem 0;padding-left:1.2rem;line-height:1.6;">' + items + '</' + tag + '>');
      continue;
    }
    const v = line.replace(/^\*\*/, '').match(/^Verdict:\s*(.*)$/i);
    if (v) { out.push('<div style="border-left:3px solid var(--blue);background:var(--bg);padding:0.45rem 0.7rem;margin:0.2rem 0 0.5rem;font-weight:600;">Verdict: ' + inline(v[1].replace(/\*\*/g, '')) + '</div>'); i++; continue; }
    out.push('<p style="margin:0.3rem 0;line-height:1.65;">' + inline(line) + '</p>');
    i++;
  }
  return out.join('');
}

// The autopilot run card's verdict banner: green when the verifier
// completed the run, amber when it did not, with the confidence.
function autopilotVerdictBanner(run) {
  if (!run || !run.verification) return '';
  const v = run.verification;
  const pct = Math.round((Number(v.confidence) || 0) * 100);
  return '<div style="margin-top:0.45rem;border-left:3px solid ' + (v.complete ? '#16a34a' : '#b45309') + ';background:var(--bg);padding:0.4rem 0.6rem;font-size:0.8rem;font-weight:600;">'
    + (v.complete ? '\u2713 Verified complete' : '\u26a0 Incomplete') + ' \u2014 confidence ' + pct + '%</div>';
}
