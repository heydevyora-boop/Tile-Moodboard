/**
 * THE DEMO DATA HAS TO ADD UP.
 *
 * A prototype whose stock figure its own ledger contradicts is worse
 * than no prototype: it teaches the studio to distrust the screens
 * before the real system is even built. The first draft of this
 * dataset had exactly that bug -- eighteen products whose ledger
 * closed somewhere other than the quantity the Product Master
 * showed -- because the two numbers were invented separately.
 *
 * These checks are what stops it coming back.
 *
 * Run:  node test/data_consistency_test.js
 */

import { BASE_PRODUCTS, CATEGORIES, SUPPLIERS, STATUSES } from '../src/data/catalogue.js';
import { PRODUCTS, MOVEMENTS, ledgerFor, openingFor, MOVEMENT_REASONS, CUSTOMERS, stockValue } from '../src/data/ledger.js';
import { PURCHASES, SALES, SYNC_EVENTS, USERS, ROLES, PURCHASE_STATUS, SALES_STATUS, SYNC_STATUS } from '../src/data/operations.js';
import { MODULES, GROUP_ORDER, moduleFor } from '../src/data/modules.js';

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 240)));
}

console.log('\n1. the ledger reconciles with the stock figure');

let mismatched = [];
let wentNegative = [];
for (const p of PRODUCTS) {
  const rows = ledgerFor(p.productCode);
  const closing = rows.length ? rows[rows.length - 1].balance : 0;
  if (closing !== p.stockQty) mismatched.push({ code: p.productCode, closing, shown: p.stockQty });
  if (rows.some((r) => r.balance < 0)) wentNegative.push(p.productCode);
}
check('1a. every product closes on the quantity the Product Master shows',
  mismatched.length === 0, mismatched.slice(0, 4));
check('1b. no running balance is ever negative', wentNegative.length === 0, wentNegative.slice(0, 4));

check('1c. a draft product has no stock and no history',
  PRODUCTS.filter((p) => p.status === 'draft')
    .every((p) => p.stockQty === 0 && ledgerFor(p.productCode).length === 0));

check('1d. the opening balance is the first row of each stock card',
  PRODUCTS.filter((p) => p.status !== 'draft').every((p) => {
    const first = ledgerFor(p.productCode)[0];
    return first && first.reason === 'opening' && first.balance === openingFor(p.productCode);
  }));

console.log('\n2. status never contradicts the quantity beside it');

/* The whole point of five statuses rather than a boolean: Out of
   Stock is a product the studio still sells and must reorder,
   Discontinued is one it has retired. A screen that showed "Out of
   Stock, 86 boxes" -- or treated the two as one state -- would be
   actively misleading to whoever does the buying. */
const contradictions = PRODUCTS.filter((p) =>
  (p.status === 'out' && p.stockQty !== 0)
  || (p.status === 'low' && (p.stockQty === 0 || p.stockQty > p.reorderLevel))
  || (p.status === 'active' && p.stockQty <= p.reorderLevel));
check('2a. out means zero, low means at or under the reorder level, active means above it',
  contradictions.length === 0,
  contradictions.slice(0, 4).map((p) => ({ code: p.productCode, status: p.status, qty: p.stockQty, reorder: p.reorderLevel })));

check('2b. a retired product is never also counted as merely out of stock',
  PRODUCTS.filter((p) => p.retired).every((p) => p.status === 'discontinued'));

check('2c. a retired product is never reordered in the window',
  PRODUCTS.filter((p) => p.retired)
    .every((p) => !ledgerFor(p.productCode).some((m) => m.reason === 'purchase')));

check('2d. Out of Stock and Discontinued do not share a presentation',
  STATUSES.out.tone !== STATUSES.discontinued.tone);

check('2e. all five statuses are represented in the data',
  Object.keys(STATUSES).every((k) => PRODUCTS.some((p) => p.status === k)),
  Object.keys(STATUSES).filter((k) => !PRODUCTS.some((p) => p.status === k)));

console.log('\n3. nothing refers to a row that is not there');

check('3a. every movement names a real product',
  MOVEMENTS.every((m) => PRODUCTS.some((p) => p.productCode === m.productCode)));
check('3b. every movement has a known reason and a direction that matches it',
  MOVEMENTS.every((m) => MOVEMENT_REASONS[m.reason] && MOVEMENT_REASONS[m.reason].dir === m.dir));
check('3c. every movement quantity is positive',
  MOVEMENTS.every((m) => Number.isInteger(m.qty) && m.qty > 0));
check('3d. every product names a real category and supplier',
  PRODUCTS.every((p) => CATEGORIES.some((c) => c.id === p.category) && SUPPLIERS.some((s) => s.id === p.supplier)));
