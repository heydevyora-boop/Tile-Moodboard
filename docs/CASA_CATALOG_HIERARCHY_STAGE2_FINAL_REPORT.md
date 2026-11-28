# Stage 2 — CASA De Aurum Catalog Hierarchy: Final Report

Branch: `claude/seed-feminine-404-fix-aq50lk`
Commits this stage: `d831c12` (inspection + mapping), `41bf02d` (schema +
backend API), `89aaadf` (frontend + test suite)
**Not merged into main. Not deployed publicly.** Per the brief's Section 13.

## 1. Existing CASA architecture (as found)

Express + TypeScript + Prisma (PostgreSQL, `cuid()` ids) + Zod validators,
JWT auth with a real permission system (`authenticate` + `requirePermission`),
a `{success, data, meta?}` response envelope via `catchAsync()`, and bounded
pagination (`DEFAULT_LIMIT=20`, `MAX_LIMIT=100`). Full detail in
`docs/CASA_CATALOG_HIERARCHY_STAGE2.md` §1, written during the inspection
pass before anything was built.

The structural gap this stage closes: `Brand` (Company) existed; neither
`Collection` nor `Product` did. `Tile.collection` was a free nullable
string with no FK and no brand scoping. `Tile` was already the finish×size
variant level, with its own `ProductColour`/`PhysicalSample` children —
untouched by this stage, as planned.

## 2. Final data hierarchy

```
Brand (Company)            -- reused, + code/description added
 └─ Collection (new)        -- belongs to one Brand
     └─ Product (new)       -- belongs to one Collection
         └─ Tile (Variant)  -- existing table, + nullable productId,
                                material, thickness
             ├─ ProductColour   -- existing, untouched
             └─ PhysicalSample -- existing, untouched
```

## 3. Database changes

Migration `20261127173950_add_catalog_hierarchy` (additive only):
- `brands`: + `code`, `description` (both nullable).
- New table `collections`: `id, name, brandId (FK→brands, CASCADE), description, coverImageUrl, catalogueDocumentUrl, isActive, createdAt, updatedAt`. Indexed on `brandId` and `(brandId, name)`.
- New table `products`: `id, name, code, collectionId (FK→collections, CASCADE), description, specifications, coverImageUrl, category, isActive, createdAt, updatedAt`. Indexed on `collectionId` and `code`.
- `tiles`: + `productId` (nullable FK→products, **`ON DELETE SET NULL`** — deleting a Product never deletes or corrupts a Tile), `material`, `thickness` (both nullable).

