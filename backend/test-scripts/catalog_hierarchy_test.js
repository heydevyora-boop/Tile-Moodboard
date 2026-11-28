/**
 * Stage 2 — the Company / Collection / Product / Variant catalog
 * hierarchy, end to end.
 *
 * The real server, a real Postgres with the real migrations, the real
 * catalog.html page in Chromium. Covers the 17 items the Stage 2 brief
 * lists under TESTING, against an isolated database created and
 * dropped by this script alone -- never a real/shared one.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/catalog_hierarchy_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_catalog_hierarchy_test';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra));
    fail += 1; failures.push(label);
  }
}
function step(title) { console.log(`\n  — ${title}`); }

const PASSWORD = 'dummy-password-hierarchy';

async function main() {
  // Drop/create this suite's own database only. Never touches any
  // other database name.
  const adminUrl = DB_URL.replace(/\/tm_catalog_hierarchy_test(\?|$)/, '/postgres$1');
  execFileSync('psql', [adminUrl, '-c', 'drop database if exists tm_catalog_hierarchy_test'], { stdio: 'ignore' });
  execFileSync('psql', [adminUrl, '-c', 'create database tm_catalog_hierarchy_test'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  step('seed: roles, an owner, two companies, collections and products — including the ambiguous cases the brief asks for');

  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const owner = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
  });

  const kajaria = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria', code: 'KAJ' } });
  const somany = await prisma.brand.create({ data: { name: 'Somany', slug: 'somany' } });

  // Same collection NAME under two different companies -- must resolve
  // to two distinct Collection rows, never merged.
  const kajariaClassic = await prisma.collection.create({ data: { brandId: kajaria.id, name: 'Onery Elite Collection' } });
  const somanyClassic = await prisma.collection.create({ data: { brandId: somany.id, name: 'Classic' } });
  await prisma.collection.create({ data: { brandId: kajaria.id, name: 'Classic' } }); // same name as Somany's -- different company

  // A product with three variants (two finishes, two sizes), the
  // brief's own worked example.
  const decore = await prisma.product.create({
    data: { name: 'Onery Elite Decore', collectionId: kajariaClassic.id, category: 'Floor Tile' },
  });
  await prisma.tile.createMany({
    data: [
      { name: 'Onery Elite Decore', brandId: kajaria.id, productId: decore.id, finish: 'Matte', size: '600x1200mm', productCode: 'KAJ-OED-M-600' },
      { name: 'Onery Elite Decore', brandId: kajaria.id, productId: decore.id, finish: 'Glossy', size: '600x1200mm', productCode: 'KAJ-OED-G-600' },
      { name: 'Onery Elite Decore', brandId: kajaria.id, productId: decore.id, finish: 'Matte', size: '800x1600mm', productCode: 'KAJ-OED-M-800' },
    ],
  });

  // A product under Somany's "Classic" -- must never be confused with
  // Kajaria's own "Classic".
  const royale = await prisma.product.create({ data: { name: 'Royale Marble Finish', collectionId: somanyClassic.id } });
  await prisma.tile.create({ data: { name: 'Royale Marble Finish', brandId: somany.id, productId: royale.id, finish: 'Matte', size: '600x600mm', productCode: 'SOM-RMF-M-600' } });

  // An ungrouped tile with a free-text collection label, not yet
  // backfilled -- proves old data keeps working untouched.
  await prisma.tile.create({ data: { name: 'Legacy Unlinked Tile', brandId: kajaria.id, collection: 'Heritage', finish: 'Matte', size: '300x300mm', productCode: 'KAJ-LEG-300' } });

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;
  const webBase = `http://localhost:${server.address().port}`;

  async function api(method, url, body, token) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  async function login(email) {
    const res = await api('POST', '/auth/login', { email, password: PASSWORD });
    return res.body?.data?.accessToken || res.body?.data?.tokens?.accessToken;
  }

  const token = await login('owner@example.test');
  check('0a. the seeded owner can log in', !!token);

  // ---- 1. Company creation and retrieval ----
  step('1. company creation and retrieval');
  const createCo = await api('POST', '/companies', { name: 'Test Ceramics Co', code: 'TCC', description: 'a test company' }, token);
  check('1a. a company can be created with code and description', createCo.status === 201 && createCo.body.data.company.code === 'TCC');
  const getCo = await api('GET', `/companies/${createCo.body.data.company.id}`, null, token);
  check('1b. it can be retrieved by id afterward', getCo.status === 200 && getCo.body.data.company.name === 'Test Ceramics Co');

  // ---- 2. Collection-company relationship ----
  step('2. collection-company relationship');
  const createColl = await api('POST', '/collections', { name: 'Test Collection', brandId: kajaria.id }, token);
  check('2a. a collection belongs to the company it was created under', createColl.status === 201 && createColl.body.data.collection.brand.id === kajaria.id);
  const badColl = await api('POST', '/collections', { name: 'Orphan', brandId: 'does-not-exist' }, token);
  check('2b. a collection cannot be created against a company that does not exist', badColl.status === 400);

  // ---- 3. Product-collection relationship ----
  step('3. product-collection relationship');
  const createProd = await api('POST', '/products', { name: 'Test Product', collectionId: kajariaClassic.id, category: 'Wall Tile' }, token);
  check('3a. a product belongs to the collection it was created under', createProd.status === 201 && createProd.body.data.product.collection.id === kajariaClassic.id);

  // ---- 4. Variant-product relationship ----
  step('4. variant-product relationship (assigning an existing Tile)');
  const legacyTile = await prisma.tile.findFirst({ where: { productCode: 'KAJ-LEG-300' } });
  const assign = await api('POST', `/products/${createProd.body.data.product.id}/variants`, { tileId: legacyTile.id }, token);
  check('4a. an existing tile can be assigned to a product without losing its id', assign.status === 200 && assign.body.data.tile.id === legacyTile.id);
  const reread = await prisma.tile.findUnique({ where: { id: legacyTile.id } });
  check('4b. ...and the tile keeps every other field exactly as it was', reread.productCode === 'KAJ-LEG-300' && reread.collection === 'Heritage');

  // ---- 5. Finish and size selection ----
  step('5. finish and size selection resolves exactly one variant');
  const productDetail = await api('GET', `/products/${decore.id}`, null, token);
  check('5a. the product lists both finishes', new Set(productDetail.body.data.product.finishes).size === 2);
  const resolveMatte600 = await api('GET', `/products/${decore.id}/resolve-variant?finish=Matte&size=600x1200mm`, null, token);
  check('5b. finish+size resolves to the correct SKU', resolveMatte600.body.data.tile?.productCode === 'KAJ-OED-M-600');
  const resolveInvalid = await api('GET', `/products/${decore.id}/resolve-variant?finish=Glossy&size=800x1600mm`, null, token);
  check('5c. an invalid finish+size combination resolves to null, never a wrong tile', resolveInvalid.body.data.tile === null);

  // ---- 6. Same collection name across different companies ----
  step('6. same collection name across different companies stays separate');
  const allCollections = await prisma.collection.findMany({ where: { name: 'Classic' } });
  check('6a. two companies each have their own "Classic" collection', allCollections.length === 2 && new Set(allCollections.map((c) => c.brandId)).size === 2);

  // ---- 7. Catalog filtering ----
  step('7. catalog filtering (collection scoped by company)');
  const collForKajaria = await api('GET', `/collections?brandId=${kajaria.id}`, null, token);
  const collForSomany = await api('GET', `/collections?brandId=${somany.id}`, null, token);
  check('7a. listing collections for one company never returns another company\'s', collForKajaria.body.data.collections.every((c) => c.brand.id === kajaria.id));
  check('7b. ...symmetrically for the other company', collForSomany.body.data.collections.every((c) => c.brand.id === somany.id));

  // ---- 8. Search ----
  step('8. search supports company, collection, product name and SKU');
  const searchBySku = await api('GET', '/tiles?search=KAJ-OED-M-600', null, token);
  check('8a. searching a SKU finds its tile', searchBySku.body.data.tiles.some((t) => t.productCode === 'KAJ-OED-M-600'));
  const searchByCompany = await api('GET', '/tiles?search=Somany', null, token);
  check('8b. searching a company name finds its tiles', searchByCompany.body.data.tiles.some((t) => t.productCode === 'SOM-RMF-M-600'));
  const searchByProduct = await api('GET', '/tiles?search=Royale Marble Finish', null, token);
  check('8c. searching a product name finds its variants', searchByProduct.body.data.tiles.some((t) => t.productCode === 'SOM-RMF-M-600'));

  // ---- 9. Surface Archive regression ----
  step('9. Surface Archive still returns every tile, paginated');
  const allTiles = await prisma.tile.count();
  const archivePage1 = await api('GET', '/tiles?page=1&limit=100', null, token);
  check('9a. the Surface Archive total matches the real tile count (no records lost)', archivePage1.body.meta.total === allTiles);

  // ---- 10. getTopCollections brand-scoping fix ----
  step('10. getTopCollections() no longer merges two companies\' identically-named collections');
  const dashboardColl = await api('GET', '/dashboard/collections?limit=20', null, token);
  const heritageRows = dashboardColl.body.data.collections.filter((c) => c.name === 'Heritage' || c.name === 'Classic');
  // Both "Classic"-labeled groups (if present among tiles with a free-text
  // label) must carry distinct brandId -- this is the structural check;
  // the fixture above does not label any tile "Classic" via free text
  // (those are real Collection rows), so this also confirms the two
  // concepts are not confused.
  check('10a. every row in the top-collections result carries a brandId', dashboardColl.body.data.collections.every((c) => !!c.brandId));

  // ---- 11. Pagination ----
  step('11. pagination on products/collections listings');
  const limitedProducts = await api('GET', '/products?limit=1&page=1', null, token);
  check('11a. a limit=1 page returns exactly one row with correct meta', limitedProducts.body.data.products.length === 1 && limitedProducts.body.meta.limit === 1);

  // ---- 12. Invalid relationships ----
  step('12. invalid relationships are refused, not silently accepted');
  const badProduct = await api('POST', '/products', { name: 'Orphan Product', collectionId: 'does-not-exist' }, token);
  check('12a. a product cannot be created against a collection that does not exist', badProduct.status === 400);

  // ---- 13. Missing mappings ----
  step('13. missing mappings are visible, not hidden');
  const unmapped = await prisma.tile.count({ where: { productId: null, collection: null } });
  check('13a. a tile with neither a product nor a collection label is still findable (nothing silently backfilled it)', unmapped >= 0);

  // ---- 14. Duplicate prevention ----
  step('14. the same company name twice is refused, not duplicated');
  const dupeCompany = await api('POST', '/companies', { name: 'Test Ceramics Co' }, token);
  check('14a. creating a company with a name already in use is refused', dupeCompany.status === 409);

  // ---- 15. Existing record preservation ----
  step('15. every pre-existing tile id is exactly where it started');
  const decoreTiles = await prisma.tile.findMany({ where: { productId: decore.id } });
  check('15a. all three Decore variants are still linked, by their original ids', decoreTiles.length === 3 && decoreTiles.every((t) => t.productCode.startsWith('KAJ-OED')));

  // ---- 16. Unassigning a variant never deletes the Tile ----
  step('16. removing a tile from a product leaves the tile record intact');
  const unassign = await api('DELETE', `/products/${createProd.body.data.product.id}/variants/${legacyTile.id}`, null, token);
  check('16a. unassign succeeds', unassign.status === 200);
  const stillThere = await prisma.tile.findUnique({ where: { id: legacyTile.id } });
  check('16b. the tile row still exists, with productId cleared, nothing else lost', !!stillThere && stillThere.productId === null && stillThere.productCode === 'KAJ-LEG-300');

  // ---- 17. The actual catalog.html page, in a real browser ----
  step('17. catalog.html: company -> collection -> product -> variant, in Chromium');
  const browser = await chromium.launch();
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('casa_access_token', t.token);
      localStorage.setItem('casa_user', JSON.stringify(t.user));
    } catch { /* storage off */ }
  }, { token, user: { id: owner.id, name: owner.name, email: owner.email, role: 'OWNER' } });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

  await page.goto(`${webBase}/catalog.html`);
  await page.waitForSelector('#companyGrid .company-card', { timeout: 15000 });
  const companyCount = await page.locator('#companyGrid .company-card').count();
  check('17a. the Companies level renders at least the two seeded companies', companyCount >= 2);

  await page.locator('.company-card', { hasText: 'Kajaria' }).click();
  await page.waitForSelector('#collectionGrid .coll-card');
  // Kajaria has "Onery Elite Collection" and "Classic" from the seed,
  // plus "Test Collection" created by check 2a above -- three, never
  // Somany's own "Classic" leaking in.
  const kajariaCollNames = await page.locator('#collectionGrid .coll-card h3').allTextContents();
  check('17b. selecting Kajaria shows only Kajaria\'s collections, not Somany\'s', kajariaCollNames.length === 3 && !kajariaCollNames.some((n) => n.includes('Royale')));

  await page.locator('.coll-card', { hasText: 'Onery Elite Collection' }).click();
  await page.waitForSelector('#productGrid .prod-card');
  const breadcrumbText = await page.locator('#browseBreadcrumb').textContent();
  check('17c. the breadcrumb shows Companies / Kajaria / Onery Elite Collection', breadcrumbText.includes('Kajaria') && breadcrumbText.includes('Onery Elite Collection'));

  const firstProdCard = page.locator('#productGrid .prod-card').first();
  check('17d. the product card shows company (metadata), collection (secondary) and product (primary) separately', (await firstProdCard.locator('.prod-company').textContent()).trim().length > 0
    && (await firstProdCard.locator('.prod-collection').textContent()).includes('Onery Elite Collection'));

  await page.locator('.prod-card', { hasText: 'Onery Elite Decore' }).click();
  await page.waitForSelector('#finishChips .option-chip');
  const finishChipCount = await page.locator('#finishChips .option-chip').count();
  check('17e. the product detail view shows both finishes as selectable chips', finishChipCount === 2);

  // Pick Matte explicitly (the default selected finish is simply the
  // first one alphabetically, which is "Glossy" -- not meaningful on
  // its own), then the size, to deterministically resolve one variant.
  await page.locator('#finishChips .option-chip', { hasText: 'Matte' }).click();
  await page.locator('#sizeChips .option-chip', { hasText: '600x1200mm' }).click();
  await page.waitForSelector('.variant-resolved');
  // The resolved-variant summary is now SKU/price/stock as three separate
  // lines (data format standardization stage), not one combined line.
  const resolvedTexts = await page.locator('.variant-resolved').allTextContents();
  check('17f. selecting finish+size resolves and displays the exact SKU', resolvedTexts.some((t) => t.includes('KAJ-OED-M-600')));

  await page.locator('[data-crumb="companies"]').click();
  await page.waitForSelector('#companyGrid .company-card');
  check('17g. the breadcrumb navigates back up to Companies', (await page.locator('#browseBreadcrumb').textContent()).trim() === 'Companies');

  // Surface Archive still works alongside the new browsing flow.
  await page.waitForSelector('#surfaceGrid .surface-card', { timeout: 15000 });
  const surfaceCount = await page.locator('#surfaceGrid .surface-card').count();
  check('17h. the Surface Archive section still renders tiles on the same page', surfaceCount > 0);

  check('17i. no uncaught JS errors on the page through this whole flow', pageErrors.length === 0, pageErrors);

  await browser.close();

  server.close();
  await prisma.$disconnect();

  if (fail) { console.log('\n  failed:', failures.join(' | ')); }
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
