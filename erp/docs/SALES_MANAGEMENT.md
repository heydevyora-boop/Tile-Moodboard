# Sales Management — step 7

Customers, quotations, sales orders, stock reservation, invoices,
dispatch, sales returns and payment tracking, drawing stock out of
the append-only ledger step 5 built.

**Nothing in the catalogue extraction system was changed.** No
Gemini prompt, no scanner, no Drive integration, no Sheets
workflow. **No Product Master SKU rule was changed.** **No
append-only protection was weakened.** **No Purchase Management
logic was modified.** **No destructive migration.** **Nothing
merged into `main`.**

---

## 1. Inspection report

Taken before any code was written.

### 1.1 Git state

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| Working tree | clean, no uncommitted changes |
| HEAD | `2469df8f` — "ERP step 6: purchase management, from supplier to goods receipt" |
| Relative to `origin/main` | 217 ahead, **0 behind** — steps 1–6 present and unmerged |

Steps 1–6 are all present in the working branch. **No integration
or recovery was needed**, and nothing was reset or discarded. The
branch is not `main` and was not assumed to be.

### 1.2 What already exists and is reused

| | Where | Verdict |
|---|---|---|
| `Customer` + `CustomerType` | step 2 | **reuse** — separate from `Supplier`, already has code, GSTIN, contact |
| `SalesOrder` / `SalesOrderLine` | step 2 | **reuse** — already snapshots `skuAtOrder` / `nameAtOrder`, tracks `dispatchedQuantity` |
| `SalesOrderStatus` | step 2 | reshaped by **rename**, see §1.5 |
| `postStockMovement()` | `db/stock.mjs` | **reuse, exclusively** |
| `reserve()` / `releaseReservation()` | `inventory.service.mjs` (step 5) | **reuse** — the reservation primitives already exist |
| `RESERVATION` / `RESERVATION_RELEASE` movement types | step 5 | **reuse** |
| `SALES_DISPATCH` / `SALES_RETURN` reasons | step 2 | **reuse** — both already there |
| `DAMAGE` / `DAMAGE_RECOVERY` | step 5 | **reuse**, for returned goods that come back broken |
| `money.mjs` — paise arithmetic, `computeLine`, `computeTotals` | step 6 | **reuse unchanged** |
| `gstRateForHsn`, `stateCodeOf` | step 6 | **reuse unchanged** |
| `DocumentSequence` + `nextDocumentNumber()` | step 2 | **reuse** — four sequences added as rows |
| `AuditLog` + `record()` | step 3 | **reuse** |
| `Role` / `RolePermission` / `permission.mjs` | step 2 / step 6 | **reuse** |
| `Warehouse` + warehouse service | step 5 | **reuse** |
| Express 4 + Zod 3 + `parse()` / `handler()` | step 3 | **reuse** |
| `useTestDatabase()` | step 3 | **reuse** |

### 1.3 Existing sales data

| | |
|---|---|
| `customers` | 4 rows (seeded) |
| `sales_orders` | **0 rows** in every database |
| `sales_order_lines` | **0 rows** |

As in step 6, zero rows means the status enum can be reshaped by
rename without migrating data or stranding dead members.

### 1.4 What is missing

| Area | Gap |
|---|---|
| Customer | no state code, shipping address, postal code, payment terms, credit period or notes |
| **Quotation** | **no model at all** — `SalesOrderStatus.QUOTATION` was the only trace of the idea |
| Sales order | no quotation link, no approval, no addresses, no delivery terms, no GST treatment, no tax breakdown, no expected dispatch date, no cancellation or closure |
| Sales order line | no reserved quantity, no discount percent, no taxable value, no tax rate, no CGST/SGST/IGST, no HSN snapshot |
| **Sales invoice** | no model |
| **Delivery challan** | no model |
| **Sales return** | no model |
| **Customer payment** | no model |
| Reservation ↔ order | nothing ties a reservation to the order that caused it |
| GST for sales | the step-6 decision function is purchase-shaped, see §1.6 |
| Frontend | `Sales.jsx` renders `SALES` from `src/data/operations.js` — **entirely mock** |
| Document sequences | `SALES_ORDER` exists; no quotation, invoice, challan or return |
| Audit actions | no `RESERVE`, no `DISPATCH` |

