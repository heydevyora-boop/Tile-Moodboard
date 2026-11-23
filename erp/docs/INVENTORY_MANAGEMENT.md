# Inventory Management & the Append-Only Stock Ledger — step 5

Warehouses, movements, reservations, damage, transfers and
reconciliation, on top of the stock ledger step 2 created.

**Nothing in the catalogue extraction system was changed.** No
Gemini prompt, no scanner, no Drive integration, no Sheets
workflow, no extraction script. **No existing table, trigger or
constraint was recreated**: step 5 is additive to step 2's
foundations. **Step 4's import engine still passes, unchanged.**
**Nothing was merged into `main`.**

---

## 1. What step 2 already built, and was reused as-is

Step 5 inspected the existing structures before writing anything.
These were found working and were **not** rebuilt:

| | Where | Reused |
|---|---|---|
| `stock_ledger_entries` | step-2 migration | yes |
| `inventory_balances` | step-2 migration | yes |
| Append-only triggers (UPDATE / DELETE / TRUNCATE) | `20261120161600_append_only_guards` | yes |
| `erp_refuse_mutation()` | same | yes |
| Idempotency key, unique | same | yes |
| `SELECT … FOR UPDATE` row lock | `db/stock.mjs` | yes |
| `v_inventory_reconciliation` | same | extended |
| Gap-free `entryNo` sequence | same | yes |
| Document number sequences | `document_sequences` | yes |

What was **missing** and had to be added:

- the **previous** balance on each entry (only the resulting one existed);
- **damaged** and **in-transit** as dimensions of their own;
- **reservation** movement types;
- the **transfer lifecycle** (the table existed; nothing drove it);
- warehouse create / edit / activate / deactivate;
- rejection of movements against an inactive warehouse;
- the inventory screens, which were still on demo data.

---

## 2. The one road in

```
    screen ─▶ route ─▶ inventory.service ─┐
                                          ├─▶ db/stock.mjs ─▶ PostgreSQL
    screen ─▶ route ─▶ warehouse.service ─┘      postStockMovement()
```

`postStockMovement()` in `db/stock.mjs` is the **only** code in this
system that writes `stock_ledger_entries` or `inventory_balances`.
No route, no controller and no frontend component writes a balance,
and test **14a/14b** greps the whole server and database layer on
every run to prove it — the only other file permitted to touch a
balance is `prisma/seed.mjs`, which is building a starting position
rather than recording a movement.

Twelve numbered steps, in one transaction:

1. validate the movement type
2. validate the quantity (always positive; direction comes from the type)
3. validate the product
4. validate the warehouse — **refused if inactive**
5. insert the balance row if this is the first movement (`ON CONFLICT DO NOTHING`)
6. `SELECT … FOR UPDATE` — the row lock
7. compute before and after for **all three dimensions**
8. reject negative physical, reserved, damaged **and available**
9. write the immutable ledger entry (a duplicate key becomes `DuplicateMovementError`)
10. update the projection
11. **read it back and verify it**
12. return `{ entry, sku, before, after }`

### Reversal, not deletion

There is no `REVERSAL` movement type, deliberately. A reversal **is
the opposite movement**, carrying `reversalOfEntryId`. The original
stays on the stock card beside its correction, which is what a
ledger is for. Tests 12a–12d.

---

## 3. The five balances

| Figure | Meaning | Part of on-hand? |
|---|---|---|
| **physical / on hand** | boxes in the building | — |
| **reserved** | committed to a confirmed order | **yes** |
| **damaged** | present but not sellable | **yes** |
| **in transit** | left another warehouse, not yet received | **no** |
| **available** | `onHand − reserved − damaged` | derived, never stored |

Two decisions worth stating:

**Damage is not a write-off.** A broken box is still a box in the
warehouse, and pretending otherwise makes the stock-take disagree
with the system. Marking stock damaged reduces what can be sold and
not what is there. Writing it off is an `ADJUSTMENT_DECREASE`, which
is a separate decision with its own reason. Tests 7a–7d.

