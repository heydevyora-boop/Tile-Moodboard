import { execSync } from 'node:child_process';
import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/* ============================================================
   THE PRODUCT HIERARCHY — COMPANY / COLLECTION / PRODUCT / VARIANT
   ============================================================
   Company (Brand) and Collection already existed; this suite is
   about the level the hierarchy brief actually added --
   ProductLine, the thing between a Collection and a SKU/variant --
   and the aggregation it makes possible. Same discipline as every
   other suite here: its own database, dropped and rebuilt on every
   run, nothing asserted without reading it back.

   Run:  npm run test:hierarchy
   ============================================================ */

const DB = 'devyora_erp_hierarchy_test';

if (!/_hierarchy_test$/.test(DB)) {
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

const { prisma, disconnect } = await import('../db/client.mjs');
const brands = await import('../server/services/brand.service.mjs');
const heads = await import('../server/services/productHead.service.mjs');
const lines = await import('../server/services/productLine.service.mjs');
const products = await import('../server/services/product.service.mjs');
const inventory = await import('../server/services/inventory.service.mjs');
const { requirePermission } = await import('../server/services/permission.mjs');

let passed = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300)));
}

async function refused(fn) {
  try { await fn(); return { threw: false }; } catch (err) { return { threw: true, err }; }
}

