# Step 9/10 — CASA Backend Integration (CASA reads the ERP)

Status: **implemented**, server-to-server only. This is the opposite
direction from `docs/ERP_SYNC_CONTRACT.md` (which describes a
*future* ERP consuming CASA's feed): here, **CASA's own backend**
calls **into the ERP's `/api/v1`**. Step 9 built a read-only
reconciliation preview (§1-8 below); Step 10 (§9) adds the website's
live stock display, on the same client and the same shared secret.
Per step 9's explicit brief:

- No website stock display. *(lifted in step 10 — §9 — but every
  other constraint below still holds for it.)*
- No live production migration.
- No write to either database, ever, from this integration.
- No ERP credential reaches a browser.
- CASA's and the ERP's PostgreSQL databases stay completely
  separate — this integration is HTTP-only, both ways.

## 1. What this step built

| Side | New | Purpose |
|---|---|---|
| ERP | `GET /api/v1/integrations/casa/catalog-feed` | lets CASA's backend read company/collection/product-line/variant/inventory data |
| ERP | `server/middleware/casaAuth.mjs` (`requireCasaKey`) | gates that route with a shared secret |
| ERP | `server/services/casaExport.service.mjs` | shapes the feed; reuses `productLine.service.mjs` + `inventory.service.mjs#productLineStock()` unchanged |
| CASA | `src/services/erpClient.service.ts` | the only file that calls the ERP; bounded retry, timeout, never throws an uncaught exception |
| CASA | `src/services/erpCatalogMapping.service.ts` | maps ERP rows onto CASA's hierarchy and reconciles by SKU; **reads only**, from both databases |
| CASA | `GET /api/v1/integrations/erp/catalog-preview` (OWNER-gated) | the human-facing report |

See `erp/docs/API_REFERENCE.md` §6.14 for the ERP-side route's full
request/response reference. This document covers the CASA side and
the integration as a whole.

## 2. Authentication — a shared secret, mirrored from the existing pattern

CASA already has one precedent for a separate service reading its
data: `GET /integrations/erp/catalog-feed`, gated by `x-erp-key` /
`ERP_EXPORT_API_KEY` (`src/middlewares/erpAuth.ts`), for a *future*
ERP to read CASA. Step 9 mirrors that exact pattern in the
**opposite** direction:

```
CASA backend  --x-casa-key: <CASA_INTEGRATION_API_KEY>-->  ERP /api/v1/integrations/casa/catalog-feed
```

- `erp/server/middleware/casaAuth.mjs` checks
  `process.env.CASA_INTEGRATION_API_KEY` **fresh on every request**
  and **fails closed**: unset means every caller is refused, even
  one presenting a key. A wrong key gets the same `403`.
- This is a dedicated secret, distinct from `ERP_EXPORT_API_KEY`
  (the other direction) and from anything else — compromising one
  credential never grants the other direction.
- There is no `x-erp-user` fallback on this route and no permission
  string: the shared secret is the whole gate, by design (see
  `erp/docs/API_REFERENCE.md` §6.14).

On the CASA side, the key and the ERP's base URL live only in
server environment variables (`ERP_API_BASE_URL`,
`ERP_INTEGRATION_API_KEY`, `ERP_INTEGRATION_TIMEOUT_MS` — see
`backend/.env.example`), read once via `@config/index` at process
start. **No route in CASA's backend ever echoes the key, the ERP
base URL, or any raw ERP response back to a caller** —
`getErpCatalogPreviewHandler` returns only the mapped/aggregated
report shape in §4 below. No frontend code imports
`erpClient.service.ts`; it is a server-only module (`fetch()` to
the ERP happens inside this Node process, never in a browser).

## 3. Error handling — always 200, never a hang, never a leaked secret

`fetchErpCatalogFeedPage()` converts every failure mode into one
`ErpUnavailableError`:

- not configured (`ERP_INTEGRATION_API_KEY` unset) — reported
  immediately, no network call attempted;
- a genuine network-level failure (connection refused, DNS, timeout)
  — retried **exactly once**, never retried for an HTTP error
  response, which is a deterministic answer retrying cannot change;
- every request is bounded by `AbortSignal.timeout(config.erpIntegration.timeoutMs)`
  (`ERP_INTEGRATION_TIMEOUT_MS`, default 8000ms) — this call can
  never hang the request that triggered it;
- a non-JSON response, a non-2xx response, or a JSON body that
  doesn't match the expected `{success, data: Array, meta: object}`
  envelope shape are each reported as their own `ErpUnavailableError`
  message, not a generic failure.

`getErpCatalogPreview()` catches `ErpUnavailableError` and returns
`{ erpReachable: false, erpUnavailableReason: <one sentence, no stack trace> }`
instead of throwing. Any *other* exception (a bug in this code, or a
genuine failure reading CASA's own database) is left to propagate —
masking a real bug in CASA's own code as "the ERP is down" would be
the wrong kind of safety.

The controller always answers **HTTP 200** — the same convention
already used for `testGeminiConnection` / `testDriveConnection` /
`testPythonAiConnection` in `integrations.controller.ts`: an
unreachable external service is a real, expected result the
frontend reads from `data.erpReachable`, not an HTTP error status
that generic error handling would swallow.

## 4. The CASA-side preview endpoint

```
GET /api/v1/integrations/erp/catalog-preview?brandId=&collectionId=
Authorization: Bearer <OWNER token>
```

Same guard as every other integration status/report route in this
file (`authenticate` + `authorize('OWNER')`). Read-only: queries the
ERP over HTTP and CASA's own database with Prisma, writes to
neither.

ERP reachable:

```json
{
  "success": true,
  "data": {
    "erpReachable": true,
    "erp": { "pagesRead": 2, "truncated": false, "companies": 1, "collections": 2, "productLines": 3, "variants": 5 },
    "casa": { "tilesWithProductCode": 4 },
    "matches": { "count": 3, "sample": [ { "erpSku": "DV-1003", "erpVariantId": "…", "casaTileId": "…", "casaTileName": "…" } ] },
    "unmatchedErpVariants": { "count": 2, "sample": [ { "sku": "DV-9999", "erpVariantId": "…", "company": "Devyora", "productLine": "Carrara White", "finish": "Polished", "size": "600x600" } ] },
    "orphanCasaTiles": { "count": 1, "sample": [ { "tileId": "…", "tileName": "…", "productCode": "CASA-ONLY-01" } ] }
  }
}
```

ERP unreachable or unconfigured (still `200 OK`):

```json
{
  "success": true,
  "data": {
    "erpReachable": false,
    "erpUnavailableReason": "The ERP integration is not configured on this server (ERP_INTEGRATION_API_KEY is unset)."
  }
}
```

Note `erp`/`casa`/`matches`/`unmatchedErpVariants`/`orphanCasaTiles`
are present **only** when `erpReachable` is `true` — nothing is
invented for an unreachable ERP.

Matching is by SKU, case-insensitively — `Tile.productCode` on
CASA's side, `variant.sku` on the ERP's — the exact convention
`docs/ERP_SYNC_CONTRACT.md` §3 already documents for the opposite
direction, reused here. A CASA tile with no `productCode` is not a
candidate for matching at all (nothing to compare), and is excluded
from `casa.tilesWithProductCode` and `orphanCasaTiles`.

Pagination from the ERP feed is followed internally, bounded at 50
pages (5,000 product lines at the default page size) by
`fetchEntireErpCatalogFeed()` — `erp.truncated: true` would mean
that cap was hit; `erp.pagesRead` reports how many pages were
actually read either way. This is a one-shot report for a human to
read, not a live or incremental display.

## 5. Environment variables

**CASA side** (`backend/.env.example`, `src/config/env.ts` /
`src/config/index.ts`, `config.erpIntegration`):

| Variable | Default | Purpose |
|---|---|---|
| `ERP_API_BASE_URL` | `http://127.0.0.1:4310/api/v1` | where the ERP's `/api/v1` is reachable from this server |
| `ERP_INTEGRATION_API_KEY` | unset | the `x-casa-key` value; leaving it unset disables the integration safely (`erpReachable: false`, never a crash) |
| `ERP_INTEGRATION_TIMEOUT_MS` | `8000` | per-request timeout to the ERP |

**ERP side** (`erp/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `CASA_INTEGRATION_API_KEY` | unset | the value `requireCasaKey` checks against `x-casa-key`; unset means the route refuses every caller |

The two sides must be configured with the **same** value for
`ERP_INTEGRATION_API_KEY` (CASA) and `CASA_INTEGRATION_API_KEY`
(ERP) for the integration to work — they are the same secret under
two env var names, one per side, matching how `ERP_EXPORT_API_KEY`
(CASA) / the ERP's own future client would pair up for the other
direction.

## 6. Database separation

- CASA's Prisma client (`@db/connection`) never points at the ERP's
  database, and the ERP's Prisma client never points at CASA's —
  nothing in this step changes either `DATABASE_URL`/
  `ERP_DATABASE_URL`.
- The only channel between the two services is the HTTP call in
  §2-3. No shared table, no shared schema, no cross-database query.
- `erpCatalogMapping.service.ts` reads CASA's `Tile` table with
  Prisma and the ERP's data only through `erpClient.service.ts`'s
  HTTP calls — it never opens a second database connection.

## 7. What this step deliberately does not do

- **No website stock display — in step 9.** `catalog-preview` is an
  OWNER-gated report, not a public or customer-facing route, and
  nothing in `catalog.html` or any other storefront page calls it.
  Step 10 (§9) adds the stock display itself, through a different,
  dedicated route — `catalog-preview` is still never called from the
  catalog pages.
- **No write-through.** Neither side's database is ever mutated by
  this integration — not a new column populated, not a record
  created or updated. The schema is unchanged on both sides.
- **No live/production migration.** This is a preview/reconciliation
  report a person reads before any future, separately-approved step
  decides what (if anything) to import or link.
- **No new linking columns.** CASA's `Tile` carries no new "external
  ERP id" field in this step — matching is computed on the fly, by
  SKU, on every call; nothing is persisted from one preview to the
  next.

## 8. Tests

- `erp/test/api_v1_test.mjs` §17 — `requireCasaKey` fails closed
  unconfigured and with any key, is correctly gated once configured,
  and the configured response matches the documented shape.
- `backend/test-scripts/erp_client_unavailable_test.js` — the
  unconfigured path never attempts a network call and never throws.
- `backend/test-scripts/erp_catalog_preview_test.js` — full
  end-to-end run against a mock ERP server: auth (no token, STAFF
  refused), the happy path (matches/unmatched/orphans, zero DB
  writes, key never leaked), `brandId` filter passthrough, and the
  ERP-unavailable-mid-run case (still `200`, real reason, answers
  promptly, zero DB writes).

## 9. Step 10 — the website stock display

Status: **implemented**. Reuses every piece of §1-8 above
(`erpClient.service.ts`'s timeout/retry/`ErpUnavailableError`
handling, the same shared secret, the same "always 200, state
instead of an HTTP error" convention) for a different, catalog-facing
purpose: showing shoppers' browsing staff live ERP stock next to the
tiles they are already looking at, never writing anything, never
sending the ERP key anywhere near a browser.

### 9.1 What it added

| Side | New | Purpose |
|---|---|---|
| ERP | `GET /api/v1/integrations/casa/stock` | batch stock lookup by SKU alone, gated by the same `requireCasaKey` as `catalog-feed` (see `erp/docs/API_REFERENCE.md` §6.14) |
| CASA | `fetchErpStockBySkus()` in `erpClient.service.ts` | the one new call out to the ERP, sharing the existing retry/timeout helper |
| CASA | `src/services/erpStock.service.ts` | maps a batch of SKUs to one of four states — never CASA's own database, never thrown for an ERP problem |
| CASA | `GET /api/v1/tiles/stock` (authenticated, `tiles:read`) | the route the catalog pages actually call |
| Frontend | `CasaApi.tiles.stock()` in `assets/api-client.js`, wired into `catalog.html` | batch-fetches stock for the Surface Archive grid and the resolved-variant panel, after the existing render, never blocking it |

### 9.2 The four states, and why there are four

A bare true/false would conflate three different facts into one bit.
This step reports exactly one of:

- **`available`** (with `quantity`) — the ERP has this SKU and it
  currently has stock.
- **`zero`** (with `quantity: 0`) — the ERP has this SKU and it
  currently has none.
- **`unknown`** — either the CASA tile has no `productCode` at all
  (nothing to ask about), or the ERP has never heard of this SKU. No
  fetch is even attempted for a tile with no `productCode`.
- **`unavailable`** — a fact about *this request*, not the product:
  the ERP integration is unconfigured, or this particular call
  failed (down, slow, malformed response). Every SKU in a batch gets
  this state together when the ERP itself is unreachable.

`erpStock.service.ts#getErpStockForSkus()` never throws for any ERP
problem — only a genuine bug (e.g. a failure reading its own inputs)
would propagate, the same split `erpCatalogMapping.service.ts`
already draws in §3 above.

### 9.3 Where it shows, and what it does not replace

Both the Surface Archive grid and the product detail panel's
resolved-variant summary already showed a `inStock` badge — CASA's
own, locally-stored, un-managed boolean (`Tile.inStock`, defaulting
`true`). This step adds a **second**, clearly-labeled "(ERP)" line
**next to** that badge; it does not remove, rename, or recompute the
existing one. Preserving that line, in its original place and
meaning, was an explicit requirement of this step's brief
("Preserve existing catalog, product detail and browsing
behavior"). A future step may decide `inStock` should be retired in
favor of the ERP figure — that decision is explicitly not made here.

The batch fetch always runs **after** the existing synchronous
render from CASA's own already-fetched data, and is guarded by a
per-render generation counter (`surfaceStockGen` / `productStockGen`
in `catalog.html`) so a stale response — from a page the shopper has
since navigated away from, or a variant they're no longer looking
at — can never overwrite a newer render.

### 9.4 Tests

- `erp/test/api_v1_test.mjs` §18 — the same gating as `catalog-feed`
  on the new `/stock` route; case-insensitive matching with the
  original casing echoed back; an unseeded SKU answers `found:false`
  with no fabricated totals; totals agree with the ERP's own
  authenticated inventory view.
- `backend/test-scripts/erp_client_unavailable_test.js` §3 — an
  unconfigured integration reports every SKU `unavailable`, fast, no
  network call attempted.
- `backend/test-scripts/erp_stock_test.js` — full end-to-end run
  against a mock ERP: auth (no token, no `tiles:read` both refused),
  validation (missing/over-100 `skus`), the happy path (available /
  zero / unknown / a duplicate SKU, in one batch), zero CASA DB
  writes, key never leaked, and the ERP-unavailable-mid-run case
  (every SKU `unavailable`, still `200`, answers promptly).
- `backend/test-scripts/catalog_hierarchy_test.js` and
  `catalog_data_format_test.js` — re-run end to end in a real
  Chromium page against the real `catalog.html`, confirming the new
  ERP-stock line coexists with every pre-existing assertion (product
  image order, the Surface Archive card's field order, the resolved
  variant's SKU/price/stock sequence) with no uncaught JS error.