### 1.5 The status enum

Existing: `QUOTATION`, `CONFIRMED`, `DISPATCHED`, `INVOICED`,
`DELIVERED`, `CANCELLED`.

With a separate `Quotation` document, a sales-order status of
`QUOTATION` is wrong, and `INVOICED` describes a different axis
from the rest (an order can be invoiced before or after dispatch).
Because there are zero rows, these are **renamed** — which rewrites
nothing and leaves no dead members:

| From | To |
|---|---|
| `QUOTATION` | `DRAFT` |
| `DISPATCHED` | `PARTIALLY_DISPATCHED` |
| `INVOICED` | `FULLY_DISPATCHED` |
| `DELIVERED` | `CLOSED` |

plus three added: `PENDING_APPROVAL`, `PARTIALLY_RESERVED`,
`RESERVED`. `CONFIRMED` and `CANCELLED` keep their names.

### 1.6 Integration risks found during inspection

These are the four places where sales could quietly corrupt what
steps 5 and 6 built. Each is addressed in the section named.

**(a) A dispatch that does not consume its reservation.** Step 5's
model is `available = onHand − reserved − damaged`. Posting an
`OUTWARD` for stock that is still reserved would reduce on-hand
*and* leave the reservation standing, double-counting the same
boxes against availability. Worse, the `OUTWARD` would be
**refused**, because available would already be zero. So a
dispatch must post `RESERVATION_RELEASE` **first**, then `OUTWARD`
— the same two-step shape the purchase return uses for damaged
stock. See §8.

**(b) GST for a sale is not GST for a purchase.** Step 6's
`gstTreatmentFor()` compares the *supplier's* state with the
*receiving warehouse's*, and treats a party with no GSTIN as
`UNREGISTERED` → no tax. Both are wrong for a sale: the place of
supply is where the goods are delivered (the **customer's shipping
state**) compared with the **seller's** state (the dispatching
warehouse), and a sale to an unregistered customer still carries
GST — B2C is taxed. A separate *decision* function is therefore
required. The *arithmetic* (`computeLine`, `computeTotals`, the
paise handling) is reused unchanged, so there is no competing GST
engine. See §11.

**(c) Cancelling a partly dispatched order.** Stock has left the
building; a cancellation that claims the order never happened
would orphan it. Same rule as a purchase order that has received
goods: refuse, and close short instead. See §9.

**(d) Invoicing must not move stock.** An invoice is a claim for
payment. The chosen inventory event is **dispatch**, stated once
and kept consistent. See §7.

---

## 2. Required additive changes

Everything below is additive. No table dropped, no column removed,
no data reset, no historical stock movement deleted.

| Change | Kind |
|---|---|
| `Customer`: `stateCode`, `postalCode`, shipping address block, `paymentTerms`, `creditPeriodDays`, `notes` | new nullable columns |
| `SalesOrderStatus`: four renames, three additions | rename + add, **safe at zero rows** |
| `SalesOrder`: quotation link, approval, addresses, terms, GST treatment, tax totals, dispatch date, cancellation and closure | new columns |
| `SalesOrderLine`: `reservedQuantity`, discount, taxable value, tax rate and amounts, HSN snapshot, `returnedQuantity` | new columns |
| `Quotation`, `QuotationLine` | **new tables** |
| `SalesInvoice`, `SalesInvoiceLine` | **new tables** |
| `DeliveryChallan`, `DeliveryChallanLine` | **new tables** |
| `SalesReturn`, `SalesReturnLine` | **new tables** |
| `CustomerPayment` | **new table** |
| `QuotationStatus`, `SalesInvoiceStatus`, `DeliveryChallanStatus`, `SalesReturnStatus`, `ReturnDisposition`, `PaymentStatus`, `PaymentMethod` | **new enums** |
| `StockReferenceType`: `DELIVERY_CHALLAN`, `SALES_RETURN` | enum additions |
| `AuditAction`: `RESERVE`, `DISPATCH` | enum additions |
| `DocumentSequence`: `QUOTATION` (QT), `SALES_INVOICE` (INV), `DELIVERY_CHALLAN` (DC), `SALES_RETURN` (SR) | new seed rows |
| Sales permissions on the seeded roles | new seed rows |

