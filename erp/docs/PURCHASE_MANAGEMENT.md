# Purchase Management — step 6

Suppliers, purchase orders, goods receipt, supplier invoices and
purchase returns, posting into the append-only stock ledger step 5
built.

**Nothing in the catalogue extraction system was changed.** No
Gemini prompt, no scanner, no Drive integration, no Sheets
workflow. **No Product Master SKU rule was changed.** **No
append-only protection was weakened.** **No destructive migration.**
**Nothing merged into `main`.**

---

## 1. Inspection report

Taken before any code was written.

### 1.1 Git state

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| Working tree | clean, no uncommitted changes |
| HEAD | `f4390d51` — "ERP step 5: inventory management on the append-only stock ledger" |
| Relative to `origin/main` | 216 commits ahead, **0 behind** — step 5 is present and unmerged |

Step 5 is fully present in the working branch. **No integration,
merge or recovery was needed**, and nothing was reset, force-pushed
or discarded.

### 1.2 What already exists and is reused as-is

| | Where | Verdict |
|---|---|---|
| `Supplier` | `schema.prisma` | **reuse** — separate from `Customer` already |
| `Customer` | same | untouched; roles are already separate models |
| `PurchaseOrder` | same | **reuse** — has totals, currency, warehouse, supplier, createdBy |
| `PurchaseOrderLine` | same | **reuse** — already snapshots `skuAtOrder` / `nameAtOrder` and tracks `receivedQuantity` |
| `PurchaseOrderStatus` | same | reshaped by **rename**, see §1.4 |
| `DocumentSequence` + `nextDocumentNumber()` | `db/stock.mjs` | **reuse** — row-locking `UPDATE … RETURNING`, already safe under concurrency |
| `AuditLog` + `record()` | `services/audit.mjs` | **reuse** — append-only, written in the same transaction |
| `postStockMovement()` | `db/stock.mjs` | **reuse, exclusively** — the only writer of stock |
| `StockMovementReason.PURCHASE_RECEIPT` / `PURCHASE_RETURN` | `schema.prisma` | **reuse** — both already exist |
| `StockReferenceType.PURCHASE_ORDER` | same | reused; two members added |
| `Warehouse` + `warehouse.service.mjs` | step 5 | **reuse** |
| Product Master + SKU services | step 3 | **reuse, unmodified** |
| `Role` / `RolePermission` / `UserRole` | `schema.prisma` | exist and are seeded — see §1.5 |
| Express 4 + Zod 3 + `parse()` / `handler()` | `server/validate.mjs` | **reuse** |
| `useTestDatabase()` | `test/helpers/testdb.mjs` | **reuse** |

### 1.3 Existing purchase data

| | |
|---|---|
| `suppliers` | 4 rows (seeded, all Gujarat) |
| `purchase_orders` | **0 rows** in every database |
| `purchase_order_lines` | **0 rows** |

This matters for §1.4: with no rows anywhere, the status enum can
be reshaped without migrating data or stranding dead members.

### 1.4 What is missing

| Area | Gap |
|---|---|
| Supplier | no state code, shipping address, credit period, postal code or notes |
| Warehouse | no state code — **without it GST treatment cannot be determined** |
| PO status | `DRAFT / ORDERED / PARTIALLY_RECEIVED / RECEIVED / CANCELLED` — no approval step, no closure |
| PO | no approver, no approval timestamp, no billing/shipping address, no payment terms, no GST treatment, no tax breakdown, no cancellation or closure record |
| PO line | no discount, no tax rate, no tax amount, no taxable value, no per-line expected date, no rejected/damaged tracking |
| **Goods receipt** | **no model at all.** Nothing connects a PO to the stock ledger |
| Purchase return | no model |
| Supplier invoice | no model |
| GST | nothing — no rates, no CGST/SGST/IGST, no state comparison |
| Money arithmetic | nothing decimal-safe; existing totals are written by the seed |
| Authorization | `Role` and `RolePermission` are seeded and **never read by any code** |
| Frontend | `Purchase.jsx` renders `PURCHASES` from `src/data/operations.js` — **entirely mock** |
| Document sequences | `PURCHASE_ORDER` exists; no `GOODS_RECEIPT_NOTE`, no `PURCHASE_RETURN` |
| Audit actions | `AuditAction` has no `APPROVE`, `RECEIVE` or `CLOSE` |

