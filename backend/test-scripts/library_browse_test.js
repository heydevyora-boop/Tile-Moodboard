/**
 * De'vyora Library -- browsing, and choosing the reference.
 *
 * The real server, a real Postgres, the real page in Chromium. Google
 * Drive is replaced at its own boundary (this machine has no credential
 * for it); everything in front of that is the real path.
 *
 * What matters most here is the last part: the chosen picture has to
 * SURVIVE leaving the page, because generation happens elsewhere.
 *
 * Every secret is a dummy.
 *
 * Run:  node test-scripts/library_browse_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_browse?host=/var/tmp';

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

async function main() {
  execFileSync('psql', [DB_URL.replace(/\/tm_browse\?/, '/postgres?'), '-c', 'drop database if exists tm_browse'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL.replace(/\/tm_browse\?/, '/postgres?'), '-c', 'create database tm_browse'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));
  drive.googleDriveClient.isConfigured = () => true;
  drive.googleDriveClient.deleteFile = async () => {};

  const staffRole = await prisma.role.create({
    data: { name: 'OWNER', description: 'test', permissions: ['reference_images:read', 'reference_images:write'] },
  });
  const clientRole = await prisma.role.create({
    data: { name: 'STAFF', description: 'test', permissions: ['reference_images:read'] },
  });
  const PASSWORD = 'dummy-password-browse';
  const staff = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
  });
  await prisma.user.create({
    data: { name: 'Client User', email: 'client@example.test', passwordHash: await hashPassword(PASSWORD), roleId: clientRole.id },
  });

  // Four British rooms and two Moroccan ones, as if already uploaded.
  const made = [];
  for (const [themeId, titles] of [
    ['british', ['Heritage Green Cloakroom', 'Panelled Bath', 'Oxblood Study Bath', 'Encaustic Hall']],
    ['moroccan', ['Zellige Courtyard', 'Cobalt Hammam']],
  ]) {
    for (let i = 0; i < titles.length; i += 1) {
      made.push(await prisma.libraryReference.create({
        data: {
          themeId, title: titles[i],
          imageUrl: `https://drive.google.com/uc?export=download&id=file-${themeId}-${i}`,
          driveFileId: `file-${themeId}-${i}`,
          room: i === 0 ? 'Bathroom' : null,
          uploadedById: staff.id,
        },
      }));
    }
  }

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Drive is not reachable from here, so every <img> pointed at it would
  // sit broken and slow the page down. The requests are answered with a
  // real PNG so the grid behaves exactly as it would with Drive up.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  let driveRequests = 0;
  await context.route('https://drive.google.com/**', (route) => {
    driveRequests += 1;
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  const signIn = async (email) => {
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('checkingState').style.display === 'none');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
  };

  const openLibrary = async () => {
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
  };

  await signIn('client@example.test');

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the themes, as the first thing a client sees');
  {
    // A local server answers in milliseconds, so the waiting state would
    // come and go before anything could look at it. The themes call is
    // held for a moment to make it observable -- which is what a real
    // connection does anyway.
    await context.route('**/api/v1/library/themes', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      route.continue();
    });
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    const skeletonSeen = await page.waitForSelector('.lib-skeleton', { timeout: 8000 })
      .then(() => true).catch(() => false);
    check('1a. something is shown while the themes load', skeletonSeen);
    await context.unroute('**/api/v1/library/themes');

    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
    check('1b. every theme is listed', await page.locator('.lib-theme-card').count() === 9,
      await page.locator('.lib-theme-card').count());
    const british = page.locator('.lib-theme-card[data-theme="british"]');
    // FOUR UPLOADED PLUS THE TWO STARTERS THAT SHIP WITH THE APP.
    // A starter is a room a client can open, choose and generate from,
    // so it counts -- which is also why no theme reads as empty any
    // more, and why the page is never the blank grid that was reported.
    check('1c. ...named, with its palette and how many rooms it holds',
      /British/.test(await british.textContent() || '')
      && /Heritage green/.test(await british.textContent() || '')
      && /6 ROOMS/.test(await british.textContent() || ''),
      await british.textContent());
    check('1d. ...and a theme nobody has uploaded to still offers its starters',
      /2 ROOMS/.test(
        await page.locator('.lib-theme-card[data-theme="rustic"]').textContent() || ''
      ),
      await page.locator('.lib-theme-card[data-theme="rustic"]').textContent());
    check('1e. a client is not offered the studio’s upload button',
      await page.locator('#libFiles').count() === 0);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. one theme’s rooms');
  {
    await page.click('[data-theme="british"]');
    await page.waitForSelector('.lib-card', { timeout: 20000 });
    check('2a. the theme’s rooms are shown -- the two starters, then the four uploaded',
      await page.locator('.lib-card').count() === 6
      && await page.locator('.lib-card .lib-starter-flag').count() === 2,
      await page.locator('.lib-card').count());
    check('2b. ...under the theme’s own name',
      /British/.test(await page.locator('.lib-head').textContent() || ''));
    check('2c. ...each picture loaded from its Drive link',
      driveRequests >= 4, driveRequests);
    // The uploaded ones, specifically: a starter is a file this server
    // hosts, so only the studio's own rooms should come from Drive.
    const uploaded = page.locator('.lib-card:not(:has(.lib-starter-flag)) img').first();
    check('2d. an uploaded room loads from Drive, not from a local copy',
      /^https:\/\/drive\.google\.com\//.test(await uploaded.getAttribute('src') || ''),
      await uploaded.getAttribute('src'));
    check('2d2. ...and a starter from this server',
      /\/static\/library-starters\//.test(
        await page.locator('.lib-card:has(.lib-starter-flag) img').first().getAttribute('src') || ''));
    check('2e. there is a way back to the themes',
      await page.locator('#libBack').count() === 1);

    await page.click('[data-theme="moroccan"]'.replace('[data-theme="moroccan"]', '#libBack'));
    await page.waitForSelector('.lib-theme-card', { timeout: 10000 });
    check('2f. ...and it goes back', await page.locator('.lib-card').count() === 0);

    await page.click('[data-theme="moroccan"]');
    await page.waitForSelector('.lib-card', { timeout: 20000 });
    check('2g. another theme shows its own rooms, not the first one’s',
      await page.locator('.lib-card').count() === 4,
      await page.locator('.lib-card').count());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. choosing one');
  {
    check('3a. nothing is chosen to begin with',
      await page.locator('#libActive').count() === 0);

    const firstTitle = (await page.locator('.lib-card .lib-title').first().textContent() || '').trim();
    await page.locator('.lib-card').first().click();
    await page.waitForSelector('#libActive', { timeout: 10000 });
    const banner = await page.locator('#libActive').textContent() || '';
    check('3b. the chosen picture is named as the active reference',
      /ACTIVE REFERENCE IMAGE/.test(banner) && banner.includes(firstTitle),
      { banner, firstTitle });
    check('3c. ...with the theme it came from',
      /Moroccan/.test(banner), banner);
    check('3d. ...and the card itself is marked',
      await page.locator('.lib-card.chosen').count() === 1
      && await page.locator('.lib-chosen-flag').count() === 1);
    check('3e. ...and says so to a screen reader too',
      await page.locator('.lib-card.chosen').getAttribute('aria-pressed') === 'true');

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('casa_library_selection') || 'null'));
    // The first card in a theme is a STARTER, so this is the record for
    // one of those: its picture is served by this backend rather than
    // by Drive, and its id is prefixed so nothing downstream can
    // mistake it for a database row.
    check('3f. the choice is the whole record the generator will need',
      stored && stored.themeId === 'moroccan' && stored.title === firstTitle
      && !!stored.id && stored.themeLabel === 'Moroccan'
      && /^\/static\/library-starters\//.test(stored.imageUrl || ''), stored);
    check('3f2. ...and a starter is marked as one by its id',
      stored.id.startsWith('starter:'), stored.id);

    // Choosing another replaces it; there is only ever one.
    const secondTitle = (await page.locator('.lib-card .lib-title').nth(1).textContent() || '').trim();
    await page.locator('.lib-card').nth(1).click();
    await page.waitForFunction(
      (wanted) => {
        const el = document.getElementById('libActive');
        return !!el && el.textContent.indexOf(wanted) !== -1;
      },
      secondTitle, { timeout: 10000 },
    );
    check('3g. choosing another replaces it, never adds a second',
      await page.locator('.lib-card.chosen').count() === 1,
      await page.locator('.lib-card.chosen').count());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. the choice survives leaving the page');
  {
    await page.click('#libBack');
    await page.waitForSelector('.lib-theme-card', { timeout: 10000 });
    const chosenTitle = await page.evaluate(
      () => (JSON.parse(localStorage.getItem('casa_library_selection') || '{}')).title
    );
    check('4a. it is still shown on the themes view',
      (await page.locator('#libActive').textContent() || '').includes(chosenTitle),
      chosenTitle);

    // The whole point: generation happens on another page.
    await page.goto(`${base}/dashboard.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const afterLeaving = await page.evaluate(
      () => (window.CasaApi && window.CasaApi.library.selection()) || null
    );
    check('4b. another page can read it, which is how generation will',
      afterLeaving && afterLeaving.title === chosenTitle, afterLeaving);

    await openLibrary();
    check('4c. coming back, it is still the active reference',
      (await page.locator('#libActive').textContent() || '').includes(chosenTitle));

    await page.click('#libClearChoice');
    await page.waitForFunction(() => !document.getElementById('libActive'), { timeout: 10000 });
    check('4d. and it can be cleared', await page.locator('#libActive').count() === 0);
    const cleared = await page.evaluate(() => localStorage.getItem('casa_library_selection'));
    check('4e. ...for good', cleared === null, cleared);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. the studio’s own view');
  {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await context.clearCookies();
    await signIn('priya@example.test');
    await openLibrary();
    await page.click('[data-theme="british"]');
    await page.waitForSelector('.lib-card', { timeout: 20000 });
    check('5a. the studio is offered the upload', await page.locator('#libFiles').count() === 1);
    // FOUR, not six: the two starters ship with the application and
    // there is nothing for the studio to remove, so they carry no
    // REMOVE at all. The server refuses one too.
    check('5b. ...and can remove a room it uploaded', await page.locator('[data-delete]').count() === 4,
      await page.locator('[data-delete]').count());
    check('5b2. ...but not a starter, which is not the studio\u2019s to remove',
      await page.locator('.lib-card:has(.lib-starter-flag) [data-delete]').count() === 0);

    // Removing the one that is currently chosen must not leave a
    // selection pointing at something that no longer exists.
    const own = page.locator('.lib-card:not(:has(.lib-starter-flag))').first();
    await own.click();
    await page.waitForSelector('#libActive', { timeout: 10000 });
    page.on('dialog', (d) => d.accept());
    await page.locator('.lib-card.chosen [data-delete]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.lib-card').length === 5, { timeout: 20000 },
    );
    check('5c. removing the chosen room clears the choice with it',
      await page.locator('#libActive').count() === 0
      && await page.evaluate(() => localStorage.getItem('casa_library_selection')) === null);

    // ...and choosing is still the client's action, not the studio's
    // REMOVE button.
    await page.locator('.lib-card').first().click();
    await page.waitForSelector('#libActive', { timeout: 10000 });
    check('5d. the studio can choose a reference too',
      await page.locator('.lib-card.chosen').count() === 1);
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