---

## 3. Architecture

```
Customer
   │
   ▼
Quotation ──revise──▶ Quotation (new revision, old one CANCELLED)
   │
   │  CONVERT (sales:write, never automatic)
   ▼
SalesOrder ──submit──▶ PENDING_APPROVAL ──approve──▶ CONFIRMED
   │                                                     │
   │                                      reserve (stock:reserve)
   │                                                     ▼
   │                                    RESERVED / PARTIALLY_RESERVED
   │                                                     │
   │               ┌─────────────────────────────────────┤
   │               ▼                                      ▼
   │         SalesInvoice                         DeliveryChallan (dispatch)
   │      (no stock moves)              RESERVATION_RELEASE, then OUTWARD
   │                                                     │
   │                                     PARTIALLY_DISPATCHED / FULLY_DISPATCHED
   │                                                     │
   │                                               SalesReturn
   │                                   ACCEPTED_GOOD → INWARD
   │                                   DAMAGED        → INWARD, then DAMAGE
   │                                   REJECTED       → nothing
   ▼
cancel (before dispatch, releases reservation)  /  close (short, releases the rest)

CustomerPayment ── against one POSTED SalesInvoice, balance always derived
```

**One stock-moving event per side of the ledger, stated once:**
`DeliveryChallan.dispatch()` is the only call in the sales module
that posts `OUTWARD`. `reservation.service.mjs` is the only one
that posts `RESERVATION` / `RESERVATION_RELEASE`.
`salesReturn.service.mjs` is the only one that posts `INWARD` /
`DAMAGE` for goods coming back. Nothing else — not the order, not
its approval, not the invoice — touches `inventory_balances` or
`stock_ledger_entries`. Verified by `test/sales_test.mjs`'s own
"architecture" check, which greps every service file for the
import and asserts the list is exactly these three plus the four
step 5/6 already had.

**Reuse, not reinvention.** `customer.service.mjs` mirrors
`supplier.service.mjs`'s shape (CRUD, `options()`, `setActive()`,
history with a derived summary) because the two relationships —
buy from, sell to — are the same kind of problem with the tax
direction reversed. `dispatch.service.mjs` mirrors
`grn.service.mjs`'s shape (create the document and its lines
first, so each line has a stable id to build an idempotency key
from, then post movements inside the same transaction, then flip
DRAFT→POSTED atomically). `salesReturn.service.mjs` mirrors
`purchaseReturn.service.mjs`'s two-step damaged-stock handling.
`salesInvoice.service.mjs` mirrors `supplierInvoice.service.mjs`'s
one rule: never import `postStockMovement`.

**One-directional, lazy imports break the only real cycle.**
`quotation.service.mjs` → `salesOrder.service.mjs` →
`reservation.service.mjs` is a straight line if each file only
imports the next one *inside the function that needs it*
(`convert()`, and `cancel()`/`close()` respectively), never at the
top of the file. That is what makes "a quotation never creates an
order on its own" and "cancelling releases the reservation" each
verifiable by reading one file, and it was load-tested directly
(`node -e "Promise.all([import(...), import(...), import(...)])"`)
before any route or test depended on it.

---

## 4. Migration

`prisma/migrations/20261123090000_sales_management/migration.sql`,
hand-written for the same reason every migration in this project
is: Prisma's generated diff would read an enum *rename* as a
drop-and-recreate of the type, which is destructive the moment a
single row exists. Verified safe here only because `sales_orders`
and `sales_order_lines` held zero rows at migration time (§1.3).

