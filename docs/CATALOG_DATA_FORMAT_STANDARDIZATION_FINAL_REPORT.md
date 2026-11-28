# Catalog Data Format Standardization & ERP API Alignment — Final Report

Branch: `claude/seed-feminine-404-fix-aq50lk`
Commits this stage: `a09a44f` (inspection), `f19456c` (implementation)
**Not merged into main. Not deployed publicly**, per the brief's Section 5.

## 1. Files inspected

`frontend/catalog.html`, `frontend/recent-generations.html`,
`frontend/mood-board.html`, `frontend/sample-placement.html`,
`frontend/Casa de Aurum.dc.html` (found unlinked/unrouted), `frontend/assets/api-client.js`;
`backend/prisma/schema.prisma` (full model search for price/UOM —
none existed); `backend/src/routes/integrations.routes.ts` and
`src/controllers/integrations.controller.ts` (the only existing
"integrations" surface — Drive/Gemini/Python-AI, no ERP); `backend/src/services/{brand,collection,product,tileRecommendation,dashboard}.service.ts`;
`backend/src/routes/ai_visualization.routes.ts` (the recent-generations
product resolver); `backend/src/middlewares/internalAuth.ts` (the
pattern reused for the new ERP export auth); every `.html`/`.js`/`.ts`/`.prisma`
file, searched for "CASA di Oro"/"Casa De Aurum" branding.

Full findings in `docs/CATALOG_DATA_FORMAT_STANDARDIZATION_INSPECTION.md`,
written before any code changed.

## 2. Final standardized product data structure

**Image → Brand → Collection → Product Name → SKU → Specifications →
Finish/Variant → Selling Price.** Fields that are genuinely unknown for
a given record (price not yet entered, no collection resolved, no
catalogue PDF) are omitted, never shown as a fabricated placeholder.

## 3. Catalog implementation summary

- **`catalog.html` product detail panel**: the image now renders first,
  above the Brand (small metadata) / Collection (secondary heading) /
  Product Name (primary heading) header. A resolved variant (once
  finish + size are both picked) shows SKU, then Selling Price (only
  when set), then stock status — never before a real variant is
  resolved, since a Product has no single price of its own.
- **Surface Archive cards** (each card is exactly one variant/SKU): now
  lead with a Brand · Collection metadata line, then the product name,
  then a SKU · Specifications (size/material/thickness) · Finish line,
  then Selling Price (when set) and stock status. Same compact card
  shape, same colours/typography — no redesign.
- **`recent-generations.html` product strip**: now shows Brand ·
  Collection ahead of the product name, resolved live from the Tile a
  stored product code points to (never from the activity log, which
  predates the hierarchy and never recorded it).
- **No other catalog or product category exists** in this codebase —
  confirmed by a full model listing of `schema.prisma`. The
  Brand→Collection→Product→Tile hierarchy (built Stage 2) is the only
  one, so "every existing catalog" is this one.
- **No branding rename was needed.** "CASA di Oro"/"Casa De Aurum"
  appears nowhere in the live, user-facing catalog — it is already
  "De'vyora" everywhere a customer or staff member sees it. The string
  survives only in internal identifiers (package name, seed/test email
  domains, the `CasaApi` JS namespace, some filenames, docs), which were
  left untouched per the brief's own caution against renaming internal
  identifiers without verifying dependencies.
- **`mood-board.html`**, **`sample-placement.html`**, and the unlinked
  **`Casa de Aurum.dc.html`** were left untouched — none of them is a
  product-information listing in the sense this brief means (confirmed
  during inspection; see the inspection report §5 for the reasoning).

## 4. ERP API payload structure

New: `GET /integrations/erp/catalog-feed`, authenticated by a shared
secret (`x-erp-key` header, checked against `ERP_EXPORT_API_KEY`) rather
than a CASA user session — the same pattern already used for the
Python extraction pipeline's own inbound sync (`internalAuth.ts`), with
a **separate** secret so a leak of one credential can never expose the
other. Fails closed if the key is unset. Built from the existing
Company/Collection/Product/Tile data — no second, parallel structure.

Example payload (field order as returned):

```json
{
  "generatedAt": "2026-11-28T01:30:00.000Z",
  "companies": [
    {
      "companyId": "cmwz...kajaria",
      "companyName": "Kajaria",
      "companyCode": "KAJ",
      "collections": [
        {
          "collectionId": "cmwz...classic",
          "collectionName": "Onery Elite Collection",
          "products": [
            {
              "productId": "cmwz...decore",
              "productName": "Onery Elite Decore",
              "productCode": null,
              "category": "Floor Tile",
              "specifications": "Porcelain, rectified edge",
              "imageUrl": null,
              "availableSizes": ["600x600mm"],
              "availableFinishes": ["Matte", "Glossy"],
              "variants": [
                {
                  "variantId": "cmwz...tile1",
                  "sku": "KAJ-OED-M-600",
                  "imageUrl": "https://drive.google.com/uc?export=view&id=abc123",
                  "material": "Porcelain",
                  "dimensions": "600x600mm",
                  "thickness": "10mm",
                  "finish": "Matte",
                  "sellingPrice": "185.5",
                  "unitOfMeasure": "SQFT",
                  "inStock": true
                },
                {
                  "variantId": "cmwz...tile2",
                  "sku": "KAJ-OED-G-600",
                  "imageUrl": null,
                  "material": null,
                  "dimensions": "600x600mm",
                  "thickness": null,
                  "finish": "Glossy",
                  "sellingPrice": null,
                  "unitOfMeasure": null,
                  "inStock": true
                }
              ]
            }
          ]
        }
      ],
      "unassignedVariants": [
        {
          "variantId": "cmwz...legacy",
          "sku": "KAJ-LEG-900",
          "imageUrl": null,
          "material": "Vitrified",
          "dimensions": null,
          "thickness": "12mm",
          "finish": null,
          "sellingPrice": "99.99",
          "unitOfMeasure": "BOX",
          "inStock": true,
          "name": "Legacy Loose Tile",
          "freeTextCollectionLabel": null
        }
      ]
    }
  ]
}
```

