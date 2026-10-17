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
function deskRefreshAll() { deskLoadQuotes(); deskLoadPortfolio(); deskLoadRuns(); deskLoadHunts(); deskUpdateApprovalNotice(); }


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

async function emailA2ATest() {
  const toEl = document.getElementById('qaEmailTo');
  const result = document.getElementById('qaEmailResult');
  const toEmail = toEl ? toEl.value : '';
  if (!toEmail) { if (result) result.innerHTML = '<div class="status-msg error">Enter an email address</div>'; return; }
  if (result) result.innerHTML = '<div class="loading">Probing every agent\'s A2A endpoint and emailing the results...</div>';
  const runId = qaLiveBegin('A2A Test Email');
  try {
    const res = await api('/api/dashboard/qa/a2a-test', 'POST', { toEmail, runId });
    const rows = res.results || [];
    const passed = rows.filter((r) => r.ok).length;
    if (res.emailed) { if (result) result.innerHTML = '<div class="status-msg success">A2A test emailed (' + passed + '/' + rows.length + ' surfaces responding)!</div>'; }
    else { if (result) result.innerHTML = '<div class="status-msg error">Failed: ' + (res.error || 'Unknown error') + '</div>'; }
    await qaLiveFinish(!!(res && res.emailed && res.ok));
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
  if (name === 'endpoints') deskRunA2ATests(true);
  if (name === 'orchestrate') deskLoadOrchestrateJobs();
  if (name === 'trading') deskSyncQuestionsClone();
  deskUpdateApprovalNotice();
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
    host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">No exchanges yet this session - ask a question in Trading and its full tool trace (raw data, downloads) lands here.</span>';
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
    + '#deskRuns{max-height:17rem;overflow-y:auto;}'
    + '#publicTrades{max-height:17rem;overflow-y:auto;}'
    + '#deskToolsList{max-height:26rem;overflow-y:auto;}'
    + '#deskChain{max-height:22rem;overflow-y:auto;}'
    + '.desk-intro{padding:0.75rem 1rem;}'
    + '.desk-intro h3{margin-bottom:0.2rem !important;font-size:1rem;}'
    + '.desk-intro p{font-size:0.82rem !important;line-height:1.45 !important;margin-bottom:0.4rem !important;}'
    + '.desk-view>.card{margin-bottom:1rem;}'
    + '.desk-duo{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:1rem;align-items:start;}'
    + '.desk-duo>.card{min-width:0;}'
    + '#publicInput{min-width:0;}'
    + '.container:has(#public.active){max-width:none;}'
    + '.desk-duo>.card{margin-bottom:0;}'
    + '.desk-logs-duo{display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-items:start;margin-bottom:1rem;}'
    + '.desk-logs-duo>.card{margin-bottom:0;}'
    + '.desk-rail:empty{display:none;}'
    + '.desk-nav-badge{background:var(--amber);color:var(--on-accent);border-radius:999px;padding:0 0.42rem;font-size:0.7rem;font-weight:700;margin-left:0.4rem;}'
    + '#publicDesk:has(> .desk-rail:empty){grid-template-columns:minmax(0,1fr);}'
    + '@media (max-width:900px){.desk-duo,.desk-logs-duo{grid-template-columns:1fr;}}@media (max-width:760px){.desk-shell{flex-direction:column;}.desk-nav{flex-direction:row;flex-wrap:wrap;position:static;}}';
  document.head.appendChild(style);
  const shell = document.createElement('div');
  shell.id = 'deskShell';
  shell.className = 'desk-shell';
  const navBtn = (k, label) => '<button class="btn desk-nav-btn' + (k === 'trading' ? ' active' : '') + '" data-view="' + k + '" onclick="deskShowView(\'' + k + '\')">' + label + '</button>';
  shell.innerHTML = '<nav class="desk-nav">'
    + navBtn('trading', 'Trading') + navBtn('hunt', 'Opportunity Hunt') + navBtn('questions', 'Questions') + navBtn('watchlist', 'Watchlist') + navBtn('portfolio', 'Portfolio') + navBtn('chain', 'Option Chain') + navBtn('tools', 'Tools') + navBtn('orchestrate', 'Orchestrate') + navBtn('logs', 'Logs') + navBtn('endpoints', 'Endpoints') + navBtn('status', 'Status')
    + '</nav><div class="desk-views">'
    + '<section class="desk-view" data-view="trading"></section>'
    + '<section class="desk-view" data-view="questions" style="display:none;"></section>'
    + '<section class="desk-view" data-view="tools" style="display:none;">'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Model</h3><div id="deskToolsModel"></div></div>'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">MCP tools <span id="deskToolsCount" style="color:var(--muted);font-size:0.8rem;"></span></h3>'
    + '<input type="text" placeholder="Filter tools..." oninput="deskFilterTools(this.value)" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.5rem;color:var(--text);font-size:0.85rem;box-sizing:border-box;margin-bottom:0.6rem;">'
    + '<div id="deskToolsList"><span style="color:var(--muted);font-size:0.8rem;">Loading the catalogue...</span></div></div></section>'
    + '<section class="desk-view" data-view="watchlist" style="display:none;"></section>'
    + '<section class="desk-view" data-view="hunt" style="display:none;"></section>'
    + '<section class="desk-view" data-view="chain" style="display:none;"></section>'
    + '<section class="desk-view" data-view="portfolio" style="display:none;"></section>'
    + '<section class="desk-view" data-view="logs" style="display:none;">'
    + '<div class="desk-logs-duo" id="deskLogsDuo"></div>'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Logs - model &amp; MCP detail</h3><div id="deskLogsList"></div></div></section>'
    + '<section class="desk-view" data-view="endpoints" style="display:none;">'
    + '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;"><h3 style="font-size:1rem;">A2A endpoint tests</h3>'
    + '<span style="display:flex;gap:0.4rem;align-items:center;"><span id="a2aTestStamp" style="color:var(--muted);font-size:0.75rem;"></span>'
    + '<button class="btn" style="padding:0.25rem 0.6rem;" onclick="deskRunA2ATests(true)">Test all now</button></span></div>'
    + '<p style="color:var(--muted);font-size:0.8rem;line-height:1.5;margin:0.4rem 0;">Every agent\'s A2A surface, probed the way an external caller would: card served, 401 without auth, snapshot reply with auth. Read-only. Runs automatically when you open this view; the same probes go out in the A2A test email.</p>'
    + '<div id="a2aTestTable"><span style="color:var(--muted);font-size:0.8rem;">Not tested yet.</span></div></div>'
    + '<div id="a2aCards"></div></section>'
    + '<section class="desk-view" data-view="orchestrate" style="display:none;">'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Orchestrate</h3>'
    + '<p style="color:var(--muted);font-size:0.8rem;line-height:1.5;margin:0 0 0.5rem;">Give the orchestrator a goal. It plans steps across the other agents, runs independent steps in parallel, retries a failed step once, and merges one report. Jobs are saved; browser-QA steps can take minutes.</p>'
    + '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;"><input id="deskOrchGoal" type="text" placeholder="e.g. Summarize every agent\'s state and post it to Slack" style="flex:1;min-width:14rem;">'
    + '<button class="btn" onclick="deskOrchestrateRun()">Run goal</button>'
    + '<label style="font-size:0.78rem;color:var(--muted);display:flex;gap:0.3rem;align-items:center;"><input type="checkbox" id="deskOrchSupervise"> Supervise (the model may revise the plan between steps)</label></div>'
    + '<div id="deskOrchSamples" style="margin-top:0.55rem;display:flex;gap:0.35rem;flex-wrap:wrap;align-items:center;"><span style="color:var(--muted);font-size:0.75rem;">Try:</span></div>'
    + '<div id="deskOrchResult" style="margin-top:0.6rem;"></div></div>'
    + '<div class="card"><h3 style="font-size:1rem;margin-bottom:0.5rem;">Jobs</h3><div id="deskOrchJobs"><span style="color:var(--muted);font-size:0.8rem;">No jobs loaded yet.</span></div></div></section>'
    + '<section class="desk-view" data-view="status" style="display:none;"></section>'
    + '</div>';
  const intro = panel.querySelector(':scope > .card');
  if (intro) { intro.classList.add('desk-intro'); intro.after(shell); } else panel.appendChild(shell);

  // Knowledge search (issue #170): the SearchAgent's desk face, in
  // the Tools view. Ask returns the grounded answer; Chunks the raw
  // retrieved chunks. An unconfigured instance errors honestly.
  const toolsSection = shell.querySelector('section.desk-view[data-view="tools"]');
  if (toolsSection) {
    const searchCard = document.createElement('div');
    searchCard.className = 'card';
    searchCard.innerHTML = '<h3 style="font-size:1rem;margin-bottom:0.5rem;">Knowledge search</h3>'
      + '<p style="color:var(--muted);font-size:0.8rem;line-height:1.5;margin:0 0 0.5rem;">Search the knowledge base indexed by Cloudflare AI Search (SearchAgent). Ask returns the grounded answer with its sources; Chunks shows the retrieved text itself.</p>'
      + '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;"><input id="deskSearchInput" type="text" placeholder="Ask the knowledge base..." style="flex:1;min-width:12rem;">'
      + '<button class="btn" onclick="deskSearchRun(\'ask\')">Ask</button>'
      + '<button class="btn" onclick="deskSearchRun(\'query\')">Chunks</button></div>'
      + '<div id="deskSearchResult" style="margin-top:0.6rem;"></div>';
    toolsSection.insertBefore(searchCard, toolsSection.firstChild);
  }
  // The host MUST be section-scoped: the nav buttons carry the same
  // data-view values and precede the sections in the shell markup, so
  // an unscoped [data-view=...] query returns a BUTTON - and the desk
  // ended up appended inside the Trading nav button (no visible nav,
  // empty views). That was the #133 layout bug found in production.
  const move = (id, view) => {
    const el = document.getElementById(id);
    const host = shell.querySelector('section.desk-view[data-view="' + view + '"]');
    if (el && host) host.appendChild(el);
  };
  move('publicDesk', 'trading');
  move('publicQuestionCard', 'questions');
  move('publicConnectedBox', 'status');
  const moveCardOf = (id, view) => {
    const anchor = document.getElementById(id);
    const card = anchor && anchor.closest('.card');
    const host = shell.querySelector('section.desk-view[data-view="' + view + '"]');
    if (card && host) host.appendChild(card);
  };
  // The whole watchlist card moves into its view (issue #166): #152
  // moved only the strip, leaving the empty card shell on Trading.
  moveCardOf('deskWatch', 'watchlist');
  // Portfolio card and the trading explainer card become views too.
  moveCardOf('deskPortfolio', 'portfolio');
  moveCardOf('publicTradingTitle', 'status');
  // Opportunity hunt card (issue #135): right next to the composer
  // ("Ask about an instrument") in the main column (issue #152).
  const rail = document.querySelector('#publicDesk .desk-rail');
  const chatCard = document.getElementById('publicChatCard');
  if ((chatCard || rail) && !document.getElementById('huntCard')) {
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
    if (chatCard) chatCard.after(card); else rail.appendChild(card);
    // The hunt is a nav view of its own now (issue #166).
    const huntHost = shell.querySelector('section.desk-view[data-view="hunt"]');
    if (huntHost) huntHost.appendChild(card);
  }

  // Voice control for the desk (issue #168): a Talk toggle in the
  // composer card. The client loads lazily from the same esm.sh
  // pattern as the dashboard's AgentClient, pinned to the server
  // package version; the dashboard key rides the handshake query,
  // which the /agents route's token check already accepts.
  if (chatCard && !document.getElementById('deskVoiceRow')) {
    const row = document.createElement('div');
    row.id = 'deskVoiceRow';
    row.style.cssText = 'margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem;';
    row.innerHTML = '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">'
      + '<button class="btn" id="deskVoiceBtn" onclick="deskToggleVoice()">\u{1F399}\ufe0f Talk to the desk</button>'
      + '<span id="deskVoiceStatus" style="color:var(--muted);font-size:0.8rem;">Voice is off - ask out loud and the desk answers out loud.</span></div>'
      + '<div id="deskVoiceTranscript" style="margin-top:0.5rem;font-size:0.85rem;line-height:1.55;"></div>';
    chatCard.appendChild(row);
  }

  // The capabilities button leaves the Ask card (issue #166): the
  // catalogue already lives in the Tools view, mirrored from the
  // (hidden) floating card, which stays as the mirror's source.
  const capsBtn = document.getElementById('publicCapsBtn');
  if (capsBtn) capsBtn.remove();

  // Chain CSV download (issue #152), beside Load chain.
  const chainBtn = document.querySelector('button[onclick="deskLoadChain()"]');
  if (chainBtn && !document.getElementById('deskChainCsv')) {
    const csvBtn = document.createElement('button');
    csvBtn.className = 'btn';
    csvBtn.id = 'deskChainCsv';
    csvBtn.textContent = 'Download CSV';
    csvBtn.setAttribute('onclick', 'deskDownloadChainCsv()');
    chainBtn.after(csvBtn);
  }

  // Option chain becomes its own nav view; Autopilot runs and Trade
  // approvals become side-by-side panes at the top of Logs (issue #159).
  moveCardOf('deskChain', 'chain');
  const logsDuo = document.getElementById('deskLogsDuo');
  const moveCardTo = (id, host) => {
    const anchor = document.getElementById(id);
    const card = anchor && anchor.closest('.card');
    if (card && host) host.appendChild(card);
  };
  moveCardTo('deskRuns', logsDuo);
  const tradesCard = document.getElementById('publicTradesCard');
  if (tradesCard && logsDuo) logsDuo.appendChild(tradesCard);
  // Main page = the composer + the strategy questions, side by side
  // (issue #166). The Questions view keeps the original card; Trading
  // gets a live clone (the library renders once into #publicQuestions
  // and deskSyncQuestionsClone mirrors it - groups are native
  // <details>, buttons call askQuestion(id), so a copy stays fully
  // functional; the clone's context <select> loses its id so the
  // original remains the one getElementById finds).
  const mainCol = document.querySelector('#publicDesk .desk-main');
  if (mainCol && chatCard) {
    const qClone = document.createElement('div');
    qClone.className = 'card';
    qClone.id = 'deskQuestionsClone';
    qClone.innerHTML = '<h3 style="font-size:1.1rem;margin-bottom:0.35rem;">Strategy questions</h3>'
      + '<p style="color:var(--muted);font-size:0.85rem;line-height:1.6;margin-bottom:0.5rem;">One click sends the prompt to the chat beside it.</p>'
      + '<div id="deskQuestionsCloneHost" style="max-height:32rem;overflow-y:auto;"></div>';
    const duo = document.createElement('div');
    duo.className = 'desk-duo';
    mainCol.insertBefore(duo, chatCard);
    duo.appendChild(chatCard);
    duo.appendChild(qClone);
    // The duo must NOT live inside #publicDesk (issue #174): that
    // legacy grid reserves a 370px rail column beside its main
    // column, which trapped the duo at partial width and squeezed
    // the Ask card until its button overflowed under the questions
    // card. As a direct child of the Trading section the duo takes
    // the section's full width by plain block layout.
    const tradingSection = shell.querySelector('section.desk-view[data-view="trading"]');
    if (tradingSection) tradingSection.insertBefore(duo, tradingSection.firstChild);
    deskSyncQuestionsClone();
    const qSrc = document.getElementById('publicQuestions');
    if (qSrc && window.MutationObserver) {
      new MutationObserver(() => deskSyncQuestionsClone()).observe(qSrc, { childList: true, subtree: true });
    }
  }

  // Pending-approvals notification (issue #161): a badge on the Logs
  // nav button + a banner on Trading that routes to the Logs page.
  const logsBtn = shell.querySelector('.desk-nav-btn[data-view="logs"]');
  if (logsBtn) {
    const badge = document.createElement('span');
    badge.id = 'deskLogsBadge';
    badge.className = 'desk-nav-badge';
    badge.style.display = 'none';
    logsBtn.appendChild(badge);
  }
  const tradingSection = shell.querySelector('section.desk-view[data-view="trading"]');
  const deskEl = document.getElementById('publicDesk');
  if (tradingSection && deskEl) {
    const notice = document.createElement('div');
    notice.id = 'deskApprovalNotice';
    notice.className = 'card';
    notice.style.cssText = 'display:none;border-left:3px solid var(--amber);padding:0.7rem 1rem;margin-bottom:1rem;';
    notice.innerHTML = '<strong>\u23f3 <span id="deskApprovalNoticeText"></span></strong>'
      + '<button class="btn" style="padding:0.25rem 0.6rem;margin-left:0.5rem;" onclick="deskShowView(\'logs\')">Review on the Logs page</button>';
    tradingSection.insertBefore(notice, deskEl);
  }
  // Proposals can be created from other surfaces too (host chat, A2A):
  // refresh the notice periodically while the Public tab is open.
  setInterval(() => {
    const panel = document.getElementById('public');
    if (panel && panel.classList.contains('active')) deskUpdateApprovalNotice();
  }, 60000);

  // The per-answer model/tools meta line is a log line, not trading UI.
  const meta = document.getElementById('publicTools');
  const logsCard = shell.querySelector('section.desk-view[data-view="logs"] .card');
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
    + '<div style="margin-top:0.5rem;display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;"><button class="btn" style="' + pBtn + '" onclick="openHuntReport(\'' + hunt.id + '\')">Full report</button>'
    + '<input type="email" id="huntEmailTo" placeholder="Email for the PDF report" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.4rem;color:var(--text);font-size:0.8rem;">'
    + '<button class="btn" style="' + pBtn + '" onclick="emailHuntReport(\'' + hunt.id + '\')">Email PDF report</button>'
    + '<span id="huntEmailState" style="color:var(--muted);font-size:0.75rem;"></span></div></div>';
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

async function emailHuntReport(id) {
  const st = document.getElementById('huntEmailState');
  const toEmail = ((document.getElementById('huntEmailTo') || {}).value || '').trim();
  if (!toEmail) { if (st) st.textContent = 'Enter an email address first.'; return; }
  if (st) st.textContent = 'Rendering the PDF and sending...';
  try {
    const res = await api('/api/public/opportunity-hunts/' + id + '/email', 'POST', { toEmail });
    if (res.error) throw new Error(res.error);
    if (st) st.textContent = res.emailed ? 'PDF report sent to ' + toEmail + '.' + (res.slackPosted ? ' Also posted to Slack.' : '') : 'The send did not complete.';
  } catch (e) {
    if (st) st.textContent = 'Failed: ' + (e.message || e);
  }
}

// ---------------------------------------------------------------------------
// Option chain CSV (issue #152): serialize the rendered chain table.

function deskDownloadChainCsv() {
  const host = document.getElementById('deskChain');
  const table = host && host.querySelector('table');
  if (!table) return;
  const cell = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th,td')].map((td) => cell(td.textContent.trim())).join(','));
  if (!rows.length) return;
  const symbol = (document.getElementById('deskChainSymbol') || {}).value || 'chain';
  const expiry = (document.getElementById('deskChainExpiry') || {}).value || 'nearest';
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'option-chain-' + symbol + '-' + expiry + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Reveal an element's desk view (used by QAAgent's snapshot flow before
// it scrolls an anchor into view - a hidden view's anchor has no box).
window.deskReveal = function (el) {
  if (!el || !el.closest) return;
  const view = el.closest('.desk-view');
  if (view && view.dataset.view) deskShowView(view.dataset.view);
};

// ---------------------------------------------------------------------------
// A2A endpoint tests view (issue #152): the probe matrix from the A2A
// test email (PR #151), tabulated in the desk. Switching to the view
// runs the probes; Test all / per-endpoint Test now re-run on demand.

let deskA2ARows = [];
let deskA2ARunning = false;

function deskA2ARowHtml(r) {
  const badge = (ok) => ok
    ? '<span style="background:var(--verified);color:var(--on-accent);border-radius:4px;padding:0.05rem 0.4rem;font-size:0.72rem;">ok</span>'
    : '<span class="badge-failed">fail</span>';
  return '<tr><td><strong>' + escapeHtml(r.agent) + '</strong><br><span style="color:var(--muted);font-size:0.72rem;">' + escapeHtml(r.rpc) + '</span></td>'
    + '<td>' + badge(r.cardOk) + (r.cardName ? '<br><span style="color:var(--muted);font-size:0.72rem;">' + escapeHtml(r.cardName) + '</span>' : '') + '</td>'
    + '<td>' + badge(r.unauthStatus === 401) + '<br><span style="color:var(--muted);font-size:0.72rem;">' + r.unauthStatus + '</span></td>'
    + '<td>' + badge(r.dispatchOk) + (r.reply ? '<br><span style="color:var(--muted);font-size:0.72rem;">' + escapeHtml(r.reply.slice(0, 90)) + '</span>' : '') + '</td>'
    + '<td><button class="btn" style="padding:0.2rem 0.5rem;font-size:0.75rem;" onclick="deskRunA2ATests(true, \'' + escapeHtml(r.rpc) + '\')">Test now</button></td></tr>';
}

function deskA2ACardHtml(r) {
  const skills = (r.cardSkills || []).map((s) =>
    '<div style="margin-top:0.45rem;"><strong style="font-size:0.82rem;">' + escapeHtml(s.name) + '</strong>'
    + (s.tags && s.tags.length ? ' <span style="color:var(--muted);font-size:0.72rem;">' + s.tags.map(escapeHtml).join(' · ') + '</span>' : '')
    + '</div>').join('');
  return '<div class="card" style="margin-bottom:1rem;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;flex-wrap:wrap;">'
    + '<h3 style="font-size:1rem;margin:0;">' + escapeHtml(r.cardName || r.agent) + '</h3>'
    + '<span style="display:flex;gap:0.35rem;align-items:center;"><span style="color:var(--muted);font-size:0.72rem;">' + escapeHtml(r.rpc) + '</span>'
    + (r.ok
      ? '<span style="background:var(--verified);color:var(--on-accent);border-radius:4px;padding:0.05rem 0.4rem;font-size:0.72rem;">live</span>'
      : '<span class="badge-failed">check</span>')
    + '</span></div>'
    + (r.cardDescription ? '<p style="color:var(--muted);font-size:0.82rem;line-height:1.55;margin:0.45rem 0 0;">' + escapeHtml(r.cardDescription) + '</p>' : '')
    + (skills ? '<div style="border-top:1px solid var(--border);margin-top:0.6rem;padding-top:0.2rem;">' + skills + '</div>' : '')
    + '</div>';
}

function deskRenderA2ACards() {
  const host = document.getElementById('a2aCards');
  if (!host) return;
  host.innerHTML = deskA2ARows.length
    ? '<h3 style="font-size:1rem;margin:0 0 0.6rem;">Agent cards</h3>' + deskA2ARows.map(deskA2ACardHtml).join('')
    : '';
}

function deskRenderA2ATests() {
  const host = document.getElementById('a2aTestTable');
  if (!host) return;
  deskRenderA2ACards();
  if (!deskA2ARows.length) {
    host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">' + (deskA2ARunning ? 'Testing...' : 'Not tested yet.') + '</span>';
    return;
  }
  host.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;"><thead><tr>'
    + '<th style="text-align:left;padding:0.3rem;">Agent</th><th style="text-align:left;padding:0.3rem;">Card</th>'
    + '<th style="text-align:left;padding:0.3rem;">No-auth</th><th style="text-align:left;padding:0.3rem;">Dispatch</th><th></th></tr></thead>'
    + '<tbody>' + deskA2ARows.map(deskA2ARowHtml).join('') + '</tbody></table>';
}

async function deskRunA2ATests(force, rpc) {
  const stamp = document.getElementById('a2aTestStamp');
  if (deskA2ARunning) return;
  if (!force && deskA2ARows.length && !rpc) { deskRenderA2ATests(); return; }
  deskA2ARunning = true;
  if (stamp) stamp.textContent = 'Testing' + (rpc ? ' ' + rpc : ' all endpoints') + '...';
  deskRenderA2ATests();
  try {
    const res = await api('/api/dashboard/qa/a2a-probe', 'POST', rpc ? { rpc } : {});
    const rows = (res && res.results) || [];
    if (rpc) {
      const i = deskA2ARows.findIndex((r) => r.rpc === rpc);
      if (i >= 0 && rows[0]) deskA2ARows[i] = rows[0];
      else if (rows[0]) deskA2ARows.push(rows[0]);
    } else {
      deskA2ARows = rows;
    }
    if (stamp) {
      const passed = deskA2ARows.filter((r) => r.ok).length;
      stamp.textContent = passed + '/' + deskA2ARows.length + ' responding · ' + new Date().toLocaleTimeString();
    }
  } catch (e) {
    if (stamp) stamp.textContent = 'Test failed: ' + (e.message || e);
  }
  deskA2ARunning = false;
  deskRenderA2ATests();
}

// ---------------------------------------------------------------------------
// Pending trade approvals notification (issue #161): the approvals queue
// lives on the Logs view, so pending proposals announce themselves -
// a badge on the Logs nav button and a banner on Trading.

async function deskUpdateApprovalNotice() {
  const badge = document.getElementById('deskLogsBadge');
  const notice = document.getElementById('deskApprovalNotice');
  if (!badge && !notice) return;
  let pending = -1;
  try {
    const res = await api('/api/public/trades');
    const proposals = (res && res.proposals) || [];
    pending = proposals.filter((x) => x.status === 'pending').length;
  } catch (e) {
    return; // A failed read leaves the current surfaces untouched.
  }
  if (badge) {
    badge.style.display = pending > 0 ? '' : 'none';
    badge.textContent = String(pending);
  }
  if (notice) {
    notice.style.display = pending > 0 ? '' : 'none';
    const txt = document.getElementById('deskApprovalNoticeText');
    if (txt) {
      txt.textContent = pending + ' trade approval' + (pending === 1 ? '' : 's') + ' pending - ' +
        (pending === 1 ? 'it expires' : 'they expire') + ' in 24 hours.';
    }
  }
}

// ---------------------------------------------------------------------------
// Notification center (issue #163): a bell in the dashboard header
// listing everything the user should know about - pending trade
// approvals (until decided), recent webhook events, recent hunts.

function notifyInit() {
  const right = document.querySelector('.header .right');
  if (!right || document.getElementById('notifyWrap')) return;
  const wrap = document.createElement('span');
  wrap.id = 'notifyWrap';
  wrap.style.cssText = 'position:relative;display:inline-block;';
  wrap.innerHTML = '<button class="wallet-btn" id="notifyBell" title="Notifications" onclick="toggleNotifyPanel(event)">\u{1F514}'
    + '<span id="notifyBadge" class="desk-nav-badge" style="display:none;margin-left:0.3rem;"></span></button>'
    + '<div id="notifyPanel" style="display:none;position:absolute;right:0;top:calc(100% + 0.5rem);width:23rem;max-width:90vw;max-height:27rem;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;z-index:80;box-shadow:0 10px 30px rgba(0,0,0,0.45);text-align:left;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 0.8rem;border-bottom:1px solid var(--border);">'
    + '<strong style="font-size:0.9rem;">Notifications</strong>'
    + '<button class="btn" style="padding:0.15rem 0.5rem;font-size:0.75rem;" onclick="refreshNotifications()">Refresh</button></div>'
    + '<div id="notifyList"><div style="padding:0.8rem;color:var(--muted);font-size:0.85rem;">Loading...</div></div></div>';
  right.insertBefore(wrap, right.firstChild);
  document.addEventListener('click', (ev) => {
    const panel = document.getElementById('notifyPanel');
    const w = document.getElementById('notifyWrap');
    if (panel && w && !w.contains(ev.target)) panel.style.display = 'none';
  });
  refreshNotifications();
  setInterval(refreshNotifications, 60000);
}

function toggleNotifyPanel(ev) {
  if (ev) ev.stopPropagation();
  const panel = document.getElementById('notifyPanel');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening) {
    refreshNotifications().then(() => {
      localStorage.setItem('cfmail_notify_seen', String(Date.now()));
      updateNotifyBadge(window.__notifyPending || 0, 0);
    });
  }
}

function updateNotifyBadge(pending, unseen) {
  const badge = document.getElementById('notifyBadge');
  if (!badge) return;
  const total = pending + unseen;
  badge.style.display = total > 0 ? '' : 'none';
  badge.textContent = String(total);
}

function notifyGo(kind) {
  const panel = document.getElementById('notifyPanel');
  if (panel) panel.style.display = 'none';
  if (kind === 'webhooks') { switchTab('webhooks'); return; }
  switchTab('public');
  if (kind === 'logs') deskShowView('logs');
  if (kind === 'trading') deskShowView('trading');
}

async function refreshNotifications() {
  const list = document.getElementById('notifyList');
  const items = [];
  let pending = 0;
  try {
    const res = await api('/api/public/trades');
    const proposals = (res && res.proposals) || [];
    for (const pr of proposals) {
      if (pr.status !== 'pending') continue;
      pending += 1;
      items.push({
        t: Date.parse(pr.createdAt) || 0, icon: '\u23f3', kind: 'logs',
        title: 'Trade approval pending: ' + pr.tool,
        detail: 'Expires 24h after it was proposed. Review it on the Logs page.',
      });
    }
  } catch (e) { /* Public not connected or not signed in: skip. */ }
  try {
    const data = await api('/api/dashboard/webhooks');
    const events = (data && data.events) || [];
    for (const e of events.slice(0, 5)) {
      items.push({
        t: Date.parse(e.receivedAt) || 0, icon: '\u{1F517}', kind: 'webhooks',
        title: 'Webhook: ' + (e.provider || '') + ' ' + (e.eventType || ''),
        detail: 'Handled by ' + (e.agentName || 'an agent') + '.',
      });
    }
  } catch (e) { /* skip */ }
  try {
    const data = await api('/api/public/opportunity-hunts');
    const hunts = (data && data.hunts) || [];
    for (const h of hunts.slice(0, 3)) {
      const trades = h.plan && h.plan.trades ? h.plan.trades.length : 0;
      items.push({
        t: Date.parse(h.createdAt || h.ts) || 0, icon: '\u{1F3AF}', kind: 'trading',
        title: 'Opportunity hunt completed',
        detail: trades + ' sized trade(s) in the plan. Open it from the Trading view.',
      });
    }
  } catch (e) { /* skip */ }
  items.sort((a, b) => b.t - a.t);
  const seen = Number(localStorage.getItem('cfmail_notify_seen') || 0);
  const unseen = items.filter((i) => i.t > seen && i.kind !== 'logs').length;
  window.__notifyPending = pending;
  updateNotifyBadge(pending, unseen);
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div style="padding:0.8rem;color:var(--muted);font-size:0.85rem;">No notifications yet.</div>';
    return;
  }
  list.innerHTML = items.slice(0, 12).map((i) =>
    '<div onclick="notifyGo(\'' + i.kind + '\')" style="padding:0.55rem 0.8rem;border-bottom:1px solid var(--border);cursor:pointer;">'
    + '<div style="font-size:0.85rem;">' + i.icon + ' ' + escapeHtml(i.title) + '</div>'
    + '<div style="font-size:0.75rem;color:var(--muted);margin-top:0.15rem;">' + escapeHtml(i.detail) + '</div>'
    + '<div style="font-size:0.7rem;color:var(--muted);">' + (i.t ? new Date(i.t).toLocaleString() : '') + '</div></div>',
  ).join('');
}

notifyInit();

// Mirror the strategy-questions library into the Trading clone
// (issue #166). The original stays in the Questions view.
function deskSyncQuestionsClone() {
  const src = document.getElementById('publicQuestions');
  const host = document.getElementById('deskQuestionsCloneHost');
  if (!src || !host) return;
  if (host.innerHTML !== src.innerHTML) {
    host.innerHTML = src.innerHTML;
    const sel = host.querySelector('#publicContext');
    if (sel) sel.removeAttribute('id');
    const lbl = host.querySelector('label[for="publicContext"]');
    if (lbl) lbl.removeAttribute('for');
  }
}

// ---------------------------------------------------------------------------
// Voice desk client (issue #168): VoiceClient from @cloudflare/voice,
// loaded lazily as an ES module from esm.sh (the dashboard's existing
// pattern for the agents client). One client per call session.

let deskVoiceClient = null;

async function deskToggleVoice() {
  const btn = document.getElementById('deskVoiceBtn');
  const status = document.getElementById('deskVoiceStatus');
  if (deskVoiceClient) {
    try { deskVoiceClient.endCall(); deskVoiceClient.disconnect(); } catch (e) { /* already gone */ }
    deskVoiceClient = null;
    if (btn) btn.textContent = '\u{1F399}\ufe0f Talk to the desk';
    if (status) status.textContent = 'Voice is off - ask out loud and the desk answers out loud.';
    return;
  }
  const key = localStorage.getItem('cfmail_api_key') || '';
  if (!key) {
    if (status) status.textContent = 'Sign in with your API key first.';
    return;
  }
  if (status) status.textContent = 'Starting voice...';
  try {
    const { VoiceClient } = await import('https://esm.sh/@cloudflare/voice@0.5.0/client');
    const client = new VoiceClient({ agent: 'voice-agent', name: 'desk', query: { token: key } });
    deskVoiceClient = client;
    client.addEventListener('statuschange', (s) => {
      const el = document.getElementById('deskVoiceStatus');
      if (el) el.textContent = 'Voice: ' + s + (s === 'listening' ? ' - speak now.' : '');
    });
    client.addEventListener('transcriptchange', (messages) => {
      const host = document.getElementById('deskVoiceTranscript');
      if (!host || !Array.isArray(messages)) return;
      host.innerHTML = messages.slice(-6).map((m) =>
        '<div style="margin-top:0.3rem;"><strong>' + (m.role === 'user' ? 'You' : 'Desk') + ':</strong> ' + escapeHtml(m.text || m.content || '') + '</div>',
      ).join('');
    });
    client.addEventListener('error', (e) => {
      const el = document.getElementById('deskVoiceStatus');
      if (el && e) el.textContent = 'Voice error: ' + e;
    });
    client.connect();
    // startCall() refuses while the socket is still opening (it
    // emits "Cannot start call: not connected" and returns without
    // touching the microphone), so wait for the connection to open
    // first. The server greeting (status: idle) arrives on open;
    // only then can a call actually start.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the voice connection timed out')), 15000);
      client.addEventListener('connectionchange', (open) => {
        if (open) { clearTimeout(timer); resolve(); }
      });
    });
    await client.startCall();
    if (btn) btn.textContent = '\u23f9 End voice';
  } catch (err) {
    deskVoiceClient = null;
    if (status) status.textContent = 'Voice could not start: ' + (err && err.message ? err.message : err);
  }
}


