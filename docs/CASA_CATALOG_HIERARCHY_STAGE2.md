# Stage 2 — CASA De Aurum Catalog Hierarchy: Inspection & Mapping

Status: **planning only — no schema, migration, or code has been written yet.**
This document is the required "mapping document" from the Stage 2 brief
(Section 1) plus the migration-preview material from Section 3. It is
descriptive, not a change. Open design decisions are called out explicitly
and are presented for approval in chat alongside this document, per the
brief's instruction to "STOP and present the migration plan... before
applying."

## 1. What exists today in CASA (verified by direct re-read this pass)

CASA's backend is `backend/` (Express + TypeScript + Prisma + Zod, its own
PostgreSQL schema at `backend/prisma/schema.prisma`, **completely separate
from `erp/prisma/schema.prisma`**). No code in this stage touches the ERP
database, schema, or services.

### 1.1 The existing model chain

```
Brand (cuid id)
 └─ Catalog[]        -- one row per uploaded/extracted PDF catalogue
     └─ Tile[]        -- one row per finish×size SKU
         └─ ProductColour[]   -- one row per colour of that Tile
             └─ PhysicalSample?  -- the physical cut piece for that colour,
                                    with its own barcode and full
                                    SamplePlacement location history
```

Exact current fields (re-read directly from `backend/prisma/schema.prisma`
this pass):

- **`Brand`**: `id (cuid)`, `name` (unique), `slug` (unique), `logoUrl?`,
  `isActive`, timestamps. → **This is the brief's "Company."**
- **`Catalog`**: `id`, `brandId` (FK, `onDelete: Cascade`), `fileName`,
  `filePath?`, `status`, `totalPages?`, `tilesExtracted`, `fileHash?`,
  processing/dedup bookkeeping fields, `uploadedById?`, timestamps. This is
  an **upload/extraction job record**, not a commercial collection — it
  tracks one PDF file being processed, not a line of products a customer
  browses.
- **`Tile`**: `id`, `name`, `brandId` (FK), `catalogId?` (FK), `size?`,
  `finish?`, `type` (`TileType` enum: BASE/HIGHLIGHTER/BORDER/ACCENT/
  LARGE_FORMAT_BASE — a mood-board design-role axis, not a commercial
  category), `colorTone?`, `bestRoom?`, **`collection?` (free nullable
  string, no FK, not brand-scoped)**, `imageUrl?`, `productCode?`,
  `inStock`, source-tracing fields (`sourcePage`, `imageBbox`), timestamps.
  No `material` or `thickness` field exists on `Tile` today.
- **`ProductColour`**: `id`, `productId` (FK → `Tile`), `colourName`,
  `colourCode?`, `availability` enum, `notes?`. Unique on
  `(productId, colourName)`.
- **`PhysicalSample`**: `id`, `colourId` (FK → `ProductColour`, unique —
  at most one physical sample per colour), `sampleId` (unique, human-
  readable), `barcode` (unique), `photoDriveFileId?`, `photoUrl?`,
  `status` (ACTIVE/REMOVED, never hard-deleted), plus `SamplePlacement[]`
  (append-only location history) and `PlacementChangeRequest[]`.

**Important refinement over an earlier, shallower inspection pass**: CASA
already has a real, mature variant-level system *below* `Tile` — colour
(`ProductColour`) and the physical sample it represents
(`PhysicalSample`/`SamplePlacement`). This is unrelated to, and sits
entirely underneath, the Company→Collection→Product→Variant hierarchy this
stage is asked to add. **It is not touched by this plan.** The new
hierarchy work happens strictly *above* `Tile`; `Tile` keeps meaning
exactly what it means today (one finish×size SKU, with its existing
colour/sample children untouched).

### 1.2 The confirmed structural gap

Mapped against the brief's target hierarchy (Company → Collection →
Product → Variant):

| Brief's term | Exists today? | As what |
|---|---|---|
| Company | ✅ Yes | `Brand` |
| Collection | ❌ No | `Tile.collection` — a free-text nullable string, **not** an entity, **not** scoped to a brand |
| Product | ❌ No | Does not exist. `Tile` is already the variant (finish×size) level |
| Variant | ✅ Yes (as `Tile`) | `Tile`, further broken into colour (`ProductColour`) and physical sample (`PhysicalSample`) below it |

This is the exact same shape of gap Stage 1 found and solved on the ERP
side with a new `ProductLine` entity between `Brand`/`Collection`(ERP's own,
pre-existing `ProductHead`) and the SKU-level `Product` table. Stage 2 needs
two new entities on the CASA side: one for **Collection** (explicit,
brand-scoped) and one for **Product** (sits between Collection and `Tile`).

