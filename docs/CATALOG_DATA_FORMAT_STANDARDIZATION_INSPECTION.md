# Catalog Data Format Standardization & ERP API Alignment — Inspection Report

Status: **inspection only — no code changed yet.** Per the brief's own
"inspect first, implement carefully... wait for approval before merging
or deploying," this document lays out what was found and the decisions
needed before implementation starts.

The reference screenshot was read strictly as a field-order reference
(Image → Brand → Collection → Product → SKU → Specs → Finish →
Price), not as a UI design to copy — its own app (a different CRM,
"De'vyora Master CRM") and visual style are unrelated to this codebase.

## 1. Required field order vs. what exists today

Required sequence: **Image → Brand → Collection → Product Name → SKU →
Specifications → Finish/Variant → Selling Price.**

Every field in that sequence already has a home in the data model **except
two**:

| Field | Exists in CASA today? | As what |
|---|---|---|
| Image | ✅ | `Tile.imageUrl`, resolved to a real URL via `normalizeDriveImageUrl()`/`resolveBackendImageUrl()` — never a raw local path |
| Brand | ✅ | `Brand` (Company) |
| Collection | ✅ | `Collection` (added Stage 2) |
| Product Name | ✅ | `Product.name` (added Stage 2) |
| SKU | ✅ | `Tile.productCode` |
| Specifications | ✅ | `Tile.size`, `Tile.material`, `Tile.thickness` (material/thickness added Stage 2) |
| Finish/Variant | ✅ | `Tile.finish`, plus `ProductColour` for colour variants |
| **Selling Price** | ❌ | **Does not exist anywhere in CASA's schema** — confirmed by a full-schema search (`grep -i "price\|rate\|mrp"` across `schema.prisma` returns nothing). The ERP's own `Product` table has `sellingPrice`, but CASA and the ERP are, by design, separate databases with no live sync (Stage 2's documented boundary). |
| **Unit of Measurement** | ❌ | Does not exist either. The screenshot's "/sqft" is implicit in the ERP's own convention, never stored as a field in CASA. |

Per the brief's own rule — "Do not display empty or unavailable fields as
misleading placeholders" / "Do not invent missing product information" —
neither of these two can be added to the catalog display without first
either (a) adding real nullable fields to CASA's schema (additive, same
pattern as Stage 2, populated later) or (b) confirming the catalog should
simply omit Price/UOM until the ERP sync, which doesn't exist yet, can
supply them. **This needs your decision — see the question below.**

## 2. "Existing ERP API integration" — not found

Section 3 of the brief asks to "inspect the existing API integration" and
repeatedly says "do not break existing ERP API integrations" / "maintain
backward compatibility with existing ERP integrations."

**No such integration exists in this codebase.** The only module named
`integrations` (`src/routes/integrations.routes.ts`,
`src/controllers/integrations.controller.ts`) is entirely about Google
Drive OAuth, Gemini AI status and the Python AI visualization service —
nothing ERP-related. Stage 2 of this same project (completed and reported
immediately before this task) explicitly inspected this and documented
"ERP Integration Boundary" as a **future, not-yet-built** contract:
`ERP API → CASA Backend → CASA Catalog Frontend`, deliberately not
implemented, because CASA and the ERP are two separate databases with no
live connection today.

So there is nothing existing to "reuse" or avoid breaking on this front.
**This needs your decision**: should this task build the first version of
that export (a new, read-only endpoint the ERP — or anything else — can
poll, using the Company/Collection/Product/Tile data Stage 2 already
built as the single source of truth), or is "the existing API
integration" referring to something else you have in mind that isn't in
this repository?

## 3. "CASA di Oro" / "Casa De Aurum" branding — already not user-facing

Searched every `.html`/`.js`/`.ts`/`.prisma` file: **zero** instances of
"CASA di Oro" or "Casa De Aurum" in any live, user-facing page. The
catalog's actual branding is already "De'vyora" everywhere a customer or
staff member sees it — sidebar wordmark, page titles, nav. "Casa De
Aurum" survives only in **internal, non-visible identifiers**: the
backend's `package.json` name (`casa-de-aurum-backend`), seed/test email
domains (`owner@casadeaurum.com` etc.), the `CasaApi` JavaScript
namespace and its `casa_access_token`/`casa_user` localStorage keys,
some internal filenames (`00-casa-de-aurum-tool-REFERENCE.html`), and
developer documentation.

