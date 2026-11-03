/**
 * De'vyora Library -- bulk upload, listing and delete.
 *
 * Runs the REAL server (createApp() from src/) against a real Postgres,
 * with the real frontend served from the same origin and driven in
 * Chromium. The only thing replaced is the Google Drive API itself,
 * which this machine has no credential for: googleDriveClient's four
 * methods are swapped for a fake Drive that records what it was given.
 * Everything in front of that -- multer, the route, the permission
 * check, content verification, the service, Prisma -- is the real path.
 *
 * Every secret here is a dummy. Nothing reads a real key.
 *
 * Run:  node test-scripts/library_upload_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_library?host=/var/tmp';

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
const failed = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra));
    fail += 1; failed.push(label);
  }
}

/** A 1x1 PNG, and a file that only claims to be one. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  execFileSync('psql', [DB_URL.replace(/\/tm_library\?/, '/postgres?'), '-c', 'drop database if exists tm_library'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL.replace(/\/tm_library\?/, '/postgres?'), '-c', 'create database tm_library'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));

  // ── the fake Drive ──
  const driveState = { files: new Map(), folders: [], publicised: [], failNext: null, uploads: 0 };
  const client = drive.googleDriveClient;
  client.isConfigured = () => true;
  client.getOrCreateFolder = async (name, parent) => {
    driveState.folders.push({ name, parent });
    return { id: 'folder-' + name, name };
  };
  client.uploadFile = async (input) => {
    driveState.uploads += 1;
    if (driveState.failNext) {
      const message = driveState.failNext;
      driveState.failNext = null;
      throw new Error(message);
    }
    const id = 'drive-' + driveState.uploads;
    driveState.files.set(id, { name: input.name, bytes: input.content.length, parent: input.parentFolderId });
    return { id, name: input.name };
  };
  client.generatePublicLink = async (id) => { driveState.publicised.push(id); return 'ok'; };
  client.deleteFile = async (id) => {
    if (!driveState.files.has(id)) throw new Error('File not found: ' + id);
    driveState.files.delete(id);
  };

  const role = await prisma.role.create({
    data: { name: 'OWNER', description: 'test', permissions: ['reference_images:read', 'reference_images:write'] },
  });
  const viewerRole = await prisma.role.create({
    data: { name: 'VIEWER', description: 'test', permissions: ['reference_images:read'] },
  });
  const PASSWORD = 'dummy-password-library';
  await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: role.id },
  });
  await prisma.user.create({
    data: { name: 'Read Only', email: 'viewer@example.test', passwordHash: await hashPassword(PASSWORD), roleId: viewerRole.id },
  });

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
    await page.waitForSelector('.lib-theme', { timeout: 20000 });
  };

  /** Hands the real <input type=file> a set of in-memory files. */
  const choose = (files) => page.setInputFiles('#libFiles', files);
  const file = (name, buffer, type) => ({ name, mimeType: type || 'image/png', buffer: buffer || PNG });

  await signIn('priya@example.test');

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the themes, and choosing one');
  await openLibrary();
  check('1a. every theme is offered, read from the server',
    await page.locator('.lib-theme').count() === 9,
    await page.locator('.lib-theme').count());
  check('1b. no upload control until a theme is chosen',
    await page.locator('#libFiles').count() === 0);

  await page.click('[data-theme="british"]');
  await page.waitForSelector('#libFiles', { state: 'attached', timeout: 10000 });
  check('1c. choosing a theme offers the upload',
    /ADD IMAGES TO BRITISH/.test(await page.locator('.lib-add').textContent() || ''),
    await page.locator('.lib-add').textContent());
  check('1d. ...and says the theme is empty rather than showing nothing',
    /Nothing in this theme yet/.test(await page.locator('#mainContent').textContent()));

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. a bulk upload of sixty pictures');
  {
    const many = Array.from({ length: 60 }, (_, i) => file(`room-${i + 1}.png`));
    await choose(many);
    await page.waitForSelector('.lib-queue', { timeout: 20000 });
    check('2a. a queue appears with every file in it',
      await page.locator('.lib-file').count() === 60,
      await page.locator('.lib-file').count());
    check('2b. ...and a cancel while it runs',
      await page.locator('#libCancel').count() === 1);

    await page.waitForFunction(
      () => document.querySelectorAll('.lib-file-done, .lib-file-failed').length === 60,
      { timeout: 120000 },
    );
    check('2c. all sixty go up', await page.locator('.lib-file-done').count() === 60,
      { done: await page.locator('.lib-file-done').count(), failed: await page.locator('.lib-file-failed').count() });

    const rows = await prisma.libraryReference.count({ where: { themeId: 'british' } });
    check('2d. ...and sixty rows are saved under the theme', rows === 60, rows);
    check('2e. ...each one on Drive, in the library folder',
      driveState.files.size === 60
      && [...driveState.files.values()].every((f) => f.parent === 'folder-devyora-library'),
      { onDrive: driveState.files.size });
    check('2f. ...and every one made readable by link, or generation could not fetch it',
      driveState.publicised.length === 60, driveState.publicised.length);

    const sample = await prisma.libraryReference.findFirst({ where: { themeId: 'british' } });
    check('2g. the row keeps the Drive link, not a local path',
      /^https:\/\/drive\.google\.com\//.test(sample.imageUrl)
      && !/uploads|\/tmp|blob/.test(sample.imageUrl), sample.imageUrl);
    check('2h. ...and the Drive file id it came from', !!sample.driveFileId);
    check('2i. ...with a title taken from the filename when none was typed',
      /^room-\d+$/.test(sample.title), sample.title);
    check('2j. ...and who uploaded it, and when',
      !!sample.uploadedById && !!sample.createdAt);

    await page.waitForSelector('.lib-card', { timeout: 20000 });
    check('2k. the gallery shows them without a reload',
      await page.locator('.lib-card').count() === 60,
      await page.locator('.lib-card').count());
    check('2l. ...and the theme count is updated',
      /60/.test(await page.locator('.lib-theme.selected').textContent() || ''),
      await page.locator('.lib-theme.selected').textContent());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. one bad file does not take the batch with it');
  {
    await page.click('[data-theme="floral"]');
    await page.waitForSelector('#libFiles', { state: 'attached' });

    driveState.failNext = 'Service Accounts do not have storage quota.';
    await choose([
      file('good-one.png'),
      file('drive-will-refuse.png'),
      file('not-really-an-image.png', Buffer.from('this is plain text, not a PNG')),
      file('good-two.png'),
    ]);
    await page.waitForFunction(
      () => document.querySelectorAll('.lib-file-done, .lib-file-failed').length === 4,
      { timeout: 60000 },
    );

    const done = await page.locator('.lib-file-done').count();
    const failedFiles = await page.locator('.lib-file-failed').count();
    check('3a. the good ones land and the bad ones do not', done === 2 && failedFiles === 2,
      { done, failed: failedFiles });

    const errors = await page.locator('.lib-file-err').allTextContents();
    check('3b. a file that is not really an image says so, by name',
      errors.some((e) => /not actually a JPEG, PNG or WebP/.test(e)), errors);
    check('3c. a Drive refusal is reported in Google’s own words',
      errors.some((e) => /storage quota/.test(e)), errors);
    check('3d. ...and nothing was quietly written to disk instead',
      await prisma.libraryReference.count({ where: { themeId: 'floral' } }) === 2,
      await prisma.libraryReference.count({ where: { themeId: 'floral' } }));
    check('3e. the page says how many failed',
      /2 of 4 could not be uploaded/.test(await page.locator('#libAlert').textContent() || ''),
      await page.locator('#libAlert').textContent());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. removing one');
  {
    const before = await prisma.libraryReference.count({ where: { themeId: 'floral' } });
    page.on('dialog', (d) => d.accept());
    await page.click('.lib-card [data-delete]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('.lib-card').length === n - 1,
      before, { timeout: 20000 },
    );
    const after = await prisma.libraryReference.count({ where: { themeId: 'floral' } });
    check('4a. the row is gone', after === before - 1, { before, after });
    check('4b. ...and so is the file on Drive', driveState.files.size === 61, driveState.files.size);
    check('4c. ...and the theme count follows',
      /1/.test(await page.locator('.lib-theme.selected').textContent() || ''),
      await page.locator('.lib-theme.selected').textContent());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. what the API refuses');
  {
    const post = (body, headers) => page.evaluate(async ([b, h]) => {
      const form = new FormData();
      Object.keys(b).forEach((k) => form.append(k, b[k] === '__file__'
        ? new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'x.png', { type: 'image/png' })
        : b[k]));
      const r = await fetch('/api/v1/library/references', { method: 'POST', body: form, headers: h });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, [body, headers || {}]);

    const token = await page.evaluate(() => localStorage.getItem('casa_access_token'));
    const auth = { Authorization: 'Bearer ' + token };

    const noTheme = await post({ file: '__file__' }, auth);
    check('5a. a picture with no theme is refused', noTheme.status === 400, noTheme);

    const badTheme = await post({ file: '__file__', themeId: 'art-deco' }, auth);
    check('5b. a theme the studio does not have is refused',
      badTheme.status === 400 && /not one of the studio/.test(badTheme.body.message || ''),
      badTheme.body.message);

    const noFile = await post({ themeId: 'british' }, auth);
    check('5c. a theme with no picture is refused', noFile.status === 400, noFile);

    const anonymous = await post({ file: '__file__', themeId: 'british' }, {});
    check('5d. an upload with no session is refused', anonymous.status === 401, anonymous.status);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. a reader may look and may not add');
  {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await context.clearCookies();
    await signIn('viewer@example.test');
    await openLibrary();
    await page.click('[data-theme="british"]');
    await page.waitForSelector('.lib-card', { timeout: 20000 });
    check('6a. a reader sees the library', await page.locator('.lib-card').count() === 60,
      await page.locator('.lib-card').count());

    const token = await page.evaluate(() => localStorage.getItem('casa_access_token'));
    const refused = await page.evaluate(async (t) => {
      const form = new FormData();
      form.append('themeId', 'british');
      form.append('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'x.png', { type: 'image/png' }));
      const r = await fetch('/api/v1/library/references', {
        method: 'POST', body: form, headers: { Authorization: 'Bearer ' + t },
      });
      return r.status;
    }, token);
    check('6b. ...and cannot add to it', refused === 403, refused);
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failed.length) console.log('failed:\n  ' + failed.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
