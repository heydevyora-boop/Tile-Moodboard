# ERP API Development — step 8

Standardizing every existing module's API onto `/api/v1`, with a
consistent response envelope, versioning, pagination convention and
permission checks on the six route files that had none — without
touching `/api/*`, the catalogue extraction system, the CASA backend
or website, or any completed module's behavior.

**The ERP frontend still works, unchanged in appearance.** **No
existing route lost a byte of compatibility.** **No historical stock
ledger entry, purchase order, sales order or audit row was touched.**
**Nothing merged into `main`. Nothing deployed publicly.**

For the endpoint-by-endpoint reference (method, path, permission,
body, response, error codes, examples), see
**[`docs/API_REFERENCE.md`](API_REFERENCE.md)** — written for whoever
builds step 9 to consume this API without reading this file or the
ERP source. This document is the step's own report: what was found,
what was built, how it was verified, and what remains open.

---

## 1. Inspection report (taken before any code was written)

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| HEAD at start | `6d205151` — "ERP step 7: sales management, from quotation to dispatch and return" |
| Working tree at start | clean |

### 1.1 Existing endpoints

Every module from steps 3–7 already had a working, mounted router:
Product Master (`brands`, `product-heads`, `products`, `reference`),
Excel Import (`imports`), Inventory (`inventory`, `warehouses`),
Purchase (`suppliers`, `purchase-orders`, `goods-receipts`,
`purchase-returns`, `supplier-invoices`, `dashboard`, `history`), and
Sales (`customers`, `quotations`, `sales-orders`, `delivery-challans`,
`sales-invoices`, `sales-returns`, `customer-payments`,
`sales-dashboard`, `sales-history`). None of it needed rebuilding;
the brief's own instruction is "do not rebuild completed modules,"
and the inspection found no reason to.

### 1.2 Missing endpoints

Two things the business question "how is the business doing, across
every module, and who are we dealing with" needed and nothing built
before step 8 answered:

- **A combined dashboard.** Inventory, Purchase and Sales each had
  (and keep) their own dashboard, answering their own module's
  question. Nothing combined the three.
- **A party search.** Finding "this company, whichever side of the
  ledger they're on" meant knowing in advance whether to search
  Customers or Suppliers. Nothing searched both.

### 1.3 Duplicate or inconsistent endpoints

**None found.** Each module has exactly one route per operation, and
naming is consistent within each module (`GET /:resource`,
`POST /:resource`, `GET/PATCH /:resource/:id`, `POST
/:resource/:id/<verb>`). The brief's concern did not apply to this
codebase.

### 1.4 Endpoints needing standardization

**Every one of them, in the one sense that mattered:** none spoke the
`{success,message,data,meta}` / `{success,message,code,errors}`
envelope the brief asks for, because nothing before step 8 needed a
standard shape — each route sent back whatever its service returned.
Six route files (`brands`, `product-heads`, `products`, `imports`,
`inventory`, `warehouses`) also had **no permission check on a single
mutating route**, inconsistent with purchase and sales, which have
had `requirePermission()` since steps 6 and 7.

### 1.5 Services that should be reused

Every service, unchanged. Specifically identified for direct reuse
without modification: `server/services/permission.mjs`'s
`requirePermission()` (built step 6, not read by the six files above
until now); `db/stock.mjs`'s `postStockMovement()` (the one and only
stock writer); `server/services/inventory.service.mjs`,
`purchaseDashboard.service.mjs` and `salesDashboard.service.mjs`'s
own `dashboard()` functions (composed, not reimplemented, for the new
combined dashboard); `customer.service.mjs` and `supplier.service.mjs`
(dispatched to, not merged, for the new Parties search);
`server/validate.mjs`'s `parse()` / `handler()`; every existing Zod
schema.

**Inspection conclusion:** nothing to rebuild, two things to add, one
structural problem (the envelope) to solve without touching the
sixty-odd existing route handlers, and six files' permission checks
to bring in line with purchase and sales. Implementation began only
after this was written down and the design below was put to the user
and approved.

---

## 2. The envelope and versioning decision

Presented to the user as one of four linked design questions before
any code was written (see §7 for all four). The brief asks for a new
standard envelope **and** explicit backward compatibility with the
already-approved frontend in the same step — a real tension, since
every existing route returns its bare payload and the frontend's one
`request()` function already unwraps exactly that.

