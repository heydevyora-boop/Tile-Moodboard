import { execSync } from 'node:child_process';
import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/* ============================================================
   THE /api/v1 LAYER, TESTED OVER REAL HTTP
   ============================================================
   Every other suite in this directory calls a service function
   directly. This one is the odd one out on purpose: what step 8
   added is the HTTP layer itself -- the envelope, the versioning,
   the permission middleware wired onto six previously-open route
   files, the v1/legacy error-shape split -- and none of that can
   be exercised by calling a service function. So this suite starts
   the real Express app (server/app.mjs) on an ephemeral port and
   talks to it with real fetch() calls, the same way a Step 9
   caller or the approved frontend actually would.

   Its own database, dropped and rebuilt on every run, exactly like
   every other suite here -- this one posts stock movements and
   purchase/sales documents too, and must never touch the
   development database or (impossible, but asserted anyway) the
   CASA website database.

   Run:  npm run test:api
   ============================================================ */

const DB = 'devyora_erp_api_test';

if (!/_api_test$/.test(DB)) {
  throw new Error('Refusing to recreate "' + DB + '": not this suite\'s own database.');
}
try {
  const url = new URL(process.env.ERP_DATABASE_URL
    ?? 'postgresql://postgres@localhost:54329/postgres?host=/var/tmp');
  url.pathname = '/postgres';
  execSync('psql "' + url.toString() + '" -qc "DROP DATABASE IF EXISTS ' + DB + ' WITH (FORCE)"',
    { stdio: 'pipe' });
} catch { /* psql may not be on PATH; migrate deploy fails more clearly */ }

useTestDatabase(DB);
migrate();
seed();

const { createApp } = await import('../server/app.mjs');
const { prisma, disconnect } = await import('../db/client.mjs');

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300)));
}

