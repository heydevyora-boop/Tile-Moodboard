# Product Hierarchy — Stage 1 (ERP)

Company (Brand) → Collection → Product → Finish → Size, built onto
the ERP's existing Product Master, Inventory, Purchase, Sales and
Excel Import modules. **CASA De Aurum catalog work (Stage 2) and the
ERP↔CASA integration (Step 9/10) are not part of this stage** — per
the brief's own staging instruction, this report covers the ERP side
only and stops before either.

**No existing module was rebuilt.** **No destructive migration.**
**No historical product, SKU, stock ledger entry, purchase or sales
record was touched, renamed or deleted.** **Not merged into `main`.**
**Not deployed publicly.**

---

## 1. Existing data model inspection

Taken before any code was written, across both systems named in the
brief.

### 1.1 ERP (this repository's own database)

| Brief's level | Existing ERP model | Verdict |
|---|---|---|
| Company / Brand | `Brand` (table `brands`) — `id, code, name, isActive` | **already exists, maps directly** |
| Collection | `Collection` (table `collections`, displayed as "Product Head" since step 2, before the term "Collection" was settled) — scoped to a brand, optional category | **already exists, maps directly** |
| **Product** | **did not exist as its own entity** | **the one genuine gap** — see §2 |
| Finish / Size | columns (`finish`, `size`, `colour`, …) directly on `Product` (table `products`) — each row already IS one sellable SKU/variant | **already exists; these stay exactly as they are** |

**The gap, precisely:** "Onery Elite Decore" in Matte and in Glossy
has, before this stage, no row of its own anywhere — it exists only
as the identical string in the `name` column of two sibling `Product`
rows. Nothing has an `id` to hold a shared description, a
specification sheet or a cover image, and nothing stops two
unrelated rows that happen to share a name from being mistaken for
one product, or confirms that they really are the same product when
they should be.

Also inspected and confirmed reusable, unchanged: `requirePermission()` /
the seeded `Role`/`RolePermission` tables (step 6); `productRules.mjs`'s
category-aware attribute rules (step 3 — already exactly what the
brief's "category-aware attributes" asks for); `findSimilar()` /
`NeedsReviewError`'s near-duplicate-name pattern (steps 2–3, reused for
the new Product level rather than reinvented); the `/api/v1` envelope
and versioning machinery (step 8); the Excel import engine's existing
duplicate-variant detection (step 4, `duplicates.mjs` — unchanged,
since it is SKU-level and a Product grouping is a different, additive
concern).

### 1.2 CASA De Aurum catalog (the separate, pre-existing website system)

Inspected for the mapping in §2, **not modified in this stage**:

- `Brand` already exists as its own table in `backend/prisma/schema.prisma`
  (`id, name, slug, logoUrl, isActive`) — the Company level already
  exists there too, independently of the ERP.
- **No Collection entity exists.** `Tile.collection` is a free-text,
  nullable string with no FK and, confirmed in
  `dashboard.service.ts`'s `getTopCollections()`, **no brand scoping**
  — two different brands' collections sharing a name merge into one
  card today.
- **No Product entity exists**, same gap as the ERP: `Tile.finish` and
  `Tile.size` are plain columns on the one row that is already the
  SKU/variant level.
- The one genuine child-variant table that exists is `ProductColour`
  (colour only, not finish/size), with its own `PhysicalSample`
  tracking.
- No live product detail page exists in the catalog today — confirmed
  absent, not just unlinked.
- Two separate paths write into this backend's database (a UI upload
  that runs a bundled Python extractor directly, and the standalone
  `catalog_processor` Gemini pipeline via an internal `master-sync`
  endpoint, authenticated by a shared secret rather than a user login)
  — neither is the ERP's own Excel import engine, and neither is
  touched by this stage.

This confirms the two systems have the **same structural gap**
(Product, between Collection and the SKU) but are otherwise
independent, separately-owned data models — exactly as the brief's
own architecture diagram requires them to stay.

---

## 2. Final hierarchy and model mapping