Stable CASA ids (`companyId`/`collectionId`/`productId`/`variantId`) and
the SKU are carried throughout — a consumer matches on those, not
free-text names. Variants are nested, structured objects under their
product, never a flat string. `unassignedVariants` holds any Tile not
yet linked to a Product, per company, so nothing is silently dropped or
guessed into the wrong place.

## 5. Database changes

Additive only: `Tile.sellingPrice` (`Decimal(14,2)?`) and
`Tile.unitOfMeasure` (new `UnitOfMeasure` enum — `BOX`/`PIECE`/`SQFT`/`SQM`/`SET`,
matching the ERP's own enum exactly for a clean future sync). Migration
`20261128011944_add_tile_price_and_uom`. No existing column changed,
no row touched by the migration itself. Both fields are also now
settable through the existing tile-edit endpoint
(`PATCH /catalog-extractor/tiles/:id`), so staff have a real way to
populate them — nothing is invented automatically.

## 6. Existing data mapping report

- Every field in the standardized sequence already had a home in CASA's
  schema **except Selling Price and Unit of Measurement**, which did
  not exist anywhere before this stage (confirmed by a full-schema
  search). Added additively, per your approval.
- **No existing ERP API integration was found** in this codebase before
  this stage — the only prior `integrations` module covers Google
  Drive/Gemini/Python-AI, nothing ERP-related. This stage's export
  endpoint is the first version of that contract, per your approval,
  built read-only and from the existing hierarchy data.
- **No unmapped or incomplete records required manual review** in this
  round: this stage reorders existing, already-correctly-mapped fields
  and adds two new optional ones — it does not touch the
  Tile→Product/Collection resolution logic itself (that ambiguity
  handling was Stage 2's backfill tool, already built and reported).

## 7. Automated testing results

**`test-scripts/catalog_data_format_test.js`** (new,
`npm run test:catalog-data-format`) — real server, a real disposable
Postgres database the script creates and drops itself, the actual
`catalog.html` page in Chromium, plus direct checks of the ERP export
endpoint and the recent-generations resolver. **23/23 checks passed**:
resolved-variant price/UOM shown when set and omitted (never
fabricated) when not; the tile-edit endpoint accepting
material/thickness/price/UOM; the ERP feed refusing requests with no or
the wrong `x-erp-key` and succeeding with the right one; the feed's full
payload shape (stable ids, structured variants, resolved image URLs,
unassigned tiles listed separately and never duplicated inside a
product); the recent-generations resolver reading Brand/Collection back
from a live tile and never guessing when no tile matches; and a full
browser pass confirming the product image is literally the first
element in the detail panel's DOM, the resolved-variant summary shows
SKU → Price → stock in that order, and the Surface Archive's first card
leads with its metadata line before the product name.

Regression, re-run after this stage's changes: **Stage 2's own suite**
(`test:catalog-hierarchy`, 35/35 — one assertion updated to match the
now-three-line resolved-variant summary, a direct and intentional
consequence of this stage's own reordering, not a regression),
**`test:tile-recommendation`** (38/38), and **`test:home-page`** (60/60,
exercises `/dashboard/collections`). **156 checks total this round,
zero failures.**

## 8. Performance

No new queries added to any existing hot path beyond selecting a few
more already-indexed scalar columns (`material`, `thickness`,
`sellingPrice`, `unitOfMeasure`) on `Tile` in `listAllTiles` — still one
`findMany` + `count`. The recent-generations fix broadens which tile
codes get looked up (every code on the page, not only ones missing a
picture) but it is still exactly one `findMany` per page of history, no
N+1. The new ERP feed issues one query per hierarchy level
(brands→collections→products→tiles, via nested `select`), not a
per-row round trip — acceptable for a periodic export, not a hot
request path.

## 9. Files changed

Backend: `prisma/schema.prisma`,
`prisma/migrations/20261128011944_add_tile_price_and_uom/`,
`src/config/{env,index}.ts`, `src/middlewares/erpAuth.ts` (new),
`src/services/erpExport.service.ts` (new),
`src/services/tileRecommendation.service.ts`,
`src/controllers/integrations.controller.ts`,
`src/routes/{integrations,ai_visualization}.routes.ts`,
`src/validators/catalogExtractor.validators.ts`, `.env.example`,
`test-scripts/catalog_data_format_test.js` (new),
`test-scripts/catalog_hierarchy_test.js` (one assertion updated),
`package.json`.
Frontend: `catalog.html`, `recent-generations.html`.
Docs: `docs/CATALOG_DATA_FORMAT_STANDARDIZATION_INSPECTION.md`, this
report.

## 10. Unmapped or incomplete records requiring manual review

None found this round (see §6). The one standing, already-documented
item from Stage 2 remains: any `Tile` still carrying only a free-text
`collection` label and no `productId` is listed by the ERP feed's
`unassignedVariants` bucket rather than silently placed, exactly as
Stage 2's backfill tool already handles for the catalog side.
