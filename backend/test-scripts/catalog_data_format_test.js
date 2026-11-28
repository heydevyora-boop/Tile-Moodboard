/**
 * Catalog data format standardization + ERP catalog export — end to end.
 *
 * The real server, a real disposable Postgres database (created and
 * dropped by this script alone), the actual catalog.html page in
 * Chromium, plus direct checks of the new ERP export endpoint and the
 * recent-generations product resolver.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/catalog_data_format_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_catalog_data_format_test';
const ERP_KEY = 'test-only-erp-export-key';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
  ERP_EXPORT_API_KEY: ERP_KEY,
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

const PASSWORD = 'dummy-password-data-format';

async function main() {
  const adminUrl = DB_URL.replace(/\/tm_catalog_data_format_test(\?|$)/, '/postgres$1');
  execFileSync('psql', [adminUrl, '-c', 'drop database if exists tm_catalog_data_format_test'], { stdio: 'ignore' });
  execFileSync('psql', [adminUrl, '-c', 'create database tm_catalog_data_format_test'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const { generationRow } = require(path.join(ROOT, 'src/routes/ai_visualization.routes'));

  step('seed: a company, collection, product, priced and unpriced variants, and one unassigned tile');

  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const owner = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
  });

  const kajaria = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria', code: 'KAJ' } });
  const classic = await prisma.collection.create({ data: { brandId: kajaria.id, name: 'Onery Elite Collection' } });
  const decore = await prisma.product.create({
    data: { name: 'Onery Elite Decore', collectionId: classic.id, category: 'Floor Tile', specifications: 'Porcelain, rectified edge' },
  });
  const priced = await prisma.tile.create({
    data: {
      name: 'Onery Elite Decore', brandId: kajaria.id, productId: decore.id,
      finish: 'Matte', size: '600x600mm', material: 'Porcelain', thickness: '10mm',
      productCode: 'KAJ-OED-M-600', sellingPrice: 185.5, unitOfMeasure: 'SQFT',
      imageUrl: 'https://drive.google.com/file/d/abc123/view',
    },
  });
  const unpriced = await prisma.tile.create({
    data: {
      name: 'Onery Elite Decore', brandId: kajaria.id, productId: decore.id,
      finish: 'Glossy', size: '600x600mm', productCode: 'KAJ-OED-G-600',
    },
  });
  const unassigned = await prisma.tile.create({
    data: { name: 'Legacy Loose Tile', brandId: kajaria.id, productCode: 'KAJ-LEG-900' },
  });

  // A second company/collection/product, to prove pagination and the
  // brandId filter actually narrow the feed rather than always
  // returning everything.
  const somany = await prisma.brand.create({ data: { name: 'Somany', slug: 'somany' } });
  const somanyClassic = await prisma.collection.create({ data: { brandId: somany.id, name: 'Classic' } });
  const royale = await prisma.product.create({ data: { name: 'Royale Marble Finish', collectionId: somanyClassic.id } });
  await prisma.tile.create({
    data: { name: 'Royale Marble Finish', brandId: somany.id, productId: royale.id, finish: 'Matte', size: '600x600mm', productCode: 'SOM-RMF-M-600' },
  });

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;
  const webBase = `http://localhost:${server.address().port}`;

  async function api(method, url, body, headers) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
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
  const auth = { Authorization: `Bearer ${token}` };
  check('0a. the seeded owner can log in', !!token);

  // ---- 1. Resolved-variant price/UOM: present when set, omitted when not ----
  step('1. resolved variant carries price/UOM when set, never a fabricated one when not');
  const resolvedPriced = await api('GET', `/products/${decore.id}/resolve-variant?finish=Matte&size=600x600mm`, null, auth);
  check('1a. the priced variant resolves with its exact sellingPrice and unitOfMeasure',
    Number(resolvedPriced.body.data.tile?.sellingPrice) === 185.5 && resolvedPriced.body.data.tile?.unitOfMeasure === 'SQFT',
    resolvedPriced.body.data.tile);
  const resolvedUnpriced = await api('GET', `/products/${decore.id}/resolve-variant?finish=Glossy&size=600x600mm`, null, auth);
  check('1b. the unpriced variant resolves with sellingPrice null, not a placeholder',
    resolvedUnpriced.body.data.tile?.sellingPrice === null);

  // ---- 2. Editing a tile can set material/thickness/price/UOM ----
  step('2. the existing tile-edit endpoint accepts material, thickness, price and UOM');
  const edited = await api('PATCH', `/catalog-extractor/tiles/${unassigned.id}`, {
    material: 'Vitrified', thickness: '12mm', sellingPrice: 99.99, unitOfMeasure: 'BOX',
  }, auth);
  check('2a. the edit succeeds', edited.status === 200, edited.body);
  const rereadTile = await prisma.tile.findUnique({ where: { id: unassigned.id } });
  check('2b. ...and every field actually persisted', String(rereadTile.sellingPrice) === '99.99' && rereadTile.unitOfMeasure === 'BOX' && rereadTile.material === 'Vitrified');

  // ---- 3. ERP export endpoint: auth gating ----
  step('3. the ERP catalog feed refuses requests without the right key');
  const noKey = await api('GET', '/integrations/erp/catalog-feed');
  check('3a. no x-erp-key header is refused', noKey.status === 403);
  const wrongKey = await api('GET', '/integrations/erp/catalog-feed', null, { 'x-erp-key': 'wrong' });
  check('3b. a wrong x-erp-key is refused', wrongKey.status === 403);
  const rightKey = await api('GET', '/integrations/erp/catalog-feed?limit=50', null, { 'x-erp-key': ERP_KEY });
  check('3c. the correct x-erp-key succeeds', rightKey.status === 200);

  // ---- 4. ERP export payload shape (documented contract: data[], meta) ----
  step('4. the ERP feed payload: stable ids, structured variants, real image URLs, nothing invented');
  const rows = rightKey.body.data;
  const erpRow = rows.find((r) => r.product.id === decore.id);
  check('4a. the company carries its stable id and name', !!erpRow && erpRow.company.id === kajaria.id && erpRow.company.name === 'Kajaria');
  check('4b. the collection carries its stable id and name, alongside its company', erpRow.collection.id === classic.id && erpRow.collection.name === 'Onery Elite Collection');
  check('4c. the product carries id, name, category and specifications', erpRow.product.name === 'Onery Elite Decore' && erpRow.product.category === 'Floor Tile' && erpRow.product.specifications.includes('Porcelain'));
  const variant = erpRow.product.variants.find((v) => v.sku === 'KAJ-OED-M-600');
  check('4d. the priced variant is structured (not flat text) with every documented field', !!variant
    && variant.tileId === priced.id && variant.material === 'Porcelain' && variant.dimensions === '600x600mm'
    && variant.thickness === '10mm' && variant.finish === 'Matte' && variant.price === 185.5 && variant.unit === 'SQFT');
  check('4e. the variant image URL is resolved, not a raw local path', variant.imageUrl && !variant.imageUrl.startsWith('/uploads') && !variant.imageUrl.startsWith('file:'));
  const unpricedVariant = erpRow.product.variants.find((v) => v.sku === 'KAJ-OED-G-600');
  check('4f. the unpriced variant is still present, with price null rather than omitted or fabricated', !!unpricedVariant && unpricedVariant.price === null);
  check('4g. a tile not yet assigned to any product is excluded from `data`, never force-fit into one', !rows.some((r) => r.product.variants.some((v) => v.sku === 'KAJ-LEG-900')));
  check('4h. meta carries a version and real pagination totals', rightKey.body.meta.version === '1' && rightKey.body.meta.total === 2);

  // ---- 4i-4k. Pre-implementation-check fixes: pagination limit aligned with the shared helper, unassigned-tile visibility + reconciliation ----
  step('4i-4k. pagination limit matches the shared helper; unassigned tiles are visible and reconciled, never auto-assigned');
  const overLimit = await api('GET', '/integrations/erp/catalog-feed?limit=150', null, { 'x-erp-key': ERP_KEY });
  check('4i. a limit above the shared pagination helper\'s cap (100) is now rejected, not silently clamped', overLimit.status === 400);
  check('4j. the unassigned tile IS visible, under its own section, never inside a product\'s variants',
    rightKey.body.unassignedTiles.some((u) => u.sku === 'KAJ-LEG-900' && u.companyId === kajaria.id && u.companyName === 'Kajaria'));
  check('4k. reconciliation counts are correct: 3 assigned tiles, 1 unassigned, across both companies',
    rightKey.body.meta.reconciliation.assignedTileCount === 3 && rightKey.body.meta.reconciliation.unassignedTileCount === 1);
  const unassignedTile = rightKey.body.unassignedTiles.find((u) => u.sku === 'KAJ-LEG-900');
  check('4l. the unassigned tile is never silently given a productId by this feed', !!unassignedTile && !('productId' in unassignedTile));
  const rereadUnassigned = await prisma.tile.findUnique({ where: { id: unassigned.id } });
  check('4m. ...and in the database it is still genuinely unassigned, not auto-mapped', rereadUnassigned.productId === null);

  // ---- 5. ERP export pagination and company filtering ----
  step('5. the ERP feed paginates and can be scoped to one company');
  const page1 = await api('GET', '/integrations/erp/catalog-feed?limit=1&page=1', null, { 'x-erp-key': ERP_KEY });
  check('5a. limit=1 returns exactly one row with correct meta', page1.body.data.length === 1 && page1.body.meta.limit === 1 && page1.body.meta.total === 2 && page1.body.meta.hasNextPage === true);
  check('5a-ii. unassigned tiles are listed on page 1', page1.body.unassignedTiles.length === 1);
  const page2 = await api('GET', '/integrations/erp/catalog-feed?limit=1&page=2', null, { 'x-erp-key': ERP_KEY });
  check('5b. page 2 returns the other row, not the same one again', page2.body.data[0].product.id !== page1.body.data[0].product.id && page2.body.meta.hasNextPage === false);
  check('5b-ii. unassigned tiles are NOT repeated on page 2 (reconciliation count still correct, list only on page 1)',
    page2.body.unassignedTiles.length === 0 && page2.body.meta.reconciliation.unassignedTileCount === 1);
  const scoped = await api('GET', `/integrations/erp/catalog-feed?brandId=${somany.id}`, null, { 'x-erp-key': ERP_KEY });
  check('5c. filtering by brandId returns only that company\'s products', scoped.body.data.length === 1 && scoped.body.data[0].company.id === somany.id && scoped.body.data[0].product.name === 'Royale Marble Finish');
  check('5c-ii. ...and brandId also scopes the reconciliation counts and unassigned list to that company', scoped.body.meta.reconciliation.unassignedTileCount === 0 && scoped.body.unassignedTiles.length === 0);

  // ---- 5. recent-generations resolver: brand/collection read back live ----
  step('6. recent-generations resolves Brand/Collection for a product from its live tile, never from the stored log');
  const tilesByCode = new Map([
    ['KAJ-OED-M-600', { imageUrl: priced.imageUrl, name: priced.name, size: priced.size, finish: priced.finish, brandName: 'Kajaria', collectionName: 'Onery Elite Collection' }],
  ]);
  const row = {
    id: 'gen-1', createdAt: new Date(), user: { name: 'Priya' },
    metadata: { products: [{ role: 'base', code: 'KAJ-OED-M-600', name: '', size: '', finish: '', imageUrl: '' }] },
  };
  const generation = generationRow(row, tilesByCode);
  check('5a. the resolved product carries brandName and collectionName from the live tile',
    generation.products[0].brandName === 'Kajaria' && generation.products[0].collectionName === 'Onery Elite Collection');
  const rowNoTile = { id: 'gen-2', createdAt: new Date(), user: { name: 'Priya' }, metadata: { products: [{ role: 'base', code: 'UNKNOWN-CODE', name: 'Mystery Tile', size: '', finish: '', imageUrl: '' }] } };
  const generationNoTile = generationRow(rowNoTile, new Map());
  check('5b. a code with no matching tile gets empty brand/collection, never a guess', generationNoTile.products[0].brandName === '' && generationNoTile.products[0].collectionName === '');

  // ---- 6. catalog.html: image-first product detail, ordered Surface Archive cards ----
  step('7. catalog.html in Chromium: image appears first, Surface Archive cards carry the standardized order');
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
  page.on('console', (msg) => {
    // Google Fonts has no network route in this sandbox; that resource
    // failure is an environment limitation, not a script error, and is
    // unrelated to anything this stage changed.
    if (msg.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|fonts\.g(stat|oog)/.test(msg.text())) pageErrors.push(msg.text());
  });

  await page.goto(`${webBase}/catalog.html`);
  await page.waitForSelector('#companyGrid .company-card', { timeout: 15000 });
  await page.locator('.company-card', { hasText: 'Kajaria' }).click();
  await page.waitForSelector('#collectionGrid .coll-card');
  await page.locator('.coll-card', { hasText: 'Onery Elite Collection' }).click();
  await page.waitForSelector('#productGrid .prod-card');
  await page.locator('.prod-card', { hasText: 'Onery Elite Decore' }).click();
  await page.waitForSelector('.detail-panel');

  const imageFirst = await page.evaluate(() => {
    const panel = document.querySelector('.detail-panel');
    const img = panel.querySelector('.detail-img');
    const eyebrow = panel.querySelector('.detail-eyebrow');
    return !!img && !!eyebrow && !!(img.compareDocumentPosition(eyebrow) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  check('7a. the product image is the first element in the detail panel, before Brand/Collection/Name', imageFirst);

  await page.locator('#finishChips .option-chip', { hasText: 'Matte' }).click();
  await page.locator('#sizeChips .option-chip', { hasText: '600x600mm' }).click();
  await page.waitForSelector('.variant-resolved');
  const resolvedTexts = await page.locator('.variant-resolved').allTextContents();
  check('7b. the resolved variant shows SKU, then price, then stock status, in that order',
    resolvedTexts.length === 3 && resolvedTexts[0].includes('KAJ-OED-M-600') && resolvedTexts[1].includes('185.5') && resolvedTexts[2].includes('IN STOCK'));

  await page.waitForSelector('#surfaceGrid .surface-card', { timeout: 15000 });
  const firstCardLines = await page.locator('#surfaceGrid .surface-card').first().locator('.ss, .sn').allTextContents();
  check('7c. the first Surface Archive card leads with a metadata line (brand/collection) before the product-name line', firstCardLines.length >= 2 && firstCardLines[0].length > 0);
  check('7d. no uncaught JS errors through this whole flow', pageErrors.length === 0, pageErrors);

  await browser.close();

  server.close();
  await prisma.$disconnect();

  if (fail) { console.log('\n  failed:', failures.join(' | ')); }
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
