/**
 * Sample Placement AND Client Wishlists, on a deployment where the
 * migration never ran -- or ran against a different database.
 *
 * THE CODE SHIPS WITHOUT THE TABLES. vercel.json's buildCommand is
 * `prisma generate` alone, so a deploy carries the sample module and
 * none of its four tables -- and every call then fails with Prisma's
 * P2021, which this project's error handler turns into the 400
 * "Database request error (P2021)". That reached the owner's screen and
 * told them nothing: not what was wrong, and not what to do.
 *
 * The De'vyora Library already learned this (library_unmigrated_test);
 * this is the same question asked of the sample module.
 *
 * What is checked: every sample screen says, in words, that the
 * migration has not been run and names the command -- and that a
 * missing sample table costs the SAMPLE module and nothing else.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/sample_unmigrated_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_sampleunmig?host=/var/tmp';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
  GOOGLE_DRIVE_ROOT_FOLDER: 'TestDriveRoot',
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

const PASSWORD = 'dummy-password-unmig';

/** Does this message actually tell somebody what to do? */
function namesTheRemedy(message) {
  const text = String(message || '');
  return /migrate deploy/.test(text) && !/^Database request error/.test(text);
}

async function main() {
  const admin = DB_URL.replace(/\/tm_sampleunmig\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_sampleunmig'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_sampleunmig'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const ownerRole = await prisma.role.create({
    data: { name: 'OWNER', description: 't', permissions: ['*'] },
  });
  await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'owner@example.test',
      passwordHash: await hashPassword(PASSWORD),
      roleId: ownerRole.id,
    },
  });
  const brand = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria' } });
  const product = await prisma.tile.create({
    data: { name: 'Tile A', brandId: brand.id, productCode: 'TILE-A-600' },
  });

  // THE DEPLOYED STATE: the code is here, the four tables are not.
  execFileSync('psql', [DB_URL, '-c',
    'drop table if exists "placement_change_requests", "sample_placements", '
    + '"physical_samples", "product_colours" cascade'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL, '-c',
    'drop table if exists "wishlist_items", "client_wishlists" cascade'], { stdio: 'ignore' });

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;

  async function api(method, url, body, token) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  try {
    const login = await api('POST', '/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const jwt = login.body?.data?.accessToken || login.body?.data?.tokens?.accessToken;
    check('0. the owner can still log in — a missing sample table is not a broken application',
      !!jwt);

    // ── the three calls the page makes when it opens ─────────────
    const list = await api('GET', '/samples?availability=ALL&status=ACTIVE&page=1&limit=24',
      undefined, jwt);
    check('1. the sample list says the migration has not been run, and names the command',
      namesTheRemedy(list.body?.message), list.body?.message);

    const queue = await api('GET', '/samples/relocation-requests?status=PENDING&limit=1',
      undefined, jwt);
    check('2. ...and so does the approval queue',
      namesTheRemedy(queue.body?.message), queue.body?.message);

    const colours = await api('GET', `/samples/colours?productId=${product.id}`, undefined, jwt);
    check('3. ...and so does a product’s colours',
      namesTheRemedy(colours.body?.message), colours.body?.message);

    const scan = await api('GET', '/samples/by-barcode/DVS-ANYTHING', undefined, jwt);
    check('4. ...and so does a scan',
      namesTheRemedy(scan.body?.message), scan.body?.message);

    const contents = await api('GET', '/samples/contents?cassetteNo=C01', undefined, jwt);
    check('5. ...and so does asking what a cassette holds',
      namesTheRemedy(contents.body?.message), contents.body?.message);

    // ── THE CLIENT REGISTER, which is the screen in the report ───
    const register = await api('GET', '/client-wishlists/studio/all?status=ALL&page=1&limit=25',
      undefined, jwt);
    check('5b. the client register says the migration has not reached this database',
      namesTheRemedy(register.body?.message), register.body?.message);

    const clientThemes = await api('GET', '/client-wishlists/browse/themes');
    check('5c. ...and so does the client\u2019s own page, which has no login',
      clientThemes.status === 200 || namesTheRemedy(clientThemes.body?.message),
      clientThemes.body?.message);

    const registerAttempt = await api('POST', '/client-wishlists/register', { name: 'Aarti Mehta' });
    check('5d. ...and so does trying to start a wishlist',
      namesTheRemedy(registerAttempt.body?.message), registerAttempt.body?.message);

    // ── the message names BOTH ways of getting here ──────────────
    check('5e. the message says the migration may have reached a different database',
      /different database/i.test(String(register.body?.message || ''))
      && /DIRECT_URL/.test(String(register.body?.message || ''))
      && /DATABASE_URL/.test(String(register.body?.message || '')),
      register.body?.message);
    check('5f. ...and names the Vercel environment trap by name',
      /Production is not visible to a Preview/i.test(String(register.body?.message || '')),
      register.body?.message);

    // ── and nothing else is harmed ───────────────────────────────
    const tiles = await api('GET', '/tiles?limit=5', undefined, jwt);
    check('6. the ERP catalogue still answers — the sample tables cost only the samples',
      tiles.status === 200 && Array.isArray(tiles.body?.data?.tiles)
      && tiles.body.data.tiles.length === 1,
      { status: tiles.status });

    const themes = await api('GET', '/library/themes', undefined, jwt);
    check('7. ...and so does the De’vyora Library',
      themes.status === 200 && (themes.body?.data?.themes || []).length === 9,
      themes.status);

    const health = await api('GET', '/health');
    check('8. ...and the application is healthy', health.status === 200, health.status);

    // ── the message is the same one a person would act on ────────
    check('9. the message names the project’s own command, not a generic error code',
      /cd backend && npx prisma migrate deploy/.test(String(list.body?.message || '')),
      list.body?.message);
    check('10. ...and says why a deployment does not create the tables by itself',
      /prisma generate/.test(String(list.body?.message || '')),
      list.body?.message);

    // ── and the owner READS it, rather than a code ───────────────
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const origin = `http://localhost:${server.address().port}`;
      await page.goto(`${origin}/login.html`);
      await page.evaluate(([e, pw]) => window.CasaApi.auth.login(e, pw),
        ['owner@example.test', PASSWORD]);
      await page.goto(`${origin}/sample-placement.html`);
      await page.waitForSelector('.note.bad', { timeout: 20000 });

      const shown = (await page.textContent('.note.bad')).replace(/\s+/g, ' ');
      check('11. the page itself tells the owner what to run',
        /migrate deploy/.test(shown) && !/P2021/.test(shown), shown.slice(0, 160));
      check('12. ...and offers to try again once they have',
        (await page.$$('#retryBtn')).length === 1);
      check('13. ...with the rest of the workspace still reachable from the sidebar',
        (await page.$$eval('#navItems .nav-item', (els) => els.length)) >= 6);

      await page.goto(`${origin}/client-wishlists.html`);
      await page.waitForSelector('.note.bad', { timeout: 20000 });
      const onRegister = (await page.textContent('.note.bad')).replace(/\s+/g, ' ');
      check('14. the client register page says it too, instead of printing P2021',
        /migrate deploy/.test(onRegister) && !/P2021/.test(onRegister),
        onRegister.slice(0, 160));
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
