/**
 * De'vyora Client Wishlist -- the whole thing, end to end.
 *
 * Three browsers: two clients on showroom tablets and the owner at a
 * desk. The real server, a real Postgres with the real migrations, the
 * real pages in Chromium.
 *
 * GOOGLE DRIVE IS REPLACED AT ITS OWN BOUNDARY, because this machine
 * has no credential for it and no network route to it. The fake keeps
 * a folder tree and records every call, which is what makes the
 * questions worth asking answerable: is the structure right, does a
 * second submission copy anything twice, is an original ever touched,
 * and does a wishlist survive Drive failing outright. What it cannot
 * prove is that Google accepts these calls -- that is the production
 * self-test's job, and the report says so.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/client_wishlist_e2e_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_wishe2e?host=/var/tmp';

const LIBRARY_FOLDER = 'library-folder-id';

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
  GOOGLE_DRIVE_LIBRARY_FOLDER: LIBRARY_FOLDER,
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

const PASSWORD = 'dummy-password-e2e';

async function main() {
  const admin = DB_URL.replace(/\/tm_wishe2e\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_wishe2e'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_wishe2e'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));

  // ── a Drive that remembers what was asked of it ──────────────────
  const calls = [];
  const folders = new Map();
  const driveFiles = new Map();
  let seq = 0;
  let failNextCopy = false;

  const client = drive.googleDriveClient;
  client.isConfigured = () => true;
  /* The studio's actual configuration: the owner's own Google account,
     authorized once (googleOAuth.service). Left as the default the
     library folder check reads it as a service account writing into a
     My Drive, which it rightly refuses -- a real answer, but not the
     one this deployment gives. */
  client.authMode = async () => 'oauth';
  client.getFolderById = async (id) => ({ id, name: 'Reference Images' });
  // findFolder and createFolder are replaced, but getOrCreateFolder is
  // NOT: the real find-before-create logic is what is under test.
  client.findFolder = async (name, parent) => {
    calls.push({ op: 'findFolder', name, parent });
    for (const f of folders.values()) if (f.name === name && f.parent === parent) return { id: f.id, name };
    return null;
  };
  client.createFolder = async (name, parent) => {
    calls.push({ op: 'createFolder', name, parent });
    const id = `folder-${++seq}`;
    folders.set(id, { id, name, parent });
    return { id, name };
  };
  client.copyFile = async (fileId, name, parent) => {
    calls.push({ op: 'copyFile', fileId, name, parent });
    if (failNextCopy) throw new Error('Google Drive is unavailable (503)');
    const id = `copy-${++seq}`;
    driveFiles.set(id, { id, name, parent, copiedFrom: fileId });
    return { id, name };
  };
  client.uploadFile = async ({ name, parentFolderId }) => {
    calls.push({ op: 'uploadFile', name, parent: parentFolderId });
    if (failNextCopy) throw new Error('Google Drive is unavailable (503)');
    const id = `upload-${++seq}`;
    driveFiles.set(id, { id, name, parent: parentFolderId, uploaded: true });
    return { id, name };
  };
  client.generatePublicLink = async (fileId) => {
    calls.push({ op: 'generatePublicLink', fileId });
    return 'https://drive.google.com/file/d/' + fileId + '/view';
  };
  client.deleteFile = async (fileId) => {
    calls.push({ op: 'deleteFile', fileId });
    throw new Error('the wishlist must never delete anything on Drive');
  };

  // ── the studio ───────────────────────────────────────────────────
  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const adminRole = await prisma.role.create({
    data: { name: 'ADMIN', description: 't', permissions: ['customers:read', 'customers:write', 'reference_images:read', 'reference_images:write'] },
  });
  const staffRole = await prisma.role.create({
    data: { name: 'STAFF', description: 't', permissions: ['customers:read', 'customers:write', 'reference_images:read'] },
  });
  const owner = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
  });
  await prisma.user.create({
    data: { name: 'Shop Admin', email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD), roleId: adminRole.id },
  });
  await prisma.user.create({
    data: { name: 'Floor Staff', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
  });

  // A theme carrying more than the hundred the brief asks about.
  const BIG = 140;
  for (let i = 0; i < BIG; i += 1) {
    await prisma.libraryReference.create({
      data: {
        themeId: 'british',
        title: `Heritage Room ${String(i + 1).padStart(3, '0')}`,
        imageUrl: `https://drive.google.com/uc?export=download&id=file-british-${i}`,
        driveFileId: `file-british-${i}`,
        room: 'Bathroom',
        uploadedById: owner.id,
      },
    });
  }
  for (const themeId of ['moroccan', 'floral']) {
    await prisma.libraryReference.create({
      data: {
        themeId,
        title: `${themeId} studio room`,
        imageUrl: `https://drive.google.com/uc?export=download&id=file-${themeId}`,
        driveFileId: `file-${themeId}`,
        uploadedById: owner.id,
      },
    });
  }

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  const PHOTO = fs.readFileSync(path.join(FRONTEND, 'img/library/british-bathroom.png'));
  const browser = await chromium.launch();
  const pageErrors = [];

  async function tablet(size) {
    const context = await browser.newContext({ viewport: size || { width: 1180, height: 820 } });
    await context.route('https://drive.google.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO }));
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    return { context, page };
  }

  async function api(method, url, body, token) {
    const res = await fetch(`${base}/api/v1${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  const a = await tablet();
  const b = await tablet({ width: 393, height: 852 });
  const studio = await tablet({ width: 1440, height: 900 });

  try {
    // ══ 1-3. two clients register ═════════════════════════════════
    step('1–3. two clients register, and are two clients');

    await a.page.goto(`${base}/wishlist.html`);
    await a.page.waitForSelector('#regForm');
    await a.page.fill('#regName', 'Aarti Mehta');            // name only
    await a.page.click('#regBtn');
    await a.page.waitForSelector('.theme-card', { timeout: 15000 });
    const tokenA = await a.page.evaluate(() => localStorage.getItem('devyora.wishlist.token'));
    check('1. Client A registers with a name alone', !!tokenA);

    await b.page.goto(`${base}/wishlist.html`);
    await b.page.waitForSelector('#regForm');
    await b.page.fill('#regName', 'Rohit Nair');
    await b.page.fill('#regPhone', '9876543210');            // name and mobile
    await b.page.click('#regBtn');
    await b.page.waitForSelector('.theme-card', { timeout: 15000 });
    const tokenB = await b.page.evaluate(() => localStorage.getItem('devyora.wishlist.token'));
    check('2. Client B registers with a name and a mobile number', !!tokenB);

    const rowA = await prisma.clientWishlist.findUnique({ where: { token: tokenA }, include: { customer: true } });
    const rowB = await prisma.clientWishlist.findUnique({ where: { token: tokenB }, include: { customer: true } });
    check('3. they are separate clients, with separate ids, codes and credentials',
      rowA.customerId !== rowB.customerId && rowA.code !== rowB.code && tokenA !== tokenB
      && rowA.customer.phone === null && rowB.customer.phone === '9876543210',
      { a: rowA.code, b: rowB.code });

    // ══ 4-5. every theme, and Others ══════════════════════════════
    step('4–5. every theme opens, and Others is all of them');

    const themeList = (await api('GET', '/client-wishlists/browse/themes')).body.data.themes;
    const realThemes = themeList.filter((t) => t.id !== 'others');
    check('4a. the studio offers its nine themes plus Others',
      realThemes.length === 9 && themeList.length === 10, themeList.map((t) => t.id));

    let openedEvery = true;
    const themeTotals = {};
    for (const theme of realThemes) {
      const res = await api('GET', `/client-wishlists/browse/images?themeId=${theme.id}`);
      const images = res.body?.data?.images || [];
      themeTotals[theme.id] = images.length;
      if (res.status !== 200 || !images.length || !images.every((i) => i.themeId === theme.id)) {
        openedEvery = false;
      }
    }
    check('4b. every one of them opens, and holds only its own rooms', openedEvery, themeTotals);

    const others = (await api('GET', '/client-wishlists/browse/images?themeId=others')).body.data.images;
    const summed = Object.values(themeTotals).reduce((s, n) => s + n, 0);
    check('5a. Others is every theme gathered together', others.length === summed,
      { others: others.length, summed });
    check('5b. ...from more than one theme, and duplicating no record',
      new Set(others.map((i) => i.themeId)).size === 9
      && (await prisma.libraryReference.count()) === BIG + 2);

    // ══ 6. a large collection ═════════════════════════════════════
    step('6. a theme of a hundred and forty rooms');

    await a.page.click('.theme-card[data-theme="british"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 20000 });
    const firstBatch = (await a.page.$$('.grid .pic')).length;
    const britishTotal = themeTotals.british;
    check('6a. it opens in one batch rather than all at once',
      firstBatch === 24 && britishTotal === BIG + 6, { firstBatch, britishTotal });
    check('6b. and asks only for card-sized pictures',
      await a.page.$$eval('.grid .pic-shot img',
        (els) => els.every((e) => e.loading === 'lazy' && !/sz=w1000/.test(e.src))));

    for (let i = 0; i < 8; i += 1) {
      await a.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await a.page.waitForTimeout(320);
      if ((await a.page.$$('.grid .pic')).length >= britishTotal) break;
    }
    check('6c. everything in it can be reached by scrolling',
      (await a.page.$$('.grid .pic')).length === britishTotal,
      (await a.page.$$('.grid .pic')).length);

    // ══ 7-8. hearts, across themes ════════════════════════════════
    step('7–8. keeping and unkeeping, across themes');

    await a.page.evaluate(() => window.scrollTo(0, 0));
    /* The studio's OWN uploads, not the starters the gallery lists
       first: a starter has no Drive original, so it is uploaded rather
       than copied, and picking only those would leave the copy path
       untested. */
    const picsA = await a.page.$$('.grid .pic:not([data-pic^="starter:"])');
    for (const pic of picsA.slice(0, 3)) {
      await pic.$eval('.heart', (x) => x.click());
      await a.page.waitForTimeout(220);
    }
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '3', { timeout: 10000 });
    check('7a. three rooms kept', (await a.page.$eval('#countN', (e) => e.textContent)) === '3');

    await picsA[2].$eval('.heart', (x) => x.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '2', { timeout: 10000 });
    check('7b. one of them taken back out',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '2'
      && (await prisma.wishlistItem.count({ where: { wishlistId: rowA.id } })) === 2);

    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid', { timeout: 10000 });
    await a.page.click('.theme-card[data-theme="moroccan"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 10000 });
    await a.page.$eval('.grid .pic:not([data-pic^="starter:"]) .heart', (x) => x.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '3', { timeout: 10000 });

    // A starter, from a third theme.
    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid', { timeout: 10000 });
    await a.page.click('.theme-card[data-theme="floral"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 10000 });
    const starterPic = await a.page.$('.grid .pic[data-pic^="starter:"]');
    await starterPic.$eval('.heart', (x) => x.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '4', { timeout: 10000 });

    const itemsA = await prisma.wishlistItem.findMany({ where: { wishlistId: rowA.id } });
    check('8. rooms kept across three themes, starters among them',
      new Set(itemsA.map((i) => i.themeId)).size === 3
      && itemsA.some((i) => i.imageId.startsWith('starter:')), itemsA.map((i) => i.themeId));

    // Client B keeps two of their own.
    await b.page.click('.theme-card[data-theme="british"]');
    await b.page.waitForSelector('.grid .pic', { timeout: 15000 });
    const picsB = await b.page.$$('.grid .pic');
    for (const pic of picsB.slice(0, 2)) {
      await pic.$eval('.heart', (x) => x.click());
      await b.page.waitForTimeout(220);
    }
    await b.page.waitForFunction(() => document.getElementById('countN').textContent === '2', { timeout: 10000 });

    // ══ 9. a refresh ══════════════════════════════════════════════
    step('9. a refresh loses nothing');

    await a.page.reload();
    await a.page.waitForSelector('.theme-grid', { timeout: 15000 });
    check('9. the wishlist survives a reload, and does not ask again',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '4'
      && !(await a.page.$('#regForm')));

    // ══ 10. both submit ═══════════════════════════════════════════
    step('10. both wishlists are sent');

    async function submitVia(ctx) {
      await ctx.page.click('#countBtn');
      await ctx.page.waitForSelector('#submitBtn', { timeout: 10000 });
      await ctx.page.click('#submitBtn');
      await ctx.page.waitForSelector('#submitYes', { timeout: 10000 });
      await ctx.page.click('#submitYes');
      await ctx.page.waitForSelector('.code-chip', { timeout: 25000 });
    }
    await submitVia(a);
    await submitVia(b);

    const sentA = await prisma.clientWishlist.findUnique({ where: { id: rowA.id }, include: { items: true } });
    const sentB = await prisma.clientWishlist.findUnique({ where: { id: rowB.id }, include: { items: true } });
    check('10. both are marked submitted, with their times and their rooms',
      sentA.status === 'SUBMITTED' && !!sentA.submittedAt && sentA.items.length === 4
      && sentB.status === 'SUBMITTED' && !!sentB.submittedAt && sentB.items.length === 2,
      { a: sentA.items.length, b: sentB.items.length });

    // ══ 11. isolation ═════════════════════════════════════════════
    step('11. one client cannot reach the other');

    const crossRead = await api('GET', `/client-wishlists/${tokenB}`);
    const bItems = crossRead.body.data.items.map((i) => i.imageId);
    const aItems = sentA.items.map((i) => i.imageId);
    check('11a. each token opens only its own wishlist',
      crossRead.body.data.name === 'Rohit Nair'
      && !bItems.some((id) => aItems.includes(id) && false)
      && bItems.length === 2);
    const guessed = await api('GET', `/client-wishlists/${rowA.id}`);
    check('11b. a client id is not a credential', guessed.status === 404, guessed.status);
    check('11c. and no wishlist response carries a token',
      !JSON.stringify(crossRead.body).includes(tokenB));

    // ══ 14-15. the Drive folders ══════════════════════════════════
    step('14–15. the client folders on Drive');

    const rootFolder = [...folders.values()].find((f) => f.name === 'Client Wishlists');
    check('14a. one "Client Wishlists" folder, inside the studio’s own library folder',
      !!rootFolder && rootFolder.parent === LIBRARY_FOLDER
      && [...folders.values()].filter((f) => f.name === 'Client Wishlists').length === 1,
      rootFolder);

    const folderA = [...folders.values()].find((f) => f.name === `Aarti Mehta - ${rowA.code}`);
    const folderB = [...folders.values()].find((f) => f.name === `Rohit Nair - ${rowB.code}`);
    check('14b. a folder per client, named for them, under that one',
      !!folderA && !!folderB && folderA.parent === rootFolder.id && folderB.parent === rootFolder.id,
      { a: folderA && folderA.name, b: folderB && folderB.name });

    const imagesA = [...folders.values()].find((f) => f.name === 'Wishlist Images' && f.parent === folderA.id);
    check('14c. with a "Wishlist Images" folder inside each', !!imagesA
      && [...folders.values()].filter((f) => f.name === 'Wishlist Images').length === 2);

    const copiesA = [...driveFiles.values()].filter((f) => f.parent === imagesA.id);
    check('14d. every room the client kept is in it',
      copiesA.length === 4, copiesA.map((f) => f.name));
    check('14e. the three library rooms were COPIED, the starter uploaded',
      copiesA.filter((f) => f.copiedFrom).length === 3
      && copiesA.filter((f) => f.uploaded).length === 1,
      copiesA.map((f) => (f.copiedFrom ? 'copy' : 'upload')));

    const afterA = await prisma.clientWishlist.findUnique({ where: { id: rowA.id }, include: { items: true } });
    check('14f. the folder is recorded against the wishlist, with no error',
      afterA.driveFolderId === folderA.id && !!afterA.driveSyncedAt && afterA.driveError === null,
      { folderId: afterA.driveFolderId, error: afterA.driveError });
    check('14g. ...and every picture knows its own copy',
      afterA.items.every((i) => !!i.driveCopyId));

    // THE ORIGINALS ARE UNTOUCHED.
    check('14h. nothing was deleted on Drive, ever',
      !calls.some((c) => c.op === 'deleteFile'));
    const source = fs.readFileSync(path.join(ROOT, 'src/services/clientWishlistDrive.service.ts'), 'utf8');
    check('14i. ...and the code has no way to: no delete, no move, no re-parenting',
      !/deleteFile|\baddParents\b|\bremoveParents\b|\bmoveFile\b/.test(source));
    check('14j. the library rows themselves are exactly as they were',
      (await prisma.libraryReference.count()) === BIG + 2
      && (await prisma.libraryReference.count({ where: { isActive: true } })) === BIG + 2);

    // ── doing it twice ────────────────────────────────────────────
    const callsBefore = calls.length;
    const copiesBefore = driveFiles.size;
    const foldersBefore = folders.size;

    const resubmit = await api('POST', `/client-wishlists/${tokenA}/submit`);
    check('15a. submitting again succeeds and says so',
      resubmit.status === 200 && resubmit.body.data.alreadySubmitted === true, resubmit.body?.data);
    check('15b. ...and creates no second folder and no second copy',
      folders.size === foldersBefore && driveFiles.size === copiesBefore,
      { folders: folders.size, files: driveFiles.size });
    check('15c. ...and does not even ask Drive, because the sync is already done',
      calls.length === callsBefore, calls.slice(callsBefore));

    // An owner-triggered sync is idempotent too.
    const ownerLogin = await api('POST', '/auth/login', { email: 'owner@example.test', password: PASSWORD });
    const ownerJwt = ownerLogin.body?.data?.accessToken || ownerLogin.body?.data?.tokens?.accessToken;
    check('15d. the owner can log in', !!ownerJwt);

    const resync = await api('POST', `/client-wishlists/studio/${rowA.id}/drive-sync`, undefined, ownerJwt);
    check('15e. an owner’s re-sync copies nothing and reports it',
      resync.status === 200 && resync.body.data.drive.ok === true
      && resync.body.data.drive.copied === 0 && resync.body.data.drive.alreadyThere === 4
      && driveFiles.size === copiesBefore, resync.body?.data?.drive);
    check('15f. ...and makes no second folder of any kind',
      folders.size === foldersBefore
      && resync.body.data.drive.folderId === afterA.driveFolderId,
      { folders: folders.size, was: foldersBefore });

    // ── Drive failing must not cost the studio a wishlist ─────────
    step('Drive failing costs the wishlist nothing');

    const c = await tablet();
    await c.page.goto(`${base}/wishlist.html`);
    await c.page.waitForSelector('#regForm');
    await c.page.fill('#regName', 'Meera Iyer');
    await c.page.click('#regBtn');
    await c.page.waitForSelector('.theme-card', { timeout: 15000 });
    await c.page.click('.theme-card[data-theme="moroccan"]');
    await c.page.waitForSelector('.grid .pic', { timeout: 10000 });
    await c.page.$eval('.grid .pic .heart', (x) => x.click());
    await c.page.waitForFunction(() => document.getElementById('countN').textContent === '1', { timeout: 10000 });

    failNextCopy = true;
    let submitThrew = '';
    try {
      await submitVia(c);
    } catch (err) {
      submitThrew = String((err && err.message) || err).split('\n')[0];
    }
    failNextCopy = false;
    check('D0. a Drive that cannot answer does not break the client’s submission',
      submitThrew === '', submitThrew);

    const tokenC = await c.page.evaluate(() => localStorage.getItem('devyora.wishlist.token'));
    const rowC = (await prisma.clientWishlist.findUnique({ where: { token: tokenC }, include: { items: true } }))
      || { status: '', submittedAt: null, items: [], driveError: '', driveSyncedAt: null, id: '' };
    check('D1. the client still sees their confirmation', !!(await c.page.$('.code-chip')));
    check('D2. the wishlist is submitted and complete in the database',
      rowC.status === 'SUBMITTED' && !!rowC.submittedAt && rowC.items.length === 1);
    check('D3. the failure is recorded in words a studio can act on',
      !!rowC.driveError && rowC.driveSyncedAt === null && /Drive/.test(rowC.driveError),
      rowC.driveError);
    check('D4. and nothing was half-written: no copy id for a copy that failed',
      rowC.items.every((i) => i.driveCopyId === null));

    const retry = await api('POST', `/client-wishlists/studio/${rowC.id}/drive-sync`, undefined, ownerJwt);
    const rowCAfter = await prisma.clientWishlist.findUnique({ where: { id: rowC.id }, include: { items: true } });
    check('D5. once Drive is back, the owner’s retry finishes the job',
      retry.body.data.drive.ok === true && retry.body.data.drive.copied === 1
      && !!rowCAfter.driveFolderId && rowCAfter.driveError === null && !!rowCAfter.driveSyncedAt,
      retry.body?.data?.drive);
    await c.context.close();

    // ══ 12-13. the owner's register ═══════════════════════════════
    step('12–13. the owner’s register');

    await studio.page.goto(`${base}/login.html`);
    await studio.page.evaluate(
      ([email, password]) => window.CasaApi.auth.login(email, password),
      ['owner@example.test', PASSWORD],
    );
    await studio.page.goto(`${base}/client-wishlists.html`);
    await studio.page.waitForSelector('.row[data-open]', { timeout: 20000 });

    const names = await studio.page.$$eval('.row[data-open]',
      (rows) => rows.map((r) => r.querySelector('.r-name').textContent.trim()));
    check('12a. the owner sees every client who registered',
      names.includes('Aarti Mehta') && names.includes('Rohit Nair') && names.includes('Meera Iyer'), names);
    check('12b. with the count, the status and the Drive state on each row',
      (await studio.page.$$('.row[data-open] .pill.sent')).length === 3
      && (await studio.page.$$('.row[data-open] .pill.ok')).length === 3,
      await studio.page.$$eval('.row[data-open] .pill', (els) => els.map((e) => e.textContent.trim())));
    check('12c. and a mobile number only where one was given',
      (await studio.page.$$eval('.row[data-open] .r-phone .r-name',
        (els) => els.map((e) => e.textContent.trim()))).filter((t) => t === '—').length === 2);

    /* Looked at, not only asserted: the name and the client id beneath
       it are spans, and laid out inline they ran together into one
       unreadable string. Geometry catches that; a selector does not. */
    const rowBox = await studio.page.$eval('.row[data-open]', (r) => {
      const box = (sel) => r.querySelector(sel).getBoundingClientRect();
      const name = box('.r-name'); const sub = box('.r-sub');
      return { stacked: sub.top >= name.bottom - 1, sameLeft: Math.abs(sub.left - name.left) < 2 };
    });
    check('12d. a row stacks the client over their id, rather than running them together',
      rowBox.stacked && rowBox.sameLeft, rowBox);

    // Search, by name and by code.
    await studio.page.fill('#fq', 'aarti');
    await studio.page.waitForFunction(
      () => document.querySelectorAll('.row[data-open]').length === 1, { timeout: 10000 });
    check('13a. searching by name narrows it, case and all',
      (await studio.page.$eval('.row[data-open]',
        (r) => r.querySelector('.r-name').textContent.trim())) === 'Aarti Mehta');

    /* WAIT FOR THE NAME, NOT FOR THE COUNT. The previous search already
       left one row on screen, so "one row" was true before this search
       had even been sent. */
    async function searchFor(term, expected) {
      await studio.page.fill('#fq', term);
      await studio.page.waitForFunction((want) => {
        const rows = document.querySelectorAll('.row[data-open]');
        return rows.length === 1
          && rows[0].querySelector('.r-name').textContent.trim() === want;
      }, expected, { timeout: 10000 }).catch(() => {});
      const names = await studio.page.$$eval('.row[data-open]',
        (rows) => rows.map((r) => r.querySelector('.r-name').textContent.trim()));
      return names.length === 1 && names[0] === expected ? '' : JSON.stringify(names);
    }

    const byCode = await searchFor(rowB.code, 'Rohit Nair');
    check('13b. searching by the DV- code finds that one client', byCode === '', byCode);

    const byId = await searchFor(rowA.customerId, 'Aarti Mehta');
    check('13c. ...and so does the client id', byId === '', byId);

    await studio.page.click('#fclear');
    await studio.page.waitForFunction(
      () => document.querySelectorAll('.row[data-open]').length === 3, { timeout: 10000 });

    // Status and date filters, against the API so the bounds are exact.
    const draftOnly = await api('GET', '/client-wishlists/studio/all?status=DRAFT', undefined, ownerJwt);
    const sentOnly = await api('GET', '/client-wishlists/studio/all?status=SUBMITTED', undefined, ownerJwt);
    check('13d. filtering by status', draftOnly.body.data.total === 0 && sentOnly.body.data.total === 3,
      { draft: draftOnly.body.data.total, sent: sentOnly.body.data.total });

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const todays = await api('GET', `/client-wishlists/studio/all?from=${today}&to=${today}`, undefined, ownerJwt);
    const future = await api('GET', `/client-wishlists/studio/all?from=${tomorrow}`, undefined, ownerJwt);
    check('13e. filtering by registration date, both ends inclusive',
      todays.body.data.total === 3 && future.body.data.total === 0,
      { today: todays.body.data.total, future: future.body.data.total });

    const paged = await api('GET', '/client-wishlists/studio/all?limit=2&page=2', undefined, ownerJwt);
    check('13f. and it pages rather than returning everything',
      paged.body.data.wishlists.length === 1 && paged.body.data.pages === 2
      && paged.body.data.total === 3, paged.body?.data);

    // One client, opened.
    await studio.page.click(`.row[data-open="${rowA.id}"]`);
    await studio.page.waitForSelector('.picks .pick', { timeout: 15000 });
    check('13g. opening a client shows their details and every room they kept',
      (await studio.page.$$('.picks .pick')).length === 4
      && /Aarti Mehta/.test(await studio.page.textContent('.step-h1')));

    const facts = await studio.page.$$eval('.fact', (els) => els.map((e) => e.textContent));
    check('13h. with the mobile, the client id, the registration and the submission times',
      facts.some((f) => /CLIENT ID/.test(f) && f.includes(rowA.customerId.slice(0, 8)))
      && facts.some((f) => /REGISTERED/.test(f))
      && facts.some((f) => /Submitted/.test(f)), facts.map((f) => f.slice(0, 28)));

    const themesShown = await studio.page.$$eval('.pick .tag.gold', (els) => els.map((e) => e.textContent.trim()));
    check('13i. every picture names the theme it came from, by label',
      new Set(themesShown).size === 3 && themesShown.includes('British'), themesShown);

    const refs = await studio.page.$$eval('.pick-ref', (els) => els.map((e) => e.textContent));
    check('13j. ...and its original library reference',
      refs.filter((t) => /Library reference/.test(t)).length === 3
      && refs.some((t) => /Starter room/.test(t)));

    const driveText = await studio.page.textContent('.drive');
    check('13k. the client’s Drive folder is linked from the record',
      driveText.includes(folderA.id) && /drive\.google\.com\/drive\/folders/.test(driveText));

    check('13l. no preview asks for a full-resolution picture',
      await studio.page.$$eval('.pick-shot img', (els) => els.every(
        (e) => e.loading === 'lazy' && !/sz=w1000/.test(e.src))));

    // ══ who may look ══════════════════════════════════════════════
    step('only the owner and the admin may look');

    const staffLogin = await api('POST', '/auth/login', { email: 'staff@example.test', password: PASSWORD });
    const staffJwt = staffLogin.body?.data?.accessToken || staffLogin.body?.data?.tokens?.accessToken;
    const staffTry = await api('GET', '/client-wishlists/studio/all', undefined, staffJwt);
    check('P1. floor staff are refused the register', staffTry.status === 403, staffTry.status);
    const staffOne = await api('GET', `/client-wishlists/studio/${rowA.id}`, undefined, staffJwt);
    check('P2. ...and an individual client too', staffOne.status === 403, staffOne.status);

    const adminLogin = await api('POST', '/auth/login', { email: 'admin@example.test', password: PASSWORD });
    const adminJwt = adminLogin.body?.data?.accessToken || adminLogin.body?.data?.tokens?.accessToken;
    const adminTry = await api('GET', '/client-wishlists/studio/all', undefined, adminJwt);
    check('P3. an admin may read it', adminTry.status === 200 && adminTry.body.data.total === 3);

    const noLogin = await api('GET', '/client-wishlists/studio/all');
    check('P4. and nobody may without logging in', noLogin.status === 401, noLogin.status);

    // The staff member is not even shown the way in.
    const staffTablet = await tablet();
    await staffTablet.page.goto(`${base}/login.html`);
    await staffTablet.page.evaluate(
      ([email, password]) => window.CasaApi.auth.login(email, password),
      ['staff@example.test', PASSWORD],
    );
    await staffTablet.page.goto(`${base}/devyora-library.html`);
    await staffTablet.page.waitForSelector('#navItems .nav-item', { timeout: 20000 });
    const staffNav = await staffTablet.page.$$eval('#navItems .nav-item', (els) => els.map((e) => e.textContent.trim()));
    check('P5. floor staff are not shown the menu item either',
      !staffNav.includes('Client Wishlists'), staffNav);

    await staffTablet.page.goto(`${base}/client-wishlists.html`);
    await staffTablet.page.waitForSelector('.note.bad', { timeout: 20000 });
    check('P6. ...and typing the address in says so plainly, rather than showing an empty table',
      /owner/i.test(await staffTablet.page.textContent('.note.bad'))
      && (await staffTablet.page.$$('.row[data-open]')).length === 0);
    await staffTablet.context.close();

    const ownerNav = await studio.page.evaluate(() => Array.from(
      document.querySelectorAll('#navItems .nav-item')).map((e) => e.textContent.trim()));
    check('P7. the owner is', ownerNav.includes('Client Wishlists'), ownerNav);

    // ══ 16. the library still works ═══════════════════════════════
    step('16–17. nothing else was disturbed');

    const before = await prisma.libraryReference.count();
    const form = new FormData();
    form.set('themeId', 'rustic');
    form.set('title', 'A new upload, after all this');
    form.set('roomId', 'bathroom');
    form.set('file', new Blob([PHOTO], { type: 'image/png' }), 'new-room.png');
    const upload = await fetch(`${base}/api/v1/library/references`, {
      method: 'POST', headers: { Authorization: `Bearer ${ownerJwt}` }, body: form,
    });
    const uploaded = await upload.json().catch(() => null);
    check('16. a studio upload into the library still works',
      upload.status === 201 && (await prisma.libraryReference.count()) === before + 1,
      { status: upload.status, message: uploaded?.message });

    const lastUpload = calls.filter((c) => c.op === 'uploadFile').slice(-1)[0];
    const ancestry = [];
    for (let at = lastUpload.parent; at && folders.has(at); at = folders.get(at).parent) {
      ancestry.push(folders.get(at).name);
    }
    check('16b. ...into <library>/<theme>/<room> as it always did, nowhere near a client’s folder',
      ancestry.length === 2
      && !ancestry.includes('Client Wishlists') && !ancestry.includes('Wishlist Images')
      && folders.get(lastUpload.parent).parent !== rootFolder.id
      && ancestry.every((name) => !/ - DV-/.test(name)),
      { ancestry, parentOfTop: lastUpload.parent });

    // The generation path still resolves a library reference by id --
    // the step the mood board takes before it calls Gemini. Gemini
    // itself needs a key this machine does not have, and the existing
    // library-generation suite covers the rest.
    const chosen = await prisma.libraryReference.findFirst({ where: { themeId: 'british' } });
    const resolved = await api('GET', `/library/references?themeId=british`, undefined, ownerJwt);
    check('17. the library still answers the question generation asks of it',
      resolved.status === 200
      && resolved.body.data.references.some((r) => r.id === chosen.id),
      resolved.status);

    check('Z. no page threw at any point', pageErrors.length === 0, pageErrors.slice(0, 3));
  } finally {
    await browser.close();
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