No column was removed, renamed, or made non-nullable. No existing row was
modified by the migration itself. `category` is a plain string (no new
taxonomy table — CASA had none and the brief said not to force structure
that doesn't exist). `material`/`thickness` are nullable strings, matching
the existing loose, string-based convention `Tile.size` already uses
(CASA, unlike the ERP, does not store structured numeric dimensions).

## 4. Migration preview and record counts

**No persistent CASA database connection exists in this sandbox** —
confirmed by `.env` not existing and a repo-wide search finding none.
Every count below is from an **isolated, disposable test database this
work created and dropped itself** (`tm_catalog_hierarchy`, then later
`tm_catalog_hierarchy_test` for the automated suite) — never a real
development or production database. No production data was migrated, and
none is claimed to have been.

The dry-run-by-default backfill tool (`backend/scripts/backfill-catalog-hierarchy.js`)
was run against seeded fixtures built specifically to contain the
ambiguous cases the brief asks to detect:

| Scenario | Fixture | Result |
|---|---|---|
| Baseline counts | 2 brands, 7 tiles, 0 existing Collections/Products | Reported correctly before any write |
| Same collection name, two brands | "Classic" under Kajaria AND Somany | Resolved to **two separate Collection rows** — never merged |
| Clean, groupable product | "Royale Marble Finish" (Somany), 2 variants | Correctly proposed and auto-created |
| Near-duplicate product name | "Onery Elite Decore" (3 tiles) vs "Onery Elite Decor" (1 tile, typo), same brand+collection | **Flagged for manual review** (similarity 0.944), neither auto-created |
| Tile with no collection at all | 1 tile, `collection = null` | **Flagged as a missing mapping**, left untouched |

Dry run (default) wrote nothing; `--apply` then wrote exactly what the dry
run previewed — 2 Collections, 1 Product, 2 tiles linked — verified
afterward with direct SQL against the test database. The two ambiguous
groups and the collection-less tile were, as designed, left for a person
to resolve; re-running the script after that is how they get included.

**Ambiguous mapping report** (from this fixture run, as a worked example
of the report format): one near-duplicate product-name pair and one
collection-less tile, both listed above with their reasons, exactly as
the script prints them.

Rules honored, verified by direct inspection of the resulting rows: no
company was ever guessed (every Tile already carries a required
`brandId`); no collection was merged across brands; matching used company
ID + normalized name; every existing Tile id, image URL and `productCode`
was preserved exactly; nothing was deleted.

## 5. Frontend changes

`frontend/catalog.html`: added Company → Collection → Product browsing
above the existing Collections preview and Surface Archive (both kept).
Breadcrumb navigation; company cards; collection cards scoped to the
selected company; product cards showing company (small metadata),
collection (secondary heading) and product (primary heading) — never
mixed on one line; a product detail view where selecting a finish filters
to its valid sizes and selecting a size resolves exactly one SKU (never
an invalid combination), with description, specifications, category and
catalogue PDF link where present. Surface Archive gained company/finish/size
filters and its search now also matches company, collection and product
names. No change to the sidebar, visual language, colours, typography, or
any unrelated page.

`frontend/assets/api-client.js`: added `companies`, `collections`,
`products` namespaces calling the new routes, following the file's
existing `apiFetch`/`qs` conventions.

## 6. Backend/API changes

New routes (all under `authenticate`; reads use `tiles:read`, writes use
`catalogs:write` — both pre-existing permission strings, no new ones
invented):
- `GET/POST /companies`, `GET/PATCH /companies/:id`
- `GET/POST /collections`, `GET/PATCH /collections/:id`
- `GET/POST /products`, `GET/PATCH /products/:id`, `GET /products/:id/resolve-variant`, `POST/DELETE /products/:id/variants[/:tileId]`

New: `src/services/collection.service.ts`, `src/services/product.service.ts`,
`src/controllers/catalogHierarchy.controller.ts`,
`src/routes/catalogHierarchy.routes.ts`,
`src/validators/catalogHierarchy.validators.ts`. Extended (not replaced):
`src/services/brand.service.ts` (added company CRUD; existing
`listBrands`/`resolveBrand` used by the sync pipeline untouched).

**`getTopCollections()` bug fixed**: `dashboard.service.ts` now groups by
`(brandId, collection)` instead of `collection` alone, and the result
carries `brandId`/`brandName`, so two companies with an identically named
collection never merge into one count. Verified directly (test #10 in the
suite, and by the same logic the backfill fixtures exercised).

`tileRecommendation.service.ts` (`listAllTiles`, the Surface Archive
query): added `collectionId`, `productId`, `finish`, `size` filters;
broadened search to company name, collection label and product name
alongside the existing tile name and SKU match. Still one `findMany` +
`count`, still bounded pagination — no N+1 introduced.

No ERP database credential is referenced anywhere in this stage's code.

## 7. Surface Archive changes

Query logic extended (filters + broader search) but its record set is
unchanged — verified directly: the test suite's `allTiles` count (from a
raw `prisma.tile.count()`) matched the Surface Archive API's reported
total exactly, with every seeded tile, including the one deliberately
left with no collection or product, still present and findable.

## 8. Test counts and results

New suite: `backend/test-scripts/catalog_hierarchy_test.js`
(`npm run test:catalog-hierarchy`) — real server, a real disposable
Postgres database the script creates and drops itself, the actual
`catalog.html` page driven in Chromium. **35/35 checks passed**, covering
all 17 items the brief's TESTING section lists: company CRUD, collection↔company
and product↔collection relationships, variant↔product assignment/unassignment
(tile id and fields preserved), finish/size resolution (including the
invalid-combination case resolving to `null`), the same collection name
staying separate across two companies, company-scoped filtering, search
across company/collection/product/SKU, Surface Archive record-count
regression, pagination, invalid relationships refused, missing mappings
staying visible, duplicate-company-name prevention, and a full browser
walk of the actual UI (company → collection → product → finish → size →
resolved SKU → breadcrumb back to companies → Surface Archive still
rendering → zero uncaught JS errors).

Targeted regression on every existing file this stage touched, run in
addition to the new suite:
- `test:tile-recommendation` — 38/38 passed (the ranking logic the
  Surface Archive query sits next to).
