# Product Master — step 3

The ERP's own backend for brands, product heads, variants and SKUs,
with two screens connected to it.

```
ERP frontend  ->  Product Master API  ->  ERP PostgreSQL
                  (Express, this step)    (step 2)
```

Nothing calls the Casa De Aurum backend, the website or its
database. No website file is touched. The catalogue extraction
pipeline and the Google Drive and Sheets workflow are untouched.

---

## 1. The hierarchy, and a naming note

```
Brand          Kajaria
  └ Product Head / Series      Neo Sapien          ← ONE head
      ├ Variant  Grey   DV-…   KAJ-NEOSAP-GRE-MA-600X1200
      ├ Variant  Brown  DV-…   KAJ-NEOSAP-BRO-MA-600X1200
      └ Variant  Blue   DV-…   KAJ-NEOSAP-BLU-MA-600X1200
```

Adding a colour never creates a second Neo Sapien. A duplicate
within a brand is refused outright; a *near*-duplicate is returned
with its candidates for a person to judge, never merged
automatically.

**There is no `ProductVariant` table, and none was added.** The
step‑2 schema already had this shape under different names:

| The brief says | The database calls it | Why it was not renamed |
|---|---|---|
| Product Head / Series | `collections` | Created in step 2, before the term was settled. A rename is one non-destructive `ALTER TABLE` — say the word. |
| Product Variant | `products` | A `products` row **is** a variant: it carries the SKU, colour, finish, size and both prices. Renaming it would touch every foreign key and service for no behavioural gain. |

The API speaks the brief's vocabulary throughout
(`/api/product-heads`, `productHead`, `variants`).

---

## 2. Database: reused, extended, never rebuilt

Every step‑2 table is reused as it stands. The migration
`20261121074655_product_master_heads_variants_images` is **additive
only** — no `DROP`, no `TRUNCATE`, no `DELETE`, and the 15 products,
10 heads and 64 ledger entries already in the development database
survived it untouched.

**Added to existing tables**

| Table | Column | Why |
|---|---|---|
| `collections` | `categoryId`, `description` | A head belongs to a category, which decides what its variants must carry. Nullable, because step‑2 rows predate it and a guessed backfill is worse than an honest blank. |
| `products` | `attributes` (JSON) | Category-specific fields. A GRC panel has a projection and a material; a tile has a surface type. Neither belongs as a column on every product. |
| `products` | `archivedAt`, `archivedById` | Archival is independent of commercial status — see §5. |
| `products` | indexes on `colour`, `finish`, `size`, `archivedAt` | The four filters the screen offers. |

**New table:** `product_images` — main, gallery and catalogue-page
references with an approval flag and provenance (§7).

**New guards (SQL):**

- `brands_unique_normalised_name` — `lower(btrim(collapse(name)))`.
  The plain unique column stops the second "Kajaria" and nothing
  else; "kajaria", "Kajaria " and "KAJARIA" all got through and
  split the catalogue four ways.
- `collections_unique_normalised_name_per_brand` — the same, scoped
  to the brand, because two brands may both sell a "Verona".
- `product_images_single_main`, `product_images_main_must_be_approved`.
- `product_archival_is_complete`.
- `v_product_head_summary` — a head with its variant counts and stock.

---

## 3. Services

| File | Holds |
|---|---|
| `server/services/brand.service.mjs` | Brands: list, get, create, update, activate/deactivate, near-match detection. |
| `server/services/productHead.service.mjs` | Heads: list, get-with-variants, create, update, near-match detection. |
| `server/services/product.service.mjs` | Variants: list (search/filter/sort/page), get, stock summary, create, update, status, archive, restore. |
| `server/services/sku.mjs` | Deterministic generation, manual override, concurrency-safe allocation. |
| `server/services/productRules.mjs` | Category-aware validation. |
| `server/services/normalise.mjs` | Name folding and similarity. |
| `server/services/audit.mjs` | Audit rows, written in the same transaction as the change. |

---

## 4. Endpoints

| Method | Path | |
|---|---|---|
| GET | `/api/health` | |
| GET | `/api/products` | search, filter, sort, paginate — **in the database** |
| GET | `/api/products/filter-options` | the values the dropdowns offer |
| GET | `/api/products/:id` | one variant, with images and sync state |
| GET | `/api/products/:id/stock` | **read-only** stock summary |
| POST | `/api/products` | create a variant, allocate its SKU |
| PATCH | `/api/products/:id` | edit — the SKU is refused |
| POST | `/api/products/:id/status` | ACTIVE / INACTIVE / DISCONTINUED |
| POST | `/api/products/:id/archive` · `/restore` | |
| GET/POST/PATCH | `/api/brands`, `/api/brands/:id` | |
| GET | `/api/brands/similar` | near-matches before saving |
| POST | `/api/brands/:id/activate` · `/deactivate` | |
| GET/POST/PATCH | `/api/product-heads`, `/api/product-heads/:id` | `:id` returns every variant |
| GET | `/api/product-heads/similar` | |
| GET | `/api/reference/categories` · `/product-rules` · `/warehouses` | |

There is **no DELETE route** for a product. See §5.

---

## 5. The rules that shaped it

**Out of stock is not a product status.** The enum is
ACTIVE / INACTIVE / DISCONTINUED. Availability is derived from
inventory on every read, returned as `stock.isOutOfStock` and
`stock.isLowStock`, and shown as a *second* pill beside the status —
so a product can be Active and out of stock at once. A retired
product holding nothing reads DISCONTINUED, never OUT_OF_STOCK: one
is a product to stop buying, the other one to buy more of.

