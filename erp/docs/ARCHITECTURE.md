# ERP Database Architecture

**Status:** schema designed, migrated and verified. No API, no website
connection, no website code touched.

---

## 1. Where this sits

```
┌──────────────┐   ┌─────────┐   ┌──────────────────┐   ┌─────────┐
│  ERP front   │──▶│ ERP API │──▶│  Casa De Aurum   │──▶│ website │
│  end (built) │   │ (later) │   │ backend (exists) │   │         │
└──────┬───────┘   └────┬────┘   └────────┬─────────┘   └────┬────┘
       │                │                 │                  │
       ▼                ▼                 ▼                  ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│   ERP PostgreSQL  (THIS)     │   │  Website PostgreSQL          │
│   ERP_DATABASE_URL           │   │  DATABASE_URL   — untouched  │
│   25 tables, owns the trade  │   │  30 models, owns the site    │
└──────────────────────────────┘   └──────────────────────────────┘
        no connection between these two at the database level, ever
```

The ERP database is **completely independent**. It has its own
connection variable, its own schema file, its own migration history
and its own generated client. Nothing in it reads, writes or
references the website's database, and the ERP works correctly with
the website switched off.

The only acknowledgement that a website exists is one small mapping
table (§6).

### How the independence is enforced, not just intended

| | |
|---|---|
| Connection variable | `ERP_DATABASE_URL`, never `DATABASE_URL` |
| Schema | `erp/prisma/schema.prisma`, separate file, separate migration history |
| Generated client | `erp/node_modules/.prisma/erp-client` — its own output path, so it can never be imported by mistake in place of the website's |
| Website identifiers | confined to `website_product_mappings` |

The variable name is the important one. If the ERP read `DATABASE_URL`
too, running `prisma migrate dev` with the website's environment
loaded in the same shell would attempt to migrate the **website's**
production database with the ERP's schema. Under a different name
that cannot happen by accident: the ERP CLI finds nothing and
refuses to run.

---

## 2. The stack, after inspecting the project

| | Found | Decision |
|---|---|---|
| ERP frontend | Vite 8 + React 19, **plain JavaScript, ESM**, no backend, no ORM, no database library of any kind | untouched |
| Website backend | Express 4 + TypeScript + **Prisma 7.9.1 + PostgreSQL** | reuse Prisma + PostgreSQL |

Prisma was **not assumed** — the ERP folder was inspected first and
had no database layer at all. It was chosen because the team already
runs Prisma 7 on PostgreSQL next door, so the migration workflow,
the config pattern and the operational knowledge all carry over.

Four dependencies added, and no more: `prisma`, `@prisma/client`,
`@prisma/adapter-pg`, `dotenv`. The seed and the checks are plain
ESM JavaScript, matching the frontend, so no TypeScript toolchain
is introduced.

---

## 3. The tables

**25 tables, 15 enums.**

### Access
| Table | Holds |
|---|---|
| `users` | ERP accounts. Disabled, never deleted. |
| `roles`, `user_roles`, `role_permissions` | Roles and `resource:action` permissions, the same convention the website backend already uses. |

### Catalogue
| Table | Holds |
|---|---|
| `brands` | Somany, Morson, Simpolo … |
| `collections` | A brand's series. Scoped to a brand: two brands may both sell a "Verona" and they are not the same range. |
| `product_categories` | Commercial grouping, self-referencing for sub-categories, with HSN codes. |
| `products` | **The Product Master.** |

### Inventory
| Table | Holds |
|---|---|
| `warehouses` | Stock locations. One today; the schema is already multi-warehouse. |
| `inventory_balances` | On-hand and reserved, per product per warehouse. **A projection of the ledger, not a second truth.** |
| `stock_ledger_entries` | **Append-only.** Every box that ever moved, and why. |
| `stock_adjustments`, `stock_adjustment_lines` | A count or write-off, as an approvable document. |

### Trade
| Table | Holds |
|---|---|
| `suppliers`, `customers` | The parties. |
| `purchase_orders`, `purchase_order_lines` | What was ordered in, and what has arrived. |
| `sales_orders`, `sales_order_lines` | Quotation through delivery. |
| `warehouse_transfers`, `warehouse_transfer_lines` | Stock between the studio's own locations. |

