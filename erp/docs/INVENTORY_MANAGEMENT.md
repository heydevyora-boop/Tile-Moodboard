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
| receive (full or partial) | `TRANSFER_IN` at destination for accepted+damaged; `DAMAGE` for the damaged part; `TRANSFER_LOSS` for any quantity written off as missing; in-transit down by exactly what was just resolved; attributed. **Phase 4.1 — see §14.** |
| cancel from DRAFT | nothing had moved; the draft closes |
| cancel from IN_TRANSIT, nothing yet received | `TRANSFER_IN` **at the source** — the lorry turned round |
| cancel from IN_TRANSIT, something already received | **refused.** Phase 4.1 — see §14 |
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
| `POST /api/warehouses/transfers/:id/receive` | **Phase 4.1**: body is `{ lines: [{ transferLineId, acceptedQuantity?, damagedQuantity?, missingQuantity?, missingReason?, remarks? }] }` — see §14 |

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

**Phase 4.1 re-examined this and reached the same conclusion,
deliberately.** `stock:read` is a real permission — the seed assigns
it to roles — but no `GET` route in `inventory.mjs` or
`warehouses.mjs` checks it, confirmed directly by grep and by test
18b/18c. This was **not** closed in Phase 4.1. `req.actor` is still
resolved from the `x-erp-user` header, which anyone who can reach the
port can set to anything; adding a permission check on top of that
identity would check a permission against nobody-knows-who and look
like security while providing none. The only thing actually standing
between this API and the internet is `ERP_API_HOST=127.0.0.1`. Fixing
this properly means real authentication, which Phase 4.1 was
explicitly told not to build (and did not).

---

## 11. Migrations added

Both additive. No table was dropped, no column removed, no data
reset.

| | |
|---|---|
| `20261121134143_inventory_damage_reservation_transit` | `balanceBefore`, `reservedAfter`, `damagedAfter`, `quantityDamaged`, `quantityInTransit`, transfer attribution columns; backfill; CHECKs; the one-opening unique index |
| `20261121134500_inventory_reconciliation_views` | `v_inventory_reconciliation` across three dimensions, `v_company_stock`, `v_transfer_reconciliation` |
| `20261121150000_transfer_reconciliation_cancelled` | the cancelled-transfer fix described in §4 |
| `20261128090000_transfer_partial_receipt` | **Phase 4.1.** `acceptedQuantity`/`damagedQuantity`/`missingQuantity` on `warehouse_transfer_lines`; `inTransitAfter` (nullable) on `stock_ledger_entries`; `TRANSFER_LOSS`/`TRANSFER_LOSS_REVERSAL` added to `StockMovementType`; `TRANSFER_LOSS` added to `StockMovementReason`; backfill + CHECKs — see §14 |
| `20261128090500_transfer_reconciliation_partial_receipt` | **Phase 4.1.** `v_transfer_reconciliation` rebuilt to tolerate a legitimate partial receipt and to account for a transfer loss — see §14. Split from the migration above for the same reason `20261121134500` was split from `20261121134143`: Postgres refuses to use a new enum value in the transaction that adds it |

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

`npm run test:inventory` — **124 checks, all passing** (86 from step
5, 38 added by Phase 4.1), on `devyora_erp_inventory_test`, which the
suite drops and rebuilds from the same migrations and the same seed
on every run, so nothing accumulates between runs and no assertion
can quietly start measuring the last run's leftovers.

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
| 17 | **Phase 4.1** — partial receipt, accumulating accepted/damaged, missing with a mandatory reason, outstanding calculation, invalid combinations and over-receipt refused outright, duplicate line refused, cancellation refused once anything is resolved (and still allowed when nothing is), reconciliation tolerates a legitimate partial receipt, two concurrent receipts that together would over-receive leave exactly one standing |
| 18 | **Phase 4.1** — `stock:read` is a real, seeded permission that no route checks; confirmed by direct inspection, not by one person's memory of the code |

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

**Phase 4.1 re-ran `test:inventory` (124/124), `test:purchase`
(126/126) and `test:sales` (95/95)** — the two latter suites exist
only because of work between step 5 and Phase 4.1, and both exercise
`postStockMovement()` through Goods Receipt and sales dispatch, so
they are the most direct check that extending `db/stock.mjs` with the
`inTransit` dimension and `TRANSFER_LOSS` left every existing
movement type's behaviour untouched. Also re-run clean:
`test:product-master` (92/92), `test:hierarchy` (29/29), `test:api`
(61/61), `test:data` (38/38), `test:import` (85/85).