**A SKU is issued once.** `PATCH` with a different `sku` is refused
with a 409, not ignored — a caller that thinks it renumbered a
product should find out. Renaming, re-pricing or re-finishing a
product leaves it untouched, because order lines and stock
movements already quote it.

**Products are archived, not deleted.** One with stock movements
cannot be deleted at all — the database restricts it, because
deleting it would orphan the entries that explain where the stock
went. Archiving hides it from every default list and keeps all of
it. `archivedAt` is separate from `status` because the two are
independent facts.

**Validation is category-aware and names every field.** A floor
tile must have a thickness, finish and colour; a GRC panel must
have a height, width, projection and material and is never asked
for a tile thickness. An attribute key no rule allows is rejected
rather than stored. Every failure is collected and returned at
once — one correction instead of six round trips.

**Stock is read, never written.** There is no path from any Product
Master service to a stock figure. Moving stock is the inventory
phase's job and the ledger stays the only way.

---

## 6. SKUs

```
KAJ-NEOSAP-GRE-MA-600X1200          brand · head · colour · finish · size
KAJ-NEOSAP-GRE-MA-600X1200-2        if that one is taken
```

Deterministic: same inputs, same candidate, on every machine, with
no clock and no randomness. Hyphenated so it can be read over a
phone — `600X1200` keeps its X because `6001200` is both 600×1200
and 6001×200.

**Concurrency.** The unique constraint is the arbiter; a loser
recomputes and retries with a jittered backoff. *Ten simultaneous
creations of the same variant produced ten different SKUs and ten
rows* — tested, not asserted. Without the backoff the ten retries
collide again in lockstep; without the retry they fail outright,
which is what happened first time, because Prisma 7's pg adapter
leaves `meta.target` undefined and the clash went undetected.

A manual SKU is accepted where the studio must match a supplier's
code or a shelf label. If it is taken, it is refused — never
quietly changed into something else.

---

## 7. Images

`product_images` stores **references, not files**: a URL and an
optional storage key. The catalogue pipeline already uploads to
Google Drive and records the URL; this points at what is there.

The rule the table exists for: **an extracted catalogue image is
not automatically a product image.** Every row arrives with
`isApproved = false`, and a database CHECK forbids an unapproved
image from being MAIN. A partial unique index allows one MAIN per
product. `catalogueName`, `cataloguePage` and `extractionRef` keep
provenance — `extractionRef` is a loose string, not a foreign key,
so the ERP never depends on the extraction system being reachable.

The upload and approval UI is not built in this phase.

---

## 8. Catalogue / Excel field mapping — definition only

**No import engine was built, and the existing pipeline was not
touched.** This is the agreed mapping for the dedicated import
phase:

| Spreadsheet column | Lands in | Notes |
|---|---|---|
| Brand | `brands.name` | Matched on the normalised name; an unknown brand is a row error, not a silent create. |
| Product Head / Series | `collections.name` | Matched within the brand. A near-match goes to human review. |
| Product Name | `products.name` | |
| Size | `products.size` (+ `lengthMm`, `widthMm`) | Mandatory. |
| Thickness | `products.thicknessMm` | Mandatory for tiles. |
| Colour | `products.colour` | Part of the variant's identity. |
| Finish | `products.finish` | Part of the variant's identity. |
| Image Reference | `product_images.url` | `source = CATALOGUE_EXTRACTION`, `isApproved = false`. |
| Catalogue Reference | `product_images.catalogueName` / `cataloguePage` / `extractionRef` | |
| (derived) | `products.sku` | Generated, unless the sheet carries one. |

Brand + Product Head + Colour + Finish + Size identifies a variant.
An exact match is an update; a near-match is a review item; neither
is ever merged automatically.

---

## 9. Running it

```bash
cd erp
npm install
cp .env.example .env            # fill in ERP_DATABASE_URL

npm run db:deploy               # migrations
npm run db:seed                 # safe, idempotent
npm run api                     # http://127.0.0.1:4310
npm run dev                     # http://127.0.0.1:5174   (second terminal)
```

### Tests

```bash
npm run db:verify               #  41  database integrity (step 2)
npm run test:product-master     #  92  Product Master (step 3)
npm run test:frontend           #  42  frontend regression (needs api + dev)
npm run test:data               #  35  the demo data the unconnected screens use
```

The Product Master suite builds and uses its **own** database
(`devyora_erp_test`) from the same migrations and seed. It refuses
to run against any database whose name does not contain "test".

---

## 10. What is NOT connected

| Screen | |
|---|---|
| Product Master, Catalogue Structure | **live** — the ERP database |
| Dashboard, Inventory, Inward, Outward, Ledger, Purchase, Sales, Reports, Sync, Import/Export, Users, Settings | still generated demo data |
| Warehouses | planned placeholder |

The sidebar marks each one, and the topbar pill reads *Live data* or
*Demo data* per screen. A screen full of convincing demo data looks
exactly like a working one until somebody tries to save.

Also not built, deliberately: bulk actions, the Excel import
engine, image upload and approval UI, stock movements from Product
Master, authentication (the API resolves a real seeded user from an
`x-erp-user` header as a labelled placeholder), and anything that
talks to the Casa De Aurum backend.