**Available, not physical, is the default policy.** The database
enforces `onHand − reserved − damaged >= 0`. Without it a
reservation could promise stock that is already broken, and the
system would confirm an order for boxes nobody can ship. Tests
6d–6f.

---

## 4. The transfer lifecycle

```
    DRAFT ──dispatch──▶ IN_TRANSIT ──receive──▶ COMPLETED
      │                      │
      └──────cancel──────────┴──▶ CANCELLED
```

**One logical reference, two linked movements.** Both the
`TRANSFER_OUT` at the source and the `TRANSFER_IN` at the
destination carry `referenceType = WAREHOUSE_TRANSFER` and the
transfer's own id as `referenceId`. They are not two unrelated
movements that happen to be the same size:
`v_transfer_reconciliation` joins them on that reference and reports
any transfer whose two sides disagree.

**In transit is held against the destination**, because that is
where the stock is going and where somebody will count it. It is
deliberately not part of either warehouse's on-hand, because a lorry
is not a shelf and nobody can pick from it. So:

> **company physical stock = Σ on hand + Σ in transit**

and this figure is **constant at every step of a transfer**: on
dispatch the source's on-hand falls and the destination's in-transit
rises by the same amount; on receipt the reverse. Nothing is ever
counted in two places. Tests 11c–11e, 11j–11l, 11q.

| Transition | What happens |
|---|---|
| dispatch | `TRANSFER_OUT` at source; destination's in-transit up; attributed |
| receive | `TRANSFER_IN` at destination; in-transit down; attributed |
| cancel from DRAFT | nothing had moved; the draft closes |
| cancel from IN_TRANSIT | `TRANSFER_IN` **at the source** — the lorry turned round |
| cancel from COMPLETED | **refused.** Send it back as a new transfer; that is what would actually happen |

A receipt uses `allowInactiveWarehouse`, so stock already on a lorry
can always be received even if the destination has since been
deactivated. Refusing it would strand the stock in transit, counted
nowhere anybody can act on.

Dispatch and receipt each record **who**, separately. A transfer one
person can both dispatch and receive unnoticed is not a control, and
a database CHECK refuses a dispatch or receipt with nobody's name on
it.

### A bug this found

The first version of `v_transfer_reconciliation` called a
`CANCELLED` transfer balanced only when nothing had ever been
dispatched or received. That is true of a transfer cancelled as a
draft and **wrong** for one cancelled in transit, whose return leg
legitimately makes dispatched equal received. The view reported
every such cancellation as unaccounted-for stock — the worst kind of
false alarm, because it trains people to ignore the reconciliation
report. Found by the lifecycle test; fixed in migration
`20261121150000_transfer_reconciliation_cancelled`, which also adds
`received_at_destination` and `returned_to_source` so the two cases
are distinguishable.

---

## 5. Concurrency and idempotency

**Idempotency.** Every movement carries a key, unique in the
database. The forms mint one when the dialog opens and replace it
only once a movement is accepted, so pressing Save twice posts once
and a corrected resubmission is genuinely a new movement. A
duplicate is answered `409 DUPLICATE_MOVEMENT`, not a 500. Tests
4a–4d.

**Concurrency, tested with real simultaneous transactions.** Test 5
fires ten concurrent movements at the same product and warehouse.
All ten must be accepted, the balance must move by exactly ten, and
— the check that actually matters — **no two may record the same
resulting balance**. Two entries claiming the same `balanceAfter`
would mean two transactions read the same row and one overwrote the
other: the classic lost update, invisible in the total and fatal to
the stock card. Tests 5a–5d.

---

## 6. Reconciliation reports; it never repairs

`GET /api/inventory/reconciliation` re-derives every balance from
the ledger that produced it, across on-hand, reserved and damaged,
and compares both sides of every transfer. It reports:

- balances that have drifted from their ledger;
- negative balances (which a CHECK should make impossible);
- movements with no balance row;
- transfers whose two sides disagree;
- documents quoted more than once — **for information, not a
  failure**: a purchase order received in two deliveries
  legitimately appears twice.

**There is no "fix it" button, and there is not going to be.** A
silent repair makes the numbers agree and destroys the only evidence
of what went wrong; the next time it happens nobody knows it is the
second time. A discrepancy is a question for a person, and the
answer is an authorised adjustment with a reason on it, which leaves
both the error and the correction on the record.

### Two different faults that both read as "the number is wrong"

Test 13 forces a discrepancy and proves the distinction:

- **A miscount.** Ledger and projection agree with each other and
  disagree with the shelf. An adjustment is exactly right: it moves
  both, and the reason records why.
- **A corrupted projection.** The ledger is correct and the running
  total beside it is not. An adjustment moves **both** sides by the
  same amount, so the gap survives it untouched (test 13g asserts
  precisely this). The remedy is to re-derive the projection from
  the ledger, by hand, by somebody who has first worked out how it
  drifted.

Conflating the two is how a reconciliation report becomes
decorative.

---

## 7. Valuation — not chosen, and not invented

**No valuation method has been selected, and step 5 did not pick
one.** This is a decision for the studio and its accountant, not for
the software.

| Method | Means | Suits |
|---|---|---|
| **FIFO** | the oldest boxes are the ones issued | tiles bought in distinct batches at moving prices; matches how stock physically rotates |
| **Weighted average** | one running average cost per product | simplest to explain and to audit; smooths price swings |
| **Standard cost** | a fixed planned cost, with variances posted separately | useful when purchase prices swing and margin analysis matters more than exactness |

They give **three different answers for the same stock**, so a
figure labelled "value" that nobody can reproduce is worse than no
figure at all.

What was done instead:

- **`unitCost` and `valueAmount` are recorded on every movement**,
  which is everything all three methods need and which cannot be
  reconstructed later if it is not captured now (test 16c);
- the prototype's "Stock value" KPI, which multiplied boxes by the
  product's current purchase price — a guess — **was removed** from
  the Inventory screen and the Dashboard;
- tests 16a and 16b assert that no API response carries a stock
  value, so nothing can quietly start inventing one.

Once the method is chosen, it is a valuation service reading the
ledger. No stored figure has to be migrated, because none was
invented.

---

## 8. The screens

All eight are marked **live** in the sidebar and read and write the
real ERP database. Nothing on them is demo data.

| Screen | Path | What it is |
|---|---|---|
| Inventory / Stock | `/inventory` | every balance, warehouse by warehouse, with reserved / damaged / in-transit / sellable |
| Stock Inward | `/inward` | the ledger read in the IN direction, with a working receipt form |
| Stock Outward | `/outward` | the same ledger read the other way |
| Stock Adjustments | `/adjustments` | every correction and its reason — the stock-count history |
| Stock Ledger | `/ledger` | the record itself; `?sku=` makes it a stock card |
| Warehouses | `/warehouses` | create, edit, activate, deactivate, per-warehouse stock |
| Warehouse Transfers | `/transfers` | the lifecycle, with both sides reconciled |
| Stock Reconciliation | `/reconciliation` | the report above |

The Dashboard's two stock figures are live; the rest of that screen
is still demo data, which the sidebar marks.

**Warehouses is no longer a placeholder.** Through step 4 it listed
four open questions, because the brief itself flagged that the
workflow was unsettled. Step 5 answers them:

| Question it asked | Answer |
|---|---|
| separate stock per location, or one figure with a breakdown? | separate, per product per warehouse |
| is a transfer one movement or a pair? | a pair, on one transfer reference |
| while in transit, who owns it? | the destination, as in-transit, sellable by neither |
| can an order draw from more than one location? | out of scope until Sales Management; the data supports it |

