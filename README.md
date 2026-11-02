# SpecCheck

A spell-checker for clothing orders. Upload the **tech pack**, the **purchase order** and the
**factory sheet** for one order; SpecCheck extracts the same fields from each, compares them, and
flags conflicts and gaps by priority with a plain-language warning. The human decides — nothing is
ever auto-approved.

## Install & run

```bash
cd speccheck
npm install
cp .env.example .env        # then paste your key
npm start                   # http://localhost:3000
```

`.env`:

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=3000
```

The key is read only by `server.js`. It is never sent to the browser: the frontend only talks to
`/api/*` on the same origin.

## File map

```
server.js              Express app: /api/extract, /api/compare, /api/health, static hosting
public/index.html      Landing page — hero, problem, cost, how-it-works, preview, glossary
public/app.html        The tool: document slots, results
public/app.js          Upload → extract → compare → flag → decide, plus report export
public/styles.css      Design tokens + both surfaces (paper, ink, signal red)
public/samples/*.txt   Demo order: tech pack, purchase order, factory sheet (planted errors)
public/samples/demo-result.json   Pre-computed result used when no model call can be made
PRODUCT.md             Product truth and the surface briefs
```

## API

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/extract` | multipart `file` + `docType`, or JSON `{text, docType}` | `{fields, quotes, chars}` — PDF via pdf-parse, XLSX/XLS/CSV via xlsx, else plain text |
| `POST /api/compare` | `{docs: {techpack, purchase_order, factory_sheet}}` (extracted fields) | `{style, flags[], counts, ai, ai_error}` |
| `POST /api/report.pdf` | the compare payload + `decisions` | a PDF of the same report (`pdfkit`) |
| `GET /api/health` | – | `{hasKey, model, baseURL, telegramAgentUrl}` |

Comparison is deterministic first: values are normalised in code (units, dates, case, commas) and
matched per field and per size/point-of-measure. Model calls then judge semantic equivalence
(`Navy` vs `Navy Blue`), assign priority, and write the warning a merchandiser would act on.

Judgement is **batched, 8 findings per call**. A single call over 20+ findings overflows the token
budget (reasoning tokens count against `max_tokens`) and the JSON truncates — that defect was hit in
testing and fixed; each batch now retries once at double the budget, and a failed batch only costs
its own findings. Any finding the model did not judge is marked **rule-based** in the UI.

A size curve that is wrong the same way in every size collapses into one finding
("chest cm · all 10 sizes (XS–6XL)"), while per-size differences stay separate.

Spreadsheet cells produce quotes like `Blue,480,1440,1440,960,480,4800`; those are dropped rather
than shown as evidence, and quotes are capped at 120 characters.

## The demo order

`Load demo order` fills all three slots with the sample documents. Planted disagreements:

| Field | Tech pack | Purchase order | Factory sheet |
|---|---|---|---|
| Colour | Navy | Navy | **Blue** |
| Chest (M) | 52 cm | 52 cm | **50 cm** |
| Chest (S / L) | 50 / 54 | 50 / 54 | **48 / 52** |
| Ship date | 15 Dec 2027 | 15 Dec 2027 | **20 Dec 2027** |
| Quantity | 1200 | 1200 | **1000** |
| Composition | 100% cotton | 100% cotton | **95% cotton, 5% elastane** |
| Care label | present | present | **absent** |

It also shows two genuine gaps: shoulder and sleeve are on the tech pack but not on the purchase
order, grouped into one Low flag each rather than one per size.

## Send to Agent

`Send to Agent` sits left of `Export report`. It builds the PDF report, saves it, and opens the
Telegram chat in a new tab so the report can be attached and sent.

Set the chat in `.env`:

```
TELEGRAM_AGENT_URL=https://web.telegram.org/k/#@your_bot
```

**What the browser will not do:** a page cannot attach a file into another origin's chat. There is no
Telegram URL that pre-fills an attachment, so the sequence is: PDF downloads → chat opens → you
drag the file in and send. The button says this rather than pretending the upload happened.

## Known limitations

- **PDF reading recovers from a damaged index.** Files that made the old parser fail with
  `bad XRef entry` are re-opened with `stopAtErrors: false`, which rebuilds the index; the
  recovered text is what a human opening the file would see. If both readers come back empty
  (a scan with no text layer), the document is rejected with an explanation instead of a stack trace.
- **Text PDFs only.** No OCR, so a scanned tech pack cannot be read — paste the text instead.
- **A partial comparison says so.** If one document cannot be read it is excluded rather than
  shown as "not stated": the header reads "2 of 3 documents compared", the column reads
  "not read", and gaps are never inferred from a document nobody could read.
- **`deepseek-v4-flash` is a reasoning model.** Reasoning tokens count against `max_tokens`; a tight
  budget truncates the JSON. The default is 8000 with one automatic retry at double the budget.
- **Priority can vary between runs.** The model judges severity, so a colour conflict may come back
  High on one run and Medium on the next. Deterministic checks (quantity, dates, measurements) are
  stable; the judgement layer is not.
- **Prose fields are presence-checked, not word-checked.** `trims` and `notes` are only flagged when
  a document is silent, because two people never write trims the same way.
- **Decisions live in the page.** Reload and they are gone; the export is the record.
- **No auth, no database.** Single user, localhost.
- Landing-page statistics are the two figures given in the brief (Apparel Resources; *Tekstilna
  Industrija* 2025) and are attributed, not independently verified here.