The brief itself says "Do not rename unrelated database entities,
historical records, or internal identifiers without verifying their
dependencies" — and every one of the internal identifiers above has
real dependencies (environment variables, test fixtures, the public API
client's own storage keys that real signed-in sessions already hold).
**Recommendation: no rename is needed** for this task's stated goal (the
catalog's user-facing identity), and the internal identifiers should be
left alone unless you specifically want that separate, higher-risk
rename done too.

## 4. "Every existing catalog and product category" — there is one

Full model listing of `backend/prisma/schema.prisma` (35 models) confirms
there is exactly one product hierarchy in this codebase: Brand →
Collection → Product → Tile (built in Stage 2). No second catalog type
(fixtures, sanitaryware, etc.) exists to extend the format to.

## 5. Where product information is displayed today, and its current order

| Page / surface | What it shows today | Order today | In scope for reordering? |
|---|---|---|---|
| `catalog.html` — product detail panel (built Stage 2) | Company, Collection, Product name, description, THEN image (in a side column) + finish/size chips + specs/category | **Image is not first** — text header comes before the image | Yes — straightforward reorder within the existing panel |
| `catalog.html` — product card (grid) | Image, Company (small), Collection, Product name, variant count | Already Image→Brand→Collection→Product | Minor — already compliant, no SKU/price shown (a product card represents several variants, so a single SKU/price would be misleading at this level) |
| `catalog.html` — Surface Archive card (one Tile = one variant) | Image, then a single compressed line mixing name/brand/collection/size/finish | Not cleanly ordered | Yes — this is the natural place for the full Image→Brand→Collection→Product→SKU→Specs→Finish→(Price, if added) sequence, since each card is exactly one variant |
| `recent-generations.html` — "products used" strip | Image, name, then a meta line of role/code/size/finish | No Brand/Collection shown at all; no price | Likely yes, but lower-traffic page — confirm priority |
| `mood-board.html` — combination thumbnails | Images only, no text | N/A | Out of scope — there is no field order to change |
| `sample-placement.html` | A "facts" key/value grid for an operational workflow (cassette, panel, sample ID, barcode, product code, dates) | Not a product-info sequence at all — a different kind of page | **Recommend excluding** — this is sample/location tracking, not a product listing, and forcing the brand→...→price sequence into this grid would be a structural change to a page the brief's own boundaries (preserve existing functionality, don't redesign) argue against touching |
| `Casa de Aurum.dc.html` | An unlinked, unrouted static file (not referenced from any nav or page) | — | Out of scope — not part of the live app |

## 6. Proposed plan, pending your answers below

1. Reorder `catalog.html`'s product detail panel so the image appears
   first, followed by Brand/Collection/Product/SKU/Specs/Finish(/Price
   once available) — no visual redesign, same colours/typography/cards,
   just the sequence of existing elements.
2. Restructure the Surface Archive card's single compressed line into
   the full ordered sequence (still the same compact card shape — no
   layout redesign).
3. Extend `recent-generations.html`'s product strip to include
   Brand/Collection ahead of the existing code/size/finish line, same
   compact style.
4. Add a new, read-only `GET /integrations/erp/catalog-feed` (or
   similar) endpoint that returns every Tile with its full
   Brand/Collection/Product/SKU/material/thickness/size/finish/image-URL
   context, in the same field order, as the one standardized payload —
   built from the existing Stage 2 Company/Collection/Product/Tile data,
   not a second, independent structure. No ERP credentials, no outbound
   connection — this is CASA exposing data, the direction the Stage 2
   report already documented.
5. Leave `sample-placement.html`, `mood-board.html`'s thumbnails, and
   `Casa de Aurum.dc.html` untouched.
6. No renaming of "Casa De Aurum" anywhere — it is already absent from
   the live catalog, and the internal identifiers are explicitly excluded
   by the brief's own caution.

Nothing above has been built yet. Your answers to the open questions
decide how #4 in particular gets built, and whether Price/UOM appear in
the catalog at all this round.
