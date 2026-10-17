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
    neutral: { glyph: '\u25C6', color: '#d8a13c' },
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
    advanced: { glyph: '\u2582\u2584\u2586', color: '#d8a13c' },
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
  return '<div style="margin-top:0.45rem;border-left:3px solid ' + (v.complete ? '#16a34a' : '#b45309') + ';background:var(--bg);padding:0.4rem 0.6rem;font-size:0.8rem;font-weight:600;">'
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
    const chip = v ? '<span style="font-size:0.7rem;font-weight:600;color:' + (v.complete ? 'var(--green)' : '#b45309') + ';">' + (v.complete ? '\u2713 verified' : '\u26a0 incomplete') + ' ' + Math.round((Number(v.confidence) || 0) * 100) + '%</span>' : '';
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
function deskRefreshAll() { deskLoadQuotes(); deskLoadPortfolio(); deskLoadRuns(); }


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
      ? '<span style="background:#b45309;color:#fff;border-radius:4px;padding:0.05rem 0.35rem;">proposed</span>'
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
