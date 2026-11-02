'use strict';
/**
 * SpecCheck server
 * - extracts specs from tech pack / purchase order / factory sheet
 * - compares them deterministically, then asks the model to judge + write warnings
 * The API key never leaves this process.
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const OpenAI = require('openai');
const { buildReportPdf } = require('./pdf-report');

const PORT = process.env.PORT || 3000;
const MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim();
const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const TELEGRAM_AGENT_URL = (process.env.TELEGRAM_AGENT_URL || 'https://web.telegram.org/k/').trim();

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

let client = null;
function llm() {
  if (!API_KEY) {
    const e = new Error('MISSING_KEY');
    e.code = 'MISSING_KEY';
    throw e;
  }
  if (!client) client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
  return client;
}

/* ------------------------------------------------------------------ model */

function friendlyModelError(err) {
  const raw = err && (err.message || String(err));
  const status = err && err.status;
  if (/model/i.test(raw) && (status === 400 || status === 404 || /not ?found|does not exist|invalid/i.test(raw))) {
    return `The model "${MODEL}" was rejected by ${BASE_URL} (HTTP ${status || 'n/a'}). Set DEEPSEEK_MODEL in .env to a model your key can use. Real error: ${raw}`;
  }
  if (/401|invalid.?api.?key|unauthor/i.test(raw)) {
    return `The DeepSeek key was rejected (HTTP ${status || 401}). Check DEEPSEEK_API_KEY in .env. Real error: ${raw}`;
  }
  return raw;
}

// deepseek-v4-flash is a reasoning model: reasoning_tokens are billed inside
// max_tokens, so a tight budget truncates the JSON (or empties it entirely).
async function callJson(system, user, maxTokens = 8000, attempt = 1) {
  const c = llm();
  const res = await c.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const choice = res.choices?.[0] || {};
  const finish = choice.finish_reason;
  let text = (choice.message?.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  if (!text && attempt === 1) {
    console.warn('[llm] empty content, finish_reason=' + finish + ' — retrying with a larger budget');
    return callJson(system, user, Math.min(maxTokens * 2, 16000), 2);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fall through */ } }
    if (finish === 'length' && attempt === 1) {
      console.warn('[llm] truncated at ' + maxTokens + ' tokens — retrying with a larger budget');
      return callJson(system, user, Math.min(maxTokens * 2, 16000), 2);
    }
    const why = finish === 'length'
      ? 'the reply hit the token limit before the JSON closed'
      : `finish_reason=${finish}, ${text.length} chars returned`;
    throw new Error(`Model returned non-JSON (${why}): ${text.slice(0, 160)}`);
  }
}

/* --------------------------------------------------------------- extract */

function toTextFromWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    return `# sheet: ${name}\n${csv}`;
  }).join('\n\n');
}

async function fileToText(file) {
  const name = (file.originalname || '').toLowerCase();
  const ext = path.extname(name);
  if (ext === '.pdf' || file.mimetype === 'application/pdf') {
    try {
      const text = await pdfToText(file.buffer);
      if (text.trim().length > 20) return { text, kind: 'pdf' };
      throw new Error('no text layer');
    } catch (primary) {
      // second opinion from the older parser before giving up
      try {
        const parsed = await pdfParse(file.buffer);
        if ((parsed.text || '').trim()) return { text: parsed.text, kind: 'pdf' };
      } catch (_) { /* fall through to the readable error */ }
      const e = new Error(
        'This PDF could not be read: its internal index is damaged or the file is a scan with no text layer. ' +
        'Re-save or export the PDF from the original program, or paste the text into the box instead. ' +
        `(reader said: ${primary.message})`
      );
      e.code = 'BAD_PDF';
      throw e;
    }
  }
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    return { text: toTextFromWorkbook(file.buffer), kind: 'sheet' };
  }
  return { text: file.buffer.toString('utf8'), kind: 'text' };
}

/* PDF reading with recovery. pdf.js refuses a PDF whose cross-reference table is
   malformed; `stopAtErrors: false` makes it rebuild the index from the object
   stream instead, which is what a human opening the file would see. */
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLib;
}

async function pdfToText(buf) {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(buf),
    stopAtErrors: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      const s = item.str || '';
      line += s;
      if (item.hasEOL) { out.push(line.trimEnd()); line = ''; }
      else if (s && !/\s$/.test(s)) line += ' ';
    }
    if (line.trim()) out.push(line.trimEnd());
    out.push('');
  }
  const pages = doc.numPages;
  await doc.destroy();
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error(`no text layer in ${pages} page(s)`);
  return text;
}