### What is refused, and why

- **A warehouse is never deleted.** One with movements against it
  cannot be removed without orphaning the entries that explain where
  the stock went. There is no delete endpoint and no delete button.
- **A warehouse still holding stock cannot be deactivated.** Once
  deactivated it accepts no movements at all, including the one that
  would empty it, so the stock would be stranded. The error says so,
  with the figure.
- **A warehouse code cannot change once the ledger quotes it.**
- **Opening stock can be set once.** A second one is a correction
  and must be posted as an adjustment. Enforced in the service *and*
  by a partial unique index (tests 9a–9c).

---

## 9. The API

Mounted at `/api/inventory` and `/api/warehouses`.

| | |
|---|---|
| `GET /api/inventory` | balances, with filters, sorting and paging |
| `GET /api/inventory/totals` | company-wide, from `v_company_stock` |
| `GET /api/inventory/dashboard` | totals, what needs ordering, recent movements, reconciliation status |
| `GET /api/inventory/ledger` | the stock card, filterable by product, warehouse, type, direction, reason, document, person, date range |
| `GET /api/inventory/reconciliation` | the report |
| `POST /api/inventory/opening` | opening stock, once |
| `POST /api/inventory/inward` · `/outward` | receipts and issues |
| `POST /api/inventory/adjustments` | direction + **mandatory** reason |
| `POST /api/inventory/reservations` · `/release` | commit and release |
| `POST /api/inventory/damage` · `/recover` | condemn and un-condemn |
| `POST /api/inventory/ledger/reverse` | the opposite movement, linked |
| `GET/POST/PATCH /api/warehouses…` | list, open, create, edit, per-warehouse stock |
| `POST /api/warehouses/:id/active` | activate / deactivate. **No DELETE exists.** |
| `GET/POST /api/warehouses/transfers…` | list, raise, open, dispatch, receive, cancel |

Refusals are answers, not faults, and each carries its figures:

```json
{ "error": { "code": "INSUFFICIENT_STOCK",
  "message": "Not enough available stock for DV-1001: 272 available, 274 requested.",
  "details": { "dimension": "available", "available": 272, "requested": 274 } } }
```

`db/stock.mjs` knows nothing about HTTP — deliberately, so it can be
called from a script or a test with no Express in sight — so
`app.mjs` translates its three refusals by name, from a closed list.
"Any error carrying a status" would eventually let a Prisma error
through, and those carry table names, column names and sometimes
values.

---

## 10. Security — the open limitation

**The inventory API is not public and must not be made public.**

- The server binds to `127.0.0.1` (`ERP_API_HOST`, default
  `127.0.0.1`).
- CORS allows only the two localhost development origins, listed
  explicitly rather than reflected.
- **Authentication is still the step-3 development placeholder**: an
  `x-erp-user` header resolving a real user from the database. It is
  labelled as a placeholder in the code and here.

Every service takes an actor and writes it to the audit log, so when
real sign-in is built it replaces one middleware and nothing
downstream changes. **Until it exists, nothing on these routes may
be exposed to the internet**, and the binding to localhost is what
currently enforces that.

No secrets, keys or credentials appear in any file added by step 5.

---

## 11. Migrations added

Both additive. No table was dropped, no column removed, no data
reset.

| | |
|---|---|
| `20261121134143_inventory_damage_reservation_transit` | `balanceBefore`, `reservedAfter`, `damagedAfter`, `quantityDamaged`, `quantityInTransit`, transfer attribution columns; backfill; CHECKs; the one-opening unique index |
| `20261121134500_inventory_reconciliation_views` | `v_inventory_reconciliation` across three dimensions, `v_company_stock`, `v_transfer_reconciliation` |
| `20261121150000_transfer_reconciliation_cancelled` | the cancelled-transfer fix described in §4 |

### The one place the append-only trigger was disabled