### 1.5 Authorization — the finding that shaped §14

`Role`, `RolePermission` and `UserRole` exist, and `prisma/seed.mjs`
populates five roles with permission strings (`purchase:write`,
`stock:post`, `*`, …).

**Nothing in the codebase reads them.** A grep across `server/` and
`db/` for `permission` returns no matches. Every route has been open
to any caller since step 3.

The brief requires that unauthorised approval and finalisation be
prevented, and that the *existing* authorization infrastructure be
used rather than a new one invented. So step 6 wires the tables that
were already there into a permission check, and applies it to the
purchase routes. It does **not** build an authentication system: the
actor still arrives through the `x-erp-user` placeholder, which
remains the open limitation recorded in §16.

### 1.6 Purchase requisition

The brief makes it conditional — "optional, only if supported by
existing schema". There is **no requisition model, table or enum**
anywhere in the schema, and inventing one would be new scope rather
than reuse. **Not implemented**, recorded in §16 as a deferred
capability. The PO lifecycle starts at `DRAFT`.

---

## 2. Required additive changes

Everything below is additive. No table is dropped, no column
removed, no data reset, no historical stock movement deleted.

| Change | Kind |
|---|---|
| `Supplier`: `stateCode`, `postalCode`, `shippingAddressLine` / `shippingCity` / `shippingState` / `shippingStateCode` / `shippingPostalCode`, `creditPeriodDays`, `notes` | new nullable columns |
| `Warehouse`: `stateCode`, `gstin` | new nullable columns |
| `PurchaseOrderStatus`: rename `ORDERED` → `APPROVED`, `RECEIVED` → `FULLY_RECEIVED`; add `PENDING_APPROVAL`, `CLOSED` | rename + add, **safe at zero rows** |
| `PurchaseOrder`: approval, addresses, payment terms, GST treatment and tax totals, cancellation and closure columns | new columns |
| `PurchaseOrderLine`: discount, taxable value, tax rate and amounts, per-line expected date, `rejectedQuantity` | new columns |
| `GoodsReceiptNote`, `GoodsReceiptNoteLine` | **new tables** |
| `PurchaseReturn`, `PurchaseReturnLine` | **new tables** |
| `SupplierInvoice` | **new table** |
| `GoodsReceiptStatus`, `PurchaseReturnStatus`, `SupplierInvoiceStatus`, `GstTreatment` | **new enums** |
| `StockReferenceType`: add `GOODS_RECEIPT_NOTE`, `PURCHASE_RETURN` | enum additions |
| `AuditAction`: add `APPROVE`, `RECEIVE`, `CLOSE` | enum additions |
| `DocumentSequence`: `GOODS_RECEIPT_NOTE` (GRN), `PURCHASE_RETURN` (PR), `SUPPLIER_INVOICE` (SI) rows | new seed rows |
| `purchase:approve` permission on ADMIN and MANAGER | new seed rows |

Rationale for the two renames: `ORDERED` already means "placed with
the supplier", which is what `APPROVED` means in the brief's
lifecycle, and `RECEIVED` already means `FULLY_RECEIVED`. Renaming
keeps the brief's vocabulary **without** leaving two dead enum
members behind, and `ALTER TYPE … RENAME VALUE` rewrites no rows.
With zero purchase orders in any database there is nothing to
migrate.

---

## 3. Architecture

```
   Supplier
      │
      ▼
   Purchase Order ──approve──▶ APPROVED        no stock moves
      │                           │
      │                           ▼
      │                    Goods Receipt  ──▶ postStockMovement()  ◀── STOCK MOVES HERE
      │                           │                    │
      │                           │                    ▼
      │                           │            append-only stock ledger
      │                           ▼
      │                    Supplier Invoice      no stock moves
      ▼
   Purchase Return ─────────▶ postStockMovement()      stock moves, the other way
```

**A purchase order does not increase inventory. Neither does
approving one. Neither does a supplier's invoice.** Stock changes
exactly twice in this module: when a goods receipt is posted, and
when a purchase return is posted. Both go through
`postStockMovement()` and nothing else.

`grn.service.mjs` and `purchaseReturn.service.mjs` are the only
two files in the module that import it.
`purchaseOrder.service.mjs` and `supplierInvoice.service.mjs`
deliberately do not, and test 33b greps the import lines on every
run to keep it that way.

