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
// Classification chips for a question group's header (tier / outlook /
// premium, added to the library 2026-10-16): shown on the collapsed group
// line itself, so the classification is visible without expanding the
// group. Inline styles + theme variables only — no stylesheet changes.
function questionGroupChips(g) {
  if (!g) return '';
  // Every pill carries a glyph and, where the theme offers one, a color:
  // outlook by direction, premium by cash-flow sign, tier by signal bars
  // that fill (and heat up) with proficiency.
  const outlookMeta = {
    bullish: { glyph: '\u25B2', color: 'var(--green)' },
    bearish: { glyph: '\u25BC', color: 'var(--red)' },
    neutral: { glyph: '\u25C6', color: 'var(--gold)' },
    directional: { glyph: '\u21C5', color: 'var(--accent)' },
  };
  const premiumMeta = {
    selling: { glyph: '+$', color: 'var(--green)' },
    buying: { glyph: '\u2212$', color: 'var(--blue)' },
    mixed: { glyph: '\u00B1$', color: undefined },
  };
  const tierMeta = {
    basic: { glyph: '\u2582', color: undefined },
    intermediate: { glyph: '\u2582\u2584', color: 'var(--blue)' },
    advanced: { glyph: '\u2582\u2584\u2586', color: 'var(--gold)' },
    expert: { glyph: '\u2582\u2584\u2586\u2588', color: 'var(--red)' },
  };
  const chip = (text, color) =>
    '<span style="display:inline-block;margin-left:0.35rem;padding:0.05rem 0.45rem;border:1px solid ' +
    (color || 'var(--border)') + ';border-radius:999px;font-size:0.66rem;color:' + (color || 'var(--muted)') +
    ';vertical-align:middle;white-space:nowrap;">' + escapeHtml(text) + '</span>';
  const pill = (meta, text) =>
    meta ? chip(meta.glyph + ' ' + text, meta.color) : chip(text);
  let out = '';
  if (g.outlook) out += pill(outlookMeta[g.outlook], g.outlook);
  if (g.premium) out += pill(premiumMeta[g.premium], 'premium ' + g.premium);
  if (g.tier) out += pill(tierMeta[g.tier], g.tier);
  return out;
}

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
  return '<div style="margin-top:0.45rem;border-left:3px solid ' + (v.complete ? 'var(--verified)' : 'var(--amber)') + ';background:var(--bg);padding:0.4rem 0.6rem;font-size:0.8rem;font-weight:600;">'
    + (v.complete ? '\u2713 Verified complete' : '\u26a0 Incomplete') + ' \u2014 confidence ' + pct + '%</div>';
}

// ---------------------------------------------------------------------------
// Autopilot Trading Desk (issue #112 part 2): panel renderers. The data
// comes from the desk endpoints (/api/public/quotes, /portfolio, /chain),
// which call the MCP tools directly — so what renders here is the tools'
// own payloads, never model prose. pParse/pTable live here (moved from
// the page's inline script, which calls them as globals) so the desk
// panels and the answer trace share one table extraction.
// ---------------------------------------------------------------------------

const pParse = (r) => { try { return JSON.parse(r); } catch { return undefined; } };