Verified, before it touched a real database, by building a scratch
database (`devyora_erp_mig_check7`) from a full fresh history,
running `prisma migrate deploy` against it, then
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma`
until it reported **"No difference detected"**. Five real
discrepancies were found and fixed this way before the migration
ever reached the dev database — two index names that didn't match
Prisma's own convention, a `Quotation.revisionOf` scalar with no
actual `@relation` behind it, a column renamed to the wrong name
in SQL versus the schema, and — the one that mattered — an entire
column (`dispatchDate`) that had been **dropped** rather than
renamed when the `SalesOrder` model was rewritten, which would
have violated the additive-only rule this project runs on. Fixed
by renaming it to `legacyDispatchDate` (documented, superseded by
the order's own `expectedDispatchDate` and by each challan's real
`dispatchDate`) and adding the genuinely new column alongside it.

**Superseded columns, kept, never dropped:** `sales_orders.discount`
→ `legacyDiscount`; `sales_orders.dispatchDate` →
`legacyDispatchDate`; `sales_order_lines.discount` →
`legacyDiscount`. All three are zero or null on every existing row
and documented with a `COMMENT ON COLUMN` explaining what replaced
them.

**CHECK constraints, the second layer behind every service-level
validation**, same vocabulary as step 6's purchase migration:
amounts non-negative, tax split matches the stated treatment
(CGST+SGST only for `INTRA_STATE`, IGST only for `INTER_STATE`),
totals equal the sum of their own components, a status and its
timestamp pair agree (`POSTED` with `postedAt`, never one without
the other), quantities positive,
`sales_order_line_reserved_plus_dispatched_within_ordered`
(`reservedQuantity + dispatchedQuantity <= quantity`), and
`sales_order_line_returned_within_dispatched`
(`returnedQuantity <= dispatchedQuantity`).

**One deferred foreign key**, documented in the SQL itself: the
`sales_orders.quotationId` FK had to be added *after* the
`quotations` table exists, not in the same `ALTER TABLE` that adds
the column, because `quotations` is created later in the same file.

---

## 5. Services and endpoints

| Area | Service | Mounted at |
|---|---|---|
| Customers | `customer.service.mjs` | `/api/customers` |
| Quotations | `quotation.service.mjs` | `/api/quotations` |
| Sales orders | `salesOrder.service.mjs` | `/api/sales-orders` |
| Stock reservation | `reservation.service.mjs` | `/api/sales-orders/:id/{availability,reserve,release}` |
| Dispatch | `dispatch.service.mjs` | `/api/delivery-challans` |
| Sales invoices | `salesInvoice.service.mjs` | `/api/sales-invoices` |
| Sales returns | `salesReturn.service.mjs` | `/api/sales-returns` |
| Customer payments | `payment.service.mjs` | `/api/customer-payments` |
| Dashboard & history | `salesDashboard.service.mjs` | `/api/sales-dashboard`, `/api/sales-history` |

All mounted at the root of `/api` in `server/app.mjs` (peer
documents, same reasoning as purchase: a customer, a quotation and
a sales order are three things, not three views of one noun).

**Customer** — CRUD, `options()`, `setActive()`, history with a
derived summary (`ordersPlaced`, `valueOrdered`, `invoiced`,
`outstanding`). No delete: a customer with history cannot be
removed without orphaning the quotations, orders and invoices that
explain it.

**Quotation** — `create`/`update` (draft only), `send`, `respond`
(`ACCEPTED`/`REJECTED`/`EXPIRED`, only from `SENT`), `cancel`,
`revise` (one transaction: creates the new revision, marks the old
one `CANCELLED`, writes two audit records), `convert` (requires
`sales:write`, not `quotation:write` — committing to an order is a
different act from drafting a quote). A quotation never creates a
sales order on its own: `convert()` is the one path, and it moves
no stock either.

**Sales order** — the state machine: `DRAFT → PENDING_APPROVAL →
CONFIRMED → PARTIALLY_RESERVED/RESERVED → PARTIALLY_DISPATCHED →
FULLY_DISPATCHED → CLOSED`, with `CANCELLED` reachable from any
non-terminal, non-dispatched state. `DRAFT` may be approved
directly, the same shortcut `purchaseOrder.service.mjs` allows —
`submit()` is a workflow courtesy, not a hard gate.
`refreshStatusFromLines()` derives the order's status by checking
**every line individually**, never by summing quantities across
lines — summing lets one over-fulfilled line mask another that was
never touched at all (the exact bug class step 6 found and fixed
for purchase orders, designed out from the start here).
`cancel()` refuses once anything has dispatched, and says to close
short instead; `close()` releases whatever remains reserved,
leaving what already shipped untouched.

**Reservation** — `availability()` reads `inventory_balances`
fresh, every time: `available = onHand − reserved − damaged`,
physical stock is never assumed to equal what can be promised.
`reserveForOrder()` validates per line (order status, warehouse
active, quantity within the unreserved-and-undispatched bound, and
within the *live* available figure), then posts a `RESERVATION`
movement per line inside one transaction, updates the line's
`reservedQuantity`, and refreshes the order's status.
`releaseForLine()` is the shared primitive `releaseFromOrder()`,
`cancel()` and `close()` all call — it requires
`salesOrder.warehouseId` directly and throws rather than guess if
it is missing, which is exactly the bug a prior version of this
file had (§10, known limitations lists what the test suite proved
instead of guessed).

**Dispatch** — the only sales document that decreases stock.
`prepare()` validates: order dispatchable, line belongs to the
order, quantity positive, **never** above what remains on the
order line (no exception — shipping more than was ordered has no
legitimate case through this screen), and not above what is
reserved *unless* `allowUnreservedApproved` and a reason are given.
Posting order, inside one transaction: release the reservation
**first**, then `OUTWARD` — reversing the order would let the
available-stock check see, for one instant, the same boxes counted
as both reserved and gone, and refuse a dispatch that is in fact
valid. The release is capped at what the line itself actually
holds reserved (`Math.min(dispatched, reserved)`): an
approved over-dispatch's excess was never reserved, so nothing is
released or decremented for that part — found by
`test/sales_test.mjs` itself, see §10. Idempotency keys are built
from the freshly-created `DeliveryChallanLine.id`
(`dc:<lineId>:release` / `dc:<lineId>:outward`), the same pattern
as a goods receipt.

**Sales invoice** — never imports `postStockMovement`. Price and
tax are the sales order line's own frozen figures (or, for an
order converted from a quotation, the quotation's), never re-read
from today's Product Master. What remains invoiceable on a line is
computed fresh each call — ordered less what every earlier,
non-cancelled invoice against this order already claimed for that
product — because no `invoicedQuantity` running total was added to
`SalesOrderLine`: the figure didn't need one to stay correct.
Created and posted in one atomic step, the same shape as a goods
receipt: there is no separately-editable draft. `cancel()` is
refused while any payment is recorded against the invoice.

**Sales return** — three dispositions, three different effects:
`ACCEPTED_GOOD` posts one `INWARD`; `DAMAGED` posts `INWARD` then
`DAMAGE` (the boxes are physically back, so the figure says so,
but immediately pulled out of the sellable count); `REJECTED`
posts nothing at all — the claim is refused by simply never
calling the stock service for that line, not by a movement that is
later reversed. One dispatched line may split across all three
dispositions on a single return (dedup key is
`(orderLine, disposition)`, the same shape as a purchase return
keying on `(product, fromDamaged)`). Eligibility is read straight
off `dispatchedQuantity − returnedQuantity` on the order line —
and `returnedQuantity` advances for **every** disposition,
including `REJECTED`, because a claim made and refused still
resolves the dispatched quantity it was made against (documented
on the schema field itself).

**Customer payment** — "implement basic payment tracking only if
supported by existing schema" is taken literally: one payment row
against one posted invoice, no bank account, no allocation across
several invoices, no accounting system. The balance is never
stored — `paid`, `outstanding` and `status` are derived fresh from
`SUM(CustomerPayment.amount)` against the invoice's own
`grandTotal`, every time, the same discipline this schema applies
everywhere a figure can be computed instead of cached. Overpayment
is refused outright, with the real outstanding figure in the
refusal, rather than clipped or carried as a credit this phase has
no concept of.

---

## 6. GST

`salesGstTreatmentFor({ warehouse, customer })`, added to
`money.mjs` immediately before `stateCodeOf`, reuses the exact same
arithmetic (`computeLine`, `computeTotals`, paise and milli
scaling) as the purchase side, but decides the treatment
differently, and deliberately so (§1.6b):

| | Purchase (`gstTreatmentFor`) | Sales (`salesGstTreatmentFor`) |
|---|---|---|
| Compares | supplier's state vs. **receiving warehouse's** | **selling warehouse's** state vs. customer's **shipping** state, never billing |
| No GSTIN | `UNREGISTERED` — no tax charged | still taxed — an ordinary B2C sale |
| Missing state code | refuses, names the field | refuses, names the field |

Neither function guesses a missing state code. Both return an
`{ error }` object that the caller turns into a `ValidationError`
naming the exact field, never a silent `INTRA_STATE` default. GST
is decided and frozen **once per document** — a sales order
decides its own at creation, and a sales invoice decides its own
again at invoicing time (reading the customer and warehouse as
they stand *then*), rather than inheriting the order's. In the
ordinary case the two agree; they are allowed to differ because a
customer's shipping address can be corrected between the order and
the invoice, and the invoice must reflect the truth on the day it
is raised, not inherit a historical one.

Proven correct by ten standalone assertions before any service
code was built on it, and again by `test/sales_test.mjs`'s own
checks 16–17, which compare the service's output against the
figures actually written to the database columns, not against
what the service claims about itself.

---

## 7. Permissions

Reused unchanged: `permission.mjs`'s `resource:action` convention,
`can()`/`assertCan()`/`requirePermission()`, the `*` and
`resource:*` wildcards. This is still **not authentication** —
identity still arrives through the `x-erp-user` placeholder header
from step 3, and a permission check on top of an unauthenticated
actor stops mistakes, not a determined caller on the same host.
That limitation is the same one documented for purchase in step 6
and is not re-solved here.

| Permission | Granted to | Withheld from |
|---|---|---|
| `customer:read` / `customer:write` | ADMIN, MANAGER, STORE (read only), SALES | — |
| `quotation:read` / `quotation:write` | ADMIN, MANAGER, SALES | STORE, VIEWER (read only) |
| `sales:read` / `sales:write` | ADMIN, MANAGER, SALES | STORE (read only) |
| `sales:approve` | ADMIN, MANAGER | SALES, STORE |
| `stock:reserve` | ADMIN, MANAGER, STORE | SALES |
| `sales:dispatch` | ADMIN, MANAGER, STORE | SALES |
| `sales:invoice` | ADMIN, MANAGER | SALES, STORE |
| `sales:return` | ADMIN, MANAGER | SALES, STORE |
| `sales:payment` | ADMIN, MANAGER | SALES, STORE |

The SALES role can read everything, raise quotations and orders,
but cannot approve them, reserve stock, dispatch, invoice, return
or record a payment against its own work — order approval, stock
reservation, dispatch and payment are each a separate permission
from `sales:write` for exactly that reason. All eight withholdings
are proven, not asserted, by `test/sales_test.mjs` §43: each one
actually attempts the forbidden call with the wrong actor and
checks for a thrown `ForbiddenError`.

---

## 8. Audit logging

Reused unchanged: the append-only `AuditLog` table and
`audit.mjs`'s `record()`, called inside the same transaction as
every state change so an audited action and its effect commit or
roll back together. Two new `AuditAction` values were added,
additively: `RESERVE` and `DISPATCH`. Every lifecycle step on a
sales order — create, update, submit, approve, reserve, dispatch,
cancel, close — writes one entry naming a real actor; quotation
revision writes two in one transaction (the new revision's
`CREATE` and the superseded one's `CANCEL`). Proven by
`test/sales_test.mjs` §44, which reads `AuditLog` back for a real
order and a real return and checks every expected action is
present with a non-null actor — not that the call to `record()`
was merely made.

---

## 9. Frontend

Sixteen named screens, delivered as nine routed pages following the
exact convention step 6 already established: list, create and
detail for one kind of document live in a single file (compare
`PurchaseOrders.jsx`, which combines the purchase order list,
creation form and detail view with its approve/cancel/close
actions in one component).

| Brief's screen(s) | File |
|---|---|
| Sales Dashboard | `SalesDashboard.jsx` |
| Customer List, Customer Details | `Customers.jsx` |
| Quotations, Create Quotation, Quotation Details | `Quotations.jsx` |
| Sales Orders, Create Sales Order, Sales Order Details | `SalesOrders.jsx` (reservation is an action inside the order detail, `ReservationPanel`) |
| Stock Reservation | embedded in `SalesOrders.jsx` |
| Sales Invoices, Invoice Details | `SalesInvoices.jsx` |
| Dispatch / Delivery Challan | `DeliveryChallans.jsx` |
| Sales Returns | `SalesReturns.jsx` |
| Customer Payment Tracking | `CustomerPayments.jsx` |
| Sales History | `SalesHistory.jsx` |

Every one of the nine reads the real ERP database through
`src/api/client.js`'s new `customers`, `quotations`, `salesOrders`,
`deliveryChallans`, `salesInvoices`, `salesReturns`,
`customerPayments` and `sales` blocks — none renders mock data. The
old `Sales.jsx`, which rendered `SALES` from
`src/data/operations.js`, is deleted; that mock array itself is
left in place because `Reports.jsx` (still a demo-data screen,
out of this step's scope) still reads it. The sidebar's `Trade`
group is renamed `Sales` and now carries nine `live` entries in
`src/data/modules.js`, replacing the single `ready` placeholder —
proven present and marked live by
`test/frontend_regression_test.mjs` §1 and §6e, and the sidebar's
module count (now thirty-two) is asserted in
`test/data_consistency_test.js` §5c, not left to drift unnoticed.

Verified end to end in a real browser (Playwright, against an
isolated scratch database, never the dev database): create a
customer → raise a quotation → send it → accept it → convert it to
a sales order → submit → approve → reserve stock → dispatch →
invoice → record a part-payment → have an overpayment refused by
the disabled submit button → post a split-disposition sales
return. Every step rendered with zero console errors and produced
the figures the backend actually recorded.

---

## 10. Test report

```
npm run test:sales              95 passed, 0 failed   (test/sales_test.mjs)
npm run test:purchase          126 passed, 0 failed   (regression, allowlist updated for the 3 new importers)
npm run test:inventory          86 passed, 0 failed   (regression)
npm run test:product-master     92 passed, 0 failed   (regression)
npm run test:import             83 passed, 0 failed   (regression)
npm run test:data                38 passed, 0 failed   (regression, module count updated: 24 → 32)
npm run test:frontend            66 passed, 0 failed   (regression, screen list and live-flags updated)
npm run db:verify                41 passed, 0 failed   (regression, dev database untouched throughout)
```

**607 checks, 0 failures**, all against databases dropped and
rebuilt from the same migrations and the same seed on every run —
`devyora_erp_sales_test` for the new suite, never the development
database. The forty-four brief-listed cases are covered by name
across the ninety-five sales checks (several brief cases map to
more than one assertion, e.g. "excess dispatch rejection" is
checks 28 and 29, "concurrent reservation" is 22 and 22b).

**Three real defects were found by this suite before it ever ran
clean, and fixed, not worked around:**

1. **A dispatch beyond reserved stock, once approved, crashed.**
   `dispatch.service.mjs` released and decremented the *full*
   dispatched quantity from the order line's `reservedQuantity`
   regardless of how much that line actually held reserved;
   dispatching 5 when only 2 were reserved drove the column
   negative and hit the database's own `CHECK` constraint. Fixed
   by capping the release at `Math.min(dispatched, reserved)` and
   skipping the `RESERVATION_RELEASE` movement entirely when that
   cap is zero — found by test 29b, the one case that genuinely
   exercises the approved-exception path.
2. **`salesOrder.service.mjs`'s `loadWithLines()` selected a
   `warehouseId` field that does not exist on `SalesOrderLine`** —
   only `SalesOrder` carries it — which crashed `close()` the
   moment it tried to release a reservation on a partially
   dispatched order. Found while tracing `releaseForLine()`'s
   contract, confirmed by test 35, fixed by removing the invalid
   selection and reading the order's own `warehouseId` once.
3. **`CustomerType`'s real enum is `RETAIL`/`TRADE`/`PROJECT`/
   `INTERNAL`**, not the five-value list the Zod route schema and
   the frontend's dropdown had guessed — caught while cross-checking
   every Zod enum against `prisma/schema.prisma` directly rather
   than trusting memory, before any test ran, and fixed in both
   places.

**One pre-existing gap, left alone, worked around in the test
suite only:** `prisma.customer.create`'s `code` field is
`.optional()` where it should be `.nullish()`, in both
`CreateSupplier` (purchase, step 6, untouched) and
`CreateCustomer` (this step) — a blank "Code" field in the create
form sends `code: null`, which `.optional()` rejects. Fixed in
`CreateCustomer` because it blocks sales functionality directly;
left alone in `CreateSupplier` per the brief's own instruction not
to touch purchase logic absent a proven defect blocking sales.

---

## 11. Known limitations

- **Authentication is still a development placeholder.** The
  `x-erp-user` header is unchanged from step 3; every permission
  check in this step sits on top of it and inherits the same
  limitation documented for purchase.
- **Dev-database customers have no state code.** The original
  seed never set a `state` value on the four dev customers (only
  `city`), so the migration's GSTIN- and state-name-derived
  backfill had nothing to populate for them. The service layer
  does the right thing with this gap — `salesGstTreatmentFor`
  refuses to guess rather than defaulting silently — but a sales
  order against a dev customer with no shipping state code will
  be refused until one is set. Not a correctness bug; a demo-data
  gap. (Running `node prisma/seed.mjs` against the dev database
  to backfill it was denied twice by the session's own permission
  classifier as a destructive action; not retried a third time or
  worked around.)
- **No `invoicedQuantity` running total on `SalesOrderLine`.**
  What remains invoiceable is computed from an aggregate query
  over `SalesInvoiceLine` every time, the same shape purchase
  returns already use for eligibility. Correct, proven by test
  25b, and consistent with the rest of this schema's preference
  for deriving over caching — but it is one query heavier than a
  stored counter would be.
- **No accounting system.** Customer payments are tracked at the
  level the brief asked for and no further: no bank account, no
  reconciliation, no multi-invoice allocation, no financial
  reporting. Explicitly out of scope.
- **No ERP API integration, CASA backend integration, or website
  stock synchronization** — the brief's own exclusion, honoured.

---

## 12. Git

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` (unchanged — step 7 continues it) |
| Base | `2469df8f` — "ERP step 6: purchase management, from supplier to goods receipt" |
| Merged into `main` | **no** |
| Destructive migration | **no** |
| Dev database reset | **no** |
| Historical stock movement deleted | **no** |

STOP after step 7, per the brief. Waiting for review and approval
before step 8 — ERP API Development.