**A new entity was required**, per the brief's own conditional
instruction ("if a genuinely separate... base Product entity is
required, explain the mapping and migration strategy before
implementing it") — presented to the user before any schema change,
and approved.

| | |
|---|---|
| New Prisma model | `ProductLine` (table `product_lines`) |
| Displayed as | **"Product"**, throughout the API and every screen |
| Why not named `Product` in the schema | that name was already taken, since step 3, by the SKU/variant row. Renaming the existing table to match the brief's vocabulary was explicitly out of scope ("do not rename existing database models merely to match display terminology") and would have touched every foreign key, every service and every one of 24 screens for no behavioural gain |
| Sits | between `Collection` and the existing `Product` (variant) table |
| Relationship | `Product.productLineId` — **nullable** foreign key. A variant with no `ProductLine` is not an error, only ungrouped |

```
Brand ("Company")
  └── Collection
        └── ProductLine ("Product")   <-- new, this stage
              └── Product ("variant"/SKU)   <-- unchanged since step 3
                    · finish, size, colour — columns, as always
```

Fields added to `ProductLine` (the brief's Product-level fields that
had no home before this stage): `code`, `name`, `description`,
`specifications` (JSON), `imageUrl` (a cover image, shown before a
finish is chosen), `isActive`, plus the usual actor/timestamp columns.
`category` is inherited from the collection unless a product
genuinely differs — the same inheritance rule `Collection.categoryId`
already used one level up.

Two smaller, additive fields were added where the brief named them
and nothing existed yet: `Brand.logoUrl` / `Brand.description`, and
`Collection.coverImageUrl` / `Collection.catalogueDocumentUrl`. Both
are nullable; every row created before this stage has neither, and
nothing reads them as required.

---

## 3. Database changes

**One migration, entirely additive.** No `DROP`, no data rewrite, no
column removed, no table dropped.

| Change | Kind |
|---|---|
| `brands`: `+logoUrl`, `+description` | `ADD COLUMN`, nullable |
| `collections`: `+coverImageUrl`, `+catalogueDocumentUrl` | `ADD COLUMN`, nullable |
| `products`: `+productLineId` | `ADD COLUMN`, nullable, FK `RESTRICT` |
| `product_lines` | `CREATE TABLE` — `brandId`, `collectionId` (nullable), `categoryId` (nullable), `code`, `name`, `description`, `specifications`, `imageUrl`, `isActive`, actor/timestamp columns |
| `product_lines`: unique on `(brandId, collectionId, code)` | `CREATE UNIQUE INDEX` |
| Four new indexes | `brandId`, `collectionId`, `categoryId` on `product_lines`; `productLineId` on `products` |

Migration file: `prisma/migrations/20261127143507_product_hierarchy_product_line/migration.sql`.

**Known, accepted limitation of the unique index:** because
`collectionId` is nullable, two `ProductLine` rows under the same
brand with **no** collection could in principle share a `code` without
the database catching it (`NULL <> NULL` in a composite unique
index). The service layer's own `freeCode()` check prevents this in
practice for anything created through it; documented here rather than
worked around with a partial index, to keep this stage's migration to
exactly what was needed.

---

## 4. Migration strategy and results

**Design (approved before implementation):** group every existing,
ungrouped `Product` row into a `ProductLine` by exact name match
within the same `(brandId, collectionId)` scope — the one case the
brief calls unambiguous. Anything less certain is reported for a
person, never guessed.

`scripts/backfill-product-lines.mjs` — **dry-run by default**, writes
only with `--apply`. For each would-be group it additionally checks:

1. **Near-duplicate names** against every other group in the same
   brand/collection scope (the same similarity scorer steps 2–3 use
   for brand/collection names) — flagged for manual review, neither
   group auto-created, if two different-looking groups are too close
   to call automatically.
2. **Category disagreement** within one name-group — if products
   sharing a name do not even agree on category, that is flagged
   rather than silently resolved by picking one.

### Result, run against the development database

| | |
|---|---|
| Ungrouped products found | 14 |
| Name-groups | 14 (the seed data has no existing multi-variant product) |
| Auto-created, unambiguous | 14 |
| Flagged for manual review | **0** |
| Products linked | 14 |

**No record needed manual mapping.** The backfill script remains in
the repository (`scripts/backfill-product-lines.mjs`) for any future
database with real multi-variant history, and is re-runnable: it only
ever looks at products still missing a `productLineId`, so running it
again after resolving a flagged group picks up exactly that group and
nothing already handled.

Verified before and after: 19 → 19 → 14 → 14 products across the
container restart and the migration (the drop to 14 is the container
rebuild returning to the seed's own baseline, not data loss — see
§12), stock ledger entries unchanged, zero reconciliation drift.

---

## 5. CASA Catalog changes

**None.** Stage 2, not started in this phase. §1.2 above records what
was found during inspection so Stage 2 does not have to re-discover
it.

---

## 6. ERP Product Master changes

- **New service** `server/services/productLine.service.mjs` —
  `list`, `get` (with every variant under it), `findSimilar`,
  `create`, `update` — the same near-duplicate-name and
  cannot-move-while-it-has-children rules `productHead.service.mjs`
  already enforces one level up, applied at this level.
- **New routes** `server/routes/productLines.mjs`, mounted at both
  `/api/product-lines` and `/api/v1/product-lines` (the same router
  object, per the step-8 pattern) — `GET /`, `GET /similar`,
  `GET /:id`, `POST /` and `PATCH /:id`, the last two behind the
  existing `product:write` permission.
- **`server/services/product.service.mjs`** extended: a variant can
  now be created or edited with a `productLineId`, inheriting brand/
  collection/category from it the same way `headId` already works;
  `list()`/`get()` return `productLine`; search also matches a
  product's name; the near-duplicate-variant check (`findDuplicateVariants`)
  now scopes to the Product when one is given, which is the more
  precise scope than the Collection it fell back to before.
- **Frontend**: Product Master's listing now shows **Company,
  Collection, Product** as their own columns (previously Collection
  was folded into a subtitle and Product didn't exist); the new-
  variant form offers a Product dropdown, scoped by brand and head;
  a new **Products** tab was added to the Catalogue Structure screen
  (`src/pages/Categories.jsx`), alongside the existing Brands and
  Product Heads tabs, with full create/edit and a "Variants" view —
  mirroring the existing tabs' own pattern exactly.

**Stock stayed read-only through every one of these.** No new screen
or service here writes an inventory figure.

---

## 7. Inventory changes

- **Listing**: every balance row now also carries its `productLine`;
  a new `productLineId` filter and search-by-product-name were added
  alongside the existing brand/category/head filters.
- **Aggregation (new)**: three new, read-only functions in
  `inventory.service.mjs` — `companyStock(brandId)`,
  `collectionStock(collectionId)`, `productLineStock(productLineId)`
  — each a `SUM` over the existing `InventoryBalance` rows for the
  matching scope, computed on every read. **Nothing is stored**: a
  company or a collection has no stock balance of its own, only the
  sum of what its children have. A fourth, `stockHierarchy()`, lists
  every company with its own total, for the top of the drill-down.
- **New routes**: `GET /inventory/hierarchy`, `GET /inventory/companies/:id`,
  `GET /inventory/collections/:id`, `GET /inventory/products/:id` —
  matching the brief's own endpoint sketch.
- **Frontend**: a new "By company / collection / product" view was
  added to the Inventory screen (a toggle beside the existing List
  view, not a replacement for it) — company → collection → product →
  variant, each level showing its own total, each row clickable into
  the next level down. Warehouse-wise stock and the full stock-ledger
  history for one SKU are unchanged, reached from the existing List
  view and the Stock Ledger screen exactly as before.

**No second stock-writing mechanism was introduced.**
`postStockMovement()` remains the only function that changes a
balance; every figure the aggregation shows is read, never written,
by this stage's code.

---

## 8. Purchase and Sales changes

**Display and search only — no business logic changed.** Per the
brief's own instruction ("do not change existing purchase or sales
business logic unnecessarily"), the only edits were to how a product
is shown and found while raising a document:

- `PurchaseOrderForm.jsx`, `SalesOrders.jsx` (the sales order form)
  and `Quotations.jsx` now label every product match with its full
  breadcrumb — `Company › Collection › Product — Finish, Size` —
  instead of the variant's bare name, in both the search suggestions
  and the "you have selected" confirmation line.
- The line a user adds still stores exactly what it always has: the
  `productId` (the variant/SKU) and its price snapshot. Nothing about
  what gets sent to `purchaseOrders.create()` / `salesOrders.create()`
  changed.
- Goods receipt, dispatch and returns screens display the lines an
  order already carries rather than searching for a new product, so
  they were left unchanged — the brief's "wherever products are
  selected" is these three creation forms, not the fulfillment
  screens that already show a resolved line.

---

## 9. Excel Import changes

- **`server/import/engine.mjs`**: `importOneRow()` now resolves or
  creates a `ProductLine` for every imported variant — by an **exact**
  name match within the brand, the one signal the source genuinely
  gives (`Product Name` is the same string across a tile's Matte row
  and its Glossy row). A near-miss is **not** guessed at: the same
  `confirmDistinct` reasoning the brand-resolution step already used
  applies here, and a person merges two products afterward in the
  Product Master if the sheet really did spell one name two ways.
- The Product Head (Collection) **stays unset**, exactly as it was
  before this stage and for the same, already-documented reason: the
  source's "Catalog" column is the PDF a product was found in, not a
  series, and guessing one would scatter variants across heads that
  do not exist.
- **Nothing in the catalogue extraction pipeline was touched.** No
  Gemini prompt, no scanner script, no Drive or Sheets workflow, no
  spreadsheet-writing logic — the only change is inside the ERP's own
  import engine, in the one function that was already resolving the
  brand and the category.
- Existing duplicate-variant and duplicate-SKU detection
  (`duplicates.mjs`, step 4) is **unchanged** and untouched — it
  operates one level below the Product, on the full variant
  fingerprint, and is complementary to the new Product-level
  resolution rather than overlapping it.
- Idempotent retry (`/batches/:id/retry`) is unchanged: re-running a
  retry resolves the **same** product line by the same exact-name
  lookup, rather than creating a sibling.
- Import batch and row history (`ImportBatch`, `ImportRow`) — schema
  and listing untouched.

Verified with two new assertions added to the existing, 83-check
import suite (now 85): importing two sizes of one named product under
the same brand produces **two** variant rows with two SKUs but **one**
`ProductLine`, and a plain single-variant import still resolves its
own, correctly-named product.

---

## 10. API endpoints added or modified

All under both `/api/*` (unchanged shape) and `/api/v1/*` (the
envelope), per the existing step-8 architecture — reusing the same
router objects, not a rewritten copy.

| Method | Path | Perm. | New/changed |
|---|---|---|---|
| GET | `/product-lines` | | **new** |
| GET | `/product-lines/similar` | | **new** |
| GET | `/product-lines/:id` | | **new** — includes every variant |
| POST | `/product-lines` | `product:write` | **new** |
| PATCH | `/product-lines/:id` | `product:write` | **new** |
| GET | `/products` | | **changed** — `+productLineId` filter, `+productLine` in each row, search also matches product name |
| GET | `/products/:id` | | **changed** — `+productLine` |
| POST | `/products` | `product:write` | **changed** — accepts `productLineId` |
| PATCH | `/products/:id` | `product:write` | **changed** — accepts `productLineId` |
| GET | `/inventory` | | **changed** — `+productLineId` filter, `+productLine` per row |
| GET | `/inventory/hierarchy` | | **new** |
| GET | `/inventory/companies/:id` | | **new** |
| GET | `/inventory/collections/:id` | | **new** |
| GET | `/inventory/products/:id` | | **new** |
| POST/PATCH | `/brands`, `/brands/:id` | `product:write` | **changed** — accepts `logoUrl`, `description` |
| POST/PATCH | `/product-heads`, `/product-heads/:id` | `product:write` | **changed** — accepts `coverImageUrl`, `catalogueDocumentUrl` |

**No endpoint was removed or renamed. No existing field was removed
from any response.** Every change above is an addition to what a
route already returned.

---

## 11. Test results, with exact numbers

| Suite | Result | Notes |
|---|---|---|
| `test:hierarchy` (**new** — `test/product_hierarchy_test.mjs`) | **29/29** | company/collection/product creation and relationships; multiple finishes and sizes of one product; invalid finish/size combinations refused; SKU uniqueness; filtering and search at every level; inventory aggregation at company, collection and SKU level, cross-checked against a raw `SUM`; warehouse-level inventory unaffected; permission enforcement; historical records preserved |
| `test:import` | **85/85** (was 83) | +2: one named product's two sizes share one Product; a plain import resolves its own correctly-named Product |
| `test:data` | 38/38 | unchanged |
| `test:product-master` | 92/92 | unchanged |
| `test:inventory` | 86/86 | unchanged |
| `test:purchase` | 126/126 | unchanged |
| `test:sales` | 95/95 | unchanged |
| `test:api` | 61/61 | unchanged |
| `db:verify` | 41/41 | unchanged |
| `test:frontend` | 66/66 | unchanged |
| **Total** | **719/719, zero failures** | |

Production build: clean (`npm run build`, no errors, one pre-existing
bundle-size advisory unrelated to this stage).

---

## 12. Database integrity report

| Check | Result |
|---|---|
| Products before this stage's work | 19 (14 seeded + 5 from step-8 manual smoke-testing) |
| Products after a container rebuild mid-session | 14 (the rebuild reset to a fresh container; the dev database was rebuilt from migrations and the seed, which creates exactly 14) |
| Products after this stage's migration + backfill | 14 — **identical**, only `productLineId` added |
| `product_lines` created by the backfill | 14, one per product, zero flagged for review |
| Stock ledger entries | 12 before, 12 after the schema migration and backfill (unaffected — this stage posts no stock movements of its own) |
| `db:verify` | 41/41, both before and after |
| A stray product created during this stage's own manual API smoke-testing | found (1 row, zero stock references) and removed before the final count above — see note below |

**Note on the stray row:** while manually verifying the new
`POST /products` with a `productLineId` worked end-to-end (§6), one
extra variant was created directly against the development database
for that check. It carried no stock, no order line and no audit
dependency, confirmed before removal, and was deleted so the
development database ends this stage at exactly the seed's own 14
products — the same discipline every earlier step in this project has
held to when a manual check touched the shared development data.

---

## 13. Existing records that need manual mapping

**None.** Every one of the 14 pre-existing products resolved to its
own `ProductLine` automatically, by exact name match, with zero
near-duplicate or category-disagreement flags. `scripts/backfill-product-lines.mjs`
remains available, unchanged, for a future database where that is not
the case — it reports before it ever writes, and writes only what it
reported.

---

## 14. CASA integration work still pending

**Everything.** Stage 2 (CASA catalog hierarchy) and the live
ERP↔CASA integration (Step 9/10 in the original numbering) have
**not been started**, per this brief's own staging instruction and
its explicit "do not merge into main" / "stop for review before
proceeding to any separate CASA backend or website integration."

What Stage 2 will need, recorded here so it does not have to
re-inspect:

- CASA's `Brand` already exists (§1.2) — no new Company-level work
  needed there.
- CASA needs its own new `Collection` entity (brand-scoped — the
  current free-text, unscoped field is a confirmed, pre-existing bug
  in `getTopCollections()`) and its own new Product-level entity,
  built the same way this stage built `ProductLine` for the ERP, but
  as a **separate, additive migration on CASA's own database** — not
  shared with the ERP's `product_lines` table.
- A live product detail page does not exist in the CASA catalog today
  and will need to be built from nothing, not adapted from an
  existing screen.
- The actual ERP→ERP API→CASA backend→CASA website data flow (moving
  product master data from the ERP into CASA, rather than CASA
  continuing to populate itself from its own two import paths) is a
  separate, later decision this stage does not make.

---

## 15. Files created and modified

### New

```
docs/PRODUCT_HIERARCHY.md                      (this report)
prisma/migrations/20261127143507_product_hierarchy_product_line/migration.sql
scripts/backfill-product-lines.mjs
server/routes/productLines.mjs
server/services/productLine.service.mjs
test/product_hierarchy_test.mjs
```

### Modified

```
package.json                        (+ "test:hierarchy" script)
prisma/schema.prisma                 (+ ProductLine model, + Brand/Collection/Product fields -- see §3)
server/app.mjs                       (+ /api/product-lines mount)
server/import/engine.mjs             (+ Product resolution during import, see §9)
server/routes/brands.mjs             (+ logoUrl/description fields)
server/routes/inventory.mjs          (+ hierarchy routes, + productLineId filter)
server/routes/productHeads.mjs       (+ coverImageUrl/catalogueDocumentUrl fields)
server/routes/products.mjs           (+ productLineId field)
server/routes/v1.mjs                 (+ /product-lines mount)
server/services/brand.service.mjs    (+ logoUrl/description read-write)
server/services/inventory.service.mjs (+ aggregation functions, see §7)
server/services/product.service.mjs  (+ productLineId resolution, + Product-scoped duplicate check)
server/services/productHead.service.mjs (+ coverImageUrl/catalogueDocumentUrl read-write)
src/api/client.js                    (+ productLines, + inventory hierarchy client methods)
src/components/ProductForm.jsx       (+ Product field)
src/components/PurchaseOrderForm.jsx (+ hierarchy breadcrumb in product search)
src/pages/Categories.jsx             (+ Products tab)
src/pages/Inventory.jsx              (+ hierarchy drill-down view)
src/pages/ProductMaster.jsx          (+ Company/Collection/Product columns)
src/pages/Quotations.jsx             (+ hierarchy breadcrumb in product search)
src/pages/SalesOrders.jsx            (+ hierarchy breadcrumb in product search)
test/import_engine_test.mjs          (+ 2 assertions, see §9, §11)
```

**No file in `server/routes/sales.mjs`, `server/routes/purchase.mjs`,
`server/routes/warehouses.mjs`, `server/routes/imports.mjs` or any
purchase/sales service was modified** — their business logic is
unchanged, per §8.

---

## 16. Git

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| Base at start of this stage | `39553ba` (merge of step 8 / PR #155) |
| **Merged into `main`** | **no — this brief explicitly says not to** |
| Pushed | yes, to the feature branch only |

Stage 2 (CASA catalog) and Step 9/10 (CASA integration) have **not**
been started, per this brief's explicit instruction to complete only
the required hierarchy and stop for review.