Filling in `balanceBefore` for rows written before the column
existed. It runs with the trigger off for **exactly one statement**
and switches it back on immediately. This is not changing what a row
says: every quantity, direction, date and reference is untouched,
and the value written is derived arithmetically from the row itself,
so a reviewer can recompute it and get the same answer. Verified
afterwards: all 116 existing rows arithmetically consistent, zero
reconciliation drift, development data intact.

---

## 12. Tests

`npm run test:inventory` — **86 checks, all passing**, on
`devyora_erp_inventory_test`, which the suite drops and rebuilds
from the same migrations and the same seed on every run, so nothing
accumulates between runs and no assertion can quietly start
measuring the last run's leftovers.

| | |
|---|---|
| 1 | the right database, isolated |
| 2 | the ledger and audit log cannot be updated, deleted or truncated |
| 3 | every entry carries before and after, and the arithmetic holds |
| 4 | idempotency |
| 5 | ten real concurrent transactions, and no lost update |
| 6 | negative stock refused in every dimension |
| 7 | damage is not a write-off |
| 8 | no correction without a reason |
| 9 | opening stock once only |
| 10 | warehouses closed, never deleted |
| 11 | the transfer lifecycle, and the invariant total |
| 12 | reversal, not deletion |
| 13 | reconciliation reports and does not repair |
| 14 | nothing but the stock service writes a balance |
| 15 | the screens show what is really there |
| 16 | no valuation method was invented |

Every earlier suite re-run and passing:

| Suite | |
|---|---|
| `npm run test:data` | 36/36 |
| `npm run test:frontend` | 50/50 |
| `npm run test:product-master` | 92/92 |
| `npm run test:import` | 83/83 |
| `npm run db:verify` | 41/41 |
| `npm run test:inventory` | 86/86 |
| **total** | **388** |

Three assertions in the older suites were updated rather than
relaxed: the module count (fifteen → eighteen), "Warehouses is still
marked planned" (it is now live), and an import check that asserted
an absolute ledger count on a shared database — rewritten as a
before-and-after delta, which is what it was actually trying to
prove.

### A defect this found: `db:verify` was writing to the development database

Counting the development ledger before and after each suite turned
up thirteen new rows per run of `npm run db:verify`, with keys like
`test:race:…`, `test:sample:…` and `test:idempotency:…`.

`test/db_integrity_test.mjs` imported `db/client.mjs` at the top of
the file. That module reads `ERP_DATABASE_URL` **once, at import
time**, and `.env` points at `devyora_erp_dev`, so the suite had
never been redirected anywhere — every other suite calls
`useTestDatabase()` first, and this one did not. It had been
posting movements into the demo catalogue on every run since step
2, which is why the demo stock figures had been quietly drifting.

Fixed: it now redirects to `devyora_erp_integrity_test` and imports
`db/client.mjs` **dynamically**, after the redirect. Verified by
running all six suites and watching the development ledger stay at
155 rows with zero reconciliation drift.

**The rows already written cannot be taken out.** The ledger is
append-only and the database refuses a `DELETE` — which is the
guarantee that very suite exists to prove. They remain, they
reconcile, and nothing writes there again. They are demo movements
in a demo database; if the studio wants the demo catalogue back to
a clean starting position, that is a rebuild of the development
database from the seed, which is a decision to take deliberately
rather than something to do quietly here.

### A related wart, left alone

`prisma/seed.mjs` is idempotent for products, brands and
warehouses, but **appends its demo stock movements every time it
runs**. Re-seeding therefore shifts the demo figures rather than
restoring them. That is pre-existing, it affects demo data only,
and changing the seed was outside step 5's scope — recorded here
rather than fixed.

---

## 13. Out of scope, deliberately

Not started: Purchase Management, Sales Management, the ERP→CASA
integration, website stock synchronisation. The reservation
movements exist so that Sales Management has something to call; no
sales code was written.
