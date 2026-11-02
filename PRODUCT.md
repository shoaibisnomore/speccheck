# PRODUCT.md — SpecCheck

## What it is
A spell-checker for clothing orders. One garment order is described in three documents —
**tech pack** (how to make it), **purchase order** (what the buyer ordered), **factory sheet**
(what the factory will actually produce). People compare them by eye and conflicts slip
through: Navy vs Blue, chest 52 vs 50 cm, ship 15 Dec vs 20 Dec, a care label that exists on
paper but not on the production sheet.

SpecCheck extracts structured specs from each document, compares them field by field, and
flags conflicts and gaps by priority with a plain-language warning a merchandiser can act on.

## Non-negotiables
- AI reads and compares. **A human always makes the final call.** SpecCheck never auto-approves.
- Missing values are `null`, never guessed.
- Every extracted value carries a source quote so the user can verify it in the document.
- Deterministic comparison first (code), model judgement second (semantics, priority, wording).

## Users
Textile/apparel merchandisers and sourcing staff in Bangladesh, China, Vietnam, Turkey — people
who already read these documents daily and lose money when the three disagree.

## Surface briefs
- `public/index.html` — **Persuade**. Landing page. Editorial textile world: warm paper, ink
  navy, signal red reserved for conflicts only. Serif display (Fraunces), sans body (Inter).
- `public/app.html` — **Operate**. The tool. Same palette, tighter density, scanability first.

## Assumptions made from the brief (no interview was run — the brief was explicit)
1. Single-user, local tool: no auth, no database. Decision state lives in the browser.
2. The DeepSeek model id is used exactly as specified (`deepseek-v4-flash`) and failures are
   surfaced loudly rather than silently substituted.
3. Document uploads are PDF/XLSX/CSV/pasted text; no OCR for scanned images.
4. The demo order is the acceptance test: it must report the planted conflicts and invent none.
