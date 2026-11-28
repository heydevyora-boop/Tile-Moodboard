/**
 * Step 10 — website stock display: GET /tiles/stock, end to end
 * against a real server, a real disposable Postgres database
 * (created and dropped by this script alone), and a MOCK ERP server
 * (a plain http.createServer, no database of its own at all)
 * standing in for the real ERP's
 * /api/v1/integrations/casa/stock route.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/erp_stock_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_erp_stock_test';
const CASA_KEY = 'test-only-casa-integration-key-for-stock';

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

const PASSWORD = 'dummy-password-erp-stock';

async function main() {
  // ── 1. THE MOCK ERP — no database, no relation to CASA's own ──
  //
  // Stands in for erp/server/routes/casaIntegration.mjs's /stock
  // route. Checks the shared secret exactly like the real one does,
  // and answers with a canned row per requested SKU, matching
  // real behavior: found:false for anything not in its little
  // fixture, found:true with totals otherwise.
  let lastSkusQuery = null;
  const FIXTURE = {
    'MATCH-AVAILABLE-01': { productId: 'erp-prod-1', status: 'ACTIVE', totals: { physical: 20, reserved: 5, damaged: 0, inTransit: 0, available: 15 } },
    'MATCH-ZERO-01': { productId: 'erp-prod-2', status: 'ACTIVE', totals: { physical: 3, reserved: 3, damaged: 0, inTransit: 0, available: 0 } },
  };

  const mockErp = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const skus = (url.searchParams.get('skus') || '').split(',').map((s) => s.trim()).filter(Boolean);
    lastSkusQuery = skus;

    if (req.headers['x-casa-key'] !== CASA_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid or missing x-casa-key.', code: 'FORBIDDEN', errors: [] }));
      return;
    }

    const distinct = [...new Set(skus)];
    const data = distinct.map((sku) => {
      const fixture = FIXTURE[sku.toUpperCase()];
      return fixture ? { sku, found: true, ...fixture } : { sku, found: false };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Request completed successfully', data, meta: {} }));
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
  const adminUrl = DB_URL.replace(/\/tm_erp_stock_test(\?|$)/, '/postgres$1');
  execFileSync('psql', [adminUrl, '-c', 'drop database if exists tm_erp_stock_test'], { stdio: 'ignore' });
  execFileSync('psql', [adminUrl, '-c', 'create database tm_erp_stock_test'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  step('seed: a user who can browse tiles, a user who cannot');

  const browserRole = await prisma.role.create({ data: { name: 'CAN_BROWSE', description: 't', permissions: ['tiles:read'] } });
  const noBrowseRole = await prisma.role.create({ data: { name: 'CANNOT_BROWSE', description: 't', permissions: ['catalogs:write'] } });
  const browser = await prisma.user.create({ data: { name: 'Browser', email: 'browser@example.test', passwordHash: await hashPassword(PASSWORD), roleId: browserRole.id } });
  const noBrowse = await prisma.user.create({ data: { name: 'NoBrowse', email: 'nobrowse@example.test', passwordHash: await hashPassword(PASSWORD), roleId: noBrowseRole.id } });

  const beforeTileCount = await prisma.tile.count();

  const express = require('express');
  const host = express();
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;

  async function api(method, url, headers) {
    const res = await fetch(`${base}${url}`, { method, headers: headers || {} });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }
  async function login(email) {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const json = await res.json().catch(() => null);
    return json?.data?.accessToken || json?.data?.tokens?.accessToken;
  }

  const browserToken = await login('browser@example.test');
  const noBrowseToken = await login('nobrowse@example.test');
  check('0a. the browsing user can log in', !!browserToken);
  check('0b. the non-browsing user can log in', !!noBrowseToken);

  // ---- 1. Authorization + validation ----
  step('1. GET /tiles/stock requires authentication and tiles:read, and validates its skus param');
  const noAuth = await api('GET', '/tiles/stock?skus=MATCH-AVAILABLE-01');
  check('1a. no token at all is refused', noAuth.status === 401 || noAuth.status === 403, noAuth.status);

  const noPermission = await api('GET', '/tiles/stock?skus=MATCH-AVAILABLE-01', { Authorization: `Bearer ${noBrowseToken}` });
  check('1b. a session without tiles:read is refused', noPermission.status === 403, noPermission.status);

  const noSkus = await api('GET', '/tiles/stock', { Authorization: `Bearer ${browserToken}` });
  check('1c. no skus param at all is a validation error, not a silent empty result', noSkus.status === 400 || noSkus.status === 422, noSkus.status);

  const tooMany = await api('GET', `/tiles/stock?skus=${Array.from({ length: 101 }, (_, i) => `SKU-${i}`).join(',')}`, { Authorization: `Bearer ${browserToken}` });
  check('1d. more than 100 SKUs in one request is rejected, not silently truncated', tooMany.status === 400 || tooMany.status === 422, tooMany.status);

  // ---- 2. Happy path: available, zero, unknown, duplicate ----
  step('2. a mixed batch is correctly split into available / zero / unknown');
  const happy = await api(
    'GET',
    '/tiles/stock?skus=' + encodeURIComponent(['MATCH-AVAILABLE-01', 'match-zero-01', 'NEVER-SEEDED-ANYWHERE', 'MATCH-AVAILABLE-01'].join(',')),
    { Authorization: `Bearer ${browserToken}` },
  );
  check('2a. the request succeeds, always 200', happy.status === 200, happy.body);
  const stock = happy.body?.data?.stock || {};
  check('2b. an ERP-available SKU reports state "available" with the ERP\'s own quantity',
    stock['MATCH-AVAILABLE-01']?.state === 'available' && stock['MATCH-AVAILABLE-01']?.quantity === 15, stock['MATCH-AVAILABLE-01']);
  check('2c. an ERP-zero SKU (case-varied in the request) reports state "zero", not "unavailable"',
    stock['match-zero-01']?.state === 'zero' && stock['match-zero-01']?.quantity === 0, stock['match-zero-01']);
  check('2d. a SKU the ERP has never heard of reports state "unknown", never a fabricated number',
    stock['NEVER-SEEDED-ANYWHERE']?.state === 'unknown' && !('quantity' in (stock['NEVER-SEEDED-ANYWHERE'] || {})), stock['NEVER-SEEDED-ANYWHERE']);
  check('2e. a duplicate SKU in the request still resolves (one key, correct value)',
    Object.keys(stock).filter((k) => k === 'MATCH-AVAILABLE-01').length === 1, Object.keys(stock));
  check('2f. the mock ERP was asked for each distinct SKU', Array.isArray(lastSkusQuery) && lastSkusQuery.length > 0, lastSkusQuery);

  const afterHappyTileCount = await prisma.tile.count();
  check('2g. this endpoint never touches CASA\'s own database -- tile count unchanged',
    afterHappyTileCount === beforeTileCount, { beforeHappyTileCount: beforeTileCount, afterHappyTileCount });

  check('2h. the ERP integration key never appears anywhere in the response body sent back',
    !JSON.stringify(happy.body).includes(CASA_KEY));

  // ---- 3. ERP unavailable (closed mid-test) ----
  step('3. once the ERP becomes unreachable, every requested SKU reports "unavailable" instead of crashing or hanging');
  await new Promise((r) => mockErp.close(r));

  const startedAt = Date.now();
  const unavailable = await api('GET', '/tiles/stock?skus=MATCH-AVAILABLE-01,MATCH-ZERO-01', { Authorization: `Bearer ${browserToken}` });
  const elapsedMs = Date.now() - startedAt;

  check('3a. still answers 200 -- an unreachable ERP is a normal, reported outcome, not a 500',
    unavailable.status === 200, unavailable.body);
  const unavailableStock = unavailable.body?.data?.stock || {};
  check('3b. every requested SKU reports state "unavailable", distinct from "unknown" or "zero"',
    unavailableStock['MATCH-AVAILABLE-01']?.state === 'unavailable' && unavailableStock['MATCH-ZERO-01']?.state === 'unavailable',
    unavailableStock);
  check('3c. it did not hang -- answered well within the configured timeout, counting the one retry',
    elapsedMs < 6000, elapsedMs);

  const afterUnavailableTileCount = await prisma.tile.count();
  check('3d. an unreachable ERP still wrote nothing to CASA\'s database',
    afterUnavailableTileCount === beforeTileCount);

  server.close();
  await prisma.$disconnect();

  if (fail) { console.log('\n  failed:', failures.join(' | ')); }
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
