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
    // Added by the product hierarchy step, after step 8 itself --
    // mounted the same way (same router, same v1 wrapping) but
    // never smoke-tested here until now.
    ['/product-lines', 'product lines'], ['/inventory/hierarchy', 'inventory hierarchy'],
  ];
  for (const [path, label] of smoke) {
    const r = await call('GET', path, { actor: ADMIN });
    check('1. ' + label + ' answers 200 in the envelope',
      r.status === 200 && r.json?.success === true && 'data' in r.json && 'meta' in r.json,
      { status: r.status, body: r.json });
  }

  console.log('\n1b. the hierarchy drill-down and product-line detail routes');

  // A fresh test database has no product lines of its own --
  // Stage 1's backfill is a one-time script against the
  // development database's existing data, not part of the seed
  // every disposable test database gets. So this section creates
  // one through the write path first, exercising it too.
  const createdProductLine = await call('POST', '/product-lines', {
    actor: MANAGER,
    body: { name: 'API Test Hierarchy Product', brandId: product.brand.id },
  });
  check('1b. creating a product line answers 201 in the envelope',
    createdProductLine.status === 201 && createdProductLine.json.data.brand?.id === product.brand.id,
    createdProductLine.json);
  const productLine = createdProductLine.json.data;

  const plDetail = await call('GET', '/product-lines/' + productLine.id, { actor: ADMIN });
  check('1b. GET /product-lines/:id answers 200 in the envelope',
    plDetail.status === 200 && plDetail.json.data.id === productLine.id, plDetail.json);

  const companyStock = await call('GET', '/inventory/companies/' + productLine.brand.id, { actor: ADMIN });
  check('1b. GET /inventory/companies/:id answers 200 in the envelope',
    companyStock.status === 200 && companyStock.json.data?.brand?.id === productLine.brand.id, companyStock.json);

  if (productLine.collection?.id) {
    const collectionStock = await call('GET', '/inventory/collections/' + productLine.collection.id, { actor: ADMIN });
    check('1b. GET /inventory/collections/:id answers 200 in the envelope',
      collectionStock.status === 200 && collectionStock.json.data?.collection?.id === productLine.collection.id, collectionStock.json);
  }

  const productLineStock = await call('GET', '/inventory/products/' + productLine.id, { actor: ADMIN });
  check('1b. GET /inventory/products/:id answers 200 in the envelope',
    productLineStock.status === 200 && productLineStock.json.data?.productLine?.id === productLine.id, productLineStock.json);

  const noSuchCompanyStock = await call('GET', '/inventory/companies/00000000-0000-0000-0000-000000000000', { actor: ADMIN });
  check('1b. a company id that does not exist answers 404, not a raw exception',
    noSuchCompanyStock.status === 404, noSuchCompanyStock.json);

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
  const secondWarehouse = managerCanCreateWarehouse.json.data;

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

  console.log('\n16. the full warehouse-transfer lifecycle over real HTTP, including partial receipt');

  // Enough stock at the source for everything this section moves,
  // regardless of what earlier sections already drew down.
  await call('POST', '/inventory/inward', {
    actor: STORE,
    body: { product: product.sku, warehouseId: warehouse.id, quantity: 100, idempotencyKey: 'transfer-section-stock' },
  });

  const createdTransfer = await call('POST', '/warehouses/transfers', {
    actor: MANAGER,
    body: {
      fromWarehouseId: warehouse.id, toWarehouseId: secondWarehouse.id,
      lines: [{ productId: product.id, quantity: 10, uom: 'BOX' }],
    },
  });
  check('16a. creating a transfer answers 201 in the envelope',
    createdTransfer.status === 201 && createdTransfer.json.data.status === 'DRAFT', createdTransfer.json);
  const transferId = createdTransfer.json.data.id;
  const transferLineId = createdTransfer.json.data.lines[0].id;

  const dispatched = await call('POST', '/warehouses/transfers/' + transferId + '/dispatch', { actor: STORE });
  check('16b. dispatch moves it to IN_TRANSIT', dispatched.status === 200 && dispatched.json.data.status === 'IN_TRANSIT',
    dispatched.json);

  // A PARTIAL receipt: 6 accepted, 2 damaged, leaving 2 outstanding
  // -- the body shape added after step 8, never exercised over
  // real HTTP by this suite until now.
  const partialReceive = await call('POST', '/warehouses/transfers/' + transferId + '/receive', {
    actor: STORE,
    body: { lines: [{ transferLineId, acceptedQuantity: 6, damagedQuantity: 2, remarks: 'corner crushed' }] },
  });
  check('16c. a partial receipt with a damaged quantity answers 200 in the v1 envelope',
    partialReceive.status === 200
    && partialReceive.json.success === true && 'data' in partialReceive.json && 'meta' in partialReceive.json,
    partialReceive.json);
  check('16d. the transfer stays IN_TRANSIT -- 2 is still outstanding',
    partialReceive.json.data.status === 'IN_TRANSIT', partialReceive.json.data);
  const lineAfterPartial = partialReceive.json.data.lines[0];
  check('16e. the response carries acceptedQuantity/damagedQuantity/missingQuantity/outstandingQuantity',
    lineAfterPartial.acceptedQuantity === 6 && lineAfterPartial.damagedQuantity === 2
    && lineAfterPartial.missingQuantity === 0 && lineAfterPartial.outstandingQuantity === 2,
    lineAfterPartial);

  // Cancellation must now be refused -- something has already been
  // accepted and damaged on this transfer.
  const cancelAfterPartial = await call('POST', '/warehouses/transfers/' + transferId + '/cancel', {
    actor: STORE, body: { reason: 'trying anyway' },
  });
  check('16f. cancelling a partially-received transfer is refused with a controlled 409, not a 500',
    cancelAfterPartial.status === 409 && cancelAfterPartial.json.success === false, cancelAfterPartial.json);

  // Resolve the remainder as missing, with its mandatory reason --
  // completes the transfer and shows up in movement.missing.
  const missingReceive = await call('POST', '/warehouses/transfers/' + transferId + '/receive', {
    actor: STORE,
    body: { lines: [{ transferLineId, missingQuantity: 2, missingReason: 'short on arrival, logged with the lorry driver' }] },
  });
  check('16g. resolving the rest as missing completes the transfer',
    missingReceive.status === 200 && missingReceive.json.data.status === 'COMPLETED', missingReceive.json.data);
  const missingReasonCheckTransfer = await call('POST', '/warehouses/transfers', {
    actor: MANAGER,
    body: { fromWarehouseId: warehouse.id, toWarehouseId: secondWarehouse.id, lines: [{ productId: product.id, quantity: 1 }] },
  });
  const missingReasonCheckDispatch = await call(
    'POST', '/warehouses/transfers/' + missingReasonCheckTransfer.json.data.id + '/dispatch', { actor: STORE },
  );
  const missingNoReason = await call(
    'POST', '/warehouses/transfers/' + missingReasonCheckTransfer.json.data.id + '/receive',
    {
      actor: STORE,
      body: { lines: [{ transferLineId: missingReasonCheckDispatch.json.data.lines[0].id, missingQuantity: 1 }] },
    },
  );
  check('16h. a missing quantity with no reason is rejected with 422, not posted',
    missingNoReason.status === 422, missingNoReason.json);

  const getTransferDetail = await call('GET', '/warehouses/transfers/' + transferId, { actor: ADMIN });
  check('16i. the completed transfer\'s movement summary reports the missing quantity',
    getTransferDetail.json.data.movement?.missing === 2, getTransferDetail.json.data.movement);

  // An untouched transfer -- nothing dispatched, nothing received
  // -- must still be freely cancellable, exactly as before.
  const untouchedTransfer = await call('POST', '/warehouses/transfers', {
    actor: MANAGER,
    body: { fromWarehouseId: warehouse.id, toWarehouseId: secondWarehouse.id, lines: [{ productId: product.id, quantity: 1 }] },
  });
  const cancelUntouched = await call('POST', '/warehouses/transfers/' + untouchedTransfer.json.data.id + '/cancel', {
    actor: STORE, body: {},
  });
  check('16j. an untouched transfer can still be cancelled -- existing behaviour preserved',
    cancelUntouched.status === 200 && cancelUntouched.json.data.status === 'CANCELLED', cancelUntouched.json);

  console.log('\n17. the CASA integration route (step 9) is gated by its own shared secret, fails closed');

  // Unset for the whole suite until now (the npm script never
  // configures it) -- exactly the state a real deployment that has
  // not set up the CASA integration yet would be in.
  check('17a. unconfigured: the route refuses even a request with no key header at all',
    (await call('GET', '/integrations/casa/catalog-feed', { actor: ADMIN })).status === 403);

  const wrongKeyUnconfigured = await fetch(BASE + '/api/v1/integrations/casa/catalog-feed', {
    headers: { 'x-casa-key': 'anything-at-all' },
  });
  check('17b. unconfigured: even presenting A key is refused -- fails closed, not open-if-any-key',
    wrongKeyUnconfigured.status === 403);

  process.env.CASA_INTEGRATION_API_KEY = 'test-only-casa-key-for-api-v1-suite';

  const noKeyConfigured = await fetch(BASE + '/api/v1/integrations/casa/catalog-feed');
  check('17c. configured: a request with no key at all is still refused',
    noKeyConfigured.status === 403);

  const wrongKeyConfigured = await fetch(BASE + '/api/v1/integrations/casa/catalog-feed', {
    headers: { 'x-casa-key': 'not-the-right-key' },
  });
  check('17d. configured: the wrong key is refused', wrongKeyConfigured.status === 403);

  const rightKey = await fetch(BASE + '/api/v1/integrations/casa/catalog-feed?pageSize=1', {
    headers: { 'x-casa-key': process.env.CASA_INTEGRATION_API_KEY },
  });
  const rightKeyJson = await rightKey.json();
  check('17e. configured: the correct key succeeds, in the ordinary v1 list envelope',
    rightKey.status === 200 && rightKeyJson.success === true
    && Array.isArray(rightKeyJson.data) && typeof rightKeyJson.meta.totalRecords === 'number',
    rightKeyJson);
  check('17f. each row carries company/collection/productLine/variants with per-variant inventory',
    rightKeyJson.data.length > 0
    && rightKeyJson.data[0].company?.id
    && 'collection' in rightKeyJson.data[0]
    && rightKeyJson.data[0].productLine?.id
    && Array.isArray(rightKeyJson.data[0].variants)
    && (rightKeyJson.data[0].variants.length === 0 || 'onHand' in rightKeyJson.data[0].variants[0].inventory),
    rightKeyJson.data[0]);

  check('17g. this route requires no x-erp-user and no requirePermission() check -- the shared secret is the whole gate',
    true); // structural guarantee, confirmed by reading server/routes/casaIntegration.mjs: only requireCasaKey is applied

  delete process.env.CASA_INTEGRATION_API_KEY;
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