// A result's tabular payload: a top-level array of objects, or the
// largest array of objects within two levels (a chain's contracts).
function pTable(result) {
  const data = pParse(result);
  if (data === undefined || data === null) return null;
  const isRows = (v) => Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object';
  if (Array.isArray(data)) return isRows(data) ? data : null;
  if (typeof data !== 'object') return null;
  let best = null;
  const consider = (v) => { if (isRows(v) && (!best || v.length > best.length)) best = v; };
  for (const o of [data, ...Object.values(data).filter((v) => v && typeof v === 'object' && !Array.isArray(v))]) for (const k of Object.keys(o)) consider(o[k]);
  return best || [data];
}
// One table cell / the column union for row objects, as in pCsv.
function deskCell(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function deskCols(rows) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

// Generic desk table from any tool payload (object or JSON string);
// '' when the payload has no tabular core.
function deskTableHtml(d, clickable, cap) {
  const rows = pTable(typeof d === 'string' ? d : JSON.stringify(d));
  if (!rows) return '';
  const cols = deskCols(rows);
  const limit = cap || 60;
  let body = '';
  rows.slice(0, limit).forEach((r, i) => {
    body += '<tr' + (clickable ? ' class="desk-chain-row" data-i="' + i + '" onclick="deskPickContract(this.dataset.i)"' : '') + '>'
      + cols.map((k) => '<td>' + escapeHtml(deskCell(r[k])) + '</td>').join('') + '</tr>';
  });
  return '<div style="overflow-x:auto;"><table class="desk-table"><thead><tr>' + cols.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    + (rows.length > limit ? '<div style="color:var(--muted);font-size:0.72rem;margin-top:0.3rem;">Showing ' + limit + ' of ' + rows.length + ' rows.</div>' : '');
}

// Pretty-printed fallback for payloads with no table in them.
function deskJsonFallback(d) {
  return '<pre style="white-space:pre-wrap;word-break:break-word;font-size:0.72rem;max-height:16rem;overflow:auto;">' + escapeHtml(JSON.stringify(d, null, 1).slice(0, 4000)) + '</pre>';
}

// --- Watchlist strip -------------------------------------------------------
// Quote objects vary by tool version; read the fields tolerantly and fall
// back to the first numeric field so a chip never renders blank.
function deskQuoteFields(q) {
  if (!q || typeof q !== 'object') return null;
  const keys = Object.keys(q);
  const pick = (names) => { for (const n of names) { for (const k of keys) { if (k.toLowerCase() === n) return q[k]; } } return undefined; };
  const symbol = pick(['symbol', 'ticker']);
  let last = pick(['last', 'lastprice', 'price', 'close', 'lasttradeprice']);
  if (last === undefined) { for (const k of keys) { if (typeof q[k] === 'number') { last = q[k]; break; } } }
  const pct = pick(['changepercent', 'percentchange', 'changepct', 'change_pct', 'daychangepercent']);
  return { symbol: symbol == null ? '' : String(symbol), last: last, pct: pct };
}

function deskRenderQuotes(data) {
  let list = [];
  if (Array.isArray(data)) {
    list = data.map((el) => {
      if (el && typeof el === 'object' && ('quote' in el)) {
        const f = deskQuoteFields(el.quote) || {};
        return { symbol: String(el.symbol || f.symbol || ''), last: f.last, pct: f.pct };
      }
      return deskQuoteFields(el);
    }).filter(Boolean);
  } else if (data && typeof data === 'object') {
    list = Object.keys(data).map((k) => {
      const f = deskQuoteFields(data[k]) || {};
      return { symbol: f.symbol || k, last: f.last, pct: f.pct };
    });
  }
  if (!list.length) return '<span style="color:var(--muted);font-size:0.8rem;">No quotes returned.</span>';
  return list.map((q) => {
    const lastTxt = (typeof q.last === 'number') ? q.last.toFixed(2) : (q.last == null ? '\u2014' : escapeHtml(String(q.last)));
    let pctTxt = '';
    if (typeof q.pct === 'number') {
      const v = Math.abs(q.pct) <= 1.5 ? q.pct * 100 : q.pct;
      pctTxt = '<div style="font-size:0.72rem;color:' + (v >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</div>';
    }
    return '<div class="desk-quote"><div class="sym">' + escapeHtml(q.symbol || '?') + '</div><div class="last">' + lastTxt + '</div>' + pctTxt + '</div>';
  }).join('');
}

// --- Portfolio panel --------------------------------------------------------
function deskRenderPortfolio(data) {
  const rows = pTable(typeof data === 'string' ? data : JSON.stringify(data));
  const table = deskTableHtml(data, false, 60);
  if (!table) return deskJsonFallback(data);
  return '<div style="color:var(--muted);font-size:0.75rem;margin-bottom:0.35rem;">' + (rows ? rows.length : 0) + ' position rows from Public.com</div>' + table;
}

// --- Option chain panel -----------------------------------------------------
let deskChainState = { cols: [], rows: [], symbol: '', expiry: '' };
function deskRenderChain(data, symbol, expiry) {
  const rows = pTable(typeof data === 'string' ? data : JSON.stringify(data));
  if (!rows) { deskChainState = { cols: [], rows: [], symbol: symbol, expiry: expiry }; return deskJsonFallback(data); }
  const cols = deskCols(rows);
  deskChainState = { cols: cols, rows: rows.map((r) => cols.map((k) => deskCell(r[k]))), symbol: symbol, expiry: expiry };
  return '<div style="color:var(--muted);font-size:0.75rem;margin-bottom:0.35rem;">' + escapeHtml(symbol) + ' \u00b7 ' + escapeHtml(expiry || 'nearest expiry (tool default)') + ' \u00b7 ' + rows.length + ' contracts \u2014 click a contract to draft a question about it.</div>'
    + deskTableHtml(data, true, 120);
}

// Draft an Ask question about the clicked contract, from its row cells.
function deskPickContract(i) {
  if (window.deskShowView) deskShowView('trading');
  const st = deskChainState;
  const row = st.rows[Number(i)];
  if (!row) return;
  const colOf = (re) => st.cols.findIndex((c) => re.test(c));
  const strikeI = colOf(/strike/i);
  const typeI = colOf(/type|side/i);
  let type = typeI >= 0 ? row[typeI] : '';
  if (!/call|put/i.test(type)) { const cell = row.find((c) => /^(call|put)$/i.test(c)); type = cell || 'option'; }
  const strike = strikeI >= 0 ? row[strikeI] : '';
  const q = 'For ' + st.symbol + (strike ? ', the ' + strike + ' ' : ' ') + type + (st.expiry ? ' expiring ' + st.expiry : ' at the nearest expiry') + ': give the bid, ask, delta and implied volatility from the chain, the premium per contract, and what strategy this contract best serves.';
  const input = document.getElementById('publicInput');
  if (input) { input.value = q; input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

// --- Autopilot runs ---------------------------------------------------------
function deskRenderRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) return '<span style="color:var(--muted);font-size:0.8rem;">No autopilot runs yet \u2014 ask a question with Autopilot on.</span>';
  return runs.map((r) => {
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
    const v = r.verification;
    const chip = v ? '<span style="font-size:0.7rem;font-weight:600;color:' + (v.complete ? 'var(--green)' : 'var(--amber)') + ';">' + (v.complete ? '\u2713 verified' : '\u26a0 incomplete') + ' ' + Math.round((Number(v.confidence) || 0) * 100) + '%</span>' : '';
    return '<div style="border:1px solid var(--border);border-radius:6px;padding:0.45rem 0.6rem;margin-bottom:0.4rem;">'
      + '<div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:baseline;"><span style="font-size:0.8rem;font-weight:600;">' + escapeHtml(String(r.goal || '').slice(0, 110)) + '</span>' + chip + '</div>'
      + '<div style="color:var(--muted);font-size:0.72rem;margin-top:0.2rem;">' + escapeHtml(r.status || '') + ' \u00b7 ' + (Array.isArray(r.steps) ? r.steps.length : 0) + ' steps \u00b7 ' + escapeHtml(when) + ' <button class="btn" style="padding:0.1rem 0.5rem;font-size:0.72rem;margin-left:0.4rem;" onclick="deskToggleRun(\'' + escapeHtml(r.id) + '\')">Transcript</button></div>'
      + '<div id="deskRun-' + escapeHtml(r.id) + '" style="margin-top:0.35rem;"></div></div>';
  }).join('');
}

function deskRenderSession(messages) {
  if (!Array.isArray(messages) || !messages.length) return '<span style="color:var(--muted);font-size:0.76rem;">No transcript recorded for this run (only runs since the Sessions mirror shipped have one).</span>';
  return messages.map((m) => '<div style="font-size:0.76rem;line-height:1.55;margin-bottom:0.3rem;"><strong>' + escapeHtml(m.role || '') + ':</strong> ' + escapeHtml(String(m.content || '').slice(0, 500)) + '</div>').join('');
}


// ---- Desk loaders (moved from the page: they only call the page's
// global api()/escapeHtml helpers and the renderers above, at runtime) ---
// ---- Autopilot Trading Desk loaders (issue #112 part 2) ----
// Thin fetch wrappers over the desk data endpoints; the rendering
// lives in public-data.js (deskRenderQuotes/Portfolio/Chain/Runs).
const DESK_WATCHLIST = ['NVDA', 'AMD', 'AVGO', 'SMH', 'SPY', 'QQQ'];
function deskErr(el, err) { el.innerHTML = '<span style="color:var(--red);font-size:0.8rem;">' + escapeHtml(err.message || String(err)) + '</span>'; }
async function deskLoadQuotes() {
  const el = document.getElementById('deskWatch');
  try {
    const res = await api('/api/public/quotes?symbols=' + DESK_WATCHLIST.join(','));
    el.innerHTML = deskRenderQuotes(res.data);
    document.getElementById('deskWatchUpdated').textContent = 'as of ' + new Date(res.fetchedAt).toLocaleTimeString();
  } catch (err) { deskErr(el, err); }
}
async function deskLoadPortfolio() {
  const el = document.getElementById('deskPortfolio');
  try { const res = await api('/api/public/portfolio'); el.innerHTML = deskRenderPortfolio(res.data); }
  catch (err) { deskErr(el, err); }
}
async function deskLoadChain() {
  const el = document.getElementById('deskChain');
  const symbol = (document.getElementById('deskChainSymbol').value || 'SMH').trim().toUpperCase();
  const expiry = document.getElementById('deskChainExpiry').value;
  el.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Loading chain\u2026</span>';
  try {
    const res = await api('/api/public/chain?symbol=' + encodeURIComponent(symbol) + (expiry ? '&expiry=' + encodeURIComponent(expiry) : ''));
    const sel = document.getElementById('deskChainExpiry');
    if (Array.isArray(res.expirations) && res.expirations.length) {
      sel.innerHTML = res.expirations.map((d) => '<option value="' + d + '"' + (d === res.expiry ? ' selected' : '') + '>' + d + '</option>').join('');
    }
    el.innerHTML = deskRenderChain(res.data, res.symbol, res.expiry);
  } catch (err) { deskErr(el, err); }
}
async function deskLoadRuns() {
  const el = document.getElementById('deskRuns');
  try { const res = await api('/api/public/autopilot-runs'); el.innerHTML = deskRenderRuns(res.runs); }
  catch (err) { deskErr(el, err); }
}
async function deskToggleRun(id) {
  const box = document.getElementById('deskRun-' + id);
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = '<span style="color:var(--muted);font-size:0.76rem;">Loading transcript\u2026</span>';
  try { const res = await api('/api/public/autopilot-runs/' + encodeURIComponent(id) + '/session'); box.innerHTML = deskRenderSession(res.messages); }
  catch (err) { deskErr(box, err); }
}
function deskRefreshAll() { deskLoadQuotes(); deskLoadPortfolio(); deskLoadRuns(); deskLoadHunts(); }


// --- Answer trace + raw-data downloads (moved from the page; pubData and
// pBtn are vars so the page's sendPublic can still push rendered answers) ---
// Render one tool call so the answer can be checked against what ran.
// Collapsed by default; the summary line is the first line of the result.
// Raw-data downloads (issue #112): the trace carries each call's FULL
// result from Public.com; these helpers turn it into downloadable files.
var pubData = [];
var pBtn = 'background:var(--bg);color:var(--text);border:1px solid var(--border);padding:0.15rem 0.5rem;font-size:0.7rem;';
const pEnv = (t) => { const p = pParse(t.result || ''); return { tool: t.name, args: t.args || {}, ok: t.ok, result: p !== undefined ? p : (t.result || '') }; };
function pCsv(rows) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.map(cell).join(',')];
  for (const r of rows) lines.push(keys.map((k) => cell(r[k])).join(','));
  return lines.join('\n');
}
function pDown(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const pStamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
function downloadPublicCall(idx, callIdx, format) {
  const entry = pubData[idx]; if (!entry) return;
  const t = entry.trace[callIdx]; if (!t) return;
  const base = 'public-' + t.name + '-' + pStamp();
  if (format === 'csv') {
    const rows = pTable(t.result || '');
    if (rows) pDown(base + '.csv', pCsv(rows), 'text/csv');
  } else {
    const p = pParse(t.result || '');
    pDown(base + '.json', JSON.stringify(p !== undefined ? p : pEnv(t), null, 2), 'application/json');
  }
}
function downloadPublicAll(idx) {
  const entry = pubData[idx]; if (!entry) return;
  const payload = { question: entry.question, model: entry.model, finishReason: entry.finishReason, calls: entry.trace.map(pEnv) };
  pDown('public-data-' + pStamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
}

function renderToolTrace(trace, answerIdx = -1) {
  if (!Array.isArray(trace) || trace.length === 0) {
    return '<div class="status-msg error" style="margin-top:0.5rem;">No tools were called. The answer below is not backed by Public.com data.</div>';
  }
  const hasIdx = answerIdx >= 0;
  const dlBtn = (i, f) => '<button class="btn" style="' + pBtn + '" onclick="downloadPublicCall(' + answerIdx + ',' + i + ', \'' + f + '\')">Download ' + f.toUpperCase() + '</button>';
  const dlFor = (t, i) => '<div style="margin-top:0.4rem;display:flex;gap:0.4rem;">' + dlBtn(i, 'json')
    + (pTable(t.result || '') ? dlBtn(i, 'csv') : '') + '</div>';
  const rows = trace.map((t, i) => {
    const dl = hasIdx ? dlFor(t, i) : '';
    const badge = t.proposed
      ? '<span style="background:var(--amber);color:var(--on-accent);border-radius:4px;padding:0.05rem 0.35rem;">proposed</span>'
      : t.refused
        ? '<span class="badge-failed">blocked</span>'
        : (t.ok ? '<span class="badge-confirmed">ok</span>' : '<span class="badge-failed">error</span>');
    const args = escapeHtml(JSON.stringify(t.args || {}));
    const body = escapeHtml(t.result || '');
    const summary = escapeHtml(t.summary || '');
    return '<details style="margin-top:0.4rem;border:1px solid var(--border);border-radius:6px;padding:0.5rem;">'
      + '<summary style="cursor:pointer;font-size:0.78rem;">' + badge + ' <code>' + escapeHtml(t.name)
      + '</code> <span style="color:var(--muted);">' + summary + '</span></summary>'
      + '<div style="margin-top:0.5rem;font-size:0.72rem;color:var(--muted);">'
      + '<div><strong>arguments</strong></div>'
      + '<pre style="white-space:pre-wrap;word-break:break-word;background:var(--bg);border-radius:4px;padding:0.4rem;margin:0.2rem 0 0.5rem;">' + args + '</pre>'
      + '<div><strong>result</strong> <span style="opacity:0.7;">(' + (t.result || '').length + ' chars)</span></div>'
      + '<pre style="white-space:pre-wrap;word-break:break-word;max-height:18rem;overflow:auto;background:var(--bg);border-radius:4px;padding:0.4rem;margin:0.2rem 0 0;">' + body + '</pre>' + dl
      + '</div></details>';
  }).join('');
  const bar = '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">'
    + '<div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);">Tool calls (' + trace.length + ')' + (hasIdx ? ' \u00b7 raw data from Public.com' : '') + '</div>'
    + (hasIdx ? '<button class="btn" style="' + pBtn + '" onclick="downloadPublicAll(' + answerIdx + ')">Download all (JSON)</button>' : '') + '</div>';
  return '<div style="margin-top:0.5rem;">' + bar + rows + '</div>';
}

// The autopilot run card: the persisted Goal -> Planner -> Queue ->
// Executor -> Verifier state, rendered from the run the response carries.

// Desk snapshot email (2026-10-17): five screenshots of the Autopilot
// Trading Desk, as its own email - the QA report email is unchanged.
// Reuses the report's recipient field and the live-run panel.
async function emailDeskSnapshot() {
  const toEl = document.getElementById('qaEmailTo');
  const result = document.getElementById('qaEmailResult');
  const toEmail = toEl ? toEl.value : '';
  if (!toEmail) { if (result) result.innerHTML = '<div class="status-msg error">Enter an email address</div>'; return; }
  if (result) result.innerHTML = '<div class="loading">Capturing desk snapshots and emailing...</div>';
  const runId = qaLiveBegin('Desk Snapshot Email');
  try {
    const res = await api('/api/dashboard/qa/desk-snapshot', 'POST', { toEmail, runId });
    if (res.emailed) { if (result) result.innerHTML = '<div class="status-msg success">Desk snapshot emailed (' + (res.shots || []).length + ' screenshots)!</div>'; }
    else { if (result) result.innerHTML = '<div class="status-msg error">Failed: ' + (res.error || 'Unknown error') + '</div>'; }
    await qaLiveFinish(!!(res && res.emailed));
  } catch (e) { if (result) result.innerHTML = '<div class="status-msg error">Error: ' + e.message + '</div>'; await qaLiveFinish(false); }
}

// Persistent browser profile (issue #102): one signed-in Browser Run
// session reused across runs (10-minute idle cap). The button toggles
// start/stop; the span shows the state after each action.
async function toggleBrowserProfile() {
  const span = document.getElementById('qaProfileState');
  const setText = (t) => { if (span) span.textContent = t; };
  try {
    const st = await api('/api/dashboard/qa/browser-profile', 'POST', { action: 'status' });
    if (st.active) {
      setText('Stopping...');
      const res = await api('/api/dashboard/qa/browser-profile', 'POST', { action: 'stop' });
      setText(res.active ? 'Still active' : 'Profile stopped');
    } else {
      setText('Starting (signs the profile in)...');
      const runId = qaLiveBegin('Browser Profile');
      const res = await api('/api/dashboard/qa/browser-profile', 'POST', { action: 'start', runId });
      setText(res.active ? 'Profile active - audits/investigations can reuse it' : ('Failed: ' + (res.error || 'unknown')));
      await qaLiveFinish(!!res.active);
    }
  } catch (e) { setText('Error: ' + e.message); }
}


// ---------------------------------------------------------------------------
// Public tab views (issue #133): a left nav splits the tab into Trading
// (desk + chat, answers clean), Questions (the library), Tools (model +
// MCP catalogue), Logs (full model/MCP traces + downloads), and Status
// (connection + model). The trading chat no longer inlines the raw
// trace under every answer - it carries a one-line summary and a
// "View in Logs" jump; the trace renderer itself is unchanged and now
// renders inside the Logs view, so downloads work exactly as before.

function deskShowView(name) {
  document.querySelectorAll('.desk-view').forEach((v) => { v.style.display = v.dataset.view === name ? '' : 'none'; });
  document.querySelectorAll('.desk-nav-btn').forEach((b) => { b.classList.toggle('active', b.dataset.view === name); });
  if (name === 'tools') deskSyncToolsView();
  if (name === 'logs') deskRenderLogs();
}

function deskTraceLink(idx) {
  const entry = pubData[idx];
  const trace = (entry && entry.trace) || [];
  if (!trace.length) {
    return '<div class="status-msg error" style="margin-top:0.5rem;">No tools were called. The answer above is not backed by Public.com data.</div>';
  }
  const proposed = trace.filter((t) => t.proposed).length;
  const blocked = trace.filter((t) => t.refused || !t.ok).length;
  return '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.25rem;">'
    + '<span style="font-size:0.75rem;color:var(--muted);">' + trace.length + ' tool call' + (trace.length === 1 ? '' : 's') + ' \u00b7 raw Public.com data in Logs</span>'
    + (proposed ? '<span style="background:var(--amber);color:var(--on-accent);border-radius:4px;padding:0.05rem 0.35rem;font-size:0.72rem;">' + proposed + ' proposed</span>' : '')
    + (blocked ? '<span class="badge-failed">' + blocked + ' blocked/error</span>' : '')
    + '<button class="btn" style="' + pBtn + '" onclick="deskShowLog(' + idx + ')">View in Logs</button></div>';
}

// Called after each exchange lands in pubData: refresh the Logs view
// when it is the one on screen.
function deskLogPush() {
  const v = document.querySelector('.desk-view[data-view="logs"]');
  if (v && v.style.display !== 'none') deskRenderLogs();
}

function deskRenderLogs() {
  const host = document.getElementById('deskLogsList');
  if (!host) return;
  if (!pubData.length) {
    host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">No exchanges yet this session.</span>';
    return;
  }
  host.innerHTML = pubData.map((entry, idx) => ({ entry, idx })).reverse().map(({ entry, idx }) =>
    '<div id="deskLog-' + idx + '" style="border:1px solid var(--border);border-radius:6px;padding:0.6rem;margin-bottom:0.6rem;">'
    + '<div style="font-size:0.85rem;"><strong>Q:</strong> ' + escapeHtml(entry.question || '') + '</div>'
    + '<div style="color:var(--muted);font-size:0.72rem;margin-top:0.2rem;">' + escapeHtml(entry.model || '')
    + (entry.finishReason ? ' \u00b7 finish: ' + escapeHtml(entry.finishReason) : '') + '</div>'
    + renderToolTrace(entry.trace || [], idx)
    + '</div>').join('');
}

function deskShowLog(idx) {
  deskShowView('logs');
  const el = document.getElementById('deskLog-' + idx);
  if (el) {
    el.scrollIntoView({ block: 'start' });
    el.style.outline = '2px solid var(--accent)';
    setTimeout(() => { el.style.outline = ''; }, 2000);
  }
}

// The Tools view mirrors the capabilities card's rendered catalogue
// (loadPublicTools fills it), so there is one source of truth.
async function deskSyncToolsView() {
  const list = document.getElementById('deskToolsList');
  if (!list) return;
  const src = document.getElementById('publicCapsTools');
  if (!src || !src.innerHTML.trim()) {
    try { await loadPublicTools(); } catch { /* placeholder stays */ }
  }
  if (src && src.innerHTML.trim()) list.innerHTML = src.innerHTML;
  const msrc = document.getElementById('publicCapsModel');
  const model = document.getElementById('deskToolsModel');
  if (model && msrc) model.innerHTML = msrc.innerHTML;
  const btn = document.getElementById('publicCapsBtn');
  const count = document.getElementById('deskToolsCount');
  if (count && btn) {
    const m = btn.textContent.match(/\((\d+) tools\)/);
    if (m) count.textContent = '(' + m[1] + ')';
  }
}

function deskFilterTools(q) {
  const list = document.getElementById('deskToolsList');
  if (!list) return;
  const needle = String(q || '').toLowerCase();
  list.querySelectorAll(':scope > div').forEach((d) => {
    d.style.display = !needle || d.textContent.toLowerCase().includes(needle) ? '' : 'none';
  });
}

function deskInitViews() {
  const panel = document.getElementById('public');
  if (!panel || document.getElementById('deskShell')) return;
  const style = document.createElement('style');
  style.textContent = '.desk-shell{display:flex;gap:1rem;align-items:flex-start;margin-top:1rem;}'
    + '.desk-nav{display:flex;flex-direction:column;gap:0.35rem;min-width:8.5rem;position:sticky;top:1rem;}'
    + '.desk-nav-btn{text-align:left;background:var(--bg);color:var(--text);border:1px solid var(--border);}'
    + '.desk-nav-btn.active{background:var(--accent);color:var(--on-accent);border-color:transparent;}'
    + '.desk-views{flex:1;min-width:0;}'
    + '.desk-view>.card{margin-bottom:1rem;}'
    + '@media (max-width:760px){.desk-shell{flex-direction:column;}.desk-nav{flex-direction:row;flex-wrap:wrap;position:static;}}';
  document.head.appendChild(style);
  const shell = document.createElement('div');
  shell.id = 'deskShell';
  shell.className = 'desk-shell';
  const navBtn = (k, label) => '<button class="btn desk-nav-btn' + (k === 'trading' ? ' active' : '') + '" data-view="' + k + '" onclick="deskShowView(\'' + k + '\')">' + label + '</button>';
  shell.innerHTML = '<nav class="desk-nav">'
    + navBtn('trading', 'Trading') + navBtn('questions', 'Questions') + navBtn('tools', 'Tools') + navBtn('logs', 'Logs') + navBtn('status', 'Status')
    + '</nav><div class="desk-views">'
    + '<section class="desk-view" data-view="trading"></section>'
    + '<section class="desk-view" data-view="questions" style="display:none;"></section>'
    + '<section class="desk-view" data-view="tools" style="display:none;">'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Model</h3><div id="deskToolsModel"></div></div>'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">MCP tools <span id="deskToolsCount" style="color:var(--muted);font-size:0.8rem;"></span></h3>'
    + '<input type="text" placeholder="Filter tools..." oninput="deskFilterTools(this.value)" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.5rem;color:var(--text);font-size:0.85rem;box-sizing:border-box;margin-bottom:0.6rem;">'
    + '<div id="deskToolsList"><span style="color:var(--muted);font-size:0.8rem;">Loading the catalogue...</span></div></div></section>'
    + '<section class="desk-view" data-view="logs" style="display:none;">'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Logs - model &amp; MCP detail</h3><div id="deskLogsList"></div></div></section>'
    + '<section class="desk-view" data-view="status" style="display:none;"></section>'
    + '</div>';
  const intro = panel.querySelector(':scope > .card');
  if (intro) intro.after(shell); else panel.appendChild(shell);
  const move = (id, view) => {
    const el = document.getElementById(id);
    const host = shell.querySelector('[data-view="' + view + '"]');
    if (el && host) host.appendChild(el);
  };
  move('publicDesk', 'trading');
  move('publicQuestionCard', 'questions');
  move('publicConnectedBox', 'status');
  // Opportunity hunt card (issue #135) into the desk rail.
  const rail = document.querySelector('#publicDesk .desk-rail');
  if (rail && !document.getElementById('huntCard')) {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'huntCard';
    card.innerHTML = '<h3 style="font-size:1rem;margin-bottom:0.35rem;">Opportunity hunt</h3>'
      + '<p style="color:var(--muted);font-size:0.8rem;line-height:1.5;margin-bottom:0.5rem;">Budget-bounded premium-selling scan. The agent gathers live chain evidence; sizing is computed in code. Report-only - nothing is ordered.</p>'
      + '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:flex-end;">'
      + '<label style="font-size:0.75rem;color:var(--muted);">Budget $<br><input type="number" id="huntBudget" value="50000" min="1000" step="1000" style="width:7rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.45rem;color:var(--text);font-size:0.85rem;"></label>'
      + '<label style="font-size:0.75rem;color:var(--muted);">Max risk / trade %<br><input type="number" id="huntRisk" value="2" min="0.5" max="10" step="0.5" style="width:5rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.45rem;color:var(--text);font-size:0.85rem;"></label>'
      + '<label style="font-size:0.75rem;color:var(--muted);">Symbols (optional)<br><input type="text" id="huntSymbols" placeholder="NVDA, AMD, SMH" style="width:10rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.45rem;color:var(--text);font-size:0.85rem;"></label>'
      + '<button class="btn" onclick="runOpportunityHunt()">Run hunt</button></div>'
      + '<div id="huntResult"></div><div id="huntHistory"></div>';
    rail.appendChild(card);
  }

  // The per-answer model/tools meta line is a log line, not trading UI.
  const meta = document.getElementById('publicTools');
  const logsCard = shell.querySelector('[data-view="logs"] .card');
  if (meta && logsCard) logsCard.insertBefore(meta, logsCard.children[1] || null);
  deskRenderLogs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', deskInitViews);
else deskInitViews();


// ---------------------------------------------------------------------------
// Opportunity hunt (issue #135): a budget-bounded premium-selling scan.
// The card is injected into the desk rail by deskInitViews; sizing is
// computed server-side in code - this UI only collects the budget and
// renders the plan.

function huntLegs(t) {
  return t.legs.map((l) => l.action + ' ' + l.strike + (l.type === 'call' ? 'C' : 'P')).join(' / ');
}

function huntPlanHtml(hunt) {
  const plan = hunt.plan;
  const rows = plan.trades.map((t) =>
    '<tr><td><strong>' + escapeHtml(t.underlying) + '</strong></td><td>' + escapeHtml(huntLegs(t)) + '<br><span style="color:var(--muted);font-size:0.72rem;">exp ' + escapeHtml(t.expiry) + ' · spot ' + t.spot + '</span></td>'
    + '<td>' + t.contracts + '</td><td>$' + Math.round(t.totalMaxProfit).toLocaleString() + '</td><td>$' + Math.round(t.totalRisk).toLocaleString() + '</td>'
    + '<td style="font-size:0.78rem;">' + escapeHtml(t.thesis || '') + '</td></tr>').join('');
  const discarded = plan.rejected.length + plan.unsized.length;
  return '<div style="font-size:0.82rem;margin-top:0.5rem;">'
    + '<div><strong>' + plan.trades.length + ' trades</strong> · max risk $' + Math.round(plan.totalRisk).toLocaleString()
    + ' · max profit $' + Math.round(plan.totalMaxProfit).toLocaleString()
    + ' · EV $' + Math.round(plan.totalExpectedValue).toLocaleString()
    + ' · unallocated $' + Math.round(plan.unallocated).toLocaleString()
    + (discarded ? ' · <span style="color:var(--muted);">' + discarded + ' discarded (see report)</span>' : '') + '</div>'
    + (rows ? '<table style="width:100%;border-collapse:collapse;margin-top:0.5rem;font-size:0.8rem;"><thead><tr><th style="text-align:left;">Underlying</th><th style="text-align:left;">Legs</th><th>Contracts</th><th>Max profit</th><th>Max risk</th><th style="text-align:left;">Why</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p style="color:var(--muted);">No candidate survived verification and sizing.</p>')
    + '<div style="margin-top:0.5rem;"><button class="btn" style="' + pBtn + '" onclick="openHuntReport(\'' + hunt.id + '\')">Full report</button></div></div>';
}

async function runOpportunityHunt() {
  const out = document.getElementById('huntResult');
  const budget = Number((document.getElementById('huntBudget') || {}).value);
  const maxRiskPct = Number((document.getElementById('huntRisk') || {}).value) || 2;
  const symbolsRaw = ((document.getElementById('huntSymbols') || {}).value || '').trim();
  if (!budget || budget <= 0) { if (out) out.innerHTML = '<span style="color:var(--red);font-size:0.8rem;">Enter a budget first.</span>'; return; }
  if (out) out.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Hunting - the autopilot scans quotes and chains, then sizing is computed in code. This can take a minute...</span>';
  try {
    const res = await api('/api/public/opportunity-hunt', 'POST', {
      budget,
      maxRiskPct,
      symbols: symbolsRaw ? symbolsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined,
    });
    if (res.error) throw new Error(res.error);
    if (out) out.innerHTML = huntPlanHtml(res.hunt);
    deskLoadHunts();
  } catch (e) {
    if (out) out.innerHTML = '<span style="color:var(--red);font-size:0.8rem;">' + escapeHtml(e.message || String(e)) + '</span>';
  }
}

async function deskLoadHunts() {
  const host = document.getElementById('huntHistory');
  if (!host) return;
  try {
    const res = await api('/api/public/opportunity-hunts');
    const hunts = (res && res.hunts) || [];
    host.innerHTML = hunts.length
      ? '<div style="margin-top:0.6rem;font-size:0.78rem;color:var(--muted);">Past hunts</div>' + hunts.slice(0, 5).map((h) =>
          '<div style="display:flex;justify-content:space-between;gap:0.5rem;font-size:0.8rem;margin-top:0.3rem;"><span>' + escapeHtml((h.createdAt || '').slice(0, 10)) + ' · $' + Math.round(h.request.budget).toLocaleString() + ' budget · ' + h.plan.trades.length + ' trades · $' + Math.round(h.plan.totalRisk).toLocaleString() + ' risk</span>'
          + '<button class="btn" style="' + pBtn + '" onclick="openHuntReport(\'' + h.id + '\')">Report</button></div>').join('')
      : '';
  } catch { /* not connected yet */ }
}

async function openHuntReport(id) {
  try {
    const key = localStorage.getItem('cfmail_api_key') || '';
    const res = await fetch('/api/public/opportunity-hunts/' + id + '/report', { headers: { 'X-API-Key': key } });
    if (!res.ok) throw new Error('status ' + res.status);
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  } catch (e) {
    alert('Could not open the report: ' + (e.message || e));
  }
}
