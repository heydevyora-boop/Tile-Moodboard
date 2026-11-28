# ERP API Reference — Step 8

The complete, endpoint-by-endpoint reference for the ERP API, written
for whoever builds Step 9 (the CASA De Aurum backend integration) so
they can consume this API **without opening the ERP database or the
ERP source**. If something here and the running API ever disagree,
the API inventory in §0 and the source are what Step 8 was checked
against — open an issue against this file rather than guessing.

This file documents **`/api/v1`**, the surface Step 9 should build
against. The older **`/api/*`** paths (no `/v1`) still exist, unchanged,
and are only for the already-approved ERP frontend; see §2 for why
both exist and §12 for how long `/api/*` is expected to live.

---

## 0. API inventory (what existed, what step 8 added)

Taken before any step-8 code was written, per the brief's "inspect
before implementing" requirement.

| Module | Routes before step 8 | What step 8 did |
|---|---|---|
| Product Master (`brands`, `product-heads`, `products`) | existed, open to any caller | reused unchanged under `/api/v1`; added `product:write` permission check to every mutating route |
| Excel Import (`imports`) | existed, open to any caller | reused unchanged under `/api/v1`; added `product:write` to `upload`, `confirm`, `retry` |
| Inventory (`inventory`) | existed, open to any caller | reused unchanged under `/api/v1`; added `stock:post` / `stock:reserve` |
| Warehouses (`warehouses`) | existed, open to any caller | reused unchanged under `/api/v1`; added a new `warehouse:write` permission (seed-only change, no migration) and `stock:post` on transfers |
| Purchase (`suppliers`, `purchase-orders`, `goods-receipts`, `purchase-returns`, `supplier-invoices`, `dashboard`, `history`) | existed, **already permission-checked** since step 6 | reused unchanged under `/api/v1`; no permission changes needed |
| Sales (`customers`, `quotations`, `sales-orders`, `delivery-challans`, `sales-invoices`, `sales-returns`, `customer-payments`, `sales-dashboard`, `sales-history`) | existed, **already permission-checked** since step 7 | reused unchanged under `/api/v1`; no permission changes needed |
| Reference (`categories`, `product-rules`, `warehouses`) | existed, read-only | reused unchanged under `/api/v1` |
| **Dashboard (combined)** | **did not exist** | **new**: `GET /dashboard/summary`, composing the three existing module dashboards |
| **Parties** | **did not exist** — no Party model, no cross-module party search | **new**: a thin, read-only search/detail/history surface over the existing `Customer` and `Supplier` services — no new table |
| Response envelope / versioning | every route returned its raw payload; no `/v1`, no standard shape | **new**: `/api/v1` wraps the same routes in `{success,message,data,meta}` / `{success,message,code,errors}`; `/api` is untouched |

**Duplicate or inconsistent endpoints found:** none. Each module had
exactly one route per operation; the brief's "duplicate endpoint"
concern did not apply to this codebase.

**Endpoints needing standardization:** all of them, in the one sense
that mattered — none spoke the envelope the brief asks for. That is
solved once, structurally, in §2, not by rewriting any route.

**Services reused as-is:** every one. No service file changed behavior
for step 8; `server/services/permission.mjs`'s `requirePermission()`
(built in step 6) is reused rather than reinvented, and the six
previously-open route files now call it the same way purchase and
sales already did.

### 0.1 Kept current after step 8 (maintenance note)

The table above is the step-8 point-in-time record and is left as
written. Two later pieces of work extended the same `/api/v1`
surface by the same mechanism (reusing the existing router objects,
no new envelope or versioning work needed) and are documented in
place in §6, not here:

- **The product hierarchy** added `product-lines` (full CRUD,
  `product:write`-gated writes, §6.3a) and four inventory drill-down
  routes (§6.6: `/inventory/hierarchy`, `/inventory/companies/:id`,
  `/inventory/collections/:id`, `/inventory/products/:id`). Both were
  mounted in `server/routes/v1.mjs` the same way everything in the
  table above is.
- **Partial transfer receipt** changed `POST /warehouses/transfers/
  :id/receive`'s body and the transfer line response shape (§6.7) —
  the route and its permission (`stock:post`) are unchanged; only
  what the body accepts and what the response reports grew.
- **Step 9 (CASA backend integration)** added one new route,
  `GET /integrations/casa/catalog-feed` (§6.14) — unlike every other
  route in this file, it is not for an ERP user at all: it exists
  for the CASA De Aurum backend to call as a separate service, so it
  is gated by its own shared secret instead of `x-erp-user` +
  `requirePermission()`.

Closing this gap — these additions existed in the code and were
smoke-tested in `test/api_v1_test.mjs` §1, but were never added to
§1's module list, never given their own request/response
documentation here, and the transfer lifecycle had never been
exercised end-to-end over real HTTP — is itself a later piece of work
on top of step 8, not a correction to what step 8 shipped.

---

## 1. Base URL, versioning and transport