### 1.3 The confirmed `getTopCollections()` bug

`backend/src/services/dashboard.service.ts`, `getTopCollections()`:

```ts
prisma.tile.groupBy({
  by: ['collection'],
  where: { collection: { not: null } },
  ...
})
```

Groups purely by the free-text `collection` string, with **no `brandId` in
the `by` clause or the `where` clause**. Two different brands with a
collection named e.g. "Classic" are merged into one row today. This is the
exact bug the brief names in Section 5 and must be fixed once Collection
becomes a real, brand-scoped entity.

### 1.4 How `Tile.collection` and `Tile.productCode` get written today

Two existing pipelines write directly to the free-text fields, and neither
goes through any grouping/identity logic — confirmed by direct re-read:

- **`catalogExtractor.service.ts`** (PDF → Gemini extraction pipeline):
  writes `productCode` and deduplicates new tiles against existing ones by
  `brandId` + `productCode`, falling back to `name` + `size` when no code
  is present. It does not write or resolve `collection` at all in the path
  read this pass.
- **`masterTileSync.service.ts`** (master-sheet sync): writes
  `collection: input.collection ?? undefined` verbatim from the sheet row,
  matched to an existing `Tile` by `productCode` (`findFirst`, deliberately
  not `findUnique`, per its own comment). The sheet's free-text collection
  name becomes the `Tile.collection` string as-is — no normalization, no
  brand scoping, no dedup against existing collection names.

