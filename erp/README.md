# De'vyora / Casa De Aurum — ERP

A **frontend prototype**. Fifteen screens, generated demo data, no
database, no API, no connection to the De'vyora website. Nothing here
writes anywhere.

It exists to be argued with before anything is built.

The ERP's **own PostgreSQL database** now sits beside it — schema,
migrations, seed and verification. It is independent of the Casa De
Aurum website's database and nothing connects the two. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Product Master and Catalogue Structure are now connected** to
that database through an Express API — create, edit, status,
archive, search, filter, sort and paging, with category-aware
validation and permanent SKUs. See
[`docs/PRODUCT_MASTER.md`](docs/PRODUCT_MASTER.md).

**Import / Export** loads the catalogue pipeline's spreadsheet into
the ERP — preview, duplicate detection, row-level errors and
reconciliation that has to add up. See
[`docs/EXCEL_IMPORT.md`](docs/EXCEL_IMPORT.md). Google Sheets is
implemented but **not verified against the live spreadsheet**; the
Excel export path is tested end to end.

The other twelve screens still run on generated demo data. The
sidebar marks which is which, and so does the pill in the topbar.

```bash
cd erp
npm install

# the prototype
npm run dev          # http://127.0.0.1:5174
npm run build
npm run test:data    # 35 checks on the demo data

# the database  (needs ERP_DATABASE_URL — copy .env.example to .env)
npm run db:deploy    # apply migrations
npm run db:seed      # safe, idempotent development data
npm run db:studio    # browse it

# the Product Master API
npm run api          # http://127.0.0.1:4310

# every suite
npm run db:verify            #  41  database integrity
npm run test:product-master  #  92  Product Master (own test database)
npm run test:frontend        #  42  frontend regression (needs api + dev)
npm run test:import          #  82  the import engine
npm run test:data            #  35  the demo data the other screens use
```

> `ERP_DATABASE_URL`, never `DATABASE_URL`. That second name points
> at the Casa De Aurum website's database, and the ERP must never
> open it. The connection refuses to start without its own variable
> rather than falling back.

---

## 1. What was built

| # | Module | State | What it does |
|---|--------|-------|--------------|
| 1 | Dashboard | Built | Stock value, product counts, what needs ordering, 30-day sales. Six-month sales and purchase trends, value by category, catalogue by status, the reorder to-do list, most-dispatched products, the activity feed and the sync summary. |
| 2 | Product Master | Built | All sixteen columns. Search, three filters, sort on every column, page-scoped bulk selection with five bulk actions, and a per-product detail that marks each field as the website's or the ERP's own. |
| 3 | Inventory / Stock | Built | Six saved views (everything, needs ordering, running low, out of stock, holding stock, discontinued-but-held), each carrying its count. Shortfall, value at cost, and a link to each product's stock card. |
| 4 | Stock Inward | Built | Receipts, customer returns and upward adjustments, with totals and a reason filter. |
| 5 | Stock Outward | Built | Dispatches, samples, breakages and downward adjustments. Samples and breakages are counted here but never as sales. |
| 6 | Purchase Management | Built | Supplier orders through five states, with line-item detail. |
| 7 | Sales Management | Built | Customer orders from quotation to delivery, with line-item detail. |
| 8 | Stock Ledger | Built | The stock card: every movement against one product with its running balance, and `opening + received − issued = on hand` written out as the sum it is. |
| 9 | Product Categories | Built | Two-level grouping with HSN codes and per-category stock value. |
| 10 | Warehouses | **Planned placeholder** | Deliberately not built. See §5. |
| 11 | Reports & Analytics | Built | Four reports: trade, stock and valuation, margin by product, customers and suppliers. |
| 12 | Website Sync Status | Built | Every push, its direction, its failures and why, with a retry flow. |
| 13 | Import / Export | Built | Four exports, three imports, a transfer log. One-way by design. |
| 14 | User Management | Built | Five roles, and a full module-by-module read/write matrix. |
| 15 | Settings | Built | Configuration as it would stand, plus the six decisions still open. |

---

## 2. Demo data, and why it adds up

Everything is generated from a fixed seed, so **the numbers are the
same on every reload**. A reviewer who quotes a figure can find it
again, and a screenshot taken today still matches the screen next
week. The demo clock is frozen at **20 Nov 2026**, and the dashboard
says so rather than letting "2 hours ago" quietly become "4 months
ago".

| | |
|---|---|
| Products | 91 across 6 brands, 10 collections, 6 sizes |
| Statuses | 60 active, 11 low, 10 out, 6 discontinued, 4 draft |
| Stock movements | ~1,450 across 90 days |
| Purchase orders | 46 across six months |
| Sales orders | 64 across six months |
| Sync events | 46, including 4 failures |