**Chosen (and approved): mount every existing router a second time
under `/api/v1`, wrapped in response-shaping middleware; leave
`/api/*` untouched, byte for byte.**

Express routers carry no state tied to where they are mounted, so
`server/routes/v1.mjs` imports the exact same router objects
(`brands.mjs`, `products.mjs`, `purchase.mjs`, …) `server/app.mjs`
already mounted at `/api/*`, and mounts them again at `/api/v1/*`
with three small middlewares applied once
(`server/middleware/apiV1.mjs`):

1. mark the request as v1, so the shared error handler knows which
   envelope to send back if something throws;
2. accept `?limit=` as an alias for `?pageSize=`, the brief's own
   pagination parameter name for the one every route already reads;
3. wrap whatever a route hands to `res.json()` in the standard
   envelope (`server/utils/response.mjs`'s `successEnvelope()`).

No route file, controller or service changed what it returns. The
wrapping is structural: a list endpoint is detected by its shape
(`{rows, page, pageSize, total, pageCount}`, the convention every
list endpoint in this project already follows) rather than by a
per-route flag, so a route written next year gets the same treatment
automatically. `server/utils/response.mjs`'s `errorEnvelope()`
computes **both** the legacy `{error:{code,message,details}}` shape
and the new `{success:false,message,code,errors}` shape from the same
error object in the same place, so the two can never drift apart —
replacing what used to be inline, duplicated `STOCK_REFUSALS` logic
in `app.mjs`.

**Result: `/api/*` is identical to before step 8** (verified in §6 by
running the untouched frontend test suite against it), and
**`/api/v1/*` is the complete, standardized surface** step 9 should
build against. See `docs/API_REFERENCE.md` §2 for the full
rationale written for an external reader.

---

## 3. What was implemented

### 3.1 Existing endpoints reused

All of them — every module in §1.1, mounted a second time under
`/api/v1` with zero route-handler changes. The permission checks
added in §3.4 are the only behavioral change to any of these six
files; the other modules (`reference`, `purchase`, `sales`) needed no
change at all, having already had permission checks since steps 6–7.

### 3.2 New endpoints created

| Endpoint | What it does |
|---|---|
| `GET /api/v1/dashboard/summary` | the combined dashboard — composes `inventory.dashboard()`, `purchaseDashboard.dashboard()`, `salesDashboard.dashboard()`; recomputes nothing |
| `GET /api/v1/parties` | search across customers and suppliers by name |
| `GET /api/v1/parties/:partyType/:id` | one party, from whichever table it actually lives in |
| `GET /api/v1/parties/:partyType/:id/history` | that party's own transaction history |
| `GET /api/v1/health` | the existing health check, now answering in the v1 envelope too |

Both new modules exist **only** under `/api/v1` — there is no legacy
equivalent to preserve, and both are built with the brief's full
`routes/controllers/validators` folder split
(`server/routes/dashboard.mjs` + `server/controllers/dashboard.
controller.mjs` + `server/validators/dashboard.validator.mjs`, and the
equivalent three files for `parties`), since the brief's structure was
reserved for genuinely new modules rather than imposed on the
working, already-tested shape every other module already has.

**The combined dashboard route is not at the bare path `/dashboard`.**
`purchase.mjs` already owns `GET /dashboard` (a narrower,
purchase-only question its own screen depends on), and mounting a
second, different `/dashboard` at the v1 router root would have
silently shadowed one or the other depending on mount order — found
by curl testing during development, when `/api/v1/dashboard`
unexpectedly returned purchase-shaped data instead of the combined
summary. Fixed by naming the new route `/dashboard/summary` rather
than disturbing the proven existing route; `/api/v1/dashboard`
(purchase's own) and `/api/v1/sales-dashboard` are both unchanged and
still reachable exactly as before.

### 3.3 Endpoints standardized

Every route under `/api/v1/*` — the entire surface — now answers in
the `{success,message,data,meta}` / `{success,message,code,errors}`
envelope, with consistent HTTP status codes, no raw Prisma errors, no
stack traces, field-naming validation errors, and meaningful business
error codes preserved rather than flattened to 500. See
`docs/API_REFERENCE.md` §§2, 5 for the exact contract.

### 3.4 Permission checks added

Six route files had **no permission check on any mutating route**
before this step (`purchase.mjs` and `sales.mjs` already did, since
steps 6–7). Brought in line using the **existing**
`requirePermission()` middleware and **existing** seeded permission
strings — no new authorization mechanism:

| File | Permission applied | New permission string needed? |
|---|---|---|
| `server/routes/brands.mjs` | `product:write` | no — already seeded |
| `server/routes/productHeads.mjs` | `product:write` | no |
| `server/routes/products.mjs` | `product:write` | no |
| `server/routes/imports.mjs` | `product:write` (upload, confirm, retry) | no |
| `server/routes/inventory.mjs` | `stock:post` (writes), `stock:reserve` (reservations) | no |
| `server/routes/warehouses.mjs` | `warehouse:write` (CRUD, activate), `stock:post` (transfers) | **yes — see below** |

**One new permission string:** `warehouse:write`, added to
`prisma/seed.mjs`'s `MANAGER` role array. This is the step's only
database-adjacent change (see §4) — an additive seed row, not a
schema or migration change: `RolePermission.permission` is a plain
string column, not an enum, so no migration was needed. `ADMIN` is
unaffected (already holds the `*` wildcard, which covers it).
`GET` routes on all six files remain open to any resolved caller, the
same convention purchase and sales already established: the risk the
brief names is unauthorised **writes**, and a read-only permission
wall on top of an already-placeholder identity (§5) would be
ceremony, not security.

---

## 4. Database changes

**One row, no migration, no schema change, no new table, no new
model.**

| Change | Kind |
|---|---|
| `warehouse:write` added to `MANAGER`'s seeded permission list | additive seed data, applied via `prisma/seed.mjs`'s existing upsert loop |

`Party` is explicitly **not** a model: the brief says "reuse the
existing Party model wherever applicable," and there is no Party
model in this schema and never has been (`Customer` and `Supplier`
were kept deliberately separate since step 6). §6.13 of
`docs/API_REFERENCE.md` and the code comment in
`server/services/party.service.mjs` both document this; Parties is a
thin, read-only search surface over the two existing tables, not a
third one.

Verified against the development database before and after every
change in this step: **19 products, 1 warehouse, 155 stock ledger
entries — identical, before and after.**

---

## 5. Authentication and permission status

**Unchanged from step 6, and not claimed to be anything it isn't.**

- The caller's identity still arrives entirely through the
  `x-erp-user` header (step 3's placeholder), resolved to a real
  `User` row or defaulting to `admin@devyora.local` if the header is
  absent. **This is not authentication.** Anyone who can reach the
  port can claim to be anyone.
- Permission checks are real: `requirePermission()` reads the
  existing, seeded `Role`/`RolePermission`/`UserRole` tables, and now
  covers every mutating route across all eight modules (two more than
  before this step), not just purchase and sales.
- **No JWT or other new authentication scheme was built**, per the
  brief's explicit instruction not to invent one without separate
  approval.
- **The API remains bound to `127.0.0.1`** (`ERP_API_HOST`, unchanged
  default), and CORS allows only the two localhost development
  origins, listed explicitly.
- This limitation is documented in three places a step-9 developer
  would actually read: `docs/API_REFERENCE.md` §§4, 9 (written for
  them specifically), this file, and the pre-existing per-module docs
  (`PURCHASE_MANAGEMENT.md` §11, `INVENTORY_MANAGEMENT.md` §10, …).

---

## 6. Test results

### 6.1 The new step-8 suite

`npm run test:api` — **`test/api_v1_test.mjs`**, new this step. Starts
the real Express app on an ephemeral port and drives it with real
HTTP calls (the only suite in this project that does — every other
suite calls a service function directly, which cannot exercise the
HTTP layer, the envelope, or the permission middleware). Its own
database (`devyora_erp_api_test`), dropped and rebuilt every run.

**61/61 checks passed.** Covering the brief's full list:

| Brief's requirement | Section |
|---|---|
| every module's main endpoints | §1 (25 endpoints smoke-tested) |
| request validation | §2 |
| pagination and the `limit` alias | §3 |
| search and filtering | §4 |
| permission enforcement, including the six newly-gated files | §5 |
| invalid identity handling | §6 |
| duplicate request handling | §7 |
| idempotency | §7–8 |
| transaction rollback | §9 |
| error response consistency | §10 |
| stock integrity | §11 |
| legacy/v1 response compatibility | §12 |
| concurrent inventory operations | §13 (8 concurrent posts, balance checked for exactly +8, no lost update) |
| API response compatibility with the frontend | §14 |
| the development and CASA databases untouched | §15 |

### 6.2 Every existing suite, re-run after every step-8 change

| Suite | Result |
|---|---|
| `npm run test:data` | 38/38 |
| `npm run test:product-master` | 92/92 |
| `npm run test:import` | 83/83 |
| `npm run test:inventory` | 86/86 |
| `npm run test:purchase` | 126/126 |
| `npm run test:sales` | 95/95 |
| `npm run db:verify` | 41/41 |
| `npm run test:frontend` | 66/66 |
| `npm run test:api` (new) | 61/61 |
| **total** | **688/688, zero failures** |

`test/frontend_regression_test.mjs` needed one, single-line fix: its
own request-URL filter (`r.url().includes('/api/products?')`) matched
the pre-step-8 path literally and stopped matching once the frontend
client moved to `/api/v1/products?`. Updated to match either path
(`/\/api(\/v1)?\/products\?/`) — the test's own instrumentation, not
application behavior, and the only edit this step made to any
previously-passing test.

### 6.3 A real bug the new suite's design caught before it shipped

While writing `test/api_v1_test.mjs`, a first draft of the concurrency
and idempotency checks read field names (`onHand`, `warehouseId`)
that don't exist on the actual response shapes
(`GET /inventory`'s rows use `physical`, not `onHand`; `GET
/products/:id/stock`'s `data` is a single object with `byWarehouse`,
not an array). Caught by reading the real service code
(`inventory.service.mjs`'s `shapeBalance()`,
`product.service.mjs`'s `stockSummary()`) rather than guessing, and
fixed before the suite ever ran — the same discipline
`docs/API_REFERENCE.md`'s worked examples were held to (see its own
note on a similarly-caught field-name error during that document's
drafting).

---

## 7. Design decisions put to the user

Per the brief's "if a structural change is necessary, explain why and
wait for approval," four linked questions were asked before any code
was written. All four were answered with the recommended,
reuse-maximizing, lowest-regression-risk option:

| Question | Chosen |
|---|---|
| Folder structure for the brief's `routes/controllers/validators` split | **new modules only** (Dashboard, Parties) — existing modules keep their proven shape |
| Envelope and versioning | **new `/api/v1` surface, old `/api` left untouched** |
| Permission-gating scope | **add `requirePermission()` to the six previously-open files' writes** |
| Parties implementation | **thin aggregator over Customer/Supplier, no schema change** |

No unresolved decision remains from this list.

---

## 8. Known bugs and limitations

**Found and fixed during this step, not shipped:**

1. An early design would have let the v1 error middleware's wrapped
   `res.json` fold an already-v1-shaped error body into `data` as if
   it were success payload (double-wrapping). Fixed before any route
   used it, by keeping the pre-wrap `res.json` as `res.locals.
   sendRaw` for the error path to call instead.
2. `StockValidationError`'s `fields` array came back one level more
   nested in the v1 envelope (`errors: [{fields: [...]}]`) than an
   ordinary `ValidationError`'s (`errors: [...]`, flat), despite both
   being "a validation failure's own field list" by the module's own
   stated rule. Found while building the frontend client against the
   real contract rather than the intended one; fixed in
   `server/utils/response.mjs` so both error families flatten the
   same way.
3. The route-collision between the new combined dashboard and
   `purchase.mjs`'s existing `/dashboard` (§3.2).

**Open, by design, carried over unchanged from earlier steps (not
reopened or worsened by this one):**

4. **Authentication is still the `x-erp-user` placeholder** (§5).
5. Every other module-specific limitation already recorded in
   `docs/PURCHASE_MANAGEMENT.md` §16, `docs/SALES_MANAGEMENT.md` §11,
   `docs/INVENTORY_MANAGEMENT.md` §13, `docs/EXCEL_IMPORT.md` §13 and
   `docs/PRODUCT_MASTER.md` §10 — none of it was in scope to revisit
   in this step, and none of it changed.

**New, scoped deliberately out of this step:**

6. **No OpenAPI/Swagger document was generated.** `docs/API_REFERENCE.
   md` covers the same ground in the project's existing Markdown
   documentation convention; see that document's own closing section
   for why a generated spec was set aside rather than built.
7. **No new frontend screens.** The combined dashboard and Parties
   search are consumable today over HTTP; whether the existing
   Dashboard screen ever adopts the combined summary, or whether a
   Parties screen is built, is a product decision this step's brief
   explicitly placed out of scope ("do not change the visual design
   just to complete API development").
8. **`VIEWER` role's seeded `*:read` permissions are still unchecked
   by any route** — every `GET` is open to any resolved caller, the
   convention established in steps 6–7 and extended, not invented, by
   this one. Documented, not a gap introduced here.

---

## 9. Files created and modified

### New

```
docs/API_REFERENCE.md
docs/API_DEVELOPMENT.md            (this file)
server/controllers/dashboard.controller.mjs
server/controllers/party.controller.mjs
server/middleware/apiV1.mjs
server/routes/dashboard.mjs
server/routes/parties.mjs
server/routes/v1.mjs
server/services/dashboard.service.mjs
server/services/party.service.mjs
server/utils/response.mjs
server/validators/dashboard.validator.mjs
server/validators/party.validator.mjs
test/api_v1_test.mjs
```

### Modified

```
package.json                        (+ "test:api" script)
prisma/seed.mjs                     (+ warehouse:write permission, additive)
server/app.mjs                      (+ /api/v1 mount, shared error envelope, dual health check)
server/routes/brands.mjs            (+ requirePermission('product:write') on writes)
server/routes/imports.mjs           (+ requirePermission('product:write') on upload/confirm/retry)
server/routes/inventory.mjs         (+ requirePermission('stock:post' | 'stock:reserve') on writes)
server/routes/productHeads.mjs      (+ requirePermission('product:write') on writes)
server/routes/products.mjs          (+ requirePermission('product:write') on writes)
server/routes/warehouses.mjs        (+ requirePermission('warehouse:write' | 'stock:post') on writes)
src/api/client.js                   (base URL moved to /api/v1; envelope unwrapped transparently)
test/frontend_regression_test.mjs   (URL matcher updated for the new v1 path, see §6.2)
```

**No file in `server/routes/purchase.mjs`, `server/routes/sales.mjs`
or `server/routes/reference.mjs` was modified** — both already had
permission checks, and reference data has nothing to protect.
**No frontend page component was modified** — the envelope and
versioning change is entirely contained in `src/api/client.js`.

---

## 10. Final verification

| Check | Result |
|---|---|
| Complete test suite | **688/688 checks, 0 failures**, across 9 suites (§6) |
| Production build | `npm run build` — succeeds, `dist/` produced, no errors |
| All API routes verified | every module smoke-tested over real HTTP in `test/api_v1_test.mjs` §1, plus a full legacy/v1 parity check in §12 |
| Frontend API connectivity verified | `npm run build && npm run preview` against the real API: Product Master screen renders all 19 real products, zero console errors (Playwright-driven check) |
| Permissions verified | `test/api_v1_test.mjs` §5 — a sales-desk user refused on `product:write` and `stock:post`; a store keeper allowed on `stock:post`, refused on the new `warehouse:write`; a manager allowed on `warehouse:write` |
| Database integrity verified | 19 products, 1 warehouse, 155 stock ledger entries — **identical before and after every change in this step** |
| API documentation verified | `docs/API_REFERENCE.md` — every module, every endpoint, the envelope, pagination, auth/permission model, error codes, and worked examples checked against the actual running responses (not written from memory; see §6.3) |
| No completed module regressed | every pre-step-8 suite still passes at its pre-step-8 count (§6.2); the legacy `/api/*` surface is **byte-for-byte unchanged**, proven by the parity check in `test/api_v1_test.mjs` §12 |

---

## 11. Git

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| Base at start | `6d205151` (step 7) |
| **Merged into `main`** | **no** |
| Pushed | per the user's instructions for this step |

Step 9 — CASA De Aurum Backend Integration — **has not been started**,
per this step's explicit instruction to stop after the final report.

---

## 12. Unresolved decisions

**None.** The four structural questions in §7 were put to the user
before implementation and all four were answered. Nothing in this
step required a decision that was not already resolved by the time
this report was written.