**Purchase requisition is not implemented.** The brief makes it
conditional on the existing schema supporting it, and there is no
requisition model, table or enum anywhere. Recorded in §16 as a
deferred capability rather than invented.

---

## 4. The purchase order lifecycle

```
    DRAFT ─▶ PENDING_APPROVAL ─▶ APPROVED ─▶ PARTIALLY_RECEIVED ─▶ FULLY_RECEIVED
      │             │               │               │                    │
      └─────────────┴───────────────┴─▶ CANCELLED   └────────────────────┴─▶ CLOSED
```

Every transition is checked against a table; anything absent is
refused with a message naming what *is* allowed from here.

### Two rules carry the weight

**An order that has received goods cannot be cancelled.**
Cancelling asserts the order never happened, and it did — there is
stock on a shelf whose only explanation is this order. The refusal
says so, gives the quantity already received, and names the
alternative:

```
Order PO-2026-0002 cannot be cancelled: 2 goods receipt(s) have
already been posted against it, bringing in 100.000 unit(s). That
stock is on a shelf and this order is the only thing that explains
it. Close the order short instead, with a reason.
```

`CLOSED` is that alternative: the order is finished with at
whatever arrived, and the reason is required because "the supplier
cannot supply" and "we stopped waiting" are different facts.

**An approved order cannot be edited.** Lines, prices, quantities
and the supplier are frozen once somebody has committed the studio
to them. Editing is DRAFT-only, and the refusal says to cancel and
re-raise or to close short.

### A bug the tests found

The status was first computed by comparing **summed** quantities.
That lets an over-receipt on one line cover a line that never
arrived: order 100 of A and 40 of B, take 140 of A and nothing of
B, and the totals match while B is outstanding. The smoke test did
exactly that and got `FULLY_RECEIVED`. It is now decided **line by
line** — an order is fully received only when every line is.

---

## 5. Goods receipt and inventory

### The three dispositions of a delivery

| | What happens to stock | Counts towards the order? |
|---|---|---|
| **accepted** | `INWARD`. Sellable. | yes |
| **damaged** | `INWARD`, **then** `DAMAGE`. In the building, not sellable. | yes |
| **rejected** | **no movement at all** | **no** — the supplier still owes it |

Damaged stock enters inventory because it *is* in the building and
a stock-take would find it — step 5's rule, applied here. It is
marked damaged in the same transaction so available stock excludes
it. Writing it off is a separate decision with its own reason.

Rejected stock was turned away at the gate. Nothing is posted, and
a reason is compulsory (enforced by a database CHECK as well as
the service).

### Over-receipt

**Refused by default.** Receiving more than the outstanding
quantity gives:

```
Line 2 (DV-1002): 40.000 still outstanding, but 999.000 is being
received. Over-receipt must be approved explicitly, with a reason.
```

There is an authorised path — `overReceiptApproved` with a
mandatory `overReceiptReason` — and it is deliberately **not** a
silent tolerance band. Somebody says yes, and the reason goes on
the note and into the audit log.

### Idempotency and transaction safety

Each receipt line's movements carry a key built from the line's
own id: `grn:<lineId>:inward` and `grn:<lineId>:damage`. Those ids
are minted when the note is created, so the keys are stable across
retries, and the database's unique index refuses a replay — not a
check-then-act in JavaScript that two concurrent requests would
both pass.

The note, its lines, every stock movement, the order line totals,
the order status and the audit entries are written in **one
transaction**. Test 21 posts a receipt whose second line is
invalid and proves no stock, no ledger row and no half-written
note survive it.

---

## 6. GST

`server/services/money.mjs`. **No floating point anywhere.**

> `0.1 + 0.2 === 0.30000000000000004`

That is not a curiosity when it is a tax figure. Every amount is
an integer of **paise**, every quantity an integer of
**thousandths**, every rate an integer of **hundredths of a
percent**. Decimal strings are parsed by splitting the string, never
by `Number('0.07') * 100` (which is `7.000000000000001`).

### Which treatment applies

For goods the place of supply is where they are delivered, so the
comparison is the **supplier's state** against the **receiving
warehouse's state**:

| | |
|---|---|
| same state | `INTRA_STATE` → CGST + SGST, half the rate each |
| different states | `INTER_STATE` → IGST at the whole rate |
| supplier has no GSTIN | `UNREGISTERED` → no GST charged |

**There is no "assume intra-state" fallback.** If either state
code is missing the order is refused, naming the record to fix.
Guessing produces CGST and SGST on an inter-state purchase: wrong,
plausible-looking, and found at audit.

A supplier's state code is **derived from its GSTIN**, whose first
two characters are exactly that. Where a stored code contradicts
the GSTIN the save is refused — one of the two is a typing error
and the tax on every future order depends on which.

### The line, step by step

```
gross    = quantity × unitPrice
discount = gross × discountPercent, or the amount given
taxable  = gross − discount
tax      = taxable × taxRate
total    = taxable + tax
```

Each step is **stored**, so a two-year-old order can be checked
without knowing which rate applied then. Intra-state halves the
tax, with the odd paisa to CGST so the two still sum to the whole.

**Each line rounds to the paisa, and the document total is the sum
of the rounded lines** — not a recomputation. That is how an
Indian tax invoice is built, and it is why the total always equals
the printed lines added on a calculator.

Everything is snapshotted onto the document: the rate, the
treatment, the two state codes, the HSN code, the SKU and the
name. Changing the Product Master later cannot alter an order
already placed.

Reverse charge is **not** implemented and is out of this phase.

---

## 7. Supplier invoices

Three separate records that routinely disagree:

| | |
|---|---|
| **purchase order** | what was agreed |
| **goods receipt** | what actually arrived — *the only one that moves stock* |
| **supplier invoice** | what we are being billed for |

An ERP that conflates any two cannot show you the disagreement,
and the disagreement is the point. `get()` computes a three-way
match — invoice against the value actually received, against the
order — and **reports** it. Recording an invoice that disagrees is
allowed; disagreement is a fact about the supplier.

**Duplicates are refused by a unique index on (supplier, invoice
number)**, in the database rather than in JavaScript. Two clerks
entering the same invoice at the same moment both pass a
check-then-act; only one passes a unique index. The same number
from two different suppliers is ordinary and allowed.

An invoice cannot be linked to a **draft** receipt: a draft is not
evidence that anything arrived.

---

## 8. Purchase returns

**Implemented**, not deferred: the inspection found
`StockMovementReason.PURCHASE_RETURN` already present and step 5's
service already handling both the physical and the damaged
dimension.

It reduces stock through `postStockMovement()` and **does not edit
the receipt that brought the stock in** — that entry stays on the
ledger and the return sits beside it, so the stock card reads as
what happened rather than as a tidied history.

Eligibility is what this supplier actually delivered on posted
receipts, less what has already gone back. The stock service
separately refuses to take a balance below zero, so stock received
and then sold cannot be returned either.

**Returning damaged stock takes two movements**: `DAMAGE_RECOVERY`
to release it from the damaged figure, then `OUTWARD`. Doing only
the second would leave the damaged count claiming boxes that have
left the building.

---

## 9. Document numbering

The existing `DocumentSequence` table and `nextDocumentNumber()`
from `db/stock.mjs` are reused unchanged. **No second numbering
mechanism was introduced**, and no JavaScript counter exists
anywhere.

| | |
|---|---|
| `PURCHASE_ORDER` | `PO-2026-0001` (existed) |
| `GOODS_RECEIPT_NOTE` | `GRN-2026-0001` (added) |
| `PURCHASE_RETURN` | `PR-2026-0001` (added) |

The allocator takes its row lock in the `UPDATE … RETURNING`
itself, so two callers queue rather than both reading the same
number. Tests 27 and 27b allocate twelve numbers at once, and five
concurrent receipts, and assert no duplicates.

---

## 10. Audit logging

Every purchase action writes to the existing append-only
`audit_logs`, **in the same transaction as the change**, with the
actor and a sentence of English. `AuditAction` gained `APPROVE`,
`RECEIVE` and `CLOSE` so those are not flattened into `UPDATE`.

Recorded: supplier created, updated, deactivated; PO raised,
edited while draft, submitted, approved, cancelled, closed; GRN
posted and cancelled; return posted; invoice recorded and its
status changed.

