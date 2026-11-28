# Devyora Catalog — Standardized Product Presentation & ERP Catalog Feed — Implementation Report

Branch: `claude/seed-feminine-404-fix-aq50lk`
Commits: `a09a44f`, `f19456c`, `70df269` (prior round — UI reordering +
first ERP feed version), plus this round's commit bringing the ERP feed
in line with this brief's documented contract (pagination, versioned
meta, field names). **Not merged into main. Not deployed.**

This report follows the brief's Section 9 numbering directly.

## 1. Files inspected

Re-confirmed from the prior round (no change in findings): full
`schema.prisma` model search for price/UOM fields; `integrations.routes.ts`/
`integrations.controller.ts` (Drive/Gemini/Python-AI only, no prior ERP
integration); `ai_visualization.routes.ts`'s recent-generations resolver;
`internalAuth.ts` (the pattern `erpAuth.ts` mirrors); every live catalog
page for "CASA di Oro"/"Casa De Aurum" branding (none found); Stage 2's
own docs (`CASA_CATALOG_HIERARCHY_STAGE2.md`,
`CASA_CATALOG_HIERARCHY_STAGE2_FINAL_REPORT.md`) for the
Company→Collection→Product→Tile relationships this round builds on.
This round additionally re-read `src/utils/pagination.ts` (`getPagination`/
`buildPaginationMeta`) to paginate the ERP feed the same way every other
list endpoint in this API already does.

## 2. Files modified this round

`backend/src/services/erpExport.service.ts` (rewritten — see §5),
`backend/src/controllers/integrations.controller.ts`,
`backend/src/routes/integrations.routes.ts`,
`backend/src/validators/catalogHierarchy.validators.ts` (new
`erpCatalogFeedQuerySchema`), `backend/test-scripts/catalog_data_format_test.js`
(ERP feed checks rewritten for the new shape, pagination/filter checks added).
No frontend files changed this round — Surfaces A/B/C already matched
the approved order from the prior round and needed no further change
(re-verified, see §7).

## 3. Changes made to each approved UI surface

All three were already implemented in the prior round and are
unchanged this round, re-verified by re-running their tests:

- **A. `catalog.html` product detail panel** — image renders first,
  above Brand (small metadata) / Collection (secondary heading) /
  Product Name (primary heading); SKU, Specifications and Finish follow;
  Selling Price appears only once a finish+size resolves one real
  variant. Same panel layout and visual language, nothing redesigned.
- **B. `catalog.html` Surface Archive cards** — each card (one
  variant/SKU) now leads with Brand · Collection, then the product
  name, then SKU · Specifications · Finish, then price (when set) and
  stock status. Same compact card dimensions. No variants merged — one
  card per Tile, exactly as before.
- **C. `recent-generations.html` product strip** — Brand · Collection
  now shown ahead of the product name, resolved live from the Tile a
  stored product code points to (the activity log never recorded
  Brand/Collection, since it predates the hierarchy). No duplicate
  product records created to populate this — it is read from the
  existing relationship, or left blank when a tile can't be matched.
- **Excluded surface**: `sample-placement.html` — confirmed untouched
  (not in the diff of either round).

## 4. Final standardized product-information structure

**Image → Brand → Collection → Product Name → SKU → Specifications
(Material, Dimensions/Size, Thickness) → Finish/Variant → Selling
Price.** A field that genuinely has no value (no price entered, no
catalogue PDF, no specifications text) is omitted outright — never
rendered as a placeholder or an invented value.

## 5. ERP catalog feed endpoint and example response

`GET /integrations/erp/catalog-feed` — read-only, no writes, no outbound
connection, no ERP credentials referenced anywhere. Authenticated by a
dedicated shared secret (`x-erp-key` header checked against
`ERP_EXPORT_API_KEY`), deliberately separate from the Python sync
pipeline's own `INTERNAL_SYNC_API_KEY` so a leak of one can't expose the
other — same fail-closed pattern as the existing `internalAuth.ts`.

This round rewrote the feed to match the brief's documented contract
exactly: one row per Product (flat, not a nested company→collection→product
tree), each carrying its Company and Collection inline, paginated the
same way every other list endpoint in this API is
(`getPagination`/`buildPaginationMeta`), with optional `brandId`/
`collectionId` query filters, and a `meta.version` so a consumer can
tell which contract shape it received.

```
GET /integrations/erp/catalog-feed?page=1&limit=50&brandId=<optional>&collectionId=<optional>
Header: x-erp-key: <ERP_EXPORT_API_KEY>
```

