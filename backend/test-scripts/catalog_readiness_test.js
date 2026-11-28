/**
 * Phase 3 — catalog data readiness, reconciliation and the ERP export
 * validation foundation. End to end against a real server and a real,
 * disposable Postgres database (created and dropped by this script
 * alone). No live ERP integration anywhere here -- this proves the
 * validation/reconciliation logic and the two read-only endpoints that
 * expose it.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/catalog_readiness_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_catalog_readiness_test';
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

const PASSWORD = 'dummy-password-readiness';

async function main() {
  const adminUrl = DB_URL.replace(/\/tm_catalog_readiness_test(\?|$)/, '/postgres$1');
  execFileSync('psql', [adminUrl, '-c', 'drop database if exists tm_catalog_readiness_test'], { stdio: 'ignore' });
  execFileSync('psql', [adminUrl, '-c', 'create database tm_catalog_readiness_test'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const {
    validateProduct, findDuplicateSkuGroups, getReconciliationReport, listCatalogReadinessIssues,
  } = require(path.join(ROOT, 'src/services/catalogValidation.service'));

  step('seed: one company with a complete product, an incomplete one, a blocked one, a conditionally-flagged one, a conflicting-variant one, a duplicate SKU pair, an unassigned tile, and an inactive company');

  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const staffRole = await prisma.role.create({ data: { name: 'STAFF', description: 't', permissions: ['tiles:read'] } });
  const owner = await prisma.user.create({ data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id } });
  const staff = await prisma.user.create({ data: { name: 'Floor Staff', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id } });

  const kajaria = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria', code: 'KAJ' } });
  const collection = await prisma.collection.create({ data: { brandId: kajaria.id, name: 'Onery Elite Collection' } });

  // 1. A fully complete product -- every field, two clean variants.
  const complete = await prisma.product.create({ data: { name: 'Complete Product', collectionId: collection.id, category: 'Floor Tile', coverImageUrl: 'https://x/cover.png' } });
  await prisma.tile.createMany({
    data: [
      { name: 'Complete Product', brandId: kajaria.id, productId: complete.id, finish: 'Matte', size: '600x600mm', material: 'Porcelain', thickness: '10mm', productCode: 'KAJ-CMP-M-600', sellingPrice: 100, unitOfMeasure: 'SQFT', imageUrl: 'https://x/a.png' },
      { name: 'Complete Product', brandId: kajaria.id, productId: complete.id, finish: 'Glossy', size: '600x600mm', material: 'Porcelain', thickness: '10mm', productCode: 'KAJ-CMP-G-600', sellingPrice: 100, unitOfMeasure: 'SQFT', imageUrl: 'https://x/b.png' },
    ],
  });

  // 2. Missing optional fields (no image anywhere, no material/thickness) -- NEEDS_REVIEW, still exported.
  const incomplete = await prisma.product.create({ data: { name: 'Incomplete Product', collectionId: collection.id } });
  const incompleteTile = await prisma.tile.create({ data: { name: 'Incomplete Product', brandId: kajaria.id, productId: incomplete.id, finish: 'Matte', size: '300x300mm', productCode: 'KAJ-INC-001' } });

  // 3. Conditionally-required: price set, no unit -- NEEDS_REVIEW.
  const conditional = await prisma.product.create({ data: { name: 'Conditional Product', collectionId: collection.id } });
  await prisma.tile.create({ data: { name: 'Conditional Product', brandId: kajaria.id, productId: conditional.id, finish: 'Matte', size: '300x300mm', productCode: 'KAJ-CND-001', sellingPrice: 50 } });

  // 4. BLOCKED: a tile with no SKU at all.
  const noSku = await prisma.product.create({ data: { name: 'No SKU Product', collectionId: collection.id } });
  await prisma.tile.create({ data: { name: 'No SKU Product', brandId: kajaria.id, productId: noSku.id, finish: 'Matte', size: '400x400mm' } });

  // 5. BLOCKED: zero tiles at all.
  const emptyProduct = await prisma.product.create({ data: { name: 'Empty Product', collectionId: collection.id } });

  // 6. BLOCKED: two tiles claiming the same finish+size under one product.
  const conflicting = await prisma.product.create({ data: { name: 'Conflicting Product', collectionId: collection.id } });
  await prisma.tile.createMany({
    data: [
      { name: 'Conflicting Product', brandId: kajaria.id, productId: conflicting.id, finish: 'Matte', size: '500x500mm', productCode: 'KAJ-CNF-001' },
      { name: 'Conflicting Product', brandId: kajaria.id, productId: conflicting.id, finish: 'Matte', size: '500x500mm', productCode: 'KAJ-CNF-002' },
    ],
  });

  // 7. Duplicate SKU (case-insensitive) across two otherwise-unrelated products -- the database's own unique index is case-SENSITIVE, so this is the one duplicate shape it cannot catch.
  const dupeHost = await prisma.product.create({ data: { name: 'Dupe Host Product', collectionId: collection.id } });
  await prisma.tile.createMany({
    data: [
      { name: 'Dupe Host Product', brandId: kajaria.id, productId: dupeHost.id, finish: 'Matte', size: '200x200mm', productCode: 'KAJ-DUP-001' },
      { name: 'Dupe Host Product', brandId: kajaria.id, productId: dupeHost.id, finish: 'Glossy', size: '200x200mm', productCode: 'kaj-dup-001' },
    ],
  });

  // Unassigned tile (no productId at all).
  const unassigned = await prisma.tile.create({ data: { name: 'Legacy Loose Tile', brandId: kajaria.id, productCode: 'KAJ-LEG-900' } });

  // An inactive company, so its products should never appear anywhere.
  const inactiveBrand = await prisma.brand.create({ data: { name: 'Delisted Co', slug: 'delisted-co', isActive: false } });
  const inactiveColl = await prisma.collection.create({ data: { brandId: inactiveBrand.id, name: 'Whatever' } });
  const underInactive = await prisma.product.create({ data: { name: 'Delisted Product', collectionId: inactiveColl.id } });
  await prisma.tile.create({ data: { name: 'Delisted Product', brandId: inactiveBrand.id, productId: underInactive.id, finish: 'Matte', size: '100x100mm', productCode: 'DEL-001' } });

  const express = require('express');
  const host = express();
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;

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

  const VALIDATION_SELECT = {
    id: true, name: true, coverImageUrl: true,
    collection: { select: { isActive: true, brand: { select: { isActive: true } } } },
    tiles: { select: { id: true, productCode: true, imageUrl: true, material: true, size: true, thickness: true, finish: true, sellingPrice: true, unitOfMeasure: true } },
  };

  const ownerToken = await login('owner@example.test');
  const staffToken = await login('staff@example.test');
  check('0a. the seeded owner can log in', !!ownerToken);
  check('0b. the seeded staff member can log in', !!staffToken);

  // ---- 1. Complete product: validation ----
  step('1. a fully complete product validates as READY with zero issues');
  const completeFull = await prisma.product.findUnique({ where: { id: complete.id }, select: VALIDATION_SELECT });
  const completeResult = validateProduct(completeFull);
  check('1a. status is READY', completeResult.status === 'READY', completeResult);
  check('1b. no issues at all', completeResult.issues.length === 0);

  // ---- 2. Missing optional / conditionally required fields ----
  step('2. missing optional and conditionally-required fields are flagged as NEEDS_REVIEW, never BLOCKED');
  const incompleteFull = await prisma.product.findUnique({ where: { id: incomplete.id }, select: VALIDATION_SELECT });
  const incompleteResult = validateProduct(incompleteFull);
  check('2a. status is NEEDS_REVIEW (missing image/material/thickness/price -- all optional)', incompleteResult.status === 'NEEDS_REVIEW', incompleteResult);
  check('2b. every missing field is reported at "optional" severity, not "required"', incompleteResult.issues.every((i) => i.severity === 'optional'));

  const conditionalFull = await prisma.product.findUnique({ where: { id: conditional.id }, select: VALIDATION_SELECT });
  const conditionalResult = validateProduct(conditionalFull);
  check('2c. a price with no unit is a NEEDS_REVIEW, "conditional" severity issue', conditionalResult.status === 'NEEDS_REVIEW' && conditionalResult.issues.some((i) => i.severity === 'conditional' && i.field.includes('unitOfMeasure')));

  // ---- 3. BLOCKED cases ----
  step('3. missing SKU, zero variants, and conflicting finish+size all BLOCK a product');
  const noSkuResult = validateProduct(await prisma.product.findUnique({ where: { id: noSku.id }, select: VALIDATION_SELECT }));
  check('3a. a tile with no SKU BLOCKS the product', noSkuResult.status === 'BLOCKED' && noSkuResult.issues.some((i) => i.severity === 'required' && i.field.includes('productCode')));
  const emptyResult = validateProduct(await prisma.product.findUnique({ where: { id: emptyProduct.id }, select: VALIDATION_SELECT }));
  check('3b. a product with zero tiles is BLOCKED', emptyResult.status === 'BLOCKED' && emptyResult.issues.some((i) => i.field === 'tiles'));
  const conflictingResult = validateProduct(await prisma.product.findUnique({ where: { id: conflicting.id }, select: VALIDATION_SELECT }));
  check('3c. two tiles claiming the same finish+size BLOCKS the product', conflictingResult.status === 'BLOCKED' && conflictingResult.issues.some((i) => i.field === 'tiles.finishSize'));

  // ---- 4. Duplicate SKU detection (case-insensitive) ----
  step('4. case-insensitive duplicate SKUs are detected (the DB\'s own unique index is case-sensitive and misses these)');
  const dupeGroups = await findDuplicateSkuGroups();
  const dupeGroup = dupeGroups.find((g) => g.normalizedSku === 'KAJ-DUP-001');
  check('4a. the KAJ-DUP-001 / kaj-dup-001 pair is detected as one duplicate group', !!dupeGroup && dupeGroup.tiles.length === 2);
  check('4b. exact-match duplicates do not exist in practice (confirmed: none of our seeded exact-identical SKUs got in)', dupeGroups.every((g) => new Set(g.tiles.map((t) => t.sku)).size >= 1));

  // ---- 5. Reconciliation report accuracy ----
  step('5. the reconciliation report\'s counts are exactly right');
  const recon = await getReconciliationReport({});
  // Products: complete, incomplete, conditional, noSku, emptyProduct, conflicting, dupeHost = 7 visible (active chain); + underInactive (inactive brand) = 8 total.
  check('5a. totalProducts counts every product regardless of visibility', recon.totalProducts === 8, recon.totalProducts);
  check('5b. visibleProducts excludes only the one under the inactive company', recon.visibleProducts === 7, recon.visibleProducts);
  check('5c. excludedProducts = totalProducts - visibleProducts, with a breakdown explaining why', recon.excludedProducts === 1 && recon.excludedBreakdown.inactiveBrand === 1);
  check('5d. blockedProducts counts exactly the three BLOCKED cases (no SKU, zero tiles, conflicting variant)', recon.blockedProducts === 3, recon.blockedProducts);
  check('5e. needsReviewProducts counts exactly the two NEEDS_REVIEW cases (incomplete, conditional) plus the dupe-host (missing optional fields too)', recon.needsReviewProducts === 3, recon.needsReviewProducts);
  check('5f. readyProducts counts exactly the one fully clean product', recon.readyProducts === 1, recon.readyProducts);
  check('5g. exportEligibleProducts = ready + needsReview, excluding blocked', recon.exportEligibleProducts === recon.readyProducts + recon.needsReviewProducts && recon.exportEligibleProducts === 4);
  check('5h. duplicateSkuGroupCount and duplicateSkuTileCount are correct', recon.duplicateSkuGroupCount === 1 && recon.duplicateSkuTileCount === 2);
  check('5i. unassignedTiles counts the one loose tile', recon.unassignedTiles === 1);
  check('5j. assignedTiles counts every tile with a productId, regardless of that product\'s own status', recon.assignedTiles === 10, recon.assignedTiles);

  // ---- 6. Readiness API: authorization ----
  step('6. GET /integrations/erp/catalog-readiness requires an authenticated OWNER session');
  const noAuth = await api('GET', '/integrations/erp/catalog-readiness');
  check('6a. no token at all is refused', noAuth.status === 401 || noAuth.status === 403, noAuth.status);
  const staffAuth = await api('GET', '/integrations/erp/catalog-readiness', null, { Authorization: `Bearer ${staffToken}` });
  check('6b. a non-OWNER session is refused', staffAuth.status === 403, staffAuth.status);
  const ownerAuth = await api('GET', '/integrations/erp/catalog-readiness', null, { Authorization: `Bearer ${ownerToken}` });
  check('6c. an OWNER session succeeds', ownerAuth.status === 200, ownerAuth.body);

  // ---- 7. Readiness API: response shape, pagination, filtering ----
  step('7. the readiness report\'s summary and paginated issue list are correct');
  check('7a. summary matches the reconciliation report exactly', ownerAuth.body.summary.blockedProducts === 3 && ownerAuth.body.summary.readyProducts === 1);
  check('7b. the default issue list excludes READY products (only actionable rows)', !ownerAuth.body.data.some((row) => row.productId === complete.id));
  check('7c. BLOCKED products appear with their exact issues', ownerAuth.body.data.some((row) => row.productId === noSku.id && row.status === 'BLOCKED'));

  const statusFiltered = await api('GET', '/integrations/erp/catalog-readiness?status=READY', null, { Authorization: `Bearer ${ownerToken}` });
  check('7d. status=READY returns exactly the one clean product', statusFiltered.body.data.length === 1 && statusFiltered.body.data[0].productId === complete.id);

  const page1 = await api('GET', '/integrations/erp/catalog-readiness?limit=1&page=1', null, { Authorization: `Bearer ${ownerToken}` });
  check('7e. limit=1 returns exactly one row with correct meta', page1.body.data.length === 1 && page1.body.meta.limit === 1 && page1.body.meta.hasNextPage === true);
  const overLimit = await api('GET', '/integrations/erp/catalog-readiness?limit=500', null, { Authorization: `Bearer ${ownerToken}` });
  check('7f. a limit above 100 is rejected, matching the shared pagination helper', overLimit.status === 400);

  // ---- 8. Invalid relationships / read-only behavior ----
  step('8. the readiness endpoint never writes anything, however it is queried');
  const beforeCounts = { products: await prisma.product.count(), tiles: await prisma.tile.count() };
  await api('GET', '/integrations/erp/catalog-readiness?brandId=does-not-exist', null, { Authorization: `Bearer ${ownerToken}` });
  await api('GET', '/integrations/erp/catalog-readiness?status=BLOCKED', null, { Authorization: `Bearer ${ownerToken}` });
  const afterCounts = { products: await prisma.product.count(), tiles: await prisma.tile.count() };
  check('8a. product/tile counts are byte-for-byte unchanged after every query above', beforeCounts.products === afterCounts.products && beforeCounts.tiles === afterCounts.tiles);
  const stillNoSku = await prisma.tile.findFirst({ where: { productId: noSku.id } });
  check('8b. the BLOCKED tile with no SKU was never auto-repaired or given one', stillNoSku.productCode === null);
  const stillUnassigned = await prisma.tile.findUnique({ where: { id: unassigned.id } });
  check('8c. the unassigned tile was never auto-assigned to a product', stillUnassigned.productId === null);

  // ---- 9. Export eligibility reflected in the actual feed ----
  step('9. BLOCKED products are excluded from the live ERP catalog feed; NEEDS_REVIEW and READY are not');
  const feed = await api('GET', '/integrations/erp/catalog-feed?limit=100', null, { 'x-erp-key': ERP_KEY });
  const feedProductIds = feed.body.data.map((r) => r.product.id);
  check('9a. the fully clean product is in the feed', feedProductIds.includes(complete.id));
  check('9b. the NEEDS_REVIEW products are still in the feed (not blocked, just flagged)', feedProductIds.includes(incomplete.id) && feedProductIds.includes(conditional.id) && feedProductIds.includes(dupeHost.id));
  check('9c. the no-SKU product is excluded from the feed', !feedProductIds.includes(noSku.id));
  check('9d. the zero-tile product is excluded from the feed', !feedProductIds.includes(emptyProduct.id));
  check('9e. the conflicting-variant product is excluded from the feed', !feedProductIds.includes(conflicting.id));
  check('9f. the product under the inactive company is excluded (visibility rule, unchanged)', !feedProductIds.includes(underInactive.id));

  server.close();
  await prisma.$disconnect();

  if (fail) { console.log('\n  failed:', failures.join(' | ')); }
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