Test 30 asserts entries exist, that every one names a person and a
time, that each says what happened in words, and that the log
itself still cannot be rewritten.

---

## 11. Security and validation

Express 4 and Zod 3 on every route, with the same `parse()` /
`handler()` helpers the rest of the API uses. Refused: invalid SKU,
supplier or warehouse references; zero, negative or unparseable
quantities; negative rates; GST rates outside 0–100; invalid
status transitions; duplicate GRN lines; duplicate stock postings;
duplicate supplier invoices; over-receipt without authorisation;
adjustments and returns with no reason.

### Authorization — wired for the first time

The inspection found `Role`, `RolePermission` and `UserRole`
seeded since step 2 and **read by no code at all**. Step 6 wires
them rather than inventing a parallel scheme:

| Permission | Who has it (seeded) |
|---|---|
| `purchase:write` | ADMIN, MANAGER |
| `purchase:approve` | ADMIN, MANAGER |
| `purchase:receive` | ADMIN, MANAGER, **STORE** |

Approving and receiving are separate authorities: the store keeper
books in what arrives and cannot commit the studio to an order.
Tests 7b and 7c prove the sales desk and the store keeper are both
refused approval with `403 FORBIDDEN`.

### The open limitation

**Authentication is still the step-3 development placeholder.**
The actor arrives in an `x-erp-user` header that anyone able to
reach the port could set to anything. The permission checks stop
*mistakes* — a store keeper approving their own order — and stop
nothing else.

So **the API stays bound to `127.0.0.1`** (`ERP_API_HOST`,
default `127.0.0.1`), CORS allows only the two localhost
development origins, and **nothing here may be exposed to the
internet** until real sign-in exists. Every service takes an actor
and writes it to the audit log, so when it is built it replaces
one middleware and nothing downstream changes.

---

## 12. The screens

All seven are marked **live** and read and write the real
database. Nothing on them is demo data.

| Screen | Path |
|---|---|
| Purchase Dashboard | `/purchase` |
| Suppliers (list, detail and history) | `/suppliers` |
| Purchase Orders (list, create, detail) | `/purchase-orders` |
| Goods Receipt (list, receive, detail) | `/goods-receipts` |
| Supplier Invoices | `/supplier-invoices` |
| Purchase Returns | `/purchase-returns` |
| Purchase History | `/purchase-history` |

Supplier details, purchase order details, order creation and the
receiving form are panels within their lists, the same pattern the
Product Master and Inventory screens already use. That is ten
screens in the brief's sense, on seven routes.

Search, supplier, warehouse, status and date-range filters, and
server-side paging, on every list.

### The sidebar now scrolls, deliberately

Through step 5 all eighteen modules fitted a 900px laptop screen
and a test held them to it. Step 6's seven purchase screens take
it to **twenty-four**, which needs about 1060px. Forcing them into
900 would mean type too small to scan or padding too tight to
click accurately.

So the nav scrolls below that, and **the active module scrolls
itself into view** on every navigation. The real failure
scrolling causes is not the scrollbar — it is landing on Purchase
History, seeing no highlight anywhere and not knowing where you
are. The frontend test now checks that instead.

### Screenshots

In `docs/screenshots/`: `purchase-dashboard`,
`purchase-suppliers`, `purchase-orders`, `purchase-order-detail`,
`purchase-goods-receipts`, `purchase-receipt-detail`,
`purchase-supplier-invoices`, `purchase-returns`,
`purchase-history`.

Taken against `devyora_erp_purchase_test`, which the test suite
fills with real orders, receipts, returns and invoices. The
development database has no purchase data, and screenshots of
empty tables would show nothing working.

---

## 13. Migration

One migration: `20261122090000_purchase_management`. Hand-written
rather than generated, because Prisma diffs a renamed enum member
as a drop and an add, which would recreate the type and rewrite
the column.

| | |
|---|---|
| `ALTER TYPE … RENAME VALUE` | `ORDERED` → `APPROVED`, `RECEIVED` → `FULLY_RECEIVED`. Rewrites no rows; zero purchase orders existed anywhere |
| `ALTER TYPE … ADD VALUE` | `PENDING_APPROVAL`, `CLOSED`; `GOODS_RECEIPT_NOTE`, `PURCHASE_RETURN`; `APPROVE`, `RECEIVE`, `CLOSE` |
| `CREATE TYPE` | `GoodsReceiptStatus`, `PurchaseReturnStatus`, `SupplierInvoiceStatus`, `GstTreatment` |
| `ADD COLUMN` × 40 | suppliers, warehouses, purchase orders and their lines |
| `CREATE TABLE` × 5 | receipts, receipt lines, returns, return lines, supplier invoices |
| CHECK constraints × 22 | see below |
| `INSERT` × 2 | the two new document sequences |