const EXTRACT_SYSTEM = `You extract garment specifications from a single document. The document is one of:
TECH PACK, PURCHASE ORDER, or FACTORY SHEET.
Return JSON only, exactly this shape:
{
  "doc_kind": "tech_pack|purchase_order|factory_sheet|unknown",
  "style_name": null,
  "color": null,
  "fabric": null,
  "composition": null,
  "quantity": null,
  "ship_date": null,
  "sizes": [ { "size": "M", "measurements": { "chest_cm": 52 } } ],
  "care_label": null,
  "trims": null,
  "notes": null,
  "quotes": { "color": "exact words from the document" }
}
Rules:
- Copy values verbatim; do not translate, reformat or improve them.
- If a field is absent, its value MUST be null. Never guess, never infer from another field.
- quantity is a number only. ship_date is the date as written (string).
- measurements keys are snake_case point-of-measure with unit, e.g. chest_cm, body_length_cm, sleeve_cm.
- "quotes" maps each non-null field (and "sizes.M.chest_cm") to the exact source line, max 120 chars.
- care_label: the printed care/wash instruction text, or null if the document says nothing about care.`;

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    let text = '';
    let kind = 'pasted';
    if (req.file) {
      const r = await fileToText(req.file);
      text = r.text;
      kind = r.kind;
    } else {
      text = (req.body && req.body.text) || '';
    }
    text = String(text).replace(/\u0000/g, '').trim();
    if (!text) return res.status(400).json({ error: 'No readable text in that document.', detail: 'The file may be a scanned image; SpecCheck reads text-based PDFs only.' });
    if (text.length > 24000) text = text.slice(0, 24000);

    const docType = (req.body && req.body.docType) || 'unknown';
    const parsed = await callJson(
      EXTRACT_SYSTEM,
      `DOCUMENT TYPE HINT: ${docType}\n\n--- DOCUMENT START ---\n${text}\n--- DOCUMENT END ---`
    );
    res.json({
      ok: true,
      kind,
      doc_kind: parsed.doc_kind || docType,
      chars: text.length,
      fields: parsed,
      text_preview: text.slice(0, 400),
      model: MODEL,
    });
  } catch (err) {
    if (err.code === 'BAD_PDF') {
      console.error('[extract] BAD_PDF:', err.message);
      return res.status(400).json({ error: err.message, code: 'BAD_PDF' });
    }
    const msg = err.code === 'MISSING_KEY'
      ? 'No DEEPSEEK_API_KEY is set on the server. Add it to .env and restart.'
      : friendlyModelError(err);
    console.error('[extract]', err.code || '', err.message);
    res.status(err.code === 'MISSING_KEY' ? 503 : 502).json({ error: msg, detail: String(err.message || err) });
  }
});

/* --------------------------------------------------------------- compare */

const DOCS = ['techpack', 'purchase_order', 'factory_sheet'];
const LABEL = { techpack: 'Tech pack', purchase_order: 'Purchase order', factory_sheet: 'Factory sheet' };
const HIGH_FIELDS = ['quantity', 'ship_date', 'sizes'];