**The concurrency fix's own closure pass went further and actually
stood up a live dev server, API and browser** (`npm run api` +
`npm run dev`, against a disposable database, never the development
one) to run `test:frontend` (66/66) and a dedicated Transfers-page
Playwright script that drives the partial-receipt form itself —
accepted, damaged and missing dispositions, the mandatory missing
reason, over-receipt refused client-side, the duplicate-submit guard
— all through actual clicks and typed input, 19/19. Plus the new
`test/transfer_concurrency_test.mjs` (21/21) — see "Concurrency: the
transfer row is locked first" above.

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

*(Purchase Management and Sales Management were in fact built in the
two phases between step 5 and Phase 4.1; this paragraph is left as
written at the time, rather than silently edited, since fixing it is
outside Phase 4.1's own scope. See `docs/` for whatever those phases
documented.)*

---

## 14. Phase 4.1 — partial transfer receipt, damage and loss

A full audit against a separate 16-section brief found the inventory
system already built here covering every one of its sections, with
exactly two gaps: a transfer could only be received all at once, and
`stock:read` was a defined permission nothing checked. This phase
closes the first and re-examines the second. **No new inventory
system, no duplicate model, no new authentication.** Everything below
extends the same `postStockMovement()` choke point, the same ledger,
the same projection.

### The problem with all-or-nothing receipt

The original `receiveTransfer()` always recorded the full dispatched
quantity as received, in one call, with nothing to record if a lorry
arrived with some boxes short or some broken. Real receiving does not
work that way.

### The model: three running totals, not one

`warehouse_transfer_lines` gains `acceptedQuantity`, `damagedQuantity`
and `missingQuantity`, following the Goods Receipt Note's own
convention exactly rather than inventing a second one:

```
receivedQuantity = acceptedQuantity + damagedQuantity      (CHECK)
acceptedQuantity + damagedQuantity + missingQuantity <= quantity   (CHECK)
```

**Accepted and damaged both arrive physically** — a broken box is
still a box in the building, and a stock-take would still count it —
so both post one `TRANSFER_IN` for their combined quantity, exactly
like a goods receipt. Damaged is then condemned separately with its
own `DAMAGE` entry and its own reason, so physical stock matches the
shelf while available stock excludes what nobody can sell.

**Missing never arrives, and never posts a `TRANSFER_IN`.** It posts
exactly one new movement type, `TRANSFER_LOSS` — decrementing the
destination's in-transit balance (where the dispatch put it) through
the ordinary `postStockMovement()` path, with a reason **mandatory**
on the call, never inferred or defaulted. `db/stock.mjs` gained one
new dimension (`inTransit`, alongside physical/reserved/damaged) and
one new "after" column on the ledger (`inTransitAfter`, nullable —
every entry **before** this phase never recorded it, because nothing
wrote it through the ledger before now, and backfilling a figure
nobody measured would be a claim, not a fact). `TRANSFER_LOSS` has a
real opposite, `TRANSFER_LOSS_REVERSAL`, so a write-off can be
corrected the same way every other movement is: by posting the
opposite, never by editing the original.

**There is no automatic loss or damage adjustment anywhere in this
phase.** Every accepted, damaged and missing quantity is a number a
person typed into a specific receipt call, with damage additionally
requiring a per-line `remarks` convention (matched on the `DAMAGE`
entry) and missing requiring `missingReason` enforced before anything
is posted.

### Repeatable, never resetting

`receiveTransfer(id, { lines }, actor)` can be called as many times as
a transfer needs. Each call's quantities are **what this pass is
resolving**, not a running total the caller has to track — the
service recomputes outstanding from the line's own stored totals
(`quantity - accepted - damaged - missing`) and refuses outright, with
no override, if a call would resolve more than is still outstanding.
A transfer only becomes `COMPLETED` once every line has nothing left
outstanding; until then it correctly stays `IN_TRANSIT`, because some
of it genuinely still is.

### Cancellation after partial resolution

Phase 4.1 adds one guard: a transfer cannot be cancelled once **any**
quantity on any line has been accepted, damaged or written off.
Reversing a cancellation that undoes stock already counted somewhere
is a real workflow this phase was explicitly told not to invent
(§2 of the brief: no new automatic adjustments, and no override). A
transfer nothing has yet been received against is exactly as
cancellable as before.

### Reconciliation

The old `v_transfer_reconciliation` required an `IN_TRANSIT` transfer
to have `received = 0` — true before partial receipt existed, and a
guaranteed false alarm the moment it did. The view is rebuilt (own
migration, same reason the enum-adding migration before it was split
from its own view) to treat an `IN_TRANSIT` transfer with some, but
not all, of its dispatched quantity resolved as balanced, and to fold
a `TRANSFER_LOSS` quantity into the completed/cancelled invariant:
`dispatched = received + missing`.

### Concurrency: the transfer row is locked first, in both directions