### Integration and governance
| Table | Holds |
|---|---|
| `audit_logs` | **Append-only.** Who changed what, with a before/after diff. |
| `integration_events` | The transactional outbox. What the ERP has to tell the outside world. |
| `website_product_mappings` | The one place the website exists. |
| `document_sequences` | Race-free PO-2026-0001 numbering. |

---

## 4. The decisions that shape it

### Out of Stock is not a product status

`ProductStatus` is **ACTIVE / INACTIVE / DISCONTINUED** and nothing
else. Availability is derived from `inventory_balances`.

Out of stock is a fact about inventory at a warehouse on a date. It
changes several times a week without anybody deciding anything, and
two warehouses can disagree about it. Writing it into the Product
Master would mean a background job editing the catalogue all day,
and one column that cannot answer for two locations.

`DISCONTINUED` and "out of stock" must never be confused: one is a
product to stop buying, the other a product to buy more of.

### The stock ledger is append-only, enforced by the database

A trigger raises an exception on any `UPDATE` or `DELETE` of
`stock_ledger_entries`. Not a convention, not a code review rule — a
wall that an ORM bug, a `psql` session or a future developer in a
hurry all hit equally.

A mistake is corrected by **posting the opposite entry**, linked
back through `reversalOfEntryId`. The wrong entry stays visible for
ever. A stock history that can be quietly edited is a stock history
nobody can rely on in a dispute. `audit_logs` is guarded the same
way.

### The balance is a projection, and it is checked

Summing a product's entire history on every page load stops being
viable at a few hundred thousand rows, so `inventory_balances` keeps
a running total. Three things keep it honest:

1. it is only ever written **in the same transaction** as the ledger
   entry that caused it;
2. the row is locked (`SELECT … FOR UPDATE`) before being
   read-modified-written, so simultaneous dispatches of the same
   product queue instead of racing;
3. `v_inventory_reconciliation` recomputes every balance from the
   ledger and reports any row where the two disagree. If this table
   were ever wrong, that view says so.

### Duplicates cannot be posted twice

Every ledger entry carries a unique `idempotencyKey`, built from what
the movement *is* — document, line, action. A retried API call, a
double-clicked button or a replayed queue message lands on a
unique-constraint violation instead of moving the stock twice.

### Deletes are restricted, not cascaded

Deleting a brand must not silently take its products; deleting a
product must not take the movements that explain where the stock
went. Every foreign key into history is `onDelete: Restrict`.

The **only** cascades in the schema are from a document to its own
lines (`purchase_orders → purchase_order_lines` and the three
equivalents), where a line has no meaning apart from its document.
A posted document cannot be deleted at all.

### Identity outlives everything else

`products.id` is a UUID generated once and never reused — not when
the SKU is corrected, not when the product is retired. Every
movement, order line and mapping points at it. `sku` is unique and
separate, because a SKU is a business decision and business
decisions get corrected; an identity must not.

### Prices and quantities are Decimal

Money `Decimal(14,2)`, quantity `Decimal(14,3)`. Never `Float`. A
float cannot hold 0.1 exactly, and a stock balance that drifts by a
fraction per movement is one nobody can audit.

`priceBasis` states what a price is **per** — tile is quoted per
square foot and moved per box, and leaving that implicit is how a
fifteen-fold error gets into an order.

### Historical documents say what they said

Order lines snapshot `skuAtOrder` and `nameAtOrder`; ledger entries
snapshot `referenceNo` and `unitCost`; order totals are stored, not
recomputed. The live `productId` is still there for anyone who wants
today's version. What was agreed on the day must still read the way
it read on the day.

### The outbox, not a direct call

When a price changes, the ERP writes the product **and** the
integration event in one transaction. A change can never be made
without its notification being queued, and a notification can never
be sent for a change that rolled back. Sending is a separate step,
so the ERP API and the Casa De Aurum backend can be down for an hour
without the ERP losing anything.