**The one rule the dataset keeps:** every product's opening balance
plus everything in, minus everything out, equals the quantity the
Product Master shows — with no balance ever negative on any day.

This is true by construction, not by checking afterwards. The first
version of this data invented a stock figure per product and
generated the ledger separately, and for eighteen products the two
disagreed. Both numbers were made up, so both were wrong. The arrow
is now reversed: a product declares only what it genuinely owns
(retired or draft, how fast it moves, roughly where it should end
up), the movements are simulated, and the quantity and status are
*read off* the result.

`test/data_consistency_test.js` holds 35 checks that keep it that
way, including that Out of Stock and Discontinued never share a
presentation.

---

## 3. Design decisions worth knowing

**It wears the website's own palette.** The tokens in
`src/styles/tokens.css` are the values `frontend/*.html` already
ships, copied rather than imported: the ERP shares no file with the
website, so lifting `erp/` into its own repository later is a move,
not a refactor. Five status colours and a monospace face for figures
are the only additions.

**Out of Stock is not Discontinued.** One is a product the studio
still sells and must reorder; the other it has retired. They never
share a colour, a shape or a sort position, a discontinued line is
never shown a "shortfall", and the ledger never issues a purchase
against one. Conflating them is how somebody reorders stock nobody
intends to sell.

**Colour is never the only signal.** Every status pill carries its
own word, so the five states survive greyscale printing and
colour-blind readers.

**Tables scroll sideways inside their own panel.** Sixteen columns
wrap into three-line rows at laptop width; the page itself never
scrolls horizontally, at any width down to 390px.

**Nothing pretends to write.** Every action — bulk price change,
new order, import, retry, save — opens a dialog that says plainly
it is a prototype, and several name the question that has to be
answered before the real thing is built. A button that appears to
change 24 prices and silently does nothing is how a prototype gets
mistaken for a working system.

---

## 4. How a real backend slots in

The screens never touch data directly. Each imports from
`src/data/`, and every module there exports plain arrays and plain
functions:

```
src/data/
  catalogue.js   BASE_PRODUCTS, CATEGORIES, SUPPLIERS, STATUSES, FIELD_ORIGIN
  ledger.js      PRODUCTS, MOVEMENTS, ledgerFor(code), openingFor(code), stockValue(list)
  operations.js  PURCHASES, SALES, SYNC_EVENTS, USERS, ROLES
  metrics.js     KPIS, SALES_TREND, REORDER_LIST, TOP_MOVERS, …
  modules.js     the fifteen modules the sidebar and router both read
```

Replacing the prototype data means replacing these modules with
calls to the real API and nothing else. The components take rows as
props; none of them knows where a row came from.

Two things to keep when that happens:

- **`PRODUCTS` is the finished list.** `catalogue.js` exports
  `BASE_PRODUCTS`, which carries no quantity at all, because an
  earlier version exported a half-built `PRODUCTS` that only became
  correct once the ledger had been imported — a screen importing the
  catalogue alone saw a shop where everything was zero and everything
  was active. Keep the finished list in one place.
- **Derive the stock figure, don't store it twice.** The reason the
  ledger and the Product Master agree is that there is only one
  number.

---

## 5. What is deliberately NOT here

**Warehouses is a placeholder, on purpose.** Its workflow has not
been settled, and the screen says so and lists the open questions
instead of inventing a transfer flow the studio would then have to
unlearn. Every other inventory figure treats stock as one pool,
which is true today.

**No invoices, quotations, tax or documents.** The audit found the
website has no invoice, quotation, order or price model at all, so
these are new ground for the ERP rather than something to mirror.
Orders here show lines and a total, nothing more.

**No backend, no database, no Prisma schema change, no connection
to the website or to Google Drive and Sheets.** Nothing outside
`erp/` was touched by this work, and `vercel.json` is unchanged.

---

## 6. Decisions needed before the backend is built

Listed in full on the Settings screen, and repeated here:

1. **Stock valuation** — at the last cost paid, or a weighted
   average. The margin report cannot be honest until this is settled.
2. **When a sale writes to the ledger** — on confirmation, dispatch
   or invoice — and whether confirming an order reserves stock.
3. **Logins** — whether ERP accounts are separate from the website's,
   or one person signs in once for both.
4. **A second stock location** — what it means for every figure in
   the system. This is the Warehouses question.
5. **Retry semantics** — whether a retry re-sends the value as it is
   now, or as it was when the change was queued. Only the first is
   safe.
6. **Website edits to ERP-owned fields** — whether they are ever
   allowed, and what happens when one arrives. Today the sync screen
   treats them as a conflict.