A verification pass tested the concurrent cancel-and-receive case
directly rather than reasoning about it, and found that the
in-transit CHECK did **not** always backstop it: of five real
concurrent trials, two produced a genuinely corrupted business state
(10 units counted as both returned to the source and received at the
destination — the same dispatched quantity, physically duplicated),
caught after the fact by the reconciliation report but not prevented.
Which of the two outcomes happened depended on which transaction
reached the destination warehouse's `inventory_balances` row first —
a race, not a guarantee.

**Fixed.** `receiveTransfer()` and `cancelTransfer()` both now take a
`SELECT ... FOR UPDATE` lock on the `warehouse_transfers` row itself
— as the very first statement inside their transaction, before
reading anything that decides whether the call is valid. Each then
re-reads the transfer's current status and every line's resolved
quantities from *inside* that lock, and re-runs the same validation
that always existed (status must be `IN_TRANSIT`, nothing already
resolved for a cancel, outstanding not exceeded for a receive) against
that fresh read — never against the plain, unlocked read taken before
the transaction opened. This is the same row-lock idiom
`postStockMovement()` already uses on `inventory_balances`, applied
to the one row every lifecycle operation on a transfer now serializes
through.

`test/transfer_concurrency_test.mjs` exercises this directly rather
than trusting the reasoning: 30 iterations of cancel-vs-receive in
each array order (60 total), 30 of two simultaneous partial receipts,
30 of two simultaneous full receipts, plus repeated deterministic
checks of over-receipt refusal and cancellation-after-partial/damaged/
missing. Across all of it: both sides never both succeed, the loser
always gets the existing named `ConflictError` (409) rather than a
raw database exception, and a closing pass of
`reconciliationReport()` plus direct queries for duplicate
idempotency keys, negative balances and over-resolved transfer lines
all come back clean. The two-receives-over-receiving case (test 17ae
in `inventory_test.mjs`) is additionally still backstopped by the
`transfer_line_resolved_not_over_dispatched` CHECK as defense in
depth, but is no longer the *only* thing standing between a race and
a corrupted balance.

**Closed, as a follow-up.** `dispatchTransfer()` now takes the same
lock, re-reading and re-validating status (must still be `DRAFT`)
from inside it before posting anything, exactly like the other two.

This pairing is not "exactly one must win" the way cancel-vs-receive
is: `cancelTransfer()` has no failure mode reachable from either
`DRAFT` or an untouched `IN_TRANSIT`, so it always succeeds in this
race — either closing a still-genuinely-`DRAFT` transfer outright, or
(when dispatch won the lock first) legitimately reversing the
dispatch that just happened, the same path a user clicking Dispatch
and then Cancel in quick succession would hit. Both are correct,
pre-existing behaviour. What the lock actually guarantees is the one
thing that would be wrong: dispatch never moves stock on a transfer
`cancelTransfer()` has already closed from `DRAFT` — confirmed
directly, not assumed, by 60 trials across both array orders in
`test/transfer_concurrency_test.mjs` (29 dispatch-then-cancelled, 31
cancelled-from-draft, 0 of the unsafe case), with company-wide AND
per-warehouse stock checked back to exactly its starting point after
every trial.

### `stock:read` — re-examined, not closed

See §10. The permission is real and seeded; no route checks it; this
is unchanged by design, because the only identity available
(`x-erp-user`) is not something a permission check can meaningfully
be enforced against. Tests 18a–18d assert this directly rather than
describe it from memory.

### What this phase did not touch

No CASA catalogue code. No Google Drive/Sheets workflow. No new
authentication. No production data. No merge to `main` — everything
here is on `claude/seed-feminine-404-fix-aq50lk`, same as every phase
before it.

### The Transfers screen's Receive dialog (closure pass)

The first cut of this phase kept Receive a one-click full accept,
deliberately, because nothing in the original brief asked for a
discrepancy-entry screen. The closure pass built it anyway, once
asked for: Receive is now a per-line form showing dispatched,
previously accepted/damaged/missing and outstanding (every figure
read straight off the API, never recomputed here), with three inputs
— accepted now, damaged now, missing now — that default to a full
accept of the outstanding quantity, so confirming without touching
anything is still exactly the old one-click behaviour. The three
figures together are checked against outstanding client-side before
Confirm is even enabled; a missing quantity requires its own reason,
per line, before Confirm enables; Confirm disables itself the instant
it is clicked. The transfer detail view sums the same per-line
figures into dispatched/accepted/damaged/missing/outstanding totals
and shows them beside the existing balanced/unbalanced notice and
status pill — again, summed from backend values, never an
independently computed stock balance. No new screen, no new route:
the existing confirm-dialog and detail-dialog components, widened.
