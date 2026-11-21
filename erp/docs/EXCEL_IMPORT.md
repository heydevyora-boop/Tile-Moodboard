# Excel / Google Sheets Import — step 4

Loading the catalogue pipeline's output into the ERP, with a
preview, conservative duplicate detection, row-level errors and
arithmetic that has to add up.

**Nothing in the catalogue extraction system was changed.** No
Gemini prompt, no scanner, no Drive integration, no Sheets writing
workflow, no extraction script. The ERP reads that system's output;
it never writes to it.

---

## 1. Inspection report

### 1.1 What was inspected

| | Found |
|---|---|
| ERP structure | `erp/` — Vite + React frontend, Express + Prisma 7 server, own PostgreSQL database |
| Prisma schema | 27 models before this step, 3 migrations |
| Product Master | `server/services/product.service.mjs`, `brand.service.mjs`, `productHead.service.mjs`, zod route schemas |
| Hierarchy | Brand → `collections` (Product Head) → `products` (Variant, carries the SKU) |
| Extraction system | `catalog_processor/` — Python, writes to Google Sheets via `app/google_services.py` |
| Spreadsheet structure | `MASTER_SHEETS` in `app/google_services.py` — **read, not assumed** |
| Existing import models | **None.** Nothing import-related existed. |

### 1.2 The source, as it actually is

The pipeline maintains **one Google Sheet with nine tabs**. The ERP
reads `MASTER`:

```
BRANDS  CATALOGS  MASTER  SANITARY  FAUCETS  BASINS  WC  FLUSH_PLATES  SETTINGS
```

`MASTER` has **47 columns**, header row first, written by
`append_product()`:

```
Product ID · Brand ID · Brand · Catalog ID · Catalog · PDF Name ·
Product Name · SKU / Product Code · Page · Image Index · Drive URL ·
Image Filename · Finish Override · Finish Extracted · Finish AI ·
Finish Source · Resolved Finish · Budget Override · Budget Source ·
Resolved Budget · Suitable for Wall · Suitable for Floor ·
Bathroom Wall · Bathroom Floor · Shower Area · Highlight Suitable ·
Floor / Wall · Application Source · Dimensions · Length · Width ·
Thickness · Format · Slip Rating · PEI · DCOF · Technical Notes ·
AI Style · AI Color · AI Tone · AI Pattern · AI Veining ·
AI Contrast · AI Classification Status · AI Classification Source ·
Status · Notes
```

The other six product tabs are separate families with their own,
shorter column lists. **Only MASTER is mapped**; the rest are
listed in `mapping.mjs` so adding one later is a mapping entry
rather than another inspection.

### 1.3 Three findings that changed the design

**ONE MASTER ROW IS ONE EXTRACTED IMAGE, NOT ONE PRODUCT.** The
pipeline builds its identifier as

```python
make_product_id(brand, catalog, image_index)   # ARCHROCK-ADOBE-0001
```

— brand, catalogue and the index of the image on the page. The same
physical tile photographed on two pages is **two rows with two
Product IDs**, and the sheet cannot say they are the same thing. So
the ERP must not create one product per row, and the row
fingerprint deliberately excludes `Product ID`.

**SEVEN FIELDS THE BRIEF EXPECTED DO NOT EXIST IN THE SOURCE.**
Checked against `MASTER_SHEETS`, under every spelling:

| Expected | Reality |
|---|---|
| Purchase price | **No price column of any kind.** The pipeline reads catalogues, which do not print trade prices. |
| Selling price | Same. The ERP is the only place a price exists. |
| Collection / Series | `Catalog` is the **PDF** a product was found in, not a series. A PDF may hold several series; a series may span PDFs. |
| Material | No column. |
| Unit | No column. |
| Colour | Only `AI Color` — a model's reading of a photograph, with its own `AI Classification Status`. |
| Description | Closest are `Technical Notes` and `Notes`, both free text. |

Imported products therefore arrive with **price zero and no product
head**, and the preview says so on screen rather than leaving
somebody to discover it.

**NO LIVE GOOGLE SHEETS CONNECTION EXISTS IN THIS ENVIRONMENT.**

```
GOOGLE_SHEET_ID              not set
GOOGLE_SERVICE_ACCOUNT_JSON  not set
credentials.json             not present
token.json                   not present
```

So **Google Sheets import is implemented but NOT verified**, and
is reported as unavailable everywhere — in the API, on the screen
and in the tests. It refuses to run rather than returning anything
that could be mistaken for data. See §9.

---

## 2. Source-to-ERP mapping