// Knowledge search runner (issue #170).
async function deskSearchRun(mode) {
  const input = document.getElementById('deskSearchInput');
  const host = document.getElementById('deskSearchResult');
  const q = (input && input.value || '').trim();
  if (!host) return;
  if (!q) { host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Type a question first.</span>'; return; }
  host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Searching...</span>';
  try {
    const r = await api('/api/dashboard/search', 'POST', { query: q, mode });
    if (r && r.error) throw new Error(r.error);
    const chunks = (r && r.chunks) || [];
    let html = '';
    if (mode === 'ask' && r.answer) {
      html += '<div style="font-size:0.86rem;line-height:1.55;">' + escapeHtml(r.answer) + '</div>';
    }
    if (chunks.length) {
      html += chunks.map((c0) =>
        '<div style="border-top:1px solid var(--border);margin-top:0.5rem;padding-top:0.5rem;">'
        + '<div style="font-size:0.72rem;color:var(--muted);">' + escapeHtml(c0.source || 'index') + ' \u00b7 score ' + (Math.round((c0.score || 0) * 100) / 100) + '</div>'
        + '<div style="font-size:0.82rem;line-height:1.5;">' + escapeHtml(c0.text.slice(0, 600)) + '</div></div>').join('');
    } else if (!html) {
      html = '<span style="color:var(--muted);font-size:0.8rem;">No chunks returned. If the search instance is not created yet, the agent says so in its snapshot (Endpoints view).</span>';
    }
    host.innerHTML = html;
  } catch (e) {
    host.innerHTML = '<span class="badge-failed">Search failed</span> <span style="font-size:0.8rem;">' + escapeHtml(String(e.message || e)) + '</span>';
  }
}
window.deskSearchRun = deskSearchRun;


// Orchestration view (issue #180): run a goal, list jobs.
async function deskOrchestrateRun() {
  const input = document.getElementById('deskOrchGoal');
  const host = document.getElementById('deskOrchResult');
  const goal = (input && input.value || '').trim();
  if (!host) return;
  if (!goal) { host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Type a goal first.</span>'; return; }
  host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Planning and running - this can take minutes when QA steps are involved...</span>';
  try {
    const sup = document.getElementById('deskOrchSupervise');
    const job = await api('/api/dashboard/orchestrate', 'POST', { goal, mode: sup && sup.checked ? 'supervise' : 'plan' });
    if (job && job.error) throw new Error(job.error);
    host.innerHTML = deskOrchJobHtml(job, true);
    deskLoadOrchestrateJobs();
  } catch (e) {
    host.innerHTML = '<span class="badge-failed">Job failed</span> <span style="font-size:0.8rem;">' + escapeHtml(String(e.message || e)) + '</span>';
  }
}
window.deskOrchestrateRun = deskOrchestrateRun;

function deskOrchJobHtml(job, open) {
  if (!job) return '';
  const steps = (job.plan || []).map((s) => {
    const o = (job.outcomes || []).find((x) => x.stepId === s.id);
    const mark = !o ? '\u00b7' : o.skipped ? '\u2013' : o.ok ? '\u2713' : '\u2717';
    return '<div style="font-size:0.78rem;margin-top:0.2rem;">' + mark + ' ' + escapeHtml(s.agent) + ' / ' + escapeHtml(s.operation)
      + (o && o.error ? ' <span style="color:var(--muted);">' + escapeHtml(o.error) + '</span>' : '') + '</div>';
  }).join('');
  return '<div style="border-top:1px solid var(--border);margin-top:0.5rem;padding-top:0.5rem;">'
    + '<div style="font-size:0.84rem;"><strong>' + escapeHtml(job.id) + '</strong> \u00b7 ' + escapeHtml(job.status) + ' \u00b7 ' + escapeHtml(job.goal)
    + (job.mode ? ' <span style="color:var(--muted);font-size:0.72rem;">(' + escapeHtml(job.mode) + (job.revisions ? ', ' + job.revisions + ' revision' + (job.revisions > 1 ? 's' : '') : '') + ')</span>' : '') + '</div>'
    + steps
    + (job.result ? '<div style="font-size:0.82rem;line-height:1.55;margin-top:0.45rem;white-space:pre-wrap;">' + escapeHtml(job.result.slice(0, open ? 4000 : 600)) + '</div>' : '')
    + '</div>';
}

async function deskLoadOrchestrateJobs() {
  deskOrchSamplesInit();
  const host = document.getElementById('deskOrchJobs');
  if (!host) return;
  try {
    const r = await api('/api/dashboard/orchestrate/jobs', 'GET');
    const jobs = (r && r.jobs) || [];
    host.innerHTML = jobs.length ? jobs.map((j) => deskOrchJobHtml(j, false)).join('') : '<span style="color:var(--muted);font-size:0.8rem;">No jobs yet. Run a goal above.</span>';
  } catch (e) {
    host.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">Jobs unavailable: ' + escapeHtml(String(e.message || e)) + '</span>';
  }
}
window.deskLoadOrchestrateJobs = deskLoadOrchestrateJobs;


// Orchestrate sample goals (issue #180 follow-up): one click fills
// the goal box and runs it.
const DESK_ORCH_SAMPLES = [
  'Summarize the state of qa, search, and slack',
  'Give me a status report from every agent',
  'QA-check this dashboard and search the knowledge base for how trade approvals work',
  'Summarize recent payments and webhook activity',
  'Summarize recent emails, payments, and webhook events',
  'Summarize the state of qa, search, and slack, then post the summary to Slack',
];
function deskOrchSamplesInit() {
  const host = document.getElementById('deskOrchSamples');
  if (!host || host.children.length > 1) return;
  for (const text of DESK_ORCH_SAMPLES) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.padding = '0.2rem 0.55rem';
    b.style.fontSize = '0.75rem';
    b.textContent = text;
    b.onclick = () => {
      const input = document.getElementById('deskOrchGoal');
      if (input) input.value = text;
      deskOrchestrateRun();
    };
    host.appendChild(b);
  }
}