```json
{
  "success": true,
  "data": [
    {
      "company": { "id": "cmwz...kajaria", "name": "Kajaria" },
      "collection": { "id": "cmwz...classic", "name": "Onery Elite Collection" },
      "product": {
        "id": "cmwz...decore",
        "name": "Onery Elite Decore",
        "code": null,
        "category": "Floor Tile",
        "specifications": "Porcelain, rectified edge",
        "imageUrl": null,
        "variants": [
          {
            "tileId": "cmwz...tile1",
            "sku": "KAJ-OED-M-600",
            "imageUrl": "https://drive.google.com/uc?export=view&id=abc123",
            "material": "Porcelain",
            "dimensions": "600x600mm",
            "thickness": "10mm",
            "finish": "Matte",
            "price": 185.5,
            "unit": "SQFT",
            "inStock": true
          },
          {
            "tileId": "cmwz...tile2",
            "sku": "KAJ-OED-G-600",
            "imageUrl": null,
            "material": null,
            "dimensions": "600x600mm",
            "thickness": null,
            "finish": "Glossy",
            "price": null,
            "unit": null,
            "inStock": true
          }
        ]
      }
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 2,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPrevPage": false,
    "version": "1"
  }
}
```

Only active Brands/Collections/Products are included (the existing
catalog visibility rule — `isActive: true`, the same flag the catalog
website itself reads by). A Tile is excluded from this feed's `data`
entirely if it is not yet assigned to a Product — there is no slot in
the documented contract for a variant without a product, and inventing
one (either a placeholder product or a guessed assignment) would
violate Section 3's "do not invent a relationship." See §8 for the
recommended follow-up.

## 6. Database changes

None this round. (Last round's additive migration —
`Tile.sellingPrice`/`Tile.unitOfMeasure`, `20261128011944_add_tile_price_and_uom`
— already covered the schema needs; this round only changed how the
ERP feed queries and shapes that same data.)

## 7. Tests executed and actual results

**`test-scripts/catalog_data_format_test.js`**, rewritten for the new
feed contract (`npm run test:catalog-data-format`): **25/25 passed** —
resolved-variant price/UOM shown when set and omitted when not; the
tile-edit endpoint accepting material/thickness/price/UOM; the feed
refusing requests with no or the wrong `x-erp-key`; the full payload
shape matching the documented contract field-for-field
(`tileId`/`sku`/`material`/`dimensions`/`thickness`/`finish`/`price`/`unit`);
a tile not yet assigned to a product confirmed excluded from `data`
(never force-fit into one); `meta.version` and real pagination totals;
`limit=1` returning exactly one row with correct `hasNextPage`, page 2
returning the other row (not a repeat); `brandId` filtering scoped
correctly to one company; and a full Chromium pass confirming the
product image is literally the first DOM element in the detail panel,
the resolved-variant summary reads SKU → price → stock in order, and
the first Surface Archive card leads with its Brand/Collection line.

Regression, re-run after this round's changes:
**`test:catalog-hierarchy`** (Stage 2's own suite, 35/35 — no changes
needed, still green). **156 total checks across this engagement's test
scripts, zero failures.**

## 8. Unmapped or incomplete catalog records

None newly found this round. One standing, already-documented item:
a `Tile` with `productId = null` (not yet resolved into the Company/
Collection/Product hierarchy — Stage 2's own backfill tool handles
this ambiguity on the catalog side) is, by this round's design,
**excluded from the ERP feed's `data` entirely**, since the documented
contract has no slot for a variant without a product. **Recommended
next step**: either extend the documented contract with an explicit
`unassignedVariants` section (a previous draft of this endpoint had
exactly this, dropped this round to match the brief's illustrative
shape precisely) or run Stage 2's backfill tool first so every Tile
has resolved into a Product before a real ERP pull. Flagging rather
than silently deciding which.

## 9. Backward compatibility assessment

- **Existing CASA API/frontend**: unaffected. No existing route's
  request or response shape changed; `listAllTiles`/`getProductById`
  gained new optional fields (`material`, `thickness`, `sellingPrice`,
  `unitOfMeasure`) that were not there before — strictly additive, no
  consumer could have depended on their absence.
- **This brief's own ERP feed**: the response shape changed between the
  prior round's commit and this one (nested tree → flat paginated list,
  field renames to match the documented contract). Since this endpoint
  was never merged, deployed, or consumed by anything, there is no real
  backward-compatibility break — only an internal iteration toward the
  contract this brief specifies. `meta.version: "1"` is now in place so
  any future shape change has somewhere to signal it.
- **Branding**: no rename performed (none was needed — see the prior
  inspection report), so nothing to break.

## 10. Remaining issues and recommended next steps

1. Decide how `unassignedVariants` (Tiles with no Product) should
   surface in the ERP feed, if at all — see §8.
2. The ERP feed has no real consumer yet; `ERP_EXPORT_API_KEY` must be
   set and shared with whatever will call it before this is usable.
3. Stage 2's backfill tool (`scripts/backfill-catalog-hierarchy.js`)
   has not been run against any real CASA database — this environment
   still has none connected — so the real count of resolved vs.
   unassigned Tiles is unknown outside the disposable test fixtures
   used here.
4. Everything in this report is committed on
   `claude/seed-feminine-404-fix-aq50lk` only. No merge, no deploy,
   pending your review.