**No table dropped, no column removed, no data reset, no
historical stock movement deleted.** Verified against the
development database: 155 ledger rows and 19 products before and
after, zero reconciliation drift.

### The constraints worth naming

- **the tax split must match the treatment** — intra-state means
  CGST and SGST and no IGST; inter-state means IGST and neither of
  the others. A row with both is a calculation bug refused at
  write time rather than discovered on a return;
- **`taxTotal = cgst + sgst + igst`** and
  **`grandTotal = taxable + tax + otherCharges`**;
- **`lineTotal = taxableValue + taxAmount`** and
  **`taxableValue = gross − discount`**, and a discount may not
  exceed the line it discounts;
- **`receivedQuantity = accepted + damaged`** on a receipt line,
  with rejected deliberately excluded;
- **rejecting stock requires a reason** (non-blank);
- **approval, posting, cancellation and closure are
  all-or-nothing with their attribution** — no `approvedAt`
  without an `approvedById`;
- **a state code is exactly two digits**;
- **one invoice number per supplier**, unique.

The last of these caught a stale fixture in the step-2 integrity
suite immediately: it created a purchase order line of ten boxes
at ₹62 with a `lineTotal` of 100. The database refused it, which
is the constraint working.

---

## 14. Test report

`npm run test:purchase` — **126 checks, all passing**, on
`devyora_erp_purchase_test`, dropped and rebuilt from the same
migrations and seed on every run.

Every figure is read back from the database: "the service returned
a receipt" is never taken as evidence that stock moved. Checks
that could be true of zero rows assert the count first.

| Brief's case | | |
|---|---|---|
| 1–3 | supplier create, update, search | ✓ |
| 4–6 | PO creation, multiple SKUs, draft editing | ✓ |
| 7 | PO approval | ✓ |
| 8 | invalid transition rejected | ✓ |
| 9 | cancellation before receipt | ✓ |
| 10 | **cancellation refused after receipt** | ✓ |
| 11–13 | partial, multiple and full GRN | ✓ |
| 14 | excess quantity rejected | ✓ |
| 15 | damaged and rejected goods | ✓ |
| 16 | stock inward on finalisation | ✓ |
| 17–18 | **no stock movement on PO creation or approval** | ✓ |
| 19–20 | duplicate GRN, idempotent retry | ✓ |
| 21 | **failed GRN rolls back whole** | ✓ |
| 22 | warehouse validation | ✓ |
| 23 | supplier invoice references | ✓ |
| 24–26 | GST: arithmetic, intra-state, inter-state | ✓ |
| 27 | document numbering under concurrency | ✓ |
| 28 | supplier returns | ✓ |
| 29 | append-only ledger still protected | ✓ |
| 30 | audit log correctness | ✓ |
| 31 | concurrent receipts, no lost update | ✓ |
| 32 | inventory reconciliation after receipt | ✓ |
| 33–36 | inventory, Product Master, import, frontend regressions | ✓ |

### Every suite

| Suite | |
|---|---|
| `npm run test:data` | 37/37 |
| `npm run test:product-master` | 92/92 |
| `npm run test:import` | 83/83 |
| `npm run test:inventory` | 86/86 |
| `npm run test:purchase` | **126/126** |
| `npm run db:verify` | 41/41 |
| `npm run test:frontend` | 57/57 |
| **total** | **522** |

**The development database was watched throughout** and is
unchanged: 155 ledger rows, 19 products, 0 purchase orders, zero
reconciliation drift, before and after the full run.

### Assertions updated rather than relaxed

Four older checks described the step-5 world:

- the module count, fifteen → eighteen → **twenty-four**;
- `/purchase` → "Purchase Management", now the seven screens;
- "the nav never scrolls", now "the active module is visible";
- the integrity suite's purchase order fixture, which needed a GST
  treatment and line arithmetic that adds up.