The event stores the payload **as it was**. That is also the answer
to the retry question: re-sending re-sends what was agreed at the
time, not whatever the row happens to say now.

---

## 5. Relationships

```
Brand ──< Collection ──< Product >── ProductCategory ──< (self: sub-categories)
                           │
                           ├──< StockLedgerEntry >── Warehouse        [append-only]
                           ├──< InventoryBalance  >── Warehouse        [one per pair]
                           ├──< PurchaseOrderLine >── PurchaseOrder >── Supplier
                           ├──< SalesOrderLine    >── SalesOrder    >── Customer
                           ├──< StockAdjustmentLine >── StockAdjustment
                           ├──< WarehouseTransferLine >── WarehouseTransfer
                           └──1 WebsiteProductMapping                  [optional]

User ──< UserRole >── Role ──< RolePermission
User ──< everything that records who did it                [all Restrict]
AuditLog, IntegrationEvent ── loose (entityType + entityId), no FK
```

Three relationships are deliberately **not** foreign keys:

- `stock_ledger_entries.referenceId` points at four different tables
  by `referenceType`. The ledger has to survive whatever happens to
  the documents, which is the point of it being a ledger.
- `audit_logs.entityId` must outlive the row it describes. A log
  entry that disappears when the record is deleted documents nothing.
- `integration_events.entityId`, for the same reason.

---

## 6. Website integration, prepared but not connected

`website_product_mappings` holds exactly what Step 4 asked for:

| Column | |
|---|---|
| `productId` | the ERP product — unique, one mapping per product |
| `skuAtMapping` | SKU snapshot, so a mismatch is diagnosable later |
| `externalProductId` | the website's id — unique, so two ERP products can never claim one listing |
| `externalSlug` | for support staff who have a link |
| `syncStatus` | NOT_SYNCED / PENDING / SYNCED / FAILED / **CONFLICT** |
| `lastSyncedAt`, `lastSyncError`, `lastSyncedHash` | |

A side table rather than columns on `products`, so that the Product
Master stays free of another system's identifiers, a product the
website has never heard of simply has no row (rather than three
nulls on every product), and a second sales channel later is another
mapping table rather than five more columns on the master.

`CONFLICT` exists because the ERP owns cost, price, stock and status.
A website edit to one of those is a conflict for a person to resolve,
not an update to accept.

**Nothing connects. No credentials, no client, no endpoint.**

---

## 7. Decisions still open

These change what gets built next. None is a default worth guessing
at, and the schema can express either answer to each.

1. **Stock valuation** — last cost, weighted average, or FIFO.
   `unitCost` and `valueAmount` are captured per movement so any of
   the three remains computable; FIFO would additionally need a cost
   layer table. **Until this is settled, no margin report is honest.**
2. **When a sale writes to the ledger** — on confirmation, on
   dispatch, or on invoice — and whether confirming an order reserves
   stock. `quantityReserved` exists so that answering this is not a
   migration.
3. **The prototype's "Draft" status.** The brief named three
   statuses, so `DRAFT` is not in the enum: a never-published product
   is `INACTIVE` with a mapping that has never synced. The UI can
   keep the word "Draft" if preferred — say so and the enum gains a
   fourth value.
4. **ERP logins vs website logins.** `users.websiteUserId` is there
   and nullable; nothing depends on it yet.
5. **In-transit ownership.** While stock is on a lorry between
   warehouses, which location owns it, and does it count as
   available? `TransferStatus.IN_TRANSIT` can express either.
6. **A separate goods-receipt document (GRN).** Today, receiving
   against a purchase order writes ledger entries referencing the PO.
   If receipts need to be approved separately from the order, that is
   another document and another table.
7. **Tax.** `hsnCode` is stored; GST rates and tax lines are not
   modelled, because the brief did not ask for invoicing. Invoices
   are new ground — the audit found the website has no invoice,
   quotation, order or price model at all.
8. **Multi-currency.** `currency` is on orders and defaults to INR.
   Nothing converts. If the studio ever imports directly, this needs
   a rate table.
