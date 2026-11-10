/**
 * The library on a database whose migration has not been run.
 *
 * WHAT WENT WRONG, reported from the deployed site: the De'vyora Library
 * page showed "No themes to show" and nothing else. No themes, so no way
 * into a theme, so no upload button anywhere -- the whole feature looked
 * like it had never been built.
 *
 * The actual fault was one number. The nine themes come from
 * shared/themes.json and need no database at all; only the count beside
 * each one does. That single count query was taking the whole endpoint
 * down with it on a deployment where `prisma migrate deploy` had not
 * been run, and the page could not tell the difference between "the
 * counts are missing" and "there is nothing here".
 *
 * So this runs the real server against a database with the table
 * DROPPED -- exactly the deployed state -- and checks that the studio
 * can still see its themes, is told what is wrong in words naming the
 * fix, and is never shown a count that is not true.
 *
 * It also covers the second half of the same report: an account without
 * `reference_images:write` saw no upload button and no explanation,
 * which is indistinguishable from the feature not existing.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_unmigrated_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_unmig?host=/var/tmp';

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
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
    fail += 1; failures.push(label);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// The two roles as prisma/seed.ts actually defines them. STAFF is the
// one in the report, and it really does not carry the write permission
// -- this test states that rather than assuming it either way.
const STAFF_PERMISSIONS = [
  'tiles:read', 'reference_images:read',
  'mood_boards:read', 'mood_boards:write',
  'print_boards:read', 'print_boards:write',
  'customers:read', 'customers:write',
  'analytics:read', 'visualizations:write',
];
const ADMIN_PERMISSIONS = STAFF_PERMISSIONS.concat(['reference_images:write']);

async function main() {
  const admin = DB_URL.replace(/\/tm_unmig\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_unmig'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_unmig'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const PASSWORD = 'dummy-password-unmig';
  const staffRole = await prisma.role.create({
    data: { name: 'STAFF', description: 'floor staff', permissions: STAFF_PERMISSIONS },
  });
  const adminRole = await prisma.role.create({
    data: { name: 'ADMIN', description: 'admin', permissions: ADMIN_PERMISSIONS },
  });
  await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
  });
  await prisma.user.create({
    data: { name: 'Studio Admin', email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD), roleId: adminRole.id },
  });

  // THE DEPLOYED STATE: the code is here, the table is not.
  //
  // CASCADE because wishlist_items references LibraryReference: on a
  // deployment where the library migration never ran, neither table
  // exists, so taking the dependent one with it is the accurate
  // simulation -- and without it Postgres refuses the drop outright.
  execFileSync('psql', [DB_URL, '-c', 'drop table "LibraryReference" cascade'], { stdio: 'ignore' });

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
  await context.route('https://drive.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  const signIn = async (email) => {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } }).catch(() => {});
    await context.clearCookies();
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('checkingState').style.display === 'none');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
  };


  /** Theme -> Room -> pictures: reaching a picture is two clicks now. */
  const openThemeRoom = async (themeId, roomId) => {
    await page.click('[data-theme="' + themeId + '"]');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('[data-room="' + roomId + '"]');
    await page.waitForSelector('.lib-card, .lib-empty', { timeout: 20000 });
  };

  const openLibrary = async () => {
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-grid, .lib-empty', { timeout: 20000 });
  };

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the themes survive a database that has no library table');
  {
    await signIn('priya@example.test');
    await openLibrary();

    check('1a. the themes are listed anyway',
      await page.locator('.lib-theme-card').count() === 9,
      await page.locator('.lib-theme-card').count());
    check('1b. ...and the page is NOT the empty state that was reported',
      await page.locator('.lib-empty').count() === 0);

    const note = await page.locator('.lib-note-bad').textContent() || '';
    check('1c. the real problem is stated', /STORAGE IS NOT READY/.test(note), note);
    check('1d. ...naming the command that fixes it',
      /prisma migrate deploy/.test(note), note);
    check('1e. ...and why a deployment does not do it',
      /prisma generate/.test(note), note);
    check('1f. ...not a Prisma error code',
      !/P2021/.test(note), note);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. the count is real, because the starters are files');
  {
    // The starters need no database, so even here the number beside a
    // theme is true rather than unavailable -- and no theme reads as
    // empty, which was the whole complaint.
    // One starter per room type, so the Theme x Room grid has no empty
    // cell at all -- which is the blank-page complaint, one level down.
    const first = await page.locator('.lib-theme-card').first().textContent() || '';
    check('2a. every theme shows a starter for each of its six rooms',
      /6 PICTURES/.test(first), first);
    check('2b. ...and none claims to be empty',
      !/0 PICTURES/.test(await page.locator('.lib-theme-grid').textContent() || '')
      && !/COUNT UNAVAILABLE/.test(await page.locator('.lib-theme-grid').textContent() || ''));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. opening a theme explains itself too');
  {
    page.on('dialog', (d) => d.accept());
    await openThemeRoom('british', 'bathroom');
    await page.waitForSelector('.lib-note-bad', { timeout: 20000 });
    const note = await page.locator('.lib-note-bad').textContent() || '';
    check('3a. the same explanation follows into the theme and the room',
      /prisma migrate deploy/.test(note), note);
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. an account that cannot upload is told so, not shown a gap');
  {
    const notes = await page.locator('.lib-note').allTextContents();
    const adding = notes.find((t) => /ADDING ROOMS/.test(t)) || '';
    check('4a. the page says adding rooms is a thing that exists', Boolean(adding), notes);
    check('4b. ...that this account cannot do',
      /Adding the studio/.test(adding) && /Staff does not/.test(adding), adding);
    check('4c. ...naming the permission it needs',
      /reference_images:write/.test(adding), adding);
    check('4d. ...and who has it',
      /Owner and Admin/.test(adding) && /Staff does not/.test(adding), adding);
    check('4e. no upload control is offered, since it would be refused',
      await page.locator('#libFiles').count() === 0);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. an account that CAN upload is told where');
  {
    await signIn('admin@example.test');
    await openLibrary();
    const notes = await page.locator('.lib-note').allTextContents();
    const adding = notes.find((t) => /ADDING ROOMS/.test(t)) || '';
    check('5a. the first screen says where the upload is', Boolean(adding), notes);
    check('5b. ...which is inside a theme',
      /open a theme and the upload is at the top of it/.test(adding), adding);
    check('5c. ...and that it takes many at once',
      /fifty or a hundred/.test(adding), adding);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. and once the table exists, everything is as it was');
  {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });
    // migrate deploy will not re-run an applied migration, so the table
    // is put back the way the migration itself creates it.
    execFileSync('psql', [DB_URL, '-c',
      'CREATE TABLE "LibraryReference" ('
      + '"id" TEXT NOT NULL, "themeId" TEXT NOT NULL, "title" TEXT NOT NULL, '
      + '"imageUrl" TEXT NOT NULL, "driveFileId" TEXT NOT NULL, "room" TEXT, '
      + '"description" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT true, '
      + '"sortOrder" INTEGER NOT NULL DEFAULT 0, "uploadedById" TEXT, '
      + '"visualProfile" JSONB, "visualReadAt" TIMESTAMP(3), '
      + '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, '
      + '"updatedAt" TIMESTAMP(3) NOT NULL, '
      + 'CONSTRAINT "LibraryReference_pkey" PRIMARY KEY ("id"))'], { stdio: 'ignore' });

    await openLibrary();
    // The DATABASE warning specifically. There is a second red note on
    // this deployment -- no Drive folder is configured either -- and
    // counting red notes would conflate two different problems with
    // two different remedies.
    check('6a. no storage warning is shown',
      !(await page.locator('.lib-note-bad').allTextContents())
        .some((t) => /prisma migrate deploy/.test(t)),
      await page.locator('.lib-note-bad').allTextContents());
    const grid = await page.locator('.lib-theme-grid').textContent() || '';
    check('6b. the counts are unchanged, since nothing was uploaded',
      /6 PICTURES/.test(grid) && !/COUNT UNAVAILABLE/.test(grid), grid.slice(0, 160));
    check('6c. ...and the upload is where the hint said it was',
      await (async () => {
        await openThemeRoom('british', 'kitchen');
        return await page.locator('#libFiles').count() === 1
          && await page.locator('#libRoom').count() === 1;
      })());
    check('6d. ...and the room opens on its starter, not on an empty grid',
      await page.locator('.lib-card').count() === 1
      && await page.locator('.lib-empty').count() === 0,
      await page.locator('.lib-card').count());
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