- `test-scripts/home_page_test.js` — 60/60 passed (exercises
  `/dashboard/collections`, the endpoint `getTopCollections()` backs).
- `test-scripts/physical_sample_test.js` — 100/100 passed (exercises
  `Tile`/`ProductColour`/`PhysicalSample` directly — confirms the
  colour/sample system below `Tile` is completely unaffected).

**233 checks total, zero failures, zero regressions.** This was a
targeted regression pass over the suites that exercise the files this
stage changed, not every one of the ~60 test scripts in the repository;
the untouched ones (library, print boards, mood boards, admin, settings,
jobs, client wishlists, etc.) were not re-run, since nothing in this stage
touches their code paths.

## 9. Performance

Every new list endpoint (`/collections`, `/products`) uses the existing
bounded pagination helper (`DEFAULT_LIMIT=20`, `MAX_LIMIT=100`) — never an
unbounded query. `getProductById` computes finish/size options once from
the already-fetched variant list rather than issuing further queries per
variant. `listAllTiles`'s added filters are plain indexed/equality
`where` clauses on an already-indexed table (`Tile.productId` is now
indexed); no N+1 was introduced anywhere. Image storage/delivery
(`normalizeDriveImageUrl`, Google Drive) is unchanged.

## 10. Files changed

Backend: `prisma/schema.prisma`, `prisma/migrations/20261127173950_add_catalog_hierarchy/`,
`src/services/{brand,collection,product,dashboard,tileRecommendation}.service.ts`,
`src/controllers/catalogHierarchy.controller.ts`,
`src/routes/{catalogHierarchy,index}.ts`,
`src/validators/{catalogHierarchy,tileRecommendation}.validators.ts`,
`scripts/backfill-catalog-hierarchy.js`,
`test-scripts/catalog_hierarchy_test.js`, `package.json`.
Frontend: `catalog.html`, `assets/api-client.js`.
Docs: `docs/CASA_CATALOG_HIERARCHY_STAGE2.md` (mapping/inspection),
this report.

## 11. Remaining limitations

- No real CASA database exists in this environment, so the migration
  preview and record counts above are from a disposable test database
  built for this purpose — they are not, and must not be read as, a
  statement about real catalog data. Running the backfill tool against
  the real CASA database (once reachable) is the natural next step, in
  dry-run first.
- `Collection.catalogueDocumentUrl` and `Product.coverImageUrl`/`specifications`
  are schema fields with no upload UI yet — they can be set via the API
  but nothing in the admin frontend writes them today. Populating them
  (and building an admin UI for Company/Collection/Product management,
  as opposed to the read-side browsing this stage built) was out of this
  stage's scope.
- The near-duplicate name detector in the backfill script uses a fixed
  similarity threshold (0.82) and plain Levenshtein distance — adequate
  for the cases tested, but a real catalog's naming conventions may need
  that threshold tuned after seeing real ambiguous groups.
- Existing `Tile.collection` free-text data is not touched by anything in
  this stage except the backfill tool, which only runs on explicit
  invocation (dry-run by default). Nothing automatically backfills it on
  server start or on a schedule.

## 12. ERP integration contract (future, not implemented this stage)

Per Section 10, this stage implements **no** live connection between CASA
and the ERP — no shared tables, no direct queries, no shared credentials.
The future contract, for when a separately approved integration stage
takes this on:

```
ERP API  →  CASA Backend  →  CASA Catalog Frontend
```

Expected fields the ERP would expose per level (matching what Stage 1
already built there): Company (`name`, `code`, `logoUrl`, `description`,
`isActive`), Collection (`name`, `companyId`/`brandId`, `description`,
`coverImageUrl`, `catalogueDocumentUrl`, `isActive`), Product (`name`,
`code`, `collectionId`, `description`, `specifications`, `category`,
`coverImageUrl`, `isActive`), Variant/SKU (`sku`, `finish`, `size`,
`colour`, `thicknessMm`, `purchasePrice`/`sellingPrice`, stock totals).
CASA's own `Collection`/`Product`/`Tile` models built this stage already
use the matching field names and shapes (`brandId`, `collectionId`,
`finish`, `size`, `material`, `thickness`), specifically so that a future
sync layer maps one to the other without renaming anything on either
side. That sync layer, its conflict rules, and its approval are entirely
out of scope here, per the brief's explicit boundary.