### Two bugs the tests found in my own work

- **The order status summed across lines**, so an over-receipt on
  one line could mask a line that never arrived. Now per line.
- **A test deleted the supplier it was about to use.** The check
  "a supplier cannot be deleted" ran before that supplier had any
  history, so nothing referenced it, the foreign key never fired,
  the delete *succeeded* — and the check passed anyway because it
  asserted something else. Every later step then failed with "No
  such supplier". The probe now runs where the restriction
  actually applies, and asserts its own result.

---

## 15. API

| | |
|---|---|
| `GET/POST /api/suppliers`, `GET /api/suppliers/options` | list, create |
| `GET/PATCH /api/suppliers/:id`, `GET …/history` | read, edit, trade history |
| `POST /api/suppliers/:id/active` | activate / deactivate. **No DELETE exists** |
| `GET/POST /api/purchase-orders` | list, raise |
| `GET/PATCH /api/purchase-orders/:id` | read, edit (draft only) |
| `POST …/submit`, `…/approve`, `…/return-to-draft`, `…/cancel`, `…/close` | the lifecycle |
| `GET …/receivable` | what is still outstanding |
| `GET/POST /api/goods-receipts` | list, **post a receipt — the one route that increases stock** |
| `GET /api/goods-receipts/:id`, `POST …/cancel` | read, cancel a draft |
| `GET/POST /api/purchase-returns`, `GET …/eligibility` | list, post, how much may go back |
| `GET/POST /api/supplier-invoices`, `POST …/:id/status` | list, record, match or dispute |
| `GET /api/dashboard`, `GET /api/history` | the dashboard and the timeline |

Refusals carry their figures:

```json
{ "error": { "code": "CONFLICT",
  "message": "Order PO-2026-0002 cannot be cancelled: 2 goods receipt(s) …",
  "details": { "postedReceipts": 2, "receivedQuantity": "100.000",
               "useInstead": "close" } } }
```

---

## 16. Known limitations

**Of this phase, by design:**

1. **Authentication is a development placeholder** (`x-erp-user`).
   Permission checks are real and read the seeded role tables, but
   identity is not verified. **The API must stay on localhost.**
2. **Purchase requisition is not implemented** — no requisition
   model exists in the schema and the brief made it conditional on
   one. The lifecycle starts at `DRAFT`.
3. **Reverse charge GST is not implemented.** An unregistered
   supplier's purchase carries no GST on the document; where
   reverse charge applies it is an accounting entry, out of this
   phase.
4. **No accounting ledger, no payments, no supplier ageing.**
   Invoices are tracked and matched; nothing is posted to accounts
   and nothing is paid.
5. **Inventory valuation is still unchosen** (step 5's open
   decision). Unit cost is captured on every receipt movement,
   which is what FIFO, weighted average and standard cost all
   need.
6. **The purchase history timeline is assembled from four
   bounded queries** and truncates a very long history. The screen
   says so when it does.
7. **One GSTIN per supplier.** A supplier registered in several
   states needs a row per registration today.
8. **The HSN → GST rate table covers tiles, stone and sanitary
   ware.** An unrecognised HSN refuses the line and asks for the
   rate rather than guessing.

**Pre-existing, unchanged, reported not fixed** (outside step 6's
scope):

9. `prisma/seed.mjs` **appends its demo stock movements every
   run**, so re-seeding shifts the demo figures rather than
   restoring them. Demo data only.
10. The extra movements `db:verify` wrote into the development
    database before step 5 corrected its isolation **cannot be
    removed** — the ledger is append-only. They reconcile.
11. **Google Drive `invalid_grant`** — unrelated to the ERP;
    reconnect at `drive-connect.html`.
12. **`frontend/privacy-policy.html` §11 still reads
    `REPLACE-WITH-YOUR-CONTACT-EMAIL`** and is live.
13. The Google console App name and publishing status are still
    unset.

No secrets, keys or credentials appear in any file added by step
6, and no extraction, Gemini, Drive or Sheets code was touched.

---

## 17. Branch

| | |
|---|---|
| Branch | `claude/seed-feminine-404-fix-aq50lk` |
| Base at start | `f4390d51` (step 5) |
| **Merged into `main`** | **no** |

Step 7 — Sales Management — has not been started.