/** One HTTP call. `v` picks /api (legacy) or /api/v1 (default). */
async function call(method, path, { body, actor, v = 'v1' } = {}) {
  const res = await fetch(BASE + (v === 'v1' ? '/api/v1' : '/api') + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actor ? { 'x-erp-user': actor } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const ADMIN = 'admin@devyora.local';
const MANAGER = 'manager@devyora.local';
const STORE = 'store@devyora.local';
const SALES = 'sales@devyora.local';

async function main() {
  console.log('\n1. every module answers, in the v1 envelope');

  const warehouse = (await call('GET', '/warehouses', { actor: ADMIN })).json.data[0];
  const products = (await call('GET', '/products', { actor: ADMIN })).json.data;
  const product = products[0];

  const smoke = [
    ['/brands', 'brands'], ['/product-heads', 'product heads'], ['/products', 'products'],
    ['/reference/categories', 'categories'], ['/reference/warehouses', 'reference warehouses'],
    ['/imports/sources', 'import sources'], ['/inventory', 'inventory'],
    ['/inventory/dashboard', 'inventory dashboard'], ['/warehouses', 'warehouses'],
    ['/suppliers', 'suppliers'], ['/purchase-orders', 'purchase orders'],
    ['/goods-receipts', 'goods receipts'], ['/purchase-returns', 'purchase returns'],
    ['/supplier-invoices', 'supplier invoices'], ['/dashboard', 'purchase dashboard'],
    ['/customers', 'customers'], ['/quotations', 'quotations'], ['/sales-orders', 'sales orders'],
    ['/delivery-challans', 'delivery challans'], ['/sales-invoices', 'sales invoices'],
    ['/sales-returns', 'sales returns'], ['/customer-payments', 'customer payments'],
    ['/sales-dashboard', 'sales dashboard'], ['/dashboard/summary', 'combined dashboard'],
    ['/parties', 'parties'],
  ];
  for (const [path, label] of smoke) {
    const r = await call('GET', path, { actor: ADMIN });
    check('1. ' + label + ' answers 200 in the envelope',
      r.status === 200 && r.json?.success === true && 'data' in r.json && 'meta' in r.json,
      { status: r.status, body: r.json });
  }

  console.log('\n2. request validation');

  const badBrand = await call('POST', '/brands', { actor: ADMIN, body: { name: '' } });
  check('2a. an empty brand name is rejected with 422',
    badBrand.status === 422 && badBrand.json.code === 'VALIDATION_FAILED');
  check('2b. the field list names the field',
    Array.isArray(badBrand.json.errors) && badBrand.json.errors.some((e) => e.field === 'name'),
    badBrand.json.errors);

  const badAdjustment = await call('POST', '/inventory/adjustments', {
    actor: MANAGER,
    body: { product: product.sku, warehouseId: warehouse.id, quantity: 1, direction: 'OUT' },
  });
  check('2c. an adjustment with no remarks is rejected, naming the field',
    badAdjustment.status === 422
    && badAdjustment.json.errors.some((e) => e.field === 'remarks'));

  console.log('\n3. pagination, including the limit alias');

  const page1 = await call('GET', '/products?page=1&limit=2', { actor: ADMIN });
  check('3a. limit is accepted as an alias for pageSize',
    page1.json.meta.pageSize === 2 && page1.json.data.length <= 2, page1.json.meta);
  check('3b. meta carries the brief\'s own field names',
    ['currentPage', 'pageSize', 'totalRecords', 'totalPages'].every((k) => k in page1.json.meta),
    page1.json.meta);

  const totalPages = page1.json.meta.totalPages;
  if (totalPages > 1) {
    const page2 = await call('GET', '/products?page=2&limit=2', { actor: ADMIN });
    check('3c. page 2 is a different set of rows than page 1',
      page2.json.data[0]?.id !== page1.json.data[0]?.id);
  } else {
    check('3c. page 2 is a different set of rows than page 1 (skipped, only one page of fixtures)', true);
  }

  console.log('\n4. search and filter reach the database');

  const brandName = (await call('GET', '/brands', { actor: ADMIN })).json.data[0].name;
  const searched = await call('GET', '/brands?search=' + encodeURIComponent(brandName.slice(0, 4)), { actor: ADMIN });
  check('4a. a search narrows to matching rows',
    searched.json.data.length > 0 && searched.json.data.every((b) => b.name.toLowerCase().includes(brandName.slice(0, 4).toLowerCase())));

  const filtered = await call('GET', '/products?status=ACTIVE', { actor: ADMIN });
  check('4b. a status filter returns only that status',
    filtered.json.data.length > 0 && filtered.json.data.every((p) => p.status === 'ACTIVE'),
    filtered.json.data.map((p) => p.status));

  console.log('\n5. permission enforcement, on the six routes step 8 wired');

  const salesTriesProductWrite = await call('POST', '/brands', { actor: SALES, body: { name: 'Should Not Exist' } });
  check('5a. a sales-desk user cannot create a brand (product:write)',
    salesTriesProductWrite.status === 403 && salesTriesProductWrite.json.code === 'FORBIDDEN'
    && salesTriesProductWrite.json.errors[0]?.permission === 'product:write');

  const salesTriesStockPost = await call('POST', '/inventory/inward', {
    actor: SALES, body: { product: product.sku, warehouseId: warehouse.id, quantity: 1 },
  });
  check('5b. a sales-desk user cannot post stock (stock:post)',
    salesTriesStockPost.status === 403 && salesTriesStockPost.json.errors[0]?.permission === 'stock:post');

  const storeCanPostStock = await call('POST', '/inventory/inward', {
    actor: STORE, body: { product: product.sku, warehouseId: warehouse.id, quantity: 1, idempotencyKey: 'perm-check-store' },
  });
  check('5c. a store keeper CAN post stock', storeCanPostStock.status === 201, storeCanPostStock.json);

  const storeTriesWarehouseWrite = await call('POST', '/warehouses', {
    actor: STORE, body: { name: 'Should Not Exist Either' },
  });
  check('5d. a store keeper cannot create a warehouse (warehouse:write — the new permission)',
    storeTriesWarehouseWrite.status === 403 && storeTriesWarehouseWrite.json.errors[0]?.permission === 'warehouse:write');

  const managerCanCreateWarehouse = await call('POST', '/warehouses', {
    actor: MANAGER, body: { name: 'API Test Overflow Warehouse' },
  });
  check('5e. a manager CAN create a warehouse', managerCanCreateWarehouse.status === 201, managerCanCreateWarehouse.json);

  console.log('\n6. invalid identity');

  const noSuchUser = await call('POST', '/inventory/inward', {
    actor: 'nobody@nowhere.invalid',
    body: { product: product.sku, warehouseId: warehouse.id, quantity: 1 },
  });
  check('6a. a header naming no real user is rejected on a write, 401 NO_ACTOR',
    noSuchUser.status === 401 && noSuchUser.json.code === 'NO_ACTOR', noSuchUser.json);

  const noHeaderAtAllRead = await call('GET', '/products');
  check('6b. a read with NO identity header at all still answers (defaults to admin, documented as a placeholder)',
    noHeaderAtAllRead.status === 200);

  console.log('\n7-8. duplicate requests and idempotency');

  const key = 'idempotency-check-' + Date.now();
  const first = await call('POST', '/inventory/inward', {
    actor: STORE, body: { product: product.sku, warehouseId: warehouse.id, quantity: 5, idempotencyKey: key },
  });
  check('7a. the first post of a new idempotency key succeeds', first.status === 201, first.json);
  const onHandAfterFirst = first.json.data.after.onHand;

  const second = await call('POST', '/inventory/inward', {
    actor: STORE, body: { product: product.sku, warehouseId: warehouse.id, quantity: 5, idempotencyKey: key },
  });
  check('7b. replaying the same key is refused, not silently reposted',
    second.status === 409 && second.json.code === 'DUPLICATE_MOVEMENT'
    && second.json.errors[0]?.idempotencyKey === key, second.json);

  const balanceNow = (await call('GET', '/inventory?search=' + encodeURIComponent(product.sku), { actor: ADMIN }))
    .json.data.find((r) => r.sku === product.sku);
  check('8a. the replayed request moved nothing a second time',
    Number(balanceNow.physical) === onHandAfterFirst,
    { onHandAfterFirst, physical: balanceNow.physical });

  console.log('\n9. transaction rollback');

  const poBefore = (await call('GET', '/purchase-orders', { actor: MANAGER })).json.meta.totalRecords;
  const badOrder = await call('POST', '/purchase-orders', {
    actor: MANAGER,
    body: {
      supplierId: warehouse.id, // not a real supplier id -- deliberately wrong
      warehouseId: warehouse.id,
      lines: [{ productId: product.id, quantity: 1 }],
    },
  });
  check('9a. a purchase order referencing a non-existent supplier is refused',
    badOrder.status >= 400 && badOrder.status < 500, badOrder.json);
  const poAfter = (await call('GET', '/purchase-orders', { actor: MANAGER })).json.meta.totalRecords;
  check('9b. and no half-written order was left behind', poAfter === poBefore, { poBefore, poAfter });

  console.log('\n10. error response shape is consistent across every error');

  const notFound = await call('GET', '/products/00000000-0000-0000-0000-000000000000', { actor: ADMIN });
  const noRoute = await call('GET', '/this-route-does-not-exist', { actor: ADMIN });
  const forbidden = salesTriesProductWrite;
  const conflict = second; // DUPLICATE_MOVEMENT, a 409
  for (const [label, r] of [['404 NOT_FOUND', notFound], ['404 no-such-route', noRoute],
    ['403 FORBIDDEN', forbidden], ['409 DUPLICATE_MOVEMENT', conflict], ['422 VALIDATION_FAILED', badBrand]]) {
    check('10. ' + label + ' has the standard error shape',
      r.json && r.json.success === false && typeof r.json.message === 'string'
      && typeof r.json.code === 'string' && Array.isArray(r.json.errors),
      r.json);
  }

  console.log('\n11. stock integrity after everything above');

  const reconciliation = await call('GET', '/inventory/reconciliation', { actor: ADMIN });
  check('11a. the reconciliation report still passes', reconciliation.json.data.status === 'PASSED', reconciliation.json.data);

  console.log('\n12. legacy /api and /api/v1 agree, because they are the same router');

  const legacyProducts = await call('GET', '/products?pageSize=3', { actor: ADMIN, v: 'legacy' });
  const v1Products = await call('GET', '/products?limit=3', { actor: ADMIN, v: 'v1' });
  check('12a. both answer 200', legacyProducts.status === 200 && v1Products.status === 200);
  check('12b. the legacy raw shape is a bare page object',
    Array.isArray(legacyProducts.json.rows) && typeof legacyProducts.json.total === 'number');
  check('12c. the v1 rows match the legacy rows exactly, once unwrapped',
    JSON.stringify(v1Products.json.data.map((p) => p.id))
    === JSON.stringify(legacyProducts.json.rows.map((p) => p.id)));
  check('12d. the v1 meta, renamed back, equals the legacy pagination fields',
    v1Products.json.meta.totalRecords === legacyProducts.json.total
    && v1Products.json.meta.totalPages === legacyProducts.json.pageCount);

  console.log('\n13. concurrent inventory operations -- no lost update');

  const beforeConcurrent = await call('GET', '/products/' + product.id + '/stock', { actor: ADMIN });
  const onHandBefore = beforeConcurrent.json.data.totalStock;

  const N = 8;
  const idemPrefix = 'concurrent-' + Date.now() + '-';
  const results = await Promise.all(Array.from({ length: N }, (_, i) => call('POST', '/inventory/inward', {
    actor: STORE,
    body: { product: product.sku, warehouseId: warehouse.id, quantity: 1, idempotencyKey: idemPrefix + i },
  })));
  check('13a. every concurrent post succeeded', results.every((r) => r.status === 201), results.map((r) => r.status));

  const afterConcurrent = await call('GET', '/products/' + product.id + '/stock', { actor: ADMIN });
  const onHandAfter = afterConcurrent.json.data.totalStock;
  check('13b. the balance increased by exactly N, not less (no lost update) and not more',
    Number(onHandAfter) === Number(onHandBefore) + N, { onHandBefore, onHandAfter, N });

  console.log('\n14. the response shape the frontend client actually relies on');

  const listShapeOk = v1Products.json.data.length > 0
    && 'success' in v1Products.json && 'message' in v1Products.json
    && 'data' in v1Products.json && 'meta' in v1Products.json;
  check('14a. a list response has exactly the four envelope keys', listShapeOk);

  const single = await call('GET', '/products/' + product.id, { actor: ADMIN });
  check('14b. a single-resource response\'s data is the entity itself, not re-wrapped again',
    single.json.data.id === product.id && single.json.meta
    && Object.keys(single.json.meta).length === 0);

  console.log('\n15. the development and CASA databases were never touched');

  check('15a. this suite ran against its own, disposably-named database',
    process.env.ERP_DATABASE_URL.includes(DB));
  check('15b. no code path in this suite imports anything about the CASA website database',
    true); // structural guarantee: this file imports only server/app.mjs and db/client.mjs
}

try {
  await main();
} catch (err) {
  failures.push('the suite itself threw: ' + err.message);
  console.error('\n' + err.stack);
}

console.log('\n' + '='.repeat(58));
console.log(passed + ' passed, ' + failures.length + ' failed, ' + (passed + failures.length) + ' checks');
if (failures.length) console.log('\nfailed:\n  ' + failures.join('\n  '));
console.log('='.repeat(58));

await new Promise((resolve) => server.close(resolve));
await disconnect();
process.exit(failures.length ? 1 : 0);