| MASTER column | ERP field | Notes |
|---|---|---|
| `Brand` | `brands.name` | Matched on the normalised name; created if unknown. **Mandatory.** |
| `Product Name` | `products.name` | **Mandatory.** |
| `Dimensions` | `products.size` | **Mandatory.** Falls back to `Length` × `Width`. |
| `Length`, `Width` | `products.lengthMm`, `widthMm` | |
| `Thickness` | `products.thicknessMm` | Required by the tile categories. |
| `Finish Override` → `Finish Extracted` → `Resolved Finish` → `Finish AI` | `products.finish` | First non-placeholder wins, in that order. |
| `AI Color` | `products.colour` | Flagged AI-derived. |
| `Floor / Wall`, `Suitable for Wall/Floor` | `products.categoryId` | FLOOR or WALL. Neither → the row goes to review. |
| `SKU / Product Code` | `products.sku` | Used where present; otherwise generated. |
| `Drive URL` | `product_images.url` | `source = CATALOGUE_EXTRACTION`, **`isApproved = false`**. |
| `Catalog`, `Page` | `product_images.catalogueName`, `cataloguePage` | Provenance. |
| `Product ID` | `product_images.extractionRef` | A loose string, never a foreign key. |
| `Format`, `Slip Rating`, `PEI`, `DCOF`, `AI Style`, `AI Tone`, `Resolved Budget`, `Notes` | kept on the import row | Evidence, not product data. |
| *(not in source)* | `purchasePrice`, `sellingPrice` | Zero. Not invented. |
| *(not in source)* | `collectionId` (Product Head) | **Left null.** |

`UNKNOWN`, `NOT_CLASSIFIED`, `N/A`, `-` and `NA` are treated as
**absent**, not as values — otherwise "nobody knows" becomes a
product attribute.

---

## 3. Architecture

```
catalogue extraction (unchanged)  ->  Google Sheet MASTER tab
                                              |
                                      export .xlsx / .csv
                                              |
   upload  ->  read  ->  map  ->  validate  ->  classify  ->  PREVIEW
                                                                 |
                                                   explicit confirmation
                                                                 |
                                            Product Master services  ->  ERP PostgreSQL
                                                                 |
                                                            reconcile
```

**It goes through the Product Master services, not around them.**
`productService.create()` does the category-aware validation, the
SKU allocation, the duplicate check and the audit row. An import
writing to `products` directly would be a second, weaker set of
rules — and the weaker one always wins, because it is the one that
loads nine hundred rows at a time.

---

## 4. Database changes

Migration `20261121082324_import_batches_and_rows`. **Additive
only** — no `DROP`, no `TRUNCATE`, no `DELETE`. The 14 products and
12 ledger entries already in the development database survived it.

**`import_batches`** — batch number, source type and reference,
sheet, fingerprint, status, reconciliation status, expected and
read row counts, eleven counters, error summary, who and when.

**`import_rows`** — source row number, fingerprint, the raw row,
the mapped row, status, duplicate classification, field errors,
matched and created product, attempts, last error.

### The guards

```sql
import_batch_completed_means_finished   -- COMPLETED requires: nothing pending,
                                        -- nothing failed, reconciliation not
                                        -- FAILED, and the categories summing
                                        -- to the rows read
import_batch_errors_still_add_up        -- COMPLETED_WITH_ERRORS must still add up
import_batch_counts_not_negative
import_row_imported_has_a_product
```

Plus `v_import_reconciliation`, which recomputes every batch total
from its own rows. A healthy database returns nothing from:

```sql
SELECT * FROM v_import_reconciliation WHERE NOT counts_agree;
```

These proved stronger than expected: **a corrupted counter cannot
be written at all.** The test that was going to corrupt one and
watch the view catch it had to be rewritten to assert the refusal
instead.

---

## 5. API

| Method | Path | |
|---|---|---|
| GET | `/api/imports/sources` | what is available, what is not, and why |
| POST | `/api/imports/inspect` | header analysis without creating a batch |
| POST | `/api/imports/upload` | read, map, validate, classify — **writes no products** |
| POST | `/api/imports/google-sheets` | always 501, naming the missing configuration |
| GET | `/api/imports/batches` | history |
| GET | `/api/imports/batches/:id` | one batch, with its totals recomputed |
| GET | `/api/imports/batches/:id/preview` | row-level preview |
| POST | `/api/imports/batches/:id/confirm` | import — the only call that writes |
| POST | `/api/imports/batches/:id/retry` | retry only the failed rows |
| GET | `/api/imports/batches/:id/errors.csv` | error report |

Upload is raw bytes with the filename in a header: one file, no
multipart boundary parsing, no extra library to keep patched.

---

## 6. Validation rules

