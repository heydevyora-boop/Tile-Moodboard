# Future ERP Synchronization Contract

Status: **documentation only — describes how a future, separately
approved ERP integration should consume CASA's existing read-only
catalog feed and readiness endpoints. Nothing here is implemented as
live synchronization, a webhook, a scheduled export, or an external
ERP connection.** Per Phase 3's explicit boundary: this is a foundation,
not a sync.

## 1. The two endpoints a future integration would use

- `GET /integrations/erp/catalog-feed` — the data itself. Gated by a
  shared secret (`x-erp-key` / `ERP_EXPORT_API_KEY`), never a CASA user
  session.
- `GET /integrations/erp/catalog-readiness` — the data-quality report
  over the same hierarchy, for a human (or, in a future phase, the
  integration itself) to check before trusting a pull. Gated by the
  normal CASA OWNER session, not the ERP's own credential — this one is
  for people, not machines, in this phase.

Both are read-only. Neither accepts a request body, writes to the
database, or calls out to anything.

## 2. Stable record identifiers

Every record in both endpoints carries its real CASA `cuid()` id
(`company.id`, `collection.id`, `product.id`, `variant.tileId`). A
future integration should key its own mapping table on these ids, never
on names — names change (a product gets renamed, a collection gets
re-titled), ids do not. `product.code` and `variant.sku` are
human-meaningful identifiers for display and reconciliation, not
substitutes for the id.

## 3. SKU uniqueness expectations

- `tiles.productCode` carries a case-SENSITIVE unique database
  constraint today (`tiles_productCode_key`) — two tiles can never
  share the exact same SKU string.
- This does **not** cover case-insensitive duplicates ("ABC-1" vs.
  "abc-1"), which the catalog-readiness endpoint's `duplicateSkus`
  section detects and reports. A future integration should treat SKUs
  as case-insensitively unique and reconcile any reported duplicate
  before importing either row, rather than silently picking one.
- A SKU is never reused: Stage 2's backfill tool and every service in
  this codebase only ever assign a `productCode` once, at creation.

## 4. Pagination behavior

Both endpoints use the same shared pagination convention as every
other list endpoint in this API (`getPagination`/`buildPaginationMeta`,
`utils/pagination.ts`): `page` (1-based), `limit` (max 100 — a higher
value is rejected, not silently clamped), and a `meta` object with
`total`, `totalPages`, `hasNextPage`, `hasPrevPage`. A future
integration should page until `hasNextPage` is `false`, never assume a
fixed page count, and never request a `limit` above 100.

The catalog feed's pagination is applied in application code (not a
database `LIMIT`/`OFFSET`) because product export-eligibility depends
on validating each product's own tiles, which cannot be expressed as a
SQL `WHERE` clause. At CASA's current scale this is one bounded query;
if the catalog grows by orders of magnitude, this is the first place to
revisit.

## 5. Versioning

`meta.version` on the catalog feed (currently `"1"`) and
`meta.rulesVersion` on the readiness report (currently `"1"`) each
identify the shape/rules in effect. A future integration should check
these and refuse to parse a version it doesn't recognize, rather than
guess at a changed shape. Bump whichever version changes whenever a
field is added, removed, renamed, or a validation rule's meaning
changes in a way a consumer would need to react to.

## 6. Filtering

Both endpoints accept optional `brandId` and `collectionId` query
filters, narrowing to one company or one collection. `collectionId`
has no meaning for an unassigned Tile (it has no collection by
definition) — passing it narrows `unassignedTiles`/reconciliation to
zero rather than show tiles unrelated to the collection asked for.

## 7. Data validation

Every record returned by the feed has already passed the readiness
service's validation (nothing `BLOCKED` is included — see §9). A
future integration should still re-validate on its own side before
writing anything into ERP tables (never trust a feed blindly), but does
not need to re-derive CASA's own completeness rules — those are
documented in `catalogValidation.service.ts` and summarized in the
readiness endpoint's own response.

## 8. Handling of updated products

Neither endpoint currently reports "what changed since last time" —
every call returns the full current state of whatever it's scoped to.
A future integration should either (a) pull the full feed each time and
diff against its own last-known state by id, or (b) wait for a future
phase that adds a `updatedAt`-based incremental query (not built here,
since it would be the first step toward live sync, explicitly out of
this phase's scope).

## 9. Handling of inactive products

An inactive Brand, Collection, or Product (`isActive: false`) is
excluded from both endpoints' `data` entirely — not returned with a
flag, simply absent. A future integration should treat a previously-
seen id that stops appearing as "no longer offered," and should prefer
a soft state (archived/discontinued) over hard-deleting its own mirror
record, since CASA itself never hard-deletes a Brand/Collection/Product
this way (only a Tile can be hard-deleted — see §10).

## 10. Handling of deleted or discontinued products

CASA has a genuine hard-delete path only for `Tile`
(`DELETE /catalog-extractor/tiles/:id`) — Brand/Collection/Product are
soft-deactivated (`isActive: false`), never removed. A future
integration should expect:
- A Product/Collection/Brand that disappears from the feed may reappear
  later (reactivated) with the **same id** — never recreate it as a new
  record.
- A Tile (variant/SKU) that disappears is genuinely gone and will never
  reappear with that id; the ERP side should mark it discontinued
  rather than poll for its return.

## 11. Error and retry expectations

Both endpoints use the same global error envelope as the rest of this
API (`{success:false, status, message, errors?}`), via the shared error
handler. A future integration should:
- Treat `403` (missing/invalid `x-erp-key`, or missing OWNER session for
  readiness) as a credential problem, not a transient failure — retrying
  without fixing the credential will never succeed.
- Treat `400` (a validation error, e.g. an out-of-range `limit`) as a
  request-shape problem to fix before retrying, not a transient failure.
- Treat `5xx` as transient and safe to retry with backoff — the
  database is read-only here, so a retry is always safe (no
  double-write risk).

## 12. Reconciliation before and after imports

Before any future import, pull `GET /integrations/erp/catalog-readiness`
and confirm `summary.blockedProducts` and `summary.duplicateSkuGroupCount`
are at the expected level (ideally zero, or a known, accepted set) —
importing while either is non-zero risks importing incomplete or
ambiguous data. After an import, the receiving ERP should independently
recompute its own counts of imported companies/collections/products/
variants and compare them against the feed's own `meta.total` and
`summary` counts for that same scope — any mismatch means something was
silently dropped or duplicated in transit, and should block the import
from being marked complete until explained.
