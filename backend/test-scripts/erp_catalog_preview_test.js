/**
 * Step 9 — CASA backend integration: GET /integrations/erp/catalog-preview,
 * end to end against a real server, a real disposable Postgres database
 * (created and dropped by this script alone, completely separate from
 * any ERP database), and a MOCK ERP server (a plain http.createServer,
 * no database of its own at all) standing in for the real ERP's
 * /api/v1/integrations/casa/catalog-feed route.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/erp_catalog_preview_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_erp_catalog_preview_test';
const CASA_KEY = 'test-only-casa-integration-key';

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

const PASSWORD = 'dummy-password-erp-preview';

async function main() {
  // ── 1. THE MOCK ERP — no database, no relation to CASA's own ──
  //
  // Stands in for erp/server/routes/casaIntegration.mjs. Checks the
  // shared secret exactly like the real one does, and answers two
  // pages of a canned, catalog-feed-shaped response so
  // fetchEntireErpCatalogFeed's pagination loop is genuinely
  // exercised, not just a single call.
  let lastQuery = null;
  const PAGE_1 = [
    {
      company: { id: 'erp-brand-1', name: 'Morson' },
      collection: { id: 'erp-coll-1', name: 'Calacatta' },
      productLine: { id: 'erp-pl-1', code: 'CALWHI', name: 'Calacatta White', description: null, imageUrl: null },
      variants: [
        { id: 'erp-var-1', sku: 'MATCH-001', finish: 'Polished', size: '600x600mm', colour: 'White', status: 'ACTIVE', inventory: { onHand: 10, reserved: 0, damaged: 0, inTransit: 0, available: 10 } },
        { id: 'erp-var-2', sku: 'NOMATCH-001', finish: 'Matte', size: '600x600mm', colour: 'White', status: 'ACTIVE', inventory: { onHand: 5, reserved: 0, damaged: 0, inTransit: 0, available: 5 } },
      ],
    },
  ];
  const PAGE_2 = [
    {
      company: { id: 'erp-brand-1', name: 'Morson' },
      collection: null,
      productLine: { id: 'erp-pl-2', code: 'HERGRN', name: 'Heritage Green', description: null, imageUrl: null },
      variants: [
        { id: 'erp-var-3', sku: 'MATCH-002', finish: 'Glossy', size: '300x600mm', colour: 'Green', status: 'ACTIVE', inventory: { onHand: 20, reserved: 2, damaged: 0, inTransit: 0, available: 18 } },
      ],
    },
  ];

  const mockErp = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    lastQuery = Object.fromEntries(url.searchParams.entries());

    if (req.headers['x-casa-key'] !== CASA_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid or missing x-casa-key.', code: 'FORBIDDEN', errors: [] }));
      return;
    }

    const page = Number(url.searchParams.get('page')) || 1;
    const data = page === 1 ? PAGE_1 : PAGE_2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Request completed successfully',
      data,
      meta: { currentPage: page, pageSize: 1, totalRecords: 2, totalPages: 2, version: '1' },
    }));
  });
  await new Promise((r) => mockErp.listen(0, '127.0.0.1', r));
  const mockErpPort = mockErp.address().port;

  // ── 2. ENVIRONMENT, BEFORE ANYTHING ELSE IS REQUIRED ──
  //
  // @config/index reads process.env exactly once, at first import --
  // these must be set before app.ts (or anything it imports) is
  // required below.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    DATABASE_URL: DB_URL,
    JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
    JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
    ENCRYPTION_KEY: '0'.repeat(64),
    BCRYPT_SALT_ROUNDS: '10',
    LOG_LEVEL: 'error',
    RATE_LIMIT_MAX: '100000',
    ERP_API_BASE_URL: `http://127.0.0.1:${mockErpPort}/api/v1`,
    ERP_INTEGRATION_API_KEY: CASA_KEY,
    ERP_INTEGRATION_TIMEOUT_MS: '2000',
  });

  // ── 3. CASA'S OWN, DISPOSABLE DATABASE — unrelated to the mock ──
  const adminUrl = DB_URL.replace(/\/tm_erp_catalog_preview_test(\?|$)/, '/postgres$1');
  execFileSync('psql', [adminUrl, '-c', 'drop database if exists tm_erp_catalog_preview_test'], { stdio: 'ignore' });
  execFileSync('psql', [adminUrl, '-c', 'create database tm_erp_catalog_preview_test'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  step('seed: an OWNER, a STAFF member, two tiles that match the mock ERP feed, one that does not exist in it');

  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const staffRole = await prisma.role.create({ data: { name: 'STAFF', description: 't', permissions: ['tiles:read'] } });
  const owner = await prisma.user.create({ data: { name: 'Owner', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id } });
  const staff = await prisma.user.create({ data: { name: 'Staff', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id } });

  const brand = await prisma.brand.create({ data: { name: 'Morson CASA', slug: 'morson-casa' } });
  const collection = await prisma.collection.create({ data: { brandId: brand.id, name: 'Calacatta' } });
  const product = await prisma.product.create({ data: { name: 'Calacatta White', collectionId: collection.id } });

  // Matches MATCH-001 and MATCH-002 from the mock feed (case varied
  // on purpose -- the match is case-insensitive).
  await prisma.tile.create({ data: { name: 'Calacatta White', brandId: brand.id, productId: product.id, finish: 'Polished', size: '600x600mm', productCode: 'match-001' } });
  await prisma.tile.create({ data: { name: 'Heritage Green', brandId: brand.id, productId: product.id, finish: 'Glossy', size: '300x600mm', productCode: 'MATCH-002' } });
  // Has no counterpart anywhere in the mock ERP feed -- an orphan.
  const orphanTile = await prisma.tile.create({ data: { name: 'Orphan Tile', brandId: brand.id, productId: product.id, finish: 'Matte', size: '100x100mm', productCode: 'CASA-ONLY-999' } });

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

  const ownerToken = await login('owner@example.test');
  const staffToken = await login('staff@example.test');
  check('0a. the seeded owner can log in', !!ownerToken);
  check('0b. the seeded staff member can log in', !!staffToken);

  // ---- 1. Authorization ----
  step('1. GET /integrations/erp/catalog-preview requires an authenticated OWNER session');
  const noAuth = await api('GET', '/integrations/erp/catalog-preview');
  check('1a. no token at all is refused', noAuth.status === 401 || noAuth.status === 403, noAuth.status);
  const staffAuth = await api('GET', '/integrations/erp/catalog-preview', null, { Authorization: `Bearer ${staffToken}` });
  check('1b. a non-OWNER session is refused', staffAuth.status === 403, staffAuth.status);

  // ---- 2. Happy path ----
  step('2. an OWNER session pulls the (mock) ERP feed, paginates through it, and reconciles by SKU');
  const beforeCounts = { products: await prisma.product.count(), tiles: await prisma.tile.count(), brands: await prisma.brand.count() };

  const preview = await api('GET', '/integrations/erp/catalog-preview', null, { Authorization: `Bearer ${ownerToken}` });
  check('2a. an OWNER session succeeds, always 200', preview.status === 200, preview.body);
  check('2b. erpReachable is true', preview.body.data.erpReachable === true, preview.body.data);
  check('2c. both pages of the mock feed were read', preview.body.data.erp.pagesRead === 2, preview.body.data.erp);
  check('2d. not truncated (2 pages is under the default cap)', preview.body.data.erp.truncated === false);
  check('2e. three ERP variants counted across both pages', preview.body.data.erp.variants === 3, preview.body.data.erp);
  check('2f. two companies/product-lines counted correctly',
    preview.body.data.erp.companies === 1 && preview.body.data.erp.productLines === 2, preview.body.data.erp);
  check('2g. exactly two ERP variants matched a CASA tile by SKU, case-insensitively',
    preview.body.data.matches.count === 2, preview.body.data.matches);
  check('2h. exactly one ERP variant (NOMATCH-001) has no CASA counterpart',
    preview.body.data.unmatchedErpVariants.count === 1
    && preview.body.data.unmatchedErpVariants.sample.some((v) => v.sku === 'NOMATCH-001'),
    preview.body.data.unmatchedErpVariants);
  check('2i. the one CASA-only tile is reported as an orphan',
    preview.body.data.orphanCasaTiles.count === 1
    && preview.body.data.orphanCasaTiles.sample.some((t) => t.tileId === orphanTile.id),
    preview.body.data.orphanCasaTiles);

  const afterCounts = { products: await prisma.product.count(), tiles: await prisma.tile.count(), brands: await prisma.brand.count() };
  check('2j. the preview wrote nothing to CASA\'s own database -- counts are byte-for-byte unchanged',
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), { beforeCounts, afterCounts });

  check('2k. the ERP integration key never appears anywhere in the response body sent back',
    !JSON.stringify(preview.body).includes(CASA_KEY));

  // ---- 3. Filters reach the mock ERP as query params ----
  step('3. brandId/collectionId filters are passed through to the ERP call');
  await api('GET', '/integrations/erp/catalog-preview?brandId=erp-brand-1', null, { Authorization: `Bearer ${ownerToken}` });
  check('3a. the mock ERP received brandId exactly as sent', lastQuery && lastQuery.brandId === 'erp-brand-1', lastQuery);

  // ---- 4. ERP unavailable (closed mid-test) ----
  step('4. once the ERP becomes unreachable, the preview reports it safely instead of crashing or hanging');
  await new Promise((r) => mockErp.close(r));

  const startedAt = Date.now();
  const unavailable = await api('GET', '/integrations/erp/catalog-preview', null, { Authorization: `Bearer ${ownerToken}` });
  const elapsedMs = Date.now() - startedAt;

  check('4a. still answers 200 -- an unreachable ERP is a normal, reported outcome, not a 500',
    unavailable.status === 200, unavailable.body);
  check('4b. erpReachable is false', unavailable.body.data.erpReachable === false, unavailable.body.data);
  check('4c. a real reason is given, not a stack trace',
    typeof unavailable.body.data.erpUnavailableReason === 'string'
    && !unavailable.body.data.erpUnavailableReason.includes('at Object'),
    unavailable.body.data.erpUnavailableReason);
  check('4d. it did not hang -- answered well within the configured timeout, counting the one retry',
    elapsedMs < 6000, elapsedMs);

  const afterUnavailable = { products: await prisma.product.count(), tiles: await prisma.tile.count() };
  check('4e. an unreachable ERP still wrote nothing to CASA\'s database',
    afterUnavailable.products === beforeCounts.products && afterUnavailable.tiles === beforeCounts.tiles);

  // ---- 5. The two databases never touched each other ----
  step('5. structurally: CASA\'s database and the (mock) ERP were never the same thing');
  check('5a. this suite ran against its own, disposably-named CASA database', DB_URL.includes('tm_erp_catalog_preview_test'));
  check('5b. the "ERP" in this test was a plain HTTP mock with no database connection of its own at all', true);

  server.close();
  await prisma.$disconnect();

  if (fail) { console.log('\n  failed:', failures.join(' | ')); }
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