| Check | Outcome |
|---|---|
| Brand missing | `INCOMPLETE`, field `Brand` |
| Product name missing | `INCOMPLETE`, field `Product Name` |
| Size missing (no Dimensions, no Length+Width) | `INCOMPLETE`, field `Dimensions` |
| Category undecidable | `REVIEW_REQUIRED`, field `Floor / Wall` |
| Category's own required fields missing | `INCOMPLETE` |
| Number that is not a number | the field becomes **null**, never `0` |

Errors name the **source column**, not the ERP field — the person
fixing it is looking at a spreadsheet.

Every failing field is reported at once. `INCOMPLETE` rather than
`REJECTED` for a missing mandatory field: the row is not wrong, it
is unfinished.

---

## 7. Duplicate detection

Conservative. Every rule either proves a match or hands the
decision to a person.

| Order | Check | Result |
|---|---|---|
| 1 | Source SKU already in the ERP | `EXISTING_RECORD` → skipped, not overwritten |
| 2 | Fingerprint imported by an earlier batch | `EXACT_DUPLICATE` → skipped |
| 3 | Brand + name + size + colour + finish + thickness all match | `EXACT_DUPLICATE` → skipped |
| 4 | Brand + name match, attributes differ | `POSSIBLE_DUPLICATE` → **human review**, with the candidates and the differing attribute named |
| 5 | Nothing matches | `NEW_RECORD` |

**Nothing is merged on name similarity.** A 600×1200 and an
800×1600 of the same tile are two products the studio stocks,
prices and sells separately; so are the matte and the glossy. The
cost runs one way: a duplicate to merge is an afternoon's
annoyance, two variants silently merged is stock and order history
attached to a product that no longer distinguishes what was sold.

### The fingerprint

`sha256(brand · name · size · colour · finish · thickness)`, each
normalised for case and spacing. A changed note, a re-extracted
image or a new AI tone does **not** change it — which is what makes
re-importing an updated sheet a no-op on the rows it already has.
It excludes the pipeline's `Product ID`, for the reason in §1.3.

---

## 8. Reconciliation

After every import the rows are recounted and compared:

```
imported + duplicate + existing + incomplete + review + rejected
  + failed + pending  ==  rows read
```

Mutually exclusive — a row is in exactly one category.

| Outcome | |
|---|---|
| `PASSED` | everything adds up, and the source's own count matched |
| `UNVERIFIED` | the source could not report a row count, so completeness is unknowable. **Not** reported as passed. |
| `FAILED` | the numbers disagree. The batch is left `FAILED` with the discrepancy written out. |

A batch is `COMPLETED` only when nothing is pending or failed and
reconciliation did not fail; otherwise `COMPLETED_WITH_ERRORS` or
`FAILED`. The database enforces this, not just the code.

---

## 9. Google Sheets: implemented, not verified

**This has never run against the studio's spreadsheet.** It is
written to MASTER's real column list, read out of the pipeline's
own source, and it refuses to run.

To enable it:

```
ERP_GOOGLE_SHEET_ID         the spreadsheet to read
ERP_GOOGLE_SERVICE_ACCOUNT  a service-account JSON with READ access
```

Deliberately **its own variables**, not the pipeline's
`GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`: the ERP reads
that sheet and must never inherit the pipeline's **write**
credentials, or an ERP bug could rewrite the catalogue the studio
depends on.

Even once configured, the adapter stays disabled until somebody has
run a real import and confirmed it. That is not something the code
can establish about itself.

**Until then: File → Download → Microsoft Excel, and upload it.**
That path is tested end to end.

---

## 10. Security

| | |
|---|---|
| Formula injection | Formula cells yield their **cached result**, never the formula. Anything still starting `= + - @` is prefixed with `'`. Applied on read and again in the CSV error report. |
| Formula evaluation | Never. Nothing is computed. |
| File type | `.xlsx`, `.xlsm`, `.csv` only. **`.xls` is refused** — the old binary format needs a parser with a much worse history, and the pipeline writes neither. |
| Size | 15 MB, checked at the parser (20 MB) before buffering and again as a business limit. |
| Malformed files | Caught; a clear message, never a stack trace. |
| Control characters | Stripped. |
| Secrets | None logged, none returned. The Sheets refusal names variable **names**, never values. |
| Exposure | The API binds to `127.0.0.1` only. |

**Authentication is still the step-3 development placeholder** — a
user resolved from an `x-erp-user` header. No new authentication
was built, as instructed. The API must stay on localhost until real
sign-in exists; import is the most destructive thing the ERP can do
and it is protected by nothing but that binding.

---

## 11. Test report

All suites, actual counts, on an isolated database
(`devyora_erp_test`) that the runner refuses to replace with any
name not containing "test".