const norm = (v) => String(v == null ? '' : v)
  .toLowerCase()
  .replace(/[’'`]/g, '')
  .replace(/[^a-z0-9.+\-/ ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const num = (v) => {
  if (v == null) return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// A quote must read like a line from the document. Spreadsheet cells turn into
// "Blue,480,1440,1440,960,480,4800", which is noise on screen.
function cleanQuote(q) {
  if (!q) return '';
  const first = String(q).split(/\r?\n/)[0];
  let str = first.replace(/\s+/g, ' ').trim();
  if (/^[\d.,\s%+-]+$/.test(str)) return '';
  const commas = (str.match(/,/g) || []).length;
  const digits = (str.match(/\d/g) || []).length;
  if (commas >= 2 && digits / Math.max(str.length, 1) > 0.45) return '';
  if (str.length > 120) str = str.slice(0, 117).trimEnd() + '\u2026';
  return str;
}

function dateKey(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*([a-z]{3,9})\.?\s*,?\s*(\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3)]) return `${m[3]}-${String(MONTHS[m[2].slice(0, 3)]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  m = s.match(/([a-z]{3,9})\.?\s*(\d{1,2})\s*,?\s*(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3)]) return `${m[3]}-${String(MONTHS[m[1].slice(0, 3)]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  return norm(v);
}

function valuesEqual(field, a, b) {
  if (field === 'ship_date') return dateKey(a) === dateKey(b);
  if (field === 'quantity') {
    const x = num(a), y = num(b);
    return x != null && y != null ? x === y : norm(a) === norm(b);
  }
  return norm(a) === norm(b);
}

function collect(docs, field) {
  return DOCS.map((d) => {
    const f = docs[d] || {};
    const v = f[field];
    const q = (f.quotes && f.quotes[field]) || '';
    return { doc: d, value: v == null || v === '' ? null : v, quote: cleanQuote(q) };
  });
}

function measurementList(doc) {
  const out = {};
  const sizes = Array.isArray(doc.sizes) ? doc.sizes : [];
  for (const s of sizes) {
    if (!s || !s.size) continue;
    const sz = String(s.size).toUpperCase().trim();
    const ms = s.measurements || {};
    for (const pom of Object.keys(ms)) out[`${sz} ${pom}`] = ms[pom];
  }
  return out;
}

function buildCandidates(docs, unread = new Set()) {
  const entries = [];
  const gaps = [];

  const scalars = [
    ['style_name', 'Style name'], ['color', 'Colour'], ['fabric', 'Fabric'],
    ['composition', 'Composition'], ['quantity', 'Quantity'], ['ship_date', 'Ship date'],
    ['care_label', 'Care label'], ['trims', 'Trims'],
  ];

  // prose fields: compare presence only, never wording
  const PROSE = new Set(['trims', 'notes']);

  for (const [field, label] of scalars) {
    const slots = collect(docs, field);
    const present = slots.filter((s) => s.value != null);
    const missing = slots.filter((s) => s.value == null && !unread.has(s.doc));
    if (present.length >= 2 && !PROSE.has(field)) {
      const first = present[0];
      const differs = present.some((s) => !valuesEqual(field, first.value, s.value));
      if (differs) entries.push({ field, label, slots, kind: 'mismatch' });
    }
    if (present.length >= 1 && missing.length >= 1) {
      gaps.push({ field, label, slots, kind: 'gap' });
    }
  }

  // measurements per size — conflicts are per size, gaps are grouped per point of measure
  const perDoc = {};
  DOCS.forEach((d) => { perDoc[d] = measurementList(docs[d] || {}); });
  const keys = new Set();
  DOCS.forEach((d) => Object.keys(perDoc[d]).forEach((k) => keys.add(k)));
  const gapGroups = new Map();
  const sizeConflicts = [];

  for (const key of keys) {
    const slots = DOCS.map((d) => ({
      doc: d,
      value: perDoc[d][key] == null ? null : perDoc[d][key],
      quote: cleanQuote(((docs[d] || {}).quotes || {})[`sizes.${key}`] || ''),
    }));
    const present = slots.filter((s) => s.value != null);
    const [size, ...pomParts] = key.split(' ');
    const pom = pomParts.join(' ');

    if (present.length >= 2) {
      const first = num(present[0].value);
      const differs = present.some((s) => {
        const n = num(s.value);
        return first != null && n != null ? Math.abs(first - n) > 0.05 : norm(s.value) !== norm(present[0].value);
      });
      if (differs) {
        sizeConflicts.push({ size, pom, entry: { field: `size_${key}`, label: `${size} · ${pom.replace(/_/g, ' ')}`, slots, kind: 'mismatch', group: 'sizes' } });
      }
    }

    if (present.length >= 1 && present.length < DOCS.length) {
      for (const missingDoc of DOCS.filter((d) => perDoc[d][key] == null && !unread.has(d))) {
        const gk = `${pom}|${missingDoc}`;
        const g = gapGroups.get(gk) || { pom, missing: missingDoc, sizes: [] };
        g.sizes.push(size);
        gapGroups.set(gk, g);
      }
    }
  }

  // A size curve that is wrong the same way in every size is one finding, not forty.
  const byPom = new Map();
  for (const c of sizeConflicts) {
    const list = byPom.get(c.pom) || [];
    list.push(c);
    byPom.set(c.pom, list);
  }
  for (const [pom, list] of byPom) {
    const sig = (e) => e.entry.slots.map((s) => (s.value == null ? '∅' : String(s.value))).join('|');
    const uniform = list.length >= 3 && list.every((e) => sig(e) === sig(list[0]));
    if (uniform) {
      const sizes = list.map((e) => e.size);
      const span = sizes.length > 4 ? `${sizes[0]}–${sizes[sizes.length - 1]}` : sizes.join(', ');
      const diffs = list[0].entry.slots.filter((s) => s.value == null).length;
      entries.push({
        field: `sizegroup_${pom}`,
        label: `${pom.replace(/_/g, ' ')} · all ${sizes.length} sizes (${span})`,
        slots: list[0].entry.slots.map((s) => ({ ...s, value: s.value == null ? null : `${s.value}` })),
        kind: 'mismatch',
        group: 'sizes',
        grouped: true,
        sizesAffected: sizes.length,
        quote: '',
      });
    } else {
      list.forEach((e) => entries.push(e.entry));
    }
  }

  for (const g of gapGroups.values()) {
    const sizes = g.sizes.sort();
    const slots = DOCS.map((d) => {
      const has = sizes.filter((sz) => perDoc[d][`${sz} ${g.pom}`] != null);
      return { doc: d, value: has.length ? has.join(', ') : null, quote: '' };
    });
    gaps.push({
      field: `gap_${g.pom}_${g.missing}`,
      label: `${g.pom.replace(/_/g, ' ')} (${sizes.join(', ')})`,
      slots,
      kind: 'gap',
      grouped: true,
    });
  }

  return { entries, gaps };
}

function rulePriority(c) {
  const base = c.field.split(' ')[0];
  if (c.kind === 'gap') return base === 'care_label' ? 'Medium' : 'Low';
  if (base === 'quantity' || base === 'ship_date' || c.group === 'sizes') return 'High';
  if (base === 'color' || base === 'fabric' || base === 'composition') return 'High';
  if (base === 'style_name') return 'Medium';
  return 'Low';
}

const JUDGE_SYSTEM = `You are a garment sourcing checker. You receive candidate problems found by a deterministic
comparison of three documents describing ONE order: tech pack, purchase order, factory sheet.
For each candidate you must decide and return JSON only:
{ "verdicts": [ { "id": "c1", "equivalent": false, "priority": "High|Medium|Low", "warning": "", "reason": "" } ] }

Rules:
- "equivalent": true ONLY when the values mean the same thing to a factory (e.g. "Navy" vs "Navy Blue",
  "100% Cotton" vs "Cotton 100%", "15 Dec 2026" vs "2026-12-15"). If real production would change, false.
- Priority: measurement, quantity or ship date conflict = High. Colour/fabric/composition conflict = High,
  or Medium when it is a naming difference a merchandiser can resolve without remaking the garment.
  Missing care label or trims = Low, but escalate a MISSING care label to Medium because it blocks shipment.
- "warning": one or two sentences, plain language, no jargon, written for a merchandiser who must phone the
  factory. State which document says what and what could go wrong. Never say "AI detected".
- "reason": short justification for the priority.
- Use the candidate ids exactly as given. Return one verdict per candidate.`;

app.post('/api/compare', async (req, res) => {
  try {
    const docs = (req.body && req.body.docs) || {};
    if (!docs.techpack && !docs.purchase_order && !docs.factory_sheet) {
      return res.status(400).json({ error: 'Nothing to compare yet.', detail: 'Send docs for at least one document type.' });
    }
    const unread = new Set((req.body.unread || []).filter((k) => DOCS.includes(k)));
    const { entries, gaps } = buildCandidates(docs, unread);
    const candidates = [...entries, ...gaps].map((c, i) => ({ id: `c${i + 1}`, ...c }));

    const style = docs.techpack?.style_name || docs.purchase_order?.style_name || docs.factory_sheet?.style_name || 'Unnamed order';

    let verdicts = {};
    let aiOk = false;
    let aiError = null;

    if (candidates.length) {
      const payload = candidates.map((c) => ({
        id: c.id,
        kind: c.kind,
        field: c.label,
        values: c.slots.map((s) => ({ document: LABEL[s.doc], value: s.value, quote: cleanQuote(s.quote) })),
      }));

      // One call for 20+ findings overflows the token budget and truncates the JSON,
      // so judge in batches and merge. A failed batch only costs its own findings.
      const BATCH = 8;
      const chunks = [];
      for (let i = 0; i < payload.length; i += BATCH) chunks.push(payload.slice(i, i + BATCH));

      const settle = await Promise.all(chunks.map(async (batch) => {
        const body = JSON.stringify({ style, candidates: batch }, null, 0);
        try {
          const judged = await callJson(JUDGE_SYSTEM, body, 5000);
          return { verdicts: judged.verdicts || [], error: null };
        } catch (err) {
          // one retry at double the budget, then give up on this batch only
          try {
            const judged = await callJson(JUDGE_SYSTEM, body, 10000, 2);
            return { verdicts: judged.verdicts || [], error: null };
          } catch (err2) {
            console.error('[compare:judge]', err2.message);
            return { verdicts: [], error: friendlyModelError(err2) };
          }
        }
      }));

      settle.forEach((s) => s.verdicts.forEach((v) => { if (v && v.id) verdicts[v.id] = v; }));
      aiOk = Object.keys(verdicts).length > 0;
      const failed = settle.filter((s) => s.error);
      if (failed.length) {
        aiError = `${failed.length} of ${chunks.length} judgement batches failed, so those findings kept rule-based wording. ${failed[0].error}`;
      }
    }

    const flags = candidates
      .filter((c) => !(verdicts[c.id] && verdicts[c.id].equivalent === true))
      .map((c) => {
        const v = verdicts[c.id] || {};
        return {
          id: c.id,
          kind: c.kind,
          field: c.field,
          label: c.label,
          priority: (v.priority || rulePriority(c)),
          warning: v.warning || defaultWarning(c),
          reason: v.reason || '',
          ai: Boolean(v.priority),
          values: c.slots.map((s) => ({
            doc: s.doc,
            document: LABEL[s.doc],
            value: s.value,
            quote: s.quote,
            missing: s.value == null,
            unread: unread.has(s.doc),
          })),
        };
      })
      .sort((a, b) => {
        const order = { High: 0, Medium: 1, Low: 2 };
        return (order[a.priority] ?? 3) - (order[b.priority] ?? 3);
      });

    res.json({
      ok: true,
      style: style,
      partial: unread.size > 0,
      unread: [...unread],
      compared: DOCS.length - unread.size,
      ai: aiOk,
      ai_error: aiError,
      model: MODEL,
      counts: {
        total: flags.length,
        high: flags.filter((f) => f.priority === 'High').length,
        medium: flags.filter((f) => f.priority === 'Medium').length,
        low: flags.filter((f) => f.priority === 'Low').length,
        dismissed: candidates.length - flags.length,
      },
      flags,
    });
  } catch (err) {
    console.error('[compare]', err.message);
    res.status(500).json({ error: 'Comparison failed.', detail: String(err.message || err) });
  }
});

function defaultWarning(c) {
  const said = c.slots
    .filter((s) => s.value != null)
    .map((s) => `${LABEL[s.doc]} says ${s.value}`)
    .join(', ');
  const absent = c.slots.filter((s) => s.value == null).map((s) => LABEL[s.doc]);
  if (c.grouped && c.kind === 'gap') {
    return `${c.label} appears in the tech pack but is not stated in ${absent.join(' and ')}. Confirm the factory has the full measurement chart before cutting.`;
  }
  if (c.grouped && c.kind === 'mismatch') {
    return `${c.label} disagree by the same amount in every size: ${said}. One correction to the size chart fixes the whole run, but confirm which values are right before the spread is laid.`;
  }
  if (c.kind === 'gap') {
    return `${c.label} is given as ${said || 'blank'}, but ${absent.join(' and ')} omits it. Confirm the requirement before production.`;
  }
  return `${c.label} does not agree: ${said}. Confirm which value the factory should build to.`;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(API_KEY),
    model: MODEL,
    baseURL: BASE_URL,
    telegramAgentUrl: TELEGRAM_AGENT_URL,
  });
});

/* The report as a PDF, for sending to the agent chat. */
app.post('/api/report.pdf', (req, res) => {
  try {
    const payload = req.body || {};
    const slug = String(payload.style || 'order').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'order';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="speccheck-${slug}.pdf"`);
    const doc = buildReportPdf(payload);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('[report.pdf]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the PDF.', detail: String(err.message || err) });
    else res.end();
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`SpecCheck on http://localhost:${PORT}  ·  model: ${MODEL}  ·  key: ${API_KEY ? 'set' : 'MISSING'}`);
});
