'use strict';

const DOC_DEFS = [
  { key: 'techpack', label: 'Tech pack', hint: 'How to make the garment' },
  { key: 'purchase_order', label: 'Purchase order', hint: 'What the buyer ordered' },
  { key: 'factory_sheet', label: 'Factory sheet', hint: 'What the line will cut' },
];

let AGENT_URL = 'https://web.telegram.org/k/';

const state = {
  files: {},       // key -> File
  texts: {},       // key -> pasted/loaded text
  demo: false,
  result: null,
  decisions: {},   // flag id -> 'fix' | 'ignore' | 'ask'
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------- sidebar */

function renderSlots() {
  const host = $('#slots');
  host.innerHTML = DOC_DEFS.map((d) => `
    <div class="slot" data-slot="${d.key}">
      <div class="slot-head">
        <span class="slot-name">${d.label}</span>
        <span class="slot-status" data-status="${d.key}">empty</span>
      </div>
      <p class="muted" style="font-size:.7rem;margin-top:2px">${d.hint}</p>
      <textarea data-text="${d.key}" rows="3" placeholder="Paste the document text…" aria-label="${d.label} text"></textarea>
      <div class="slot-actions">
        <button class="linkbtn" type="button" data-pick="${d.key}">Choose file</button>
        <span class="muted" data-file="${d.key}" style="font-size:.7rem"></span>
      </div>
      <input type="file" hidden accept=".pdf,.xlsx,.xls,.csv,.txt" data-input="${d.key}">
    </div>`).join('');

  host.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => host.querySelector(`[data-input="${btn.dataset.pick}"]`).click());
  });
  host.querySelectorAll('[data-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.input;
      const f = input.files[0];
      if (!f) return;
      state.files[key] = f;
      host.querySelector(`[data-file="${key}"]`).textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} KB`;
      host.querySelector(`[data-status="${key}"]`).textContent = 'file ready';
      host.querySelector(`[data-slot="${key}"]`).classList.add('filled');
    });
  });
  host.querySelectorAll('[data-text]').forEach((ta) => {
    ta.addEventListener('input', () => {
      const key = ta.dataset.text;
      state.texts[key] = ta.value;
      const slot = host.querySelector(`[data-slot="${key}"]`);
      const status = host.querySelector(`[data-status="${key}"]`);
      if (ta.value.trim()) {
        status.textContent = 'text ready';
        slot.classList.add('filled');
      } else if (!state.files[key]) {
        status.textContent = 'empty';
        slot.classList.remove('filled');
      }
    });
    // drag and drop straight onto the slot
    const slot = ta.closest('.slot');
    ['dragenter', 'dragover'].forEach((ev) => slot.addEventListener(ev, (e) => { e.preventDefault(); slot.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => slot.addEventListener(ev, (e) => { e.preventDefault(); slot.classList.remove('drag'); }));
    slot.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (!f) return;
      state.files[ta.dataset.text] = f;
      slot.querySelector('[data-file]').textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} KB`;
      slot.querySelector('[data-status]').textContent = 'file ready';
      slot.classList.add('filled');
    });
  });
}