| Suite | Checks | |
|---|---|---|
| `npm run test:import` | **82 / 82** | the import engine |
| `npm run test:product-master` | **92 / 92** | step 3, still passing |
| `npm run db:verify` | **41 / 41** | step 2, still passing |
| `npm run test:frontend` | **48 / 48** | all fifteen screens |
| `npm run test:data` | **35 / 35** | the demo data the unconnected screens use |
| | **298 / 298** | |

Production build clean.

### The 25 required cases

| | Case | Where |
|---|---|---|
| 1 | Valid Excel import | 1a–1h — 3 rows in, 3 products out, verified by count |
| 2 | Google Sheets import | 2a–2d — **not verified**, and proven to refuse |
| 3 | Missing brand | 3a |
| 4 | Missing product name | 3b |
| 5 | Missing tile size | 3c |
| 6 | Category-aware validation | 4a–4d |
| 7 | Invalid numeric values | 5a–5b |
| 8 | Duplicate SKU | 5e–5f (product master suite) |
| 9 | Exact duplicate row | 6a–6e |
| 10 | Possible duplicate row | 6f–6h |
| 11 | Different sizes stay separate | 7a–7c |
| 12 | Different finishes stay separate | 7d |
| 13 | Partial batch failure | 8a–8c |
| 14 | Retry failed rows | 8d–8g |
| 15 | Re-import without duplicates | 6a, 6c — product count unchanged |
| 16 | Fingerprint consistency | 9a–9c |
| 17 | Import batch history | 10a–10c |
| 18 | Row-level error reporting | 10d–10e |
| 19 | Reconciliation success | 11a–11c |
| 20 | Reconciliation failure | 11f–11i |
| 21 | Unverified source row count | 12a–12b |
| 22 | Concurrent import attempts | 13a–13c |
| 23 | No stock movement created | 14a–14b |
| 24 | Product Master data preserved | 15a–15d |
| 25 | Frontend regression | `test:frontend`, 48 checks |

Plus file handling: 17a–17d.

### Three real bugs the tests found

1. **`"about nine"` became a thickness of 0.** Stripping non-digits
   left an empty string, and `Number('')` is `0` — which is finite,
   so the obvious guard passed it. A tile would have arrived with a
   thickness of zero millimetres looking like data.
2. **A batch that lost a row could not be reconciled at all.**
   `reconcile()` wrote the counters and the status in two
   statements; the CHECK constraint refused the first, so the
   function threw instead of marking the batch `FAILED` — the one
   case it exists for. Counters and status now go in together.
3. **A concurrency check passed over an empty result.** Not in this
   suite but worth repeating from step 3: a set of zero SKUs has no
   duplicates in it.

---

## 12. Screens

`/transfer` — **Import / Export**, marked *live* in the sidebar.

- **New import** — the two sources, with Google Sheets shown as
  unavailable and **no button that would call it**; a header
  analysis of the chosen file before anything is created; and a
  panel listing the fields the source does not carry.
- **Preview** — totals, reconciliation, source completeness, and
  every row with its status, its problem and what it matched.
  Rows needing review import only behind an explicit tick.
- **Import history** — every batch, never deleted, with its counts
  and reconciliation status.
- **Batch details** — row-level errors, a CSV error report, and a
  retry that touches only the failed rows.
- **Export** — a labelled placeholder. It was not in this phase, and
  the earlier prototype's export buttons were removed rather than
  left looking functional.

---

## 13. Known limitations

1. **Google Sheets is not verified.** §9.
2. **Authentication is a development placeholder.** The API must
   stay on localhost.
3. **Only the MASTER tab is mapped.** SANITARY, FAUCETS, BASINS, WC
   and FLUSH_PLATES are separate families, not yet mapped.
4. **Imported products have no price and no product head.** The
   source carries neither. Both need a person.
5. **Existing products are never updated by an import.** A match is
   skipped, because no update rule has been approved. "Update the
   price if it changed" is a decision, not a default.
6. **Colour is AI-derived.** `AI Color` is a model's reading of a
   photograph.
7. **No scheduled or automatic import.** Every import is somebody
   uploading a file and confirming a preview.
8. **A 50,000-row sheet is untested.** The largest tested is a few
   hundred; rows are processed one at a time for recoverability,
   which is right for correctness and will be slow at that size.
9. **Export is not built.**
10. **`.xls` is not supported.**

---

## 14. Running it

```bash
cd erp
npm install
cp .env.example .env            # ERP_DATABASE_URL

npm run db:deploy
npm run db:seed
npm run api                     # http://127.0.0.1:4310
npm run dev                     # http://127.0.0.1:5174   (second terminal)
```

Open **Import / Export**, upload an export of the MASTER tab,
read the preview, and confirm.

```bash
npm run test:import             # 82
npm run test:product-master     # 92
npm run db:verify               # 41
npm run test:frontend           # 48   (needs api + dev running)
npm run test:data               # 35
```
