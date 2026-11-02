'use strict';
/**
 * Report PDF — the same facts as the HTML export, laid out for sending to someone.
 * Uses built-in PDF fonts (Times/Helvetica) so no font files have to be shipped.
 */
const PDFDocument = require('pdfkit');

const INK = '#161e30';
const SOFT = '#4b5468';
const FAINT = '#6f7488';
const RED = '#a8342a';
const RULE = '#d6ccb8';
const PAPER = '#ffffff';

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

function drawHeader(doc, { style, meta }) {
  doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(8).text('SPECCHECK', { characterSpacing: 1 });
  doc.moveDown(0.4);
  doc.fillColor(INK).font('Times-Bold').fontSize(22).text(String(style || 'Untitled order').slice(0, 90));
  doc.moveDown(0.25);
  doc.fillColor(FAINT).font('Helvetica').fontSize(8.5).text(meta, { lineGap: 1 });
  doc.moveDown(0.7);
  doc.moveTo(48, doc.y).lineTo(547, doc.y).lineWidth(0.8).strokeColor(INK).stroke();
  doc.moveDown(0.9);
}

function ensureRoom(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
}

function valueFor(flag, docKey) {
  const v = (flag.values || []).find((x) => x.doc === docKey);
  if (!v) return '—';
  if (v.unread) return 'not read';
  if (v.missing || v.value == null || v.value === '') return 'not stated';
  const s = String(v.value);
  return s.length > 64 ? s.slice(0, 61).trimEnd() + '…' : s;
}

function drawFlag(doc, flag, decision) {
  ensureRoom(doc, 128);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  const tagW = 46;
  const tagColor = flag.priority === 'High' ? RED : flag.priority === 'Medium' ? '#8a6a3f' : SOFT;
  doc.rect(left, doc.y, tagW, 13).fillColor(tagColor).fill();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
    .text(String(flag.priority || '—').toUpperCase(), left, doc.y + 3.5, { width: tagW, align: 'center' });

  doc.fillColor(INK).font('Times-Bold').fontSize(11.5)
    .text(String(flag.label || flag.field || ''), left + tagW + 8, doc.y - 1, { width: right - left - tagW - 8 });

  doc.moveDown(0.35);

  const colW = (right - left) / 3;
  const cols = [
    ['TECH PACK', valueFor(flag, 'techpack')],
    ['PURCHASE ORDER', valueFor(flag, 'purchase_order')],
    ['FACTORY SHEET', valueFor(flag, 'factory_sheet')],
  ];
  const y0 = doc.y;
  let tallest = 0;
  cols.forEach((c, i) => {
    const x = left + i * colW;
    const unread = c[1] === 'not read';
    const blank = c[1] === 'not stated';
    doc.fillColor(FAINT).font('Helvetica').fontSize(6.5).text(c[0], x, y0, { width: colW - 8 });
    doc.fillColor(unread || blank ? FAINT : INK).font(unread || blank ? 'Helvetica-Oblique' : 'Helvetica-Bold').fontSize(9)
      .text(c[1], x, y0 + 9, { width: colW - 8 });
    tallest = Math.max(tallest, doc.heightOfString(c[1], { width: colW - 8 }) + 9);
  });
  doc.y = y0 + tallest + 6;

  if (flag.warning) {
    doc.fillColor(INK).font('Helvetica').fontSize(8.6)
      .text(String(flag.warning), left, doc.y, { width: right - left, lineGap: 1.6 });
  }
  if (flag.reason) {
    doc.moveDown(0.15);
    doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(7.4)
      .text(`Why ${String(flag.priority || '').toLowerCase()}: ${flag.reason}`, left, doc.y, { width: right - left });
  }
  doc.moveDown(0.2);
  doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(7.6)
    .text(`Decision: ${String(decision || 'not reviewed')}`, left, doc.y, { width: right - left });
  doc.moveDown(0.5);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).dash(1, { space: 2 }).strokeColor(RULE).stroke().undash();
  doc.moveDown(0.7);
}

function buildReportPdf(payload) {
  const flags = Array.isArray(payload.flags) ? payload.flags : [];
  const decisions = payload.decisions || {};
  const sorted = [...flags].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3)
  );

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, bottom: 56, left: 48, right: 48 },
    info: {
      Title: `SpecCheck report — ${payload.style || 'order'}`,
      Author: 'SpecCheck · Team Blaze Protocol',
      Subject: 'Order specification comparison',
    },
  });

  const counts = payload.counts || {};
  const compared = payload.compared || 3;
  const generated = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });

  drawHeader(doc, {
    style: payload.style,
    meta: [
      `${counts.total ?? flags.length} issues · ${counts.high ?? ''} high · ${counts.medium ?? ''} medium · ${counts.low ?? ''} low`,
      `${compared} of 3 documents compared${payload.partial ? ' — ' + (payload.unread || []).join(', ') + ' could not be read' : ''}`,
      `Generated ${generated} (Asia/Dhaka)`,
    ].join('\n'),
  });

  if (!sorted.length) {
    doc.fillColor(SOFT).font('Helvetica').fontSize(10)
      .text('No conflicts were found in the documents that could be read. Nothing here is an approval.');
  }

  sorted.forEach((flag) => drawFlag(doc, flag, decisions[flag.id]));

  ensureRoom(doc, 40);
  doc.fillColor(FAINT).font('Helvetica').fontSize(7.6)
    .text('AI reads and compares. A human makes the final call. SpecCheck never approves an order, edits a document or contacts a supplier.',
      doc.page.margins.left, doc.y, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.fillColor(FAINT).font('Helvetica').fontSize(7.6)
    .text('SpecCheck · Team Blaze Protocol · AIVenture Innovation, Track A');

  return doc;
}

module.exports = { buildReportPdf, PAPER };