function setStatus(key, text, ok) {
  const el = document.querySelector(`[data-status="${key}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ok', Boolean(ok));
}

/* --------------------------------------------------------------- steps */

const STEP_LABELS = { extract: 'Extract', compare: 'Compare', flag: 'Flag', decide: 'Decide' };
const STEP_BUSY = { extract: 'Extracting…', compare: 'Comparing…', flag: 'Writing warnings…', decide: 'Decide' };

function setStep(name, busy) {
  document.querySelectorAll('#stepsLine [data-step]').forEach((el) => {
    const step = el.dataset.step;
    const active = step === name;
    el.classList.toggle('on', active);
    el.textContent = busy && active ? STEP_BUSY[step] : STEP_LABELS[step];
  });
}

function notice(html, kind) {
  $('#notice').innerHTML = html ? `<div class="notice ${kind || ''}">${html}</div>` : '';
}

/* --------------------------------------------------------------- fetch */

async function extractOne(key) {
  const label = DOC_DEFS.find((d) => d.key === key).label;
  setStatus(key, 'extracting…');
  let res;
  if (state.files[key]) {
    const fd = new FormData();
    fd.append('file', state.files[key]);
    fd.append('docType', key);
    res = await fetch('/api/extract', { method: 'POST', body: fd });
  } else {
    res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: state.texts[key] || '', docType: key }),
    });
  }
  const data = await res.json().catch(() => ({ error: 'The server returned a non-JSON response.' }));
  if (!res.ok || data.error) {
    setStatus(key, 'failed');
    throw new Error(`${label}: ${data.error || res.statusText}`);
  }
  setStatus(key, 'extracted', true);
  return data.fields;
}

async function compareAll(fields, unread = []) {
  const res = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs: fields, unread }),
  });
  const data = await res.json().catch(() => ({ error: 'The server returned a non-JSON response.' }));
  if (!res.ok || data.error) throw new Error(data.error + (data.detail ? ' — ' + data.detail : ''));
  return data;
}

/* ---------------------------------------------------------------- run */

async function run() {
  const present = DOC_DEFS.filter((d) => state.files[d.key] || (state.texts[d.key] || '').trim());
  if (present.length < 2) {
    notice('Add at least two documents — a comparison needs something to compare against.', '');
    return;
  }
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Working…';
  notice('');
  state.decisions = {};

  try {
    setStep('extract', true);
    const fields = {};
    const errors = [];
    for (const d of present) {
      try {
        fields[d.key] = await extractOne(d.key);
      } catch (e) {
        errors.push(e.message);
      }
    }
    DOC_DEFS.forEach((d) => { if (!fields[d.key]) setStatus(d.key, 'empty'); });

    if (!Object.keys(fields).length) {
      throw new Error(errors[0] || 'No document could be read.');
    }
    const unread = present.filter((d) => !fields[d.key]).map((d) => d.key);
    if (unread.length) {
      const names = unread.map((k) => DOC_DEFS.find((d) => d.key === k).label).join(', ');
      notice(`${esc(names)} could not be read, so ${unread.length > 1 ? 'they are' : 'it is'} left out of this comparison — gaps are not inferred from a document nobody could read. ${esc(errors[0] || '')}`, '');
    }

    setStep('compare', true);
    $('#result').innerHTML = '<div class="empty"><p>Comparing documents field by field…</p></div>';
    const data = await compareAll(fields, unread);
    state.result = data;
    renderResult(data);
    if (!data.ai && data.ai_error) {
      notice(`Comparison still worked, but the model could not add judgements or warnings: ${esc(data.ai_error)}`, '');
    }
  } catch (err) {
    notice(esc(err.message || String(err)), '');
    if (state.demo) {
      notice(`Live extraction failed, so the pre-computed demo result is shown instead. ${esc(err.message || '')}`, '');
      await loadFallback();
    } else {
      $('#result').innerHTML = '<div class="empty"><h3>Nothing compared yet</h3><p>Fix the message above and run again. If the key or model is wrong, the banner at the top of the results explains what to change in <code>.env</code>.</p></div>';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compare documents';
    setStep('decide', false);
    document.querySelectorAll('#stepsLine [data-step]').forEach((el) => el.classList.remove('on'));
    syncExport();
  }
}

/* ------------------------------------------------------------- render */

function renderResult(data) {
  const flags = data.flags || [];
  const c = data.counts || { total: flags.length };
  const style = data.style || 'Unnamed order';
  state.decisions = {};

  $('#result').innerHTML = `
    <div class="result-head">
      <h2>Order ${esc(style)} · ${c.total} issue${c.total === 1 ? '' : 's'} found</h2>
      <div class="progress">
        <span id="progText">0 of ${c.total} reviewed</span>
        <span class="bar"><span id="progBar" style="width:0%"></span></span>
      </div>
    </div>
    ${data.partial ? `<p class="fmeta" style="margin-top:10px">${data.compared} of 3 documents compared — ${esc((data.unread || []).map((k) => (DOC_DEFS.find((d) => d.key === k) || {}).label || k).join(', '))} could not be read.</p>` : ''}
    ${data.fallback ? '<p class="fmeta" style="margin-top:10px">Pre-computed demo result — no model call was made.</p>' : ''}
    <div class="flags" id="flags"></div>`;

  const host = $('#flags');
  if (!flags.length) {
    host.innerHTML = '<div class="empty"><h3>No conflicts found</h3><p>The documents agree on every field SpecCheck can read. A human should still sign off — nothing here is an approval.</p></div>';
    return;
  }

  host.innerHTML = flags.map((f) => {
    const tagClass = f.priority === 'High' ? 'tag-high' : f.priority === 'Medium' ? 'tag-med' : 'tag-low';
    const cols = (f.values || []).map((v) => {
      const bad = f.priority && v.value != null ? isDisagreeing(f, v) : false;
      const shown = v.unread ? 'not read' : (v.missing || v.value == null ? 'not stated' : String(v.value));
      const clipped = shown.length > 150 ? shown.slice(0, 150).trimEnd() + '…' : shown;
      return `<div class="dcol">
        <div class="dname">${esc(v.document)}</div>
        <div class="dval ${v.unread ? 'unread' : (v.missing ? 'none' : (bad ? 'bad' : ''))}" title="${esc(shown)}">${esc(clipped)}</div>
        ${v.quote ? `<div class="dq">“${esc(v.quote)}”</div>` : ''}
      </div>`;
    }).join('');
    return `<article class="fcard" data-flag="${esc(f.id)}">
      <div class="fcard-top">
        <span class="tag ${tagClass}">${esc(f.priority)}</span>
        <span class="fname">${esc(f.label || f.field)}</span>
        <span class="chip">${f.kind === 'gap' ? 'Missing in a document' : 'Documents disagree'}</span>
        ${f.ai ? '' : '<span class="chip" title="The model could not judge this one; wording and priority came from the rules.">rule-based</span>'}
      </div>
      <div class="cols">${cols}</div>
      <p class="fwarn">${esc(f.warning || '')}</p>
      ${f.reason ? `<p class="fmeta">Why ${esc(String(f.priority).toLowerCase())}: ${esc(f.reason)}</p>` : ''}
      <div class="decide" role="group" aria-label="Decision for ${esc(f.label)}">
        <span class="lbl">Your call:</span>
        <button class="dbtn" data-dec="fix" data-id="${esc(f.id)}" aria-pressed="false">Fix needed</button>
        <button class="dbtn" data-dec="ignore" data-id="${esc(f.id)}" aria-pressed="false">Ignore</button>
        <button class="dbtn" data-dec="ask" data-id="${esc(f.id)}" aria-pressed="false">Ask supplier</button>
      </div>
    </article>`;
  }).join('');

  host.querySelectorAll('.dbtn').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      const same = state.decisions[id] === b.dataset.dec;
      document.querySelectorAll(`.dbtn[data-id="${CSS.escape(id)}"]`).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (same) {
        delete state.decisions[id];
      } else {
        state.decisions[id] = b.dataset.dec;
        b.setAttribute('aria-pressed', 'true');
      }
      updateProgress(data);
    });
  });
  updateProgress(data);
}

// mark the value that differs from the majority
function isDisagreeing(flag, value) {
  const vals = (flag.values || []).filter((v) => v.value != null);
  if (vals.length < 2) return false;
  const key = (v) => String(v.value).toLowerCase().replace(/[^a-z0-9.]+/g, '');
  const counts = {};
  vals.forEach((v) => { const k = key(v); counts[k] = (counts[k] || 0) + 1; });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return key(value) !== best[0] && counts[key(value)] <= best[1];
}

function updateProgress(data) {
  const total = (data.flags || []).length;
  const done = Object.keys(state.decisions).length;
  const txt = $('#progText');
  const bar = $('#progBar');
  if (txt) txt.textContent = `${done} of ${total} reviewed`;
  if (bar) bar.style.width = total ? `${(done / total) * 100}%` : '0%';
  syncExport();
}

function syncExport() {
  const ready = Boolean(state.result && (state.result.flags || []).length);
  const btn = $('#exportBtn');
  const agent = $('#sendAgentBtn');
  if (btn) btn.disabled = !ready;
  if (agent) agent.disabled = !ready;
}

/* ------------------------------------------------------------- agent send */

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function sendToAgent() {
  if (!state.result) return;
  const d = state.result;

  // Open the chat on the click itself: opening after an await is blocked as a popup.
  const win = window.open(AGENT_URL, '_blank');
  if (win) { try { win.opener = null; } catch (_) {} }

  const btn = $('#sendAgentBtn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing PDF…'; }

  try {
    const res = await fetch('/api/report.pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        style: d.style,
        flags: d.flags,
        decisions: state.decisions,
        counts: d.counts,
        compared: d.compared || 3,
        partial: Boolean(d.partial),
        unread: d.unread || [],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: 'The PDF could not be built.' }));
      throw new Error(e.error || res.statusText);
    }
    const blob = await res.blob();
    const slug = String(d.style || 'order').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'order';
    downloadBlob(blob, `speccheck-${slug}.pdf`);
    const noBot = !/#@/.test(AGENT_URL);
    const where = win
      ? 'The agent chat opened in a new tab — attach that file there and send it.'
      : 'Your browser blocked the new tab; open <a href="' + esc(AGENT_URL) + '" target="_blank" rel="noopener">the agent chat</a> and attach the file.';
    const botHint = noBot
      ? '<br><strong>No bot is set yet:</strong> put <code>TELEGRAM_AGENT_URL=https://web.telegram.org/k/#@your_bot</code> in <code>.env</code> so this opens your bot instead of the Telegram start page.'
      : '';
    notice(`Report saved as <code>speccheck-${esc(slug)}.pdf</code>. ${where}${botHint}`, 'info');
  } catch (err) {
    notice(`Could not prepare the PDF: ${esc(err.message || String(err))}`, '');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || 'Send to Agent'; }
  }
}

/* --------------------------------------------------------------- export */

function exportReport() {
  if (!state.result) return;
  const d = state.result;
  const rows = (d.flags || []).map((f) => {
    const dec = state.decisions[f.id] || 'not reviewed';
    const vals = (f.values || []).map((v) => `<td>${esc(v.missing ? '—' : v.value)}<br><span class="q">${esc(v.quote || '')}</span></td>`).join('');
    return `<tr>
      <td><strong>${esc(f.priority)}</strong></td>
      <td>${esc(f.label || f.field)}</td>
      ${vals}
      <td>${esc(f.warning || '')}</td>
      <td><strong>${esc(dec)}</strong></td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SpecCheck report — ${esc(d.style)}</title>
  <style>
    body{font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#161e30;background:#f4efe6;padding:36px;max-width:1100px;margin:0 auto}
    h1{font:600 26px/1.1 Georgia,serif;margin:0 0 4px}
    .meta{color:#6d7488;font-size:12px;margin-bottom:22px}
    table{width:100%;border-collapse:collapse;background:#fbf8f2;border:1px solid #d6ccb8}
    th,td{text-align:left;padding:10px;border-bottom:1px solid #e4dccb;vertical-align:top;font-size:12.5px}
    th{background:#161e30;color:#f4efe6;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
    .q{color:#8a8578;font-style:italic;font-size:11px}
    footer{margin-top:22px;font-size:11.5px;color:#6d7488}
  </style></head><body>
  <h1>SpecCheck report — order ${esc(d.style)}</h1>
  <p class="meta">${(d.flags || []).length} issues · generated ${new Date().toLocaleString()} · documents compared: Tech pack / Purchase order / Factory sheet</p>
  <table><thead><tr><th>Priority</th><th>Field</th><th>Tech pack</th><th>Purchase order</th><th>Factory sheet</th><th>Warning</th><th>Decision</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <footer>AI reads and compares. A human makes the final call. SpecCheck does not approve orders.</footer>
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `speccheck-${String(d.style || 'order').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------------------------------------------------------- demo */

async function loadDemo({ autorun } = {}) {
  state.demo = true;
  const files = { techpack: 'techpack.txt', purchase_order: 'purchase_order.txt', factory_sheet: 'factory_sheet.txt' };
  for (const [key, name] of Object.entries(files)) {
    const res = await fetch(`/samples/${name}`);
    const text = await res.text();
    state.texts[key] = text;
    state.files[key] = null;
    const ta = document.querySelector(`[data-text="${key}"]`);
    if (ta) ta.value = text;
    const slot = document.querySelector(`[data-slot="${key}"]`);
    if (slot) slot.classList.add('filled');
    setStatus(key, 'demo text', true);
  }
  notice('Demo order loaded: one overshirt, three documents, six planted disagreements.', 'info');
  if (autorun) await run();
}

async function loadFallback() {
  try {
    const res = await fetch('/samples/demo-result.json');
    const data = await res.json();
    state.result = data;
    renderResult(data);
    syncExport();
  } catch (e) {
    $('#result').innerHTML = '<div class="empty"><h3>Demo unavailable</h3><p>The pre-computed demo result could not be loaded.</p></div>';
  }
}

/* ---------------------------------------------------------------- init */

async function init() {
  renderSlots();
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    $('#modelLine').textContent = `${h.model} · key ${h.hasKey ? 'present' : 'missing'}`;
    if (h.telegramAgentUrl) AGENT_URL = h.telegramAgentUrl;
    if (!h.hasKey) {
      notice('No API key on the server. Add <code>DEEPSEEK_API_KEY</code> to <code>.env</code> and restart. The demo order still works — it falls back to a pre-computed result.', '');
    }
  } catch (e) {
    $('#modelLine').textContent = 'server unreachable';
    notice('The server is not responding. Start it with <code>npm start</code>.', '');
  }

  $('#runBtn').addEventListener('click', run);
  $('#demoBtn').addEventListener('click', () => loadDemo({ autorun: true }));
  $('#exportBtn').addEventListener('click', exportReport);
  $('#sendAgentBtn').addEventListener('click', sendToAgent);
  $('#clearBtn').addEventListener('click', () => location.reload());

  const params = new URLSearchParams(location.search);
  if (params.get('demo')) loadDemo({ autorun: true });
}

document.addEventListener('DOMContentLoaded', init);