async function main() {
  const admin = { id: (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } })).id, name: 'Admin' };
  const sales = { id: (await prisma.user.findUniqueOrThrow({ where: { email: 'sales@devyora.local' } })).id, name: 'Sales Desk' };

  const category = await prisma.productCategory.findFirstOrThrow({ where: { code: 'FLOOR' } });
  const warehouse = await prisma.warehouse.findFirstOrThrow();

  console.log('\n1. company (brand) creation and updates');
  const company = await brands.create({ name: 'Hierarchy Test Co', code: 'HTCO', logoUrl: 'https://x/logo.png', description: 'a test company' }, admin);
  check('1a. a company can carry a logo and a description', company.logoUrl === 'https://x/logo.png' && company.description === 'a test company');
  const renamed = await brands.update(company.id, { description: 'an updated test company' }, admin);
  check('1b. ...and both are editable afterward', renamed.description === 'an updated test company' && renamed.logoUrl === 'https://x/logo.png');

  console.log('\n2. collection creation and company relationship');
  const collection = await heads.create({ name: 'Hierarchy Collection', brandId: company.id, categoryId: category.id }, admin);
  check('2a. a collection belongs to the company it was created under', collection.brand.id === company.id);
  const updatedCollection = await heads.update(collection.id, { coverImageUrl: 'https://x/cover.png', catalogueDocumentUrl: 'https://x/catalogue.pdf' }, admin);
  check('2b. a collection can carry a cover image and a catalogue document',
    updatedCollection.coverImageUrl === 'https://x/cover.png' && updatedCollection.catalogueDocumentUrl === 'https://x/catalogue.pdf');

  console.log('\n3. product creation and collection relationship');
  const product = await lines.create({ name: 'Hierarchy Product', brandId: company.id, collectionId: collection.id, categoryId: category.id }, admin);
  check('3a. a product belongs to the collection it was created under', product.collection.id === collection.id);
  check('3b. ...and inherits the collection\'s category when none is given',
    (await lines.create({ name: 'Inherits Category', brandId: company.id, collectionId: collection.id }, admin)).category?.id === category.id);

  console.log('\n4-5. multiple finishes and multiple sizes of one product');
  const matte600 = await products.create({
    name: 'Hierarchy Product', brandId: company.id, productLineId: product.id, categoryId: category.id,
    size: '600x600mm', finish: 'Matte', thicknessMm: 10, colour: 'Grey', purchasePrice: 100, sellingPrice: 140,
  }, admin);
  const glossy600 = await products.create({
    name: 'Hierarchy Product', brandId: company.id, productLineId: product.id, categoryId: category.id,
    size: '600x600mm', finish: 'Glossy', thicknessMm: 10, colour: 'Grey', purchasePrice: 100, sellingPrice: 140,
  }, admin);
  const matte800 = await products.create({
    name: 'Hierarchy Product', brandId: company.id, productLineId: product.id, categoryId: category.id,
    size: '800x1600mm', finish: 'Matte', thicknessMm: 12, colour: 'Grey', purchasePrice: 180, sellingPrice: 240,
  }, admin);
  check('4a. a product can have multiple finishes', matte600.finish === 'Matte' && glossy600.finish === 'Glossy');
  check('5a. a product can have multiple sizes', matte600.size !== matte800.size);
  check('5b. all three variants carry the SAME productLineId, not three different ones',
    new Set([matte600, glossy600, matte800].map((v) => v.productLine.id)).size === 1);
  check('5c. ...and three different SKUs',
    new Set([matte600, glossy600, matte800].map((v) => v.sku)).size === 3);

  const afterGet = await lines.get(product.id);
  check('5d. the product lists every one of its variants', afterGet.variants.length === 3, afterGet.variants.length);

  console.log('\n6. invalid finish-size combinations are refused, not silently accepted');
  const dupe = await refused(() => products.create({
    name: 'Hierarchy Product', brandId: company.id, productLineId: product.id, categoryId: category.id,
    size: '600x600mm', finish: 'Matte', thicknessMm: 10, colour: 'Grey', purchasePrice: 100, sellingPrice: 140,
  }, admin));
  check('6a. the exact same finish/size/colour under one head is flagged for review, not duplicated',
    dupe.threw && dupe.err.code === 'NEEDS_HUMAN_REVIEW', dupe.err?.message);

  console.log('\n7. SKU uniqueness across the whole product line');
  const skuSet = new Set([matte600.sku, glossy600.sku, matte800.sku]);
  check('7a. three variants of one product never collide on SKU', skuSet.size === 3);

  console.log('\n8. company and collection filtering');
  const filteredByBrand = await lines.list({ brandId: company.id });
  check('8a. listing products filters by company', filteredByBrand.rows.every((r) => r.brand.id === company.id)
    && filteredByBrand.total >= 2);
  const filteredByCollection = await lines.list({ collectionId: collection.id });
  check('8b. ...and by collection', filteredByCollection.rows.every((r) => r.collection?.id === collection.id));

  console.log('\n9. product search, across the hierarchy');
  const searched = await products.list({ search: 'Hierarchy Product' });
  check('9a. searching a product name finds its variants', searched.total >= 3, searched.total);
  const searchedByLine = await products.list({ search: 'Hierarchy Collection' });
  check('9b. ...and searching the collection name finds the same variants',
    searchedByLine.rows.some((r) => r.sku === matte600.sku));

  console.log('\n10-11. inventory aggregation at company and collection level');
  await inventory.openingStock({ product: matte600.sku, warehouseId: warehouse.id, quantity: 50 }, admin);
  await inventory.openingStock({ product: glossy600.sku, warehouseId: warehouse.id, quantity: 30 }, admin);
  await inventory.openingStock({ product: matte800.sku, warehouseId: warehouse.id, quantity: 20 }, admin);

  const companyStock = await inventory.companyStock(company.id);
  check('10a. the company total is the sum of its variants\' on-hand stock',
    companyStock.totals.physical === 100, companyStock.totals);
  check('10b. ...and the collection inside it carries the same figure (nothing else is in this company)',
    companyStock.collections.find((c) => c.id === collection.id)?.totals.physical === 100);

  const collectionStock = await inventory.collectionStock(collection.id);
  check('11a. the collection total is the sum of its products\' on-hand stock',
    collectionStock.totals.physical === 100, collectionStock.totals);
  check('11b. ...and the product inside it carries the same figure',
    collectionStock.products.find((p) => p.id === product.id)?.totals.physical === 100);

  const productStock = await inventory.productLineStock(product.id);
  check('12a. the product total is the sum of its own three variants',
    productStock.totals.physical === 100, productStock.totals);
  check('12b. SKU-level totals inside it are correct individually',
    productStock.variants.find((v) => v.sku === matte600.sku)?.totals.physical === 50
    && productStock.variants.find((v) => v.sku === glossy600.sku)?.totals.physical === 30
    && productStock.variants.find((v) => v.sku === matte800.sku)?.totals.physical === 20);

  console.log('\n12b. company and collection totals independently re-derived from the ledger, not trusted');
  const rawSum = await prisma.inventoryBalance.aggregate({
    where: { product: { brandId: company.id } }, _sum: { quantityOnHand: true },
  });
  check('12c. the company total exactly matches a raw SUM over inventory_balances',
    Number(rawSum._sum.quantityOnHand) === companyStock.totals.physical);

  console.log('\n13. warehouse-level inventory is unaffected by the hierarchy');
  const summary = await products.stockSummary(matte600.id);
  check('13a. a single variant\'s warehouse breakdown still works exactly as before',
    summary.byWarehouse.length === 1 && summary.byWarehouse[0].warehouseId === warehouse.id
    && Number(summary.byWarehouse[0].quantityOnHand) === 50);

  console.log('\n17. permission enforcement on product (ProductLine) writes');
  const mockReq = (actor) => ({ actor });
  const assertForbidden = async (actor) => new Promise((resolve) => {
    requirePermission('product:write')(mockReq(actor), {}, (err) => resolve(err));
  });
  const salesForbidden = await assertForbidden(sales);
  const adminAllowed = await assertForbidden(admin);
  check('17a. a sales-desk actor is refused product:write', salesForbidden?.code === 'FORBIDDEN');
  check('17b. an admin actor is allowed', adminAllowed === undefined);

  console.log('\n19. historical records are preserved, never silently altered');
  const seededCount = await prisma.product.count({ where: { brand: { code: { not: 'HTCO' } } } });
  check('19a. the seeded products from before this suite ran are still exactly fourteen',
    seededCount === 14, seededCount);
  const seededUngrouped = await prisma.product.count({ where: { brand: { code: { not: 'HTCO' } }, productLineId: null } });
  check('19b. none of them was silently grouped by this suite\'s own work', seededUngrouped === 14);
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

await disconnect();
process.exit(failures.length ? 1 : 0);