**This stage does not change either pipeline.** Per the brief's Section 13
("do not rebuild existing extraction workflows... do not change Google
Drive or Google Sheets workflows"), both are left exactly as they are. The
new Collection/Product resolution happens in a separate, additive layer
that reads the `collection` string and `productCode` these pipelines
already write, not inside the pipelines themselves.

### 1.5 Frontend catalog page today

`frontend/catalog.html` (433 lines, read in full): a flat two-section page
— a Collections grid (cards grouped by the buggy free-text
`getTopCollections()`) and a Surface Archive grid (`Tile` rows via
`listAllTiles()`). **No company drill-down, no product-level grouping, and
no product detail view exist anywhere in this file.** The "USE PALETTE →"
button on a collection card is a plain navigation link to
`mood-board.html` with no query parameters — it carries no
collection/product context today, so "preserving" it is low-risk: it
remains a plain nav link, just from a card that now also carries
company/product identity.

### 1.6 Surface Archive (`listAllTiles()` in `tileRecommendation.service.ts`)

Already supports `collection` (exact-string) and `brandId` filters, bounded
pagination (`DEFAULT_LIMIT=20`, `MAX_LIMIT=100` from
`backend/src/utils/pagination.ts`), single `findMany`+`count`, no N+1. This
is a solid base to extend with `productId`/finish/size filters — no
rework needed, only additive filter parameters.

### 1.7 API/backend conventions confirmed (to be followed, not reinvented)

- IDs: `@id @default(cuid())` — **CASA uses `cuid()`, not `uuid()`** (ERP
  uses `uuid()`). Any new CASA model must use `cuid()` to match.
- Response envelope: `{ success: true, data: {...}, meta?: {...} }` via a
  `catchAsync()` controller wrapper (confirmed from
  `tileRecommendation.controller.ts`).
- Auth: real JWT auth (`authenticate` middleware) + a permission system —
  `requirePermission('tiles:read')` etc. Confirmed implementation
  (`backend/src/middlewares/auth.ts`):
  `req.user.permissions.includes('*') || req.user.permissions.includes(permission)`,
  else `403 FORBIDDEN`. New Company/Collection/Product endpoints should use
  existing permission strings where they already fit the resource
  (`tiles:read`/`tiles:write`-style) or new ones following the same
  `resource:action` convention.
- Validation: Zod schemas in `src/validators/*.validators.ts`, with
  `z.infer<>` exported types — same pattern as `tileRecommendation.validators.ts`.
- Routing: `backend/src/routes/index.ts` is the single mount point. Current
  mounted prefixes: `/health /auth /library /client-wishlists /samples
  /users /roles /dashboard /catalog-extractor /design-rules
  /reference-images /integrations /mood-boards /print-boards /tiles
  /customers /admin/api-keys /admin /settings /jobs /ai`. **No public
  `/companies`, `/collections`, or `/products` prefix exists yet** — these
  would need to be added here.
- Migrations: 23 existing migrations under `backend/prisma/migrations/`,
  named `YYYYMMDDHHMMSS_snake_case_description`. Any new migration should
  follow this exact naming convention.
- No `catalogueUrl`/`pdfUrl`/`documentUrl`-style field exists anywhere in
  the schema today (confirmed by a schema-wide search) — the brief's
  "catalogue PDF" field for Collection/Product would be new.
- Palette feature ("USE PALETTE →") is a plain nav link with no data
  dependency (see 1.5) — nothing to preserve beyond the link itself still
  working, which it will.

## 2. Target mapping (proposed — not yet built)

| Brief's hierarchy level | CASA entity | Status |
|---|---|---|
| Company | `Brand` | **Reused as-is.** No changes to `Brand` needed beyond what it already has (name, logoUrl, isActive — brief asks for `code` and `description` too; see open decision 2A). |
| Collection | **New entity**, e.g. `Collection` | **New.** Belongs to one `Brand` (`brandId` required FK). Replaces `Tile.collection` as the source of collection identity going forward. |
| Product | **New entity**, e.g. `Product` | **New.** Belongs to one `Collection` (`collectionId` required FK). Sits directly above `Tile`. |
| Product Variant | `Tile` (unchanged) | **Existing table, additive column only.** Add a nullable `productId` FK on `Tile` pointing at the new `Product` table. `Tile`'s own colour/sample children (`ProductColour`, `PhysicalSample`) are untouched. |

This mirrors Stage 1's ERP design pattern exactly: existing SKU-level table
keeps its identity; a new head/line entity is inserted above it with a
**nullable** FK, so every existing row keeps working with `productId =
NULL` until explicitly backfilled, and nothing is deleted or forced.

## 3. Migration preview (Section 3 of the brief)

Per Section 3's own fallback clause and the inspection in §1 above:

1. **No persistent CASA database connection exists in this sandbox.**
   Confirmed by: `backend/.env` does not exist (checked via `ls -la`,
   existence-only, no content read, per "do not print secret values");
   a repository-wide search for any `.env` file outside `node_modules`
   found none.
2. Therefore **no real record counts, brand counts, collection-name
   counts, Tile counts, duplicate-name analysis, or ambiguous-mapping
   report can be produced against real data** — there is no real data
   reachable from this environment.
3. Per the brief's own instruction ("If no persistent CASA database
   connection is available, use an isolated test database for schema and
   application testing only. Do not claim that production data has been
   migrated."): the only honest path is to stand up a **fresh, isolated
   CASA test database** (mirroring the ERP's own `useTestDatabase()`
   pattern already used in `erp/test/product_hierarchy_test.mjs`), seed it
   with synthetic fixture data that deliberately includes the ambiguous
   cases the brief asks us to detect (same collection name under two
   different brands; repeated product names; a Tile with no collection
   at all), and run the dry-run backfill script against that test
   database only.
4. Any report produced from that point on will be explicitly labeled as
   **test-database-only**, never presented as a real/production migration
   count. No real backfill will be applied anywhere, in test or otherwise,
   without an explicit further approval step showing the dry-run's exact
   preview output first.

This matches exactly how Stage 1's own test suite and audit were built and
reported — no fabricated production numbers, ever.

## 4. Open design decisions (need your input before any schema file is written)

See the accompanying chat message / question for these — summarized here
for the record:

- **2A.** `Brand` (Company) additions: brief asks for `code` and
  `description`. Neither exists today. Proposed: add both as optional
  nullable columns (purely additive, no risk) — unless you'd rather skip
  `code` since `slug` already serves a similar purpose.
- **2B.** How to represent "Category" on the new Product entity. CASA has
  no existing category taxonomy (`TileType` is a design-role enum for
  mood-board composition, not a commercial category, and must not be
  reused for this). Proposed: a plain optional string field on `Product`,
  not a new FK-based taxonomy table, to avoid over-building where no
  existing structure asks for one.
- **2C.** Whether to add optional `material`/`thickness` columns to `Tile`.
  The brief lists them as desired variant attributes; neither exists on
  `Tile` today. These are additive and low-risk but tangential to the
  core hierarchy ask — flagging rather than silently adding.
- **2D.** Naming the two new models. Proposed: `Collection` and `Product`
  (CASA has no existing model already named either, unlike the ERP side
  where `Product` was already taken and `ProductLine` was used instead).

## 5. What is explicitly NOT done yet

No schema change, no migration file, no new service/controller/route, no
frontend change, no test database has been created. This document and the
accompanying question are the full "STOP and present" deliverable for
Section 3; implementation begins only after you approve the mapping above
and answer the open decisions in §4.