check('3e. every purchase line names a real product, and the total is the sum of its lines',
  PURCHASES.every((o) => o.lines.length > 0
    && o.lines.every((l) => PRODUCTS.some((p) => p.productCode === l.productCode))
    && o.total === o.lines.reduce((s, l) => s + l.amount, 0)));
check('3f. every sales line names a real product, and the total is the sum of its lines',
  SALES.every((o) => o.lines.length > 0
    && o.lines.every((l) => PRODUCTS.some((p) => p.productCode === l.productCode))
    && o.total === o.lines.reduce((s, l) => s + l.amount, 0)));
check('3g. every sales order names a real customer',
  SALES.every((o) => CUSTOMERS.some((c) => c.id === o.customerId)));
check('3h. every order carries a status the UI knows how to render',
  PURCHASES.every((o) => PURCHASE_STATUS[o.status]) && SALES.every((o) => SALES_STATUS[o.status]));
check('3i. every sync event names a real product and a known status',
  SYNC_EVENTS.every((e) => PRODUCTS.some((p) => p.productCode === e.productCode) && SYNC_STATUS[e.status]));
check('3j. every user holds a defined role',
  USERS.every((u) => ROLES[u.role]));

console.log('\n4. the sync direction is never ambiguous');

/* The ERP is the master for the commercial fields. A sync row
   flowing the other way would mean the website had edited something
   the ERP owns -- which is a mismatch to surface, not a routine
   event to list. */
check('4a. every sync event flows ERP -> website',
  SYNC_EVENTS.every((e) => e.direction === 'erp → website'));
check('4b. a failed event says what failed and has been retried',
  SYNC_EVENTS.filter((e) => e.status === 'failed').every((e) => e.error && e.attempts > 1));
check('4c. an event that has not failed carries no error text',
  SYNC_EVENTS.filter((e) => e.status !== 'failed').every((e) => e.error === null));

console.log('\n5. the nav and the routes cannot drift apart');

check('5a. every module belongs to a group the sidebar renders',
  MODULES.every((m) => GROUP_ORDER.includes(m.group)),
  MODULES.filter((m) => !GROUP_ORDER.includes(m.group)).map((m) => m.label));
check('5b. no two modules share a path', new Set(MODULES.map((m) => m.to)).size === MODULES.length);
check('5c. the brief asked for fifteen modules', MODULES.length === 15, MODULES.length);
check('5d. a product sub-path still resolves to Product Master',
  moduleFor('/products/DV-1001').label === 'Product Master');
check('5e. an unknown path falls back to the dashboard rather than throwing',
  moduleFor('/nothing-here').to === '/');

console.log('\n6. the figures are worth putting on a screen');

check('6a. there are enough products to need searching and paging', PRODUCTS.length >= 60, PRODUCTS.length);
check('6b. product codes are unique', new Set(PRODUCTS.map((p) => p.productCode)).size === PRODUCTS.length);
check('6c. stock is valued at cost, not at the hoped-for selling price',
  Math.round(stockValue()) === Math.round(PRODUCTS.reduce((s, p) => s + p.stockQty * p.purchaseRate * p.sqftPerBox, 0)));
check('6d. every product sells for more than it cost',
  PRODUCTS.every((p) => p.sellingRate > p.purchaseRate && p.mrp >= p.sellingRate));

console.log('\n7. the data is the same on every run');

/* A reviewer who quotes a number back has to be able to see it
   again. Two independent reads of the modules must agree, and the
   generated rows must not move between runs. */
const firstCodes = PRODUCTS.map((p) => p.productCode).join(',');
const firstValue = Math.round(stockValue());
const reread = await import('../src/data/ledger.js?again=1');
check('7a. a second read produces the same products in the same order',
  reread.PRODUCTS.map((p) => p.productCode).join(',') === firstCodes);
check('7b. ...and the same stock valuation', Math.round(reread.stockValue()) === firstValue, firstValue);

/* The trap this pair of checks exists for: the catalogue used to
   export a PRODUCTS list that only became correct once the ledger
   had been imported and had written the quantities onto it. A screen
   importing the catalogue alone saw a shop where everything was zero
   and everything was active. It is now structurally impossible --
   the half-built list is named BASE_PRODUCTS and carries no
   quantity at all. */
check('7c. the catalogue cannot hand out a product list with stock figures on it',
  BASE_PRODUCTS.every((p) => p.stockQty === undefined));
check('7d. ...and the finished list has a quantity and a status for every row',
  PRODUCTS.every((p) => Number.isInteger(p.stockQty) && STATUSES[p.status])
    && PRODUCTS.length === BASE_PRODUCTS.length);

console.log('\n' + passed + '/' + (passed + failures.length) + ' checks passed');
if (failures.length) {
  console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