| | |
|---|---|
| Base URL | `http://127.0.0.1:4310/api/v1` (`ERP_API_HOST` / `ERP_API_PORT`, defaults `127.0.0.1:4310`) |
| Legacy base URL (frontend only) | `http://127.0.0.1:4310/api` — same data, older response shape, see §2 |
| Content type | `application/json` for every request and response body, except the Excel/CSV upload and the import error-report download |
| CORS | Only `http://127.0.0.1:5174`, `http://localhost:5174`, `http://127.0.0.1:4173`, `http://localhost:4173` (the ERP frontend's dev and preview ports) are allowed. **No other origin, and no wildcard.** A Step 9 backend calling this API is a **server-to-server** call, not a browser call, so CORS does not apply to it — but see §9, because the binding does. |
| Health check | `GET /api/v1/health` → `{"success":true,"message":"ERP API is reachable","data":{"ok":true,"database":"devyora_erp_dev","phase":"step-8 ERP API development"},"meta":{}}` |

---

## 2. The response envelope

Every `/api/v1/*` response has exactly one of these two shapes.

**Success:**
```json
{
  "success": true,
  "message": "Request completed successfully",
  "data": { },
  "meta": { }
}
```

**Error:**
```json
{
  "success": false,
  "message": "The record is incomplete or invalid.",
  "code": "VALIDATION_FAILED",
  "errors": [ { "field": "name", "message": "Brand name is required." } ]
}
```

- `data` is the resource, or the array of rows for a list endpoint.
- `meta` is `{}` for a single-resource response, and the pagination
  block (§3) for a list.
- `errors` is always an array. A field-validation failure's `errors`
  **is** its field list (`[{field, message}, ...]`) directly — not a
  field list wrapped in something else. Any other refusal (a
  near-duplicate to review, insufficient stock, a duplicate
  idempotency key) carries exactly one object of detail at
  `errors[0]`, named per error code in §5.

### Why `/api/*` (no `/v1`) still exists

Before step 8, every route sent back whatever its service returned —
a bare array, a `{rows, page, pageSize, total, pageCount}` page, a
single entity — and the approved ERP frontend's one `request()`
function unwraps exactly that. The brief asked for the envelope above
**and** for backward compatibility with that frontend in the same
step. Rewriting sixty-odd existing route handlers to speak a new
shape would have touched every module this phase was told not to
rebuild, for a change that is about the wrapper, not the data inside
it.

So `/api/*` is **untouched, byte for byte** — same paths, same bare
payloads, same `{error:{code,message,details}}` error shape it has
always used — and `/api/v1/*` is the **same route files, the same Zod
schemas, the same service calls**, mounted a second time with three
small pieces of wrapping middleware (`server/middleware/apiV1.mjs`)
that build the envelope above from whatever the route already
returns. Nothing about how a route is written had to change; see
`server/utils/response.mjs` for the one place both shapes are
computed from the same data, so they can never drift apart.

**Step 9 should use `/api/v1` exclusively.** `/api/*` exists only so
the approved frontend (built in steps 3–7, before this envelope
existed) keeps working unmodified; it is not a second API to choose
between.

---

## 3. Pagination

Every list endpoint accepts:

| Query param | Meaning | Default | Max |
|---|---|---|---|
| `page` | 1-based page number | `1` | — |
| `pageSize` | rows per page | varies by endpoint (25–50) | module-specific, e.g. imports caps at 100–200 |
| `limit` | **alias for `pageSize`**, accepted only under `/api/v1` because it is the brief's own name for the same thing. If both are sent, `pageSize` wins. | — | — |

A paginated response's `meta`:

```json
"meta": {
  "currentPage": 1,
  "pageSize": 20,
  "totalRecords": 137,
  "totalPages": 7
}
```

There is no unbounded list endpoint: every one that returns rows
caps `pageSize` (enforced server-side, so a caller cannot ask for
everything in one request by sending a very large number).

---

## 4. Authentication and permissions — read this before integrating

**There is no real authentication yet.** The caller's identity
arrives entirely through a request header:

```
x-erp-user: manager@devyora.local
```

The server looks that email up in the `User` table and treats
whoever it finds as the caller. **Anyone who can reach the port can
claim to be anyone** by changing the header; there is no password,
token or session behind it. If the header is absent, the server
defaults to `admin@devyora.local` — convenient for local development,
and **not a security boundary**.

This is why the API is bound to `127.0.0.1` only (§9) and must not be
exposed to the internet or to an untrusted network in this phase. The
brief is explicit that this step must not invent a JWT scheme or
otherwise replace this placeholder without separate approval, and
this document is not claiming the system is production-authenticated.

### Permissions, on top of that placeholder identity

Every **mutating** route checks the caller's permissions against the
existing `Role` / `RolePermission` / `UserRole` tables (seeded since
step 2, first wired to any route in step 6). A request without
`x-erp-user` resolving to a real user gets `401 NO_ACTOR`; one
resolving to a user whose roles don't carry the needed permission
gets `403 FORBIDDEN`, naming the missing permission:

```json
{ "success": false, "message": "Sales Desk does not have permission to do that (product:write).",
  "code": "FORBIDDEN", "errors": [ { "permission": "product:write" } ] }
```

**Read (`GET`) routes are open to any resolved caller.** The brief's
risk is unauthorised *writes* — approving an order, posting stock,
finalising a receipt — and a read-only permission wall on top of an
already-placeholder identity would be ceremony, not security.

| Permission string | Required on | Held by (seeded roles) |
|---|---|---|
| `product:write` | brand / product-head / product create & edit & status changes; import upload, confirm, retry | ADMIN, MANAGER |
| `stock:post` | inventory opening/inward/outward/adjustment/damage/recovery/reversal; warehouse transfer create/dispatch/receive/cancel | ADMIN, MANAGER, STORE |
| `stock:reserve` | inventory manual reservation & release; sales order reserve & release | ADMIN, MANAGER, STORE |
| `warehouse:write` | warehouse create, edit, activate/deactivate | ADMIN, MANAGER |
| `purchase:write` | supplier create/edit/activate; purchase order create/edit/submit/cancel; purchase return post; supplier invoice create/status | ADMIN, MANAGER |
| `purchase:approve` | purchase order approve / return-to-draft / close | ADMIN, MANAGER |
| `purchase:receive` | goods receipt post / cancel | ADMIN, MANAGER, STORE |
| `customer:write` | customer create/edit/activate | ADMIN, MANAGER, SALES |
| `quotation:write` | quotation create/edit/send/respond/cancel/revise | ADMIN, MANAGER, SALES |
| `sales:write` | sales order create/edit/submit/cancel; quotation → order conversion | ADMIN, MANAGER, SALES |
| `sales:approve` | sales order approve / return-to-draft / close | ADMIN, MANAGER |
| `sales:dispatch` | delivery challan (dispatch) post | ADMIN, MANAGER, STORE |
| `sales:invoice` | sales invoice create / cancel | ADMIN, MANAGER |
| `sales:return` | sales return post | ADMIN, MANAGER |
| `sales:payment` | customer payment record | ADMIN, MANAGER |
| `*` | everything | ADMIN only |

`product:read`, `stock:read`, `purchase:read`, `sales:read`,
`customer:read`, `quotation:read`, `report:read` exist in the seed
but are **not checked anywhere** — every `GET` is open, per the
paragraph above; they are listed for completeness only.

**Dashboard and Parties are read-only and carry no permission check**
at all, for the same reason every other `GET` doesn't: there is
nothing to protect on a route that writes nothing.

---

## 5. Error codes

| HTTP | `code` | Meaning | `errors[0]` shape (if any) |
|---|---|---|---|
| 400 | `BAD_REQUEST` | generic bad input not caught by a field validator (e.g. missing `x-filename` on an import upload) | — |
| 401 | `NO_ACTOR` | `x-erp-user` did not resolve to a real user | — |
| 403 | `FORBIDDEN` | caller lacks the named permission | `{ "permission": "…" }` |
| 404 | `NOT_FOUND` | no such resource, or no such route at all | — |
| 409 | `CONFLICT` | a business-rule refusal with its own message (duplicate name, invalid state transition, cancellation after receipt, etc.) | whatever detail that refusal carries, e.g. `{ "postedReceipts": 2, "receivedQuantity": "100.000" }` |
| 409 | `NEEDS_HUMAN_REVIEW` | a near-duplicate name was found (brand, product head, …) and the brief requires a human decision rather than an automatic merge | `{ "candidates": [ { "id": "…", "name": "…" } ], "resolution": "Review the candidates. To create this anyway, resend with confirmDistinct: true." }` |
| 409 | `DUPLICATE_MOVEMENT` | a stock movement with this idempotency key was already posted — **nothing further was posted**, this is not an error to retry around | `{ "idempotencyKey": "…", "resolution": "This movement is already on the ledger. Nothing further was posted." }` |
| 409 | `INSUFFICIENT_STOCK` | not enough available/reserved/damaged stock for the requested movement | `{ "dimension": "available", "available": 272, "requested": 274 }` |
| 409 | `NOTHING_TO_RETRY` | import batch retry requested with no `FAILED` rows | — |
| 413 | `FILE_TOO_LARGE` | import upload over the 20 MB transport limit | — |
| 422 | `VALIDATION_FAILED` | a Zod schema or a stock-layer field check rejected the body/query | `errors` **is** the field list: `[ { "field": "name", "message": "Brand name is required." } ]` |
| 500 | `INTERNAL_ERROR` | anything unexpected (e.g. a database error) | — ; the real error is logged server-side only, **never** in the response |

The same codes and the same `errors` shapes apply to every module —
there is exactly one place (`server/utils/response.mjs`) that
computes an error's envelope, so a code here means the same thing
everywhere it appears.

---

## 6. Module reference

Every path below is relative to `/api/v1`. "Perm." is the permission
required (§4); a blank means the route is open to any resolved
caller. Where a request body exists, the field list is the exact
Zod schema the route validates against (`?` = optional/nullable).

### 6.1 Product Master — Brands

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/brands` | | query: `search?`, `isActive?`, `page?`, `pageSize?` | page of `{id, code, name, isActive, productCount, productHeadCount, …}` |
| GET | `/brands/similar` | | query: `name` | `{candidates: [...]}` — near-matches before saving |
| GET | `/brands/:id` | | | one brand |
| POST | `/brands` | `product:write` | `{name, code?, isActive?, confirmDistinct?}` | the created brand, `201` |
| PATCH | `/brands/:id` | `product:write` | `{name?, code?, isActive?}` | the updated brand |
| POST | `/brands/:id/activate` | `product:write` | — | the brand, now active |
| POST | `/brands/:id/deactivate` | `product:write` | — | the brand, now inactive |

A near-duplicate brand name on create/update returns `409
NEEDS_HUMAN_REVIEW` unless `confirmDistinct: true` is sent.

### 6.2 Product Master — Product Heads

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/product-heads` | | query: `search?`, `brandId?`, `categoryId?`, `isActive?`, `page?`, `pageSize?` | page of heads |
| GET | `/product-heads/similar` | | query: `name`, `brandId?`, `categoryId?` | `{candidates: [...]}` |
| GET | `/product-heads/:id` | | | one head **with every variant under it** |
| POST | `/product-heads` | `product:write` | `{name, brandId, categoryId?, code?, description?, isActive?, confirmDistinct?}` | created head, `201` |
| PATCH | `/product-heads/:id` | `product:write` | `{name?, brandId?, categoryId?, description?, isActive?}` | updated head |

### 6.3 Product Master — Products (variants)

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/products` | | query: `search?`, `brandId?`, `categoryId?`, `headId?`, `status?` (comma-list), `colour?`, `finish?`, `size?`, `thicknessMm?`, `includeArchived?`, `sortBy?`, `sortDir?`, `page?`, `pageSize?` | page of variants |
| GET | `/products/filter-options` | | | the values the filter dropdowns should offer |
| GET | `/products/:id` | | | one variant, with images and sync state |
| GET | `/products/:id/stock` | | | **read-only** stock summary — stock is never written through this module |
| POST | `/products` | `product:write` | `{name, size, sku?, brandId?, categoryId?, headId?, lengthMm?, widthMm?, thicknessMm?, finish?, colour?, uom?, piecesPerUnit?, areaSqftPerUnit?, purchasePrice?, sellingPrice?, mrp?, priceBasis?, hsnCode?, reorderLevel?, imageUrl?, attributes?, status?, confirmDistinct?}` | created variant, `201` |
| PATCH | `/products/:id` | `product:write` | same body, all optional, **`sku` is rejected** (SKUs are assigned once, at creation) | updated variant |
| POST | `/products/:id/status` | `product:write` | `{status: ACTIVE\|INACTIVE\|DISCONTINUED, reason?}` | updated variant |
| POST | `/products/:id/archive` | `product:write` | `{reason?}` | updated variant |
| POST | `/products/:id/restore` | `product:write` | — | updated variant |

**There is no `DELETE /products/:id`.** A product with stock movements
cannot be removed without orphaning the ledger entries that explain
where the stock went; archiving is the supported "remove from use."

### 6.3a Product Master — Product Lines

Added after step 8, by the product hierarchy work (§0.1). Sits
between Collection and the variant-level `Product` (§6.3): "Onery
Elite Decore" as its own row, rather than a name repeated across
every one of its finish/size variants. A sibling inside the existing
Product Master module, not a module of its own — no separate
`routes/controllers/validators` split, the same shape `brands.mjs`
and `product-heads.mjs` already have.

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/product-lines` | | query: `search?`, `brandId?`, `collectionId?`, `categoryId?`, `isActive?`, `page?`, `pageSize?` (≤200) | page of `{id, code, name, description, specifications, imageUrl, isActive, brand: {id,name,code}, collection: {id,name,code}\|null, category: {id,name,code}\|null, variantCount, createdAt, updatedAt}` |
| GET | `/product-lines/similar` | | query: `name`, `brandId?`, `collectionId?` | `{candidates: [...]}` — near-matches before saving |
| GET | `/product-lines/:id` | | | one product line, in the same shape as a list row |
| POST | `/product-lines` | `product:write` | `{name, brandId, collectionId?, categoryId?, code?, description?, specifications?, imageUrl?, isActive?, confirmDistinct?}` | created product line, `201` |
| PATCH | `/product-lines/:id` | `product:write` | `{name?, brandId?, collectionId?, categoryId?, description?, specifications?, imageUrl?, isActive?}` | updated product line |

**"View every variant under a product" is `GET /products?
productLineId=:id`** — the existing variant-level list endpoint
(§6.3) with one more filter, not a second, duplicate nested route.
There is no `DELETE`, for the same reason `/products/:id` has none.

### 6.4 Reference data

| Method | Path | Perm. | Response `data` |
|---|---|---|---|
| GET | `/reference/categories` | | `{rows: [{id, code, name, parentId, hsnCode, isActive, productCount, productHeadCount, rules}]}` |
| GET | `/reference/product-rules` | | `{categories: [...], fallback: {...}}` — per-category required-field rules, for a form that switches category |
| GET | `/reference/warehouses` | | `{rows: [{id, code, name, city, isDefault}]}` — active warehouses only |

### 6.5 Excel Import

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/imports/sources` | | | which import sources are available (Excel: yes; Google Sheets: no, with what's missing) and the expected columns |
| POST | `/imports/upload` | `product:write` | raw file bytes, `Content-Type: application/octet-stream`, headers `x-filename` (required), `x-sheet?` | the prepared batch: counts by row status, `201` |
| POST | `/imports/inspect` | | raw file bytes, header `x-filename` | headers found, sheet names, a quick analysis — **creates no batch** |
| POST | `/imports/google-sheets` | | | always refuses — not configured in this environment (documented, not a bug) |
| GET | `/imports/batches` | | query: `page?`, `pageSize?` (≤100) | page of batches |
| GET | `/imports/batches/:id` | | | one batch |
| GET | `/imports/batches/:id/preview` | | query: `page?`, `pageSize?` (≤200), `status?` | page of rows with their mapped data and any errors |
| POST | `/imports/batches/:id/confirm` | `product:write` | `{onlyRowIds?: [uuid], includeReviewed?: boolean}` | import result summary |
| POST | `/imports/batches/:id/retry` | `product:write` | — | retries only `FAILED` rows; `409 NOTHING_TO_RETRY` if there are none |
| GET | `/imports/batches/:id/errors.csv` | | | **not JSON** — a CSV download, formula-injection-safe, same at both `/api` and `/api/v1` since it bypasses the envelope entirely |

Confirming a row never writes to the Product Master directly — it
goes through the same `brand`/`productHead`/`product` services every
manual edit does, so a row imported this way is indistinguishable
from one typed in by hand.

### 6.6 Inventory

Every write below posts through the single `postStockMovement()`
service (`db/stock.mjs`); there is no second way to change a balance.

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/inventory` | | query: `search?`, `warehouseId?`, `brandId?`, `categoryId?`, `headId?`, `lowOnly?`, `outOnly?`, `damagedOnly?`, `sortBy?`, `sortDir?`, `page?`, `pageSize?` | page of balances |
| GET | `/inventory/dashboard` | | | totals, what needs ordering, recent movements, reconciliation status |
| GET | `/inventory/totals` | | | company-wide totals, from the database view, never re-summed in JavaScript |
| GET | `/inventory/ledger` | | query: `productId?`, `sku?`, `search?`, `warehouseId?`, `brandId?`, `headId?`, `movementType?`, `referenceNo?`, `performedById?`, `from?`, `to?`, `page?`, `pageSize?` | the stock card: every movement, with the balance it produced |
| GET | `/inventory/reconciliation` | | | the reconciliation report — **reporting-only, never repairs** |
| GET | `/inventory/hierarchy` | | | **added after step 8** (§0.1) — every active company (brand), each with its own stock totals, live-summed from the same SKU-level balances as everything else here; nothing is stored at this level |
| GET | `/inventory/companies/:id` | | | one company's totals plus each of its collections' own totals, and an `unassigned` bucket for product lines with no collection; `404` if the brand does not exist |
| GET | `/inventory/collections/:id` | | | one collection's totals plus each of its product lines' own totals, and an `unassigned` bucket for variants with no product line; `404` if the collection does not exist |
| GET | `/inventory/products/:id` | | | one product line's totals plus each of its own finish/size variants; `404` if the product line does not exist |
| POST | `/inventory/opening` | `stock:post` | `{product, warehouseId, quantity≥0, unitCost?, remarks?, transactionDate?}` | the movement, `201` |
| POST | `/inventory/inward` | `stock:post` | `{product, warehouseId, quantity>0, uom?, reason?, unitCost?, referenceType?, referenceId?, referenceNo?, remarks?, transactionDate?, idempotencyKey?}` | the movement, `201` |
| POST | `/inventory/outward` | `stock:post` | same shape, `reason` is one of `SALES_DISPATCH\|SAMPLE_ISSUE\|PURCHASE_RETURN\|OTHER` | the movement, `201` |
| POST | `/inventory/adjustments` | `stock:post` | `{product, warehouseId, quantity>0, direction: IN\|OUT, reason?, remarks (≥3 chars, required), transactionDate?, idempotencyKey?}` | the movement, `201` |
| POST | `/inventory/reservations` | `stock:reserve` | `{product, warehouseId, quantity>0, referenceType?, referenceId?, referenceNo?, remarks?, idempotencyKey?}` | the reservation, `201` |
| POST | `/inventory/reservations/release` | `stock:reserve` | same shape | the release, `201` |
| POST | `/inventory/damage` | `stock:post` | `{product, warehouseId, quantity>0, remarks (≥3 chars, required), idempotencyKey?}` | the movement, `201` |
| POST | `/inventory/damage/recover` | `stock:post` | same shape | the movement, `201` |
| POST | `/inventory/ledger/reverse` | `stock:post` | `{entryId, remarks?}` | the reversing movement, linked to the original via `reversalOfEntryId`, `201` |

`idempotencyKey` is caller-supplied on every write that takes one; a
repeated key returns `409 DUPLICATE_MOVEMENT` rather than posting a
second movement — safe to retry a dropped connection without
double-counting stock.

### 6.7 Warehouses

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/warehouses` | | query: `search?`, `isActive?`, `page?`, `pageSize?` | page of warehouses |
| GET | `/warehouses/:id` | | | one warehouse |
| GET | `/warehouses/:id/stock` | | query: `page?`, `pageSize?` | what this warehouse holds, product by product |
| POST | `/warehouses` | `warehouse:write` | `{name, code?, city?, state?, addressLine?, postalCode?, isActive?}` | created warehouse, `201` |
| PATCH | `/warehouses/:id` | `warehouse:write` | same body, all optional | updated warehouse |
| POST | `/warehouses/:id/active` | `warehouse:write` | `{isActive, reason?}` | updated warehouse; refused while the warehouse still holds stock |
| GET | `/warehouses/transfers` | | query: `status?`, `warehouseId?`, `page?`, `pageSize?` | page of transfers |
| POST | `/warehouses/transfers` | `stock:post` | `{fromWarehouseId, toWarehouseId, notes?, lines: [{productId, quantity>0, uom?}] (≥1)}` | created transfer, `201` |
| GET | `/warehouses/transfers/:id` | | | one transfer, with its lines and reconciliation summary — see below |
| POST | `/warehouses/transfers/:id/dispatch` | `stock:post` | — | the transfer, now `IN_TRANSIT` |
| POST | `/warehouses/transfers/:id/receive` | `stock:post` | **changed after step 8** (§0.1), see below | the transfer; `IN_TRANSIT` if anything is still outstanding, `COMPLETED` once every line is fully resolved |
| POST | `/warehouses/transfers/:id/cancel` | `stock:post` | `{reason?}` | the transfer, `CANCELLED`; **`409 CONFLICT`** if any line has already had a quantity accepted, damaged or written off (see below) — an untouched transfer (nothing dispatched, or dispatched and nothing yet received) is cancellable exactly as before |

**There is no `DELETE /warehouses/:id`.** A warehouse with stock
movements against it cannot be removed; deactivating is the
supported path, and the database and the service both refuse it
while the warehouse still holds anything.

#### Partial transfer receipt (changed after step 8)

A transfer can be received in more than one pass — some boxes
accepted, some arriving damaged, some never arriving at all — rather
than only all at once. `POST /warehouses/transfers/:id/receive`'s
body is:

```json
{
  "lines": [
    {
      "transferLineId": "uuid, required",
      "acceptedQuantity": "number ≥ 0, optional, default 0",
      "damagedQuantity": "number ≥ 0, optional, default 0",
      "missingQuantity": "number ≥ 0, optional, default 0",
      "missingReason": "string, required if missingQuantity > 0",
      "remarks": "string, optional — recorded against a damaged quantity"
    }
  ]
}
```

Rules, enforced with `422 VALIDATION_FAILED` naming the field:

- At least one of `acceptedQuantity`/`damagedQuantity`/`missingQuantity`
  must be greater than zero per line — a line recording nothing should
  be left off the request, not sent as all-zero.
- The three, summed with whatever was already accepted/damaged/missing
  on that line in earlier passes, can never exceed the line's
  dispatched `quantity` — over-receipt is refused outright, with
  **no override**.
- `missingQuantity > 0` requires a non-blank `missingReason`.
- Accepted and damaged both arrive physically (one combined stock
  movement); damaged is then separately condemned (unsellable, but
  still physically on the shelf). Missing never arrives at all and is
  written off against the destination's in-transit balance — never
  automatic, always this explicit, reasoned call.

Each `GET /warehouses/transfers/:id` line in the response now carries
`quantity` (dispatched), `acceptedQuantity`, `damagedQuantity`,
`missingQuantity` (each a running total across every receive call so
far) and `outstandingQuantity` (`quantity` minus the other three —
compute nothing independently; this field is already the
authoritative figure). The transfer's own `movement` summary gains a
`missing` field alongside `dispatched`/`received`/`stillInTransit`.

### 6.8 Purchase — Suppliers

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/suppliers` | | query: `search?`, `isActive?`, `stateCode?`, `page?`, `pageSize?` | page of suppliers |
| GET | `/suppliers/options` | | | a light list for a dropdown |
| GET | `/suppliers/:id` | | | one supplier |
| GET | `/suppliers/:id/history` | | query: `page?`, `pageSize?` | this supplier's own order/receipt/invoice/return history |
| POST | `/suppliers` | `purchase:write` | name/code/GSTIN/contact/billing+shipping address/payment terms/credit period/notes — see `SupplierBody` in `server/routes/purchase.mjs` | created supplier, `201` |
| PATCH | `/suppliers/:id` | `purchase:write` | same fields, all optional | updated supplier |
| POST | `/suppliers/:id/active` | `purchase:write` | `{isActive, reason?}` | updated supplier |

### 6.9 Purchase — Orders, Receipts, Returns, Invoices

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/purchase-orders` | | query: `search?`, `status?`, `supplierId?`, `warehouseId?`, `from?`, `to?`, `page?`, `pageSize?` | page of orders |
| POST | `/purchase-orders` | `purchase:write` | `{supplierId, warehouseId, orderDate?, expectedDate?, billingAddress?, shippingAddress?, paymentTerms?, currency?, otherCharges?, notes?, lines: [{productId, quantity, uom?, unitPrice?, discountPercent?, discountAmount?, taxRate?, description?, expectedDate?}] (≥1)}` | created order, `201` |
| GET | `/purchase-orders/:id` | | | one order, with lines and computed GST totals |
| PATCH | `/purchase-orders/:id` | `purchase:write` | same body — **draft only**, refused otherwise | updated order |
| POST | `/purchase-orders/:id/submit` | `purchase:write` | — | order → `PENDING_APPROVAL` |
| POST | `/purchase-orders/:id/approve` | `purchase:approve` | — | order → `APPROVED` |
| POST | `/purchase-orders/:id/return-to-draft` | `purchase:approve` | `{reason?}` | order → `DRAFT` |
| POST | `/purchase-orders/:id/cancel` | `purchase:write` | `{reason?}` | order → `CANCELLED`; **refused if any receipt has posted against it** |
| POST | `/purchase-orders/:id/close` | `purchase:approve` | `{reason?}` | order → `CLOSED` (finished short of full receipt, with a reason) |
| GET | `/purchase-orders/:id/receivable` | | | what is still outstanding, per line |
| GET | `/goods-receipts` | | query: `search?`, `status?`, `supplierId?`, `warehouseId?`, `purchaseOrderId?`, `from?`, `to?`, `page?`, `pageSize?` | page of receipts |
| POST | `/goods-receipts` | `purchase:receive` | `{purchaseOrderId, warehouseId?, receiptDate?, supplierDocNo?, supplierDocDate?, documentRef?, remarks?, overReceiptApproved?, overReceiptReason?, lines: [{purchaseOrderLineId, acceptedQuantity?, damagedQuantity?, rejectedQuantity?, rejectionReason?, uom?, unitCost?, remarks?}] (≥1)}` — **the only purchase route that increases stock** | the posted receipt, `201` |
| GET | `/goods-receipts/:id` | | | one receipt |
| POST | `/goods-receipts/:id/cancel` | `purchase:receive` | `{reason?}` — **draft only**; a posted receipt's ledger entries cannot be unwritten | cancelled receipt |
| GET | `/purchase-returns` | | query: `search?`, `status?`, `supplierId?`, `warehouseId?`, `from?`, `to?`, `page?`, `pageSize?` | page of returns |
| GET | `/purchase-returns/eligibility` | | query: `supplierId`, `productId`, `warehouseId?` | how much of this product may still go back to this supplier |
| POST | `/purchase-returns` | `purchase:write` | `{supplierId, warehouseId, purchaseOrderId?, returnDate?, reason (≥3 chars, required), remarks?, documentRef?, lines: [{productId, quantity, uom?, unitCost?, fromDamaged?, remarks?}] (≥1)}` | the posted return, `201` |
| GET | `/purchase-returns/:id` | | | one return |
| GET | `/supplier-invoices` | | query: `search?`, `status?`, `supplierId?`, `from?`, `to?`, `page?`, `pageSize?` | page of invoices |
| POST | `/supplier-invoices` | `purchase:write` | `{supplierId, invoiceNo, invoiceDate, dueDate?, purchaseOrderId?, goodsReceiptNoteId?, taxableAmount?, taxAmount?, invoiceAmount, currency?, documentRef?, notes?}` | created invoice, `201` — **moves no stock, is a claim for payment** |
| GET | `/supplier-invoices/:id` | | | one invoice, with a three-way match against the order and the receipt |
| POST | `/supplier-invoices/:id/status` | `purchase:write` | `{status: RECEIVED\|MATCHED\|DISPUTED\|CANCELLED, note?}` | updated invoice |
| GET | `/dashboard` | | query: `supplierId?`, `warehouseId?`, `from?`, `to?` | the purchase module's own dashboard figures |
| GET | `/history` | | query: `supplierId?`, `warehouseId?`, `kind?`, `from?`, `to?`, `page?`, `pageSize?` | the purchase timeline, every document kind interleaved |

GST calculation, the three-way match and the full order-status
lifecycle are documented in `docs/PURCHASE_MANAGEMENT.md` §§4–7; this
reference does not repeat that narrative, only the request/response
contract.

### 6.10 Sales — Customers

Same shape as suppliers (§6.8), different permission and one extra
field:

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/customers` | | query: `search?`, `isActive?`, `stateCode?`, `type?`, `page?`, `pageSize?` | page of customers |
| GET | `/customers/options` | | | a light list for a dropdown |
| GET | `/customers/:id` | | | one customer |
| GET | `/customers/:id/history` | | query: `page?`, `pageSize?` | this customer's own quotation/order/invoice/payment history |
| POST | `/customers` | `customer:write` | adds `type: RETAIL\|TRADE\|PROJECT\|INTERNAL` to the supplier-shaped body | created customer, `201` |
| PATCH | `/customers/:id` | `customer:write` | same fields, all optional | updated customer |
| POST | `/customers/:id/active` | `customer:write` | `{isActive, reason?}` | updated customer |

### 6.11 Sales — Quotations, Orders, Dispatch, Invoices, Returns, Payments

| Method | Path | Perm. | Params / body | Response `data` |
|---|---|---|---|---|
| GET | `/quotations` | | query: `search?`, `status?`, `customerId?`, `from?`, `to?`, `page?`, `pageSize?` | page of quotations |
| POST | `/quotations` | `quotation:write` | `{customerId, warehouseId?, quotationDate?, expiryDate?, billingAddress?, shippingAddress?, paymentTerms?, deliveryTerms?, currency?, notes?, lines: [{productId, quantity, uom?, unitPrice?, discountPercent?, discountAmount?, taxRate?, description?}] (≥1)}` | created quotation, `201` |
| GET | `/quotations/:id` | | | one quotation |
| PATCH | `/quotations/:id` | `quotation:write` | same body | updated quotation |
| POST | `/quotations/:id/send` | `quotation:write` | — | quotation → `SENT` |
| POST | `/quotations/:id/respond` | `quotation:write` | `{status: ACCEPTED\|REJECTED\|EXPIRED}` | updated quotation |
| POST | `/quotations/:id/cancel` | `quotation:write` | `{reason?}` | cancelled quotation |
| POST | `/quotations/:id/revise` | `quotation:write` | partial quote body | a **new** quotation revision, `201` |
| POST | `/quotations/:id/convert` | `sales:write` | `{warehouseId?}` | the **new** sales order created from it, `201` — moves no stock itself |
| GET | `/sales-orders` | | query: `search?`, `status?`, `customerId?`, `warehouseId?`, `from?`, `to?`, `page?`, `pageSize?` | page of orders |
| POST | `/sales-orders` | `sales:write` | `{customerId, warehouseId, quotationId?, orderDate?, expectedDispatchDate?, billingAddress?, shippingAddress?, paymentTerms?, deliveryTerms?, currency?, otherCharges?, notes?, lines: [{productId, quantity, uom?, unitPrice?, discountPercent?, discountAmount?, taxRate?, description?, allowInactiveProduct?}] (≥1)}` | created order, `201` |
| GET | `/sales-orders/:id` | | | one order |
| PATCH | `/sales-orders/:id` | `sales:write` | same body | updated order |
| POST | `/sales-orders/:id/submit` | `sales:write` | — | order → `PENDING_APPROVAL` |
| POST | `/sales-orders/:id/approve` | `sales:approve` | — | order → `APPROVED` |
| POST | `/sales-orders/:id/return-to-draft` | `sales:approve` | `{reason?}` | order → `DRAFT` |
| POST | `/sales-orders/:id/cancel` | `sales:write` | `{reason?}` | cancelled order |
| POST | `/sales-orders/:id/close` | `sales:approve` | `{reason?}` | closed order |
| GET | `/sales-orders/:id/availability` | | | per-line stock availability against this order |
| POST | `/sales-orders/:id/reserve` | `stock:reserve` | `{lines: [{salesOrderLineId, quantity, idempotencyKey?}] (≥1), clientKey?}` | reservation result — **RESERVED dimension only, physical stock unchanged** |
| POST | `/sales-orders/:id/release` | `stock:reserve` | `{lines: [{salesOrderLineId, quantity, reason?, idempotencyKey?}] (≥1), clientKey?}` | release result |
| GET | `/sales-orders/:id/dispatchable` | | | per-line dispatchable quantity |
| GET | `/delivery-challans` | | query: `search?`, `status?`, `customerId?`, `warehouseId?`, `salesOrderId?`, `from?`, `to?`, `page?`, `pageSize?` | page of challans |
| POST | `/delivery-challans` | `sales:dispatch` | `{salesOrderId, salesInvoiceId?, warehouseId?, dispatchDate?, transporter?, vehicleNumber?, trackingRef?, receiverName?, receiverPhone?, remarks?, allowUnreservedApproved?, allowUnreservedReason?, lines: [{salesOrderLineId, quantity, uom?, allowUnreserved?}] (≥1)}` — **the only sales route that issues stock** | posted challan, `201` |
| GET | `/delivery-challans/:id` | | | one challan |
| GET | `/sales-orders/:id/invoiceable` | | | per-line invoiceable quantity |
| GET | `/sales-invoices` | | query: `search?`, `status?`, `customerId?`, `salesOrderId?`, `from?`, `to?`, `page?`, `pageSize?` | page of invoices |
| POST | `/sales-invoices` | `sales:invoice` | `{salesOrderId, warehouseId?, invoiceDate?, dueDate?, billingAddress?, shippingAddress?, paymentTerms?, otherCharges?, notes?, lines: [{salesOrderLineId, quantity}] (≥1)}` | created invoice, `201` — **a claim, not a delivery** |
| GET | `/sales-invoices/:id` | | | one invoice |
| POST | `/sales-invoices/:id/cancel` | `sales:invoice` | `{reason?}` | cancelled invoice |
| GET | `/sales-invoices/:id/balance` | | | amount paid / outstanding on this invoice |
| GET | `/sales-orders/:id/returnable` | | | per-line returnable quantity |
| GET | `/sales-returns` | | query: `search?`, `status?`, `customerId?`, `warehouseId?`, `salesOrderId?`, `from?`, `to?`, `page?`, `pageSize?` | page of returns |
| POST | `/sales-returns` | `sales:return` | `{salesOrderId, warehouseId?, salesInvoiceId?, deliveryChallanId?, returnDate?, reason (≥3 chars, required), remarks?, lines: [{salesOrderLineId, quantity, uom?, disposition: ACCEPTED_GOOD\|DAMAGED\|REJECTED, remarks?}] (≥1)}` | posted return, `201` |
| GET | `/sales-returns/:id` | | | one return |
| GET | `/customer-payments` | | query: `customerId?`, `salesInvoiceId?`, `from?`, `to?`, `page?`, `pageSize?` | page of payments |
| POST | `/customer-payments` | `sales:payment` | `{salesInvoiceId, amount, paymentDate, method: CASH\|BANK_TRANSFER\|CHEQUE\|UPI\|CARD\|OTHER, reference?, notes?}` | recorded payment, `201` |
| GET | `/sales-dashboard` | | query: `customerId?`, `warehouseId?`, `from?`, `to?` | the sales module's own dashboard figures |
| GET | `/sales-history` | | query: `customerId?`, `warehouseId?`, `kind?`, `from?`, `to?`, `page?`, `pageSize?` | the sales timeline, every document kind interleaved |

The GST decision, the reservation/dispatch state machine and the full
order lifecycle are documented in `docs/SALES_MANAGEMENT.md`
§§3, 5–6; this reference does not repeat that narrative.

### 6.12 Dashboard (combined) — new in step 8

Exists only under `/api/v1` — there is no legacy equivalent, because
nothing before step 8 answered "how is the whole business doing
today" in one call. It is pure composition: every figure comes from
calling the inventory, purchase and sales modules' own, already-built
dashboard services and placing the results beside each other. **No
figure here is computed a second time from a table those modules
already query** — if a number here ever disagreed with that module's
own dashboard screen, this composition would be the bug.

| Method | Path | Perm. | Params | Response `data` |
|---|---|---|---|---|
| GET | `/dashboard/summary` | | query: `from?`, `to?` (ISO date strings, both optional) | see below |

```json
{
  "products": { "total": 19, "lowStock": 2, "outOfStock": 1 },
  "inventory": {
    "totalWarehouses": 1, "totalOnHand": 1234, "totalInTransit": 0,
    "totalReserved": 40, "totalDamaged": 2, "totalAvailable": 1192,
    "reconciliation": { "driftedBalances": 0, "unbalancedTransfers": 0, "status": "PASSED" }
  },
  "lowStockItems": [ { "sku": "DV-1003", "productName": "…", "available": 4, "reorderLevel": 10 } ],
  "purchase": {
    "suppliers": 5, "orders": 2, "deliveries": 1, "receiptsPosted": 1,
    "openInvoices": 0, "openInvoiceValue": 0
  },
  "sales": {
    "customers": 4, "orders": 3, "dispatchesPosted": 1,
    "invoicedValue": 45000, "outstandingPayments": 12000
  },
  "recentTransactions": [
    { "kind": "DISPATCH", "id": "…", "at": "2026-11-20T10:00:00.000Z",
      "reference": "DC-2026-0001", "detail": "dispatched to Ashoka Interiors",
      "quantity": 20, "direction": "OUT" }
  ]
}
```

**Not at the bare path `/dashboard`** — `purchase.mjs` already owns
that (it answers a narrower, purchase-only question and its own
screen already depends on it); mounting the combined dashboard there
too would have silently shadowed one or the other. `/dashboard` and
`/sales-dashboard` are unchanged.

### 6.13 Parties — new in step 8

Exists only under `/api/v1`, and exists **only to search across** the
`Customer` and `Supplier` tables — there is no `Party` model, and
none was created. A customer and a supplier that happen to be the
same company are still two separate records with two separate
histories, exactly as they were in every step before this one. See
the code comment in `server/services/party.service.mjs` for why.

| Method | Path | Perm. | Params | Response `data` |
|---|---|---|---|---|
| GET | `/parties` | | query: `search?`, `type?: CUSTOMER\|SUPPLIER`, `page?`, `pageSize?` (≤100) | page of `{partyType, id, code, name, gstin, isActive, contact}`, customers and suppliers merged and sorted by name |
| GET | `/parties/:partyType/:id` | | `:partyType` is `CUSTOMER` or `SUPPLIER` | `{partyType, ...}` — the customer or supplier record, dispatched to its own service unchanged |
| GET | `/parties/:partyType/:id/history` | | query: `page?`, `pageSize?` (≤100) | `{partyType, ...}` — that party's own transaction history, from its own service |

```json
// GET /parties?search=ashoka&type=CUSTOMER
{
  "success": true, "message": "Request completed successfully",
  "data": [
    { "partyType": "CUSTOMER", "id": "…", "code": "CUS-0003",
      "name": "Ashoka Interiors", "gstin": "24ABCDE1234F1Z5",
      "isActive": true, "contact": { "name": "…", "phone": "…" } }
  ],
  "meta": { "currentPage": 1, "pageSize": 25, "totalRecords": 1, "totalPages": 1 }
}
```

**`search()` is not true global pagination** over the combined set:
it asks each of the two services for up to `pageSize` rows of its
own, tags and merges them, then pages the merged list. That is the
right shape for "find this party, whichever side of the ledger they
are on"; it is the wrong shape for "page 7 of every party in the
system," which nothing in this ERP asks for, and `type=CUSTOMER` or
`type=SUPPLIER` should be used whenever the caller already knows
which side it wants.

### 6.14 CASA Integration — new in step 9

The only route in this file that does not speak `x-erp-user` at all.
It exists so the **CASA De Aurum backend** (a separate Node service,
separate database) can read this ERP's product/brand/collection/
inventory data over HTTP, for a read-only reconciliation preview on
the CASA side — see `docs/ERP_INTEGRATION.md` at the monorepo root
for the other half of this integration. Nothing in CASA writes
to this ERP, and nothing here writes to CASA.

**Auth is a shared secret, not a user.** `requireCasaKey`
(`server/middleware/casaAuth.mjs`) mirrors CASA's own `erpAuth.ts` /
`x-erp-key` pattern, in the opposite direction:

```
x-casa-key: <CASA_INTEGRATION_API_KEY>
```

It checks `process.env.CASA_INTEGRATION_API_KEY` fresh on every
request (not read once at boot), and **fails closed**: if that
variable is unset, every request is refused with `403 FORBIDDEN` —
including one that presents some key. A wrong key gets the same
`403`. There is no `x-erp-user` fallback and no permission string;
the secret is the entire gate. Leave `CASA_INTEGRATION_API_KEY`
unset in any environment the CASA backend has no business reaching.

| Method | Path | Perm. | Params | Response `data` |
|---|---|---|---|---|
| GET | `/integrations/casa/catalog-feed` | *(shared secret only)* | query: `page?`, `pageSize?` (≤100), `brandId?`, `collectionId?` | page of `{company:{id,name}, collection:{id,name}\|null, productLine:{id,code,name,description,imageUrl}, variants:[{id,sku,finish,size,colour,status,inventory:{onHand,reserved,damaged,inTransit,available}}]}` |

Built on the existing `productLine.service.mjs#list()` and
`inventory.service.mjs#productLineStock()` — no new service logic,
no new table, no change to any existing route's behavior. Shaped as
the ordinary native list page (`{rows, page, pageSize, total,
pageCount}`) so the `/api/v1` envelope middleware recognizes and
paginates it exactly like every other list route; the response is
the standard `{success, message, data: [...], meta: {...}}` seen
everywhere else in this document, plus a top-level `meta.version`
the CASA side can log.

```json
// GET /integrations/casa/catalog-feed?pageSize=1
// x-casa-key: <the configured secret>
{
  "success": true, "message": "Request completed successfully",
  "data": [
    {
      "company": { "id": "…", "name": "Devyora" },
      "collection": { "id": "…", "name": "Marble Classics" },
      "productLine": { "id": "…", "code": "PL-0001", "name": "Carrara White",
        "description": "…", "imageUrl": null },
      "variants": [
        { "id": "…", "sku": "DV-1003", "finish": "Polished", "size": "600x600",
          "colour": "White", "status": "ACTIVE",
          "inventory": { "onHand": 39, "reserved": 0, "damaged": 0, "inTransit": 0, "available": 39 } }
      ]
    }
  ],
  "meta": { "currentPage": 1, "pageSize": 1, "totalRecords": 12, "totalPages": 12, "version": "1" }
}
```

A missing or wrong key:

```json
// 403 Forbidden
{ "success": false, "message": "Invalid or missing x-casa-key.", "code": "FORBIDDEN" }
```

---

## 7. Worked example: a full request/response round trip

```
POST /api/v1/inventory/adjustments
x-erp-user: manager@devyora.local
Content-Type: application/json

{
  "product": "DV-1003",
  "warehouseId": "25d34e10-3318-4e05-97c5-74ef27f93d03",
  "quantity": 2,
  "direction": "OUT",
  "reason": "DAMAGE",
  "remarks": "Two boxes cracked in the stock-take."
}
```

```
201 Created

{
  "success": true,
  "message": "Created successfully",
  "data": {
    "operation": "STOCK_ADJUSTMENT",
    "entryId": "9f1c2e3a-…",
    "entryNo": "142",
    "sku": "DV-1003",
    "before": { "onHand": 41, "reserved": 0, "damaged": 0, "inTransit": 0, "available": 41 },
    "after":  { "onHand": 39, "reserved": 0, "damaged": 0, "inTransit": 0, "available": 39 }
  },
  "meta": {}
}
```

Every inventory write returns this same `{operation, entryId, entryNo,
sku, before, after}` shape — `before`/`after` always carry all five
dimensions (`onHand`, `reserved`, `damaged`, `inTransit`, `available`),
whichever one the movement actually changed.

Same request, missing `remarks` (an adjustment must say why):

```
422 Unprocessable Entity

{
  "success": false,
  "message": "The record is incomplete or invalid.",
  "code": "VALIDATION_FAILED",
  "errors": [ { "field": "remarks", "message": "An adjustment must say why, in a few words at least." } ]
}
```

Same request, `sales@devyora.local` (no `stock:post`):

```
403 Forbidden

{
  "success": false,
  "message": "Sales Desk does not have permission to do that (stock:post).",
  "code": "FORBIDDEN",
  "errors": [ { "permission": "stock:post" } ]
}
```

---

## 8. Idempotency and transaction safety

- Every financial/inventory-mutating write that can reasonably be
  retried (stock movements, reservations) takes an optional caller
  `idempotencyKey`. A repeated key returns `409 DUPLICATE_MOVEMENT`
  with the original key echoed back — it does **not** silently
  succeed a second time, and it does **not** error in a way that
  hides that the first attempt already worked.
- Document-numbered writes (purchase orders, receipts, returns,
  invoices, quotations, sales orders, challans) are protected by the
  database's own row-locking sequence allocator
  (`nextDocumentNumber()`), not a check-then-act in JavaScript — two
  concurrent requests queue rather than both getting the same number.
- Every multi-row write (an order with its lines, a receipt with its
  lines and the stock movements and the audit entries it produces) is
  one database transaction. A failure partway through leaves **no**
  partial document, **no** partial stock movement, and **no** partial
  audit entry.

---

## 9. Security and deployment limitations — carried over unchanged

**Nothing in step 8 changes any of this; it is restated here because
Step 9 needs to know it before connecting to anything.**

1. **The API is bound to `127.0.0.1` only** (`ERP_API_HOST`). It is
   not reachable from another host, and **must not be made so** until
   real authentication exists. If Step 9 runs in a different process
   or container, it needs either to run on the same host, or for this
   constraint to be revisited **explicitly** — not worked around.
2. **Authentication is the `x-erp-user` placeholder** (§4). It is not
   a security boundary. Do not build Step 9 as though it were.
3. **CORS is a browser-only mechanism** and does not protect a
   server-to-server caller; it is listed in §1 for completeness, not
   as something Step 9 needs to satisfy.
4. **No rate limiting.** Pagination caps protect against an
   accidentally unbounded query, not against a hostile client.
5. **Database credentials are never in frontend code and never in a
   response body.** Step 9 gets data through this HTTP API only —
   never a direct connection to the ERP's PostgreSQL database, and
   never will, per the architecture this phase is required to
   preserve (`ERP → ERP API → (future) CASA backend`).

---

## 10. What is deliberately not here

- **No OpenAPI/Swagger document.** This reference covers the same
  ground (method, path, permission, params, body, response, errors,
  examples) in the project's existing Markdown documentation
  convention (`docs/*.md`), which every other step's API section
  already uses; a generated spec was considered and set aside as an
  unforced addition rather than something the brief or the existing
  convention asked for.
- **No new frontend screens.** Dashboard composition and Parties
  search are consumable today; whether and how the existing Dashboard
  screen adopts the combined summary, or whether a Parties screen is
  ever built, is a product decision outside this step's scope (the
  brief: "do not change the visual design just to complete API
  development").
- **No per-endpoint OpenAPI-style JSON Schema.** The Zod schema in
  each table row **is** the validation contract; reproducing it a
  second time in a different notation would be a second place for
  the two to drift apart.
