/**
 * Sample Placement -- the screens.
 *
 * The real page in Chromium against the real server and a real Postgres
 * with the real migrations. Three browsers: an Admin registering
 * samples, a floor staff member scanning and asking for a move, and the
 * Owner deciding it -- because "staff cannot approve" and "nobody
 * approves their own request" are only true if two different people are
 * actually in the room.
 *
 * Google Drive is replaced at its own boundary; this machine has no
 * credential for it.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/sample_placement_page_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_samplepage?host=/var/tmp';
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

const PASSWORD = 'dummy-password-samplepage';

async function main() {
  const admin = DB_URL.replace(/\/tm_samplepage\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_samplepage'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_samplepage'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));

  const folders = new Map();
  const driveFiles = new Map();
  let seq = 0;
  const client = drive.googleDriveClient;
  client.isConfigured = () => true;
  client.authMode = async () => 'oauth';
  client.getFolderById = async (id) => ({ id, name: 'Reference Images' });
  client.findFolder = async (name, parent) => {
    for (const f of folders.values()) if (f.name === name && f.parent === parent) return { id: f.id, name };
    return null;
  };
  client.createFolder = async (name, parent) => {
    const id = `folder-${++seq}`; folders.set(id, { id, name, parent }); return { id, name };
  };
  client.uploadFile = async ({ name, parentFolderId }) => {
    const id = `file-${++seq}`; driveFiles.set(id, { id, name, parent: parentFolderId }); return { id, name };
  };
  client.generatePublicLink = async (id) => `https://drive.google.com/file/d/${id}/view`;
  client.deleteFile = async () => { throw new Error('never'); };

  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const adminRole = await prisma.role.create({
    data: { name: 'ADMIN', description: 't', permissions: ['tiles:read', 'tiles:write'] },
  });
  const staffRole = await prisma.role.create({
    data: { name: 'STAFF', description: 't', permissions: ['tiles:read'] },
  });
  await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
  });
  await prisma.user.create({
    data: { name: 'Shop Admin', email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD), roleId: adminRole.id },
  });
  await prisma.user.create({
    data: { name: 'Floor Staff', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
  });

  const brand = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria' } });
  const tileA = await prisma.tile.create({
    data: { name: 'Tile A', brandId: brand.id, productCode: 'TILE-A-600', inStock: true },
  });
  await prisma.tile.create({
    data: { name: 'Tile B', brandId: brand.id, productCode: 'TILE-B-800', inStock: true },
  });

  const server = http.createServer(
    (() => {
      const express = require('express');
      const host = express();
      host.use(express.static(FRONTEND));
      host.use(createApp());
      return host;
    })(),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const PHOTO = fs.readFileSync(path.join(FRONTEND, 'img/library/british-bathroom.png'));
  const PHOTO_PATH = path.join(FRONTEND, 'img/library/british-bathroom.png');

  const browser = await chromium.launch();
  const pageErrors = [];

  async function desk(email) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
    await context.route('https://drive.google.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO }));
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${email}: ${e}`));
    await page.goto(`${base}/login.html`);
    await page.evaluate(([e, p]) => window.CasaApi.auth.login(e, p), [email, PASSWORD]);
    await page.goto(`${base}/sample-placement.html`);
    await page.waitForSelector('.tabs .tab', { timeout: 20000 });
    return { context, page };
  }

  const adminDesk = await desk('admin@example.test');
  const staffDesk = await desk('staff@example.test');
  const ownerDesk = await desk('owner@example.test');

  try {
    // ══ 1–2. the ERP's products and their colours ═════════════════
    step('1–2. ERP products, and a colour state for each');

    check('1a. the page opens on the sample list, with a scan box to hand',
      await adminDesk.page.isVisible('#scanBox') && await adminDesk.page.isVisible('#fq'));
    check('1b. an Admin is offered registering and approvals; staff neither',
      (await adminDesk.page.$$('[data-tab="register"]')).length === 1
      && (await staffDesk.page.$$('[data-tab="register"]')).length === 0
      && (await staffDesk.page.$$('[data-tab="approvals"]')).length === 0,
      await staffDesk.page.$$eval('.tab', (els) => els.map((e) => e.textContent.trim())));

    await adminDesk.page.click('[data-tab="register"]');
    await adminDesk.page.waitForSelector('.prod', { timeout: 15000 });
    const products = await adminDesk.page.$$eval('.prod .n', (els) => els.map((e) => e.textContent.trim()));
    check('1c. the ERP’s own products are listed, read through its own API',
      products.includes('Tile A') && products.includes('Tile B'), products);

    const prodBox = await adminDesk.page.$eval('.prod', (el) => {
      const n = el.querySelector('.n').getBoundingClientRect();
      const c = el.querySelector('.c').getBoundingClientRect();
      return { stacked: c.top >= n.bottom - 1 };
    });
    check('1c-ii. a product card stacks its name over its code',
      prodBox.stacked, prodBox);

    await adminDesk.page.click('.prod:has-text("Tile A")');
    await adminDesk.page.waitForSelector('#ncName', { timeout: 15000 });

    // Five colours, each in its own state.
    const plan = [
      ['Orange', 'NOT_AVAILABLE'],
      ['Grey', 'CATALOGUE_ONLY'],
      ['Yellow', 'NOT_AVAILABLE'],
      ['Beige', 'CUTOUT_ONLY'],
      ['Charcoal', 'NOT_AVAILABLE'],
    ];
    for (const [name, availability] of plan) {
      await adminDesk.page.fill('#ncName', name);
      await adminDesk.page.selectOption('#ncAvail', availability);
      await adminDesk.page.click('#ncAdd');
      await adminDesk.page.waitForFunction(
        (n) => Array.from(document.querySelectorAll('.crow .cname')).some((e) => e.textContent.trim() === n),
        name, { timeout: 15000 });
    }
    const rows = await adminDesk.page.$$eval('.colours .crow:not(.head) .cname',
      (els) => els.map((e) => e.textContent.trim()));
    check('2a. all five colours are on record, independently',
      plan.every(([n]) => rows.includes(n)), rows);

    const states = await prisma.productColour.findMany({
      where: { productId: tileA.id }, select: { colourName: true, availability: true },
    });
    check('2b. ...each carrying its own availability',
      states.find((c) => c.colourName === 'Grey').availability === 'CATALOGUE_ONLY'
      && states.find((c) => c.colourName === 'Beige').availability === 'CUTOUT_ONLY'
      && states.find((c) => c.colourName === 'Charcoal').availability === 'NOT_AVAILABLE',
      states.map((c) => [c.colourName, c.availability]));
    check('2c. ...saved with no placement information asked for',
      (await prisma.physicalSample.count()) === 0);

    // ══ 3–5. registering, and duplicating across colours ══════════
    step('3–5. registering physical samples, and duplicating across colours');

    // Tick Orange, Yellow and Charcoal; correct Yellow's panel.
    for (const colour of ['Orange', 'Yellow', 'Charcoal']) {
      const id = states.find((c) => c.colourName === colour);
      const row = await adminDesk.page.$(`.crow:has(.cname:text-is("${colour}")) [data-pick]`);
      await row.click();
      await adminDesk.page.waitForTimeout(140);
      void id;
    }
    await adminDesk.page.waitForSelector('#bCass', { timeout: 15000 });
    check('3a. the chosen colours are listed for review before saving',
      (await adminDesk.page.$$('[data-override-cass]')).length === 3);

    await adminDesk.page.fill('#bCass', 'C01');
    await adminDesk.page.fill('#bPanel', 'P05');

    // Required fields: no photograph yet.
    await adminDesk.page.click('#bSave');
    await adminDesk.page.waitForTimeout(220);
    check('3b. it will not save without a photograph',
      /photograph/i.test(await adminDesk.page.textContent('#bErr'))
      && (await prisma.physicalSample.count()) === 0,
      await adminDesk.page.textContent('#bErr'));

    await adminDesk.page.setInputFiles('#bPhoto', PHOTO_PATH);
    // ...and one colour corrected before saving.
    const yellowOverride = await adminDesk.page.$(
      `[data-override-panel="${states.find((c) => c.colourName === 'Yellow') ? '' : ''}"]`);
    void yellowOverride;
    const overrideInputs = await adminDesk.page.$$('[data-override-panel]');
    const names = await adminDesk.page.$$eval('.panel .crow .cname', (els) => els.map((e) => e.textContent.trim()));
    const yellowIndex = names.indexOf('Yellow');
    await overrideInputs[yellowIndex].fill('P-09');

    await adminDesk.page.click('#bSave');
    await adminDesk.page.waitForSelector('#bYes', { timeout: 15000 });
    const confirmText = await adminDesk.page.evaluate(() => {
      const yes = document.getElementById('bYes');
      return yes ? yes.closest('.panel').textContent.replace(/\s+/g, ' ').trim() : '';
    });
    check('3c. a confirmation is asked for before bulk registration',
      /register these 3/i.test(confirmText) && /its own.*barcode/i.test(confirmText),
      confirmText.slice(0, 120));

    await adminDesk.page.click('#bYes');
    await adminDesk.page.waitForFunction(
      () => document.querySelectorAll('.tag.ok').length >= 3, { timeout: 25000 });

    const made = await prisma.physicalSample.findMany({
      include: { colour: true, placements: true },
      orderBy: { createdAt: 'asc' },
    });
    check('4a. three independent sample records were created',
      made.length === 3
      && new Set(made.map((m) => m.sampleId)).size === 3
      && new Set(made.map((m) => m.barcode)).size === 3,
      made.map((m) => [m.colour.colourName, m.sampleId, m.barcode]));
    check('4b. ...the shared cassette and panel copied across',
      made.filter((m) => m.placements[0].cassetteNo === 'C01').length === 3
      && made.filter((m) => m.placements[0].panelNo === 'P05').length === 2,
      made.map((m) => `${m.colour.colourName}:${m.placements[0].cassetteNo}/${m.placements[0].panelNo}`));
    check('4c. ...and the one correction honoured',
      made.find((m) => m.colour.colourName === 'Yellow').placements[0].panelNo === 'P-09');
    check('4d. every registered colour moved to PHYSICAL_SAMPLE',
      made.every((m) => m.colour.availability === 'PHYSICAL_SAMPLE'));
    check('4e. ...each with its photograph in the studio’s own Drive folder',
      made.every((m) => !!m.photoDriveFileId)
      && [...folders.values()].some((f) => f.name === 'Physical Samples' && f.parent === LIBRARY_FOLDER));

    // Registering the same colours again must not duplicate them.
    const already = await adminDesk.page.$$('.crow [data-pick]');
    check('5a. a colour already registered offers no checkbox at all',
      already.length === 2,
      await adminDesk.page.$$eval('.crow .tag.ok', (els) => els.length));

    // ══ 6. the placement list, searched and filtered ══════════════
    step('6. the Sample Placement list');

    await staffDesk.page.click('[data-tab="samples"]');
    await staffDesk.page.waitForSelector('.card', { timeout: 20000 });
    check('6a. every sample is listed, with product, colour, ids and where it sits',
      (await staffDesk.page.$$('.card')).length === 3
      && (await staffDesk.page.$$eval('.card .card-prod', (els) => els.every((e) => e.textContent.trim())))
      && (await staffDesk.page.$$eval('.card .card-where .at', (els) => els.length === 3)));

    /* Looked at, not only asserted: .card-shot is a span, and
       aspect-ratio does nothing on an inline box -- the photograph sized
       itself to its natural height and swallowed the card. Geometry
       catches that; a selector does not. */
    const cardBox = await staffDesk.page.$eval('.card', (el) => {
      const shot = el.querySelector('.card-shot').getBoundingClientRect();
      const body = el.querySelector('.card-body').getBoundingClientRect();
      return {
        ratio: shot.width / shot.height,
        bodyBelow: body.top >= shot.bottom - 1,
        bodyVisible: body.height > 40,
      };
    });
    check('6a-ii. the photograph keeps its frame instead of swallowing the card',
      Math.abs(cardBox.ratio - 1.6) < 0.08 && cardBox.bodyBelow && cardBox.bodyVisible,
      cardBox);

    await staffDesk.page.fill('#fq', 'Yellow');
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 1, { timeout: 15000 });
    check('6b. searching by colour narrows it',
      /Yellow/.test(await staffDesk.page.textContent('.card .card-col')));

    const yellowBarcode = made.find((m) => m.colour.colourName === 'Yellow').barcode;
    await staffDesk.page.fill('#fq', yellowBarcode);
    await staffDesk.page.waitForFunction(
      (code) => {
        const cards = document.querySelectorAll('.card');
        return cards.length === 1 && cards[0].textContent.includes(code);
      }, yellowBarcode, { timeout: 15000 });
    check('6c. ...and so does searching by barcode', true);

    await staffDesk.page.click('#fclear');
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 3, { timeout: 15000 });
    await staffDesk.page.fill('#fcass', 'C01');
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 3, { timeout: 15000 });
    await staffDesk.page.fill('#fpanel', 'P-09');
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 1, { timeout: 15000 });
    check('6d. filtering by cassette and panel works on the current placement', true);
    await staffDesk.page.click('#fclear');
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 3, { timeout: 15000 });

    // ══ 7. scanning ══════════════════════════════════════════════
    step('7. scanning a barcode');

    await staffDesk.page.fill('#scanBox', yellowBarcode);
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('.facts', { timeout: 20000 });

    const facts = await staffDesk.page.textContent('.facts');
    check('7a. a scan opens that exact sample, with everything about it',
      facts.includes(yellowBarcode)
      && facts.includes('C01') && facts.includes('P-09')
      && /Yellow/.test(await staffDesk.page.textContent('.step-h1')),
      { title: await staffDesk.page.textContent('.step-h1') });
    check('7b. ...including when it was registered and when it last moved',
      /REGISTERED/.test(facts) && /LAST MOVED/.test(facts));
    check('7c. ...and its photograph', (await staffDesk.page.$$('.shot-big img')).length === 1);

    // The sample view is its own screen -- back out of it the way the
    // page offers, not through a tab that is not on it.
    await staffDesk.page.click('#backBtn');
    await staffDesk.page.waitForSelector('#scanBox', { timeout: 15000 });
    await staffDesk.page.fill('#scanBox', 'NOT-A-BARCODE');
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('.toast.on', { timeout: 15000 });
    check('7d. an unknown barcode says so plainly',
      /not one of the studio|could not be found|no sample/i.test(
        await staffDesk.page.textContent('.toast')),
      await staffDesk.page.textContent('.toast'));

    // ══ 8. asking for a move ═════════════════════════════════════
    step('8. a move is asked for, and waits');

    const yellow = made.find((m) => m.colour.colourName === 'Yellow');
    await staffDesk.page.goto(`${base}/sample-placement.html`);
    await staffDesk.page.waitForSelector('.card', { timeout: 20000 });
    await staffDesk.page.fill('#scanBox', yellowBarcode);
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('#moveBtn', { timeout: 20000 });

    await staffDesk.page.click('#moveBtn');
    await staffDesk.page.waitForSelector('#mSend', { timeout: 15000 });
    await staffDesk.page.click('#mSend');
    await staffDesk.page.waitForTimeout(220);
    check('8a. a move with no cassette or panel is refused by the form',
      /both a cassette and a panel/i.test(await staffDesk.page.textContent('#mErr')),
      await staffDesk.page.textContent('#mErr'));

    await staffDesk.page.fill('#mCass', 'C01');
    await staffDesk.page.fill('#mPanel', 'P08');
    await staffDesk.page.fill('#mReason', 'Moved up a row for the window');
    await staffDesk.page.click('#mSend');
    await staffDesk.page.waitForSelector('.tr.pending', { timeout: 20000 });

    const afterAsk = await prisma.samplePlacement.findFirst({
      where: { physicalSampleId: yellow.id, isCurrent: true },
    });
    check('8b. the request is recorded and the sample has NOT moved',
      afterAsk.cassetteNo === 'C01' && afterAsk.panelNo === 'P-09'
      && (await prisma.placementChangeRequest.count({ where: { status: 'PENDING' } })) === 1,
      `${afterAsk.cassetteNo}/${afterAsk.panelNo}`);
    check('8c. the screen shows it as pending, never as the location',
      /AWAITING ADMIN APPROVAL/i.test(await staffDesk.page.textContent('.tr.pending'))
      && /THE SAMPLE HAS NOT MOVED/i.test(await staffDesk.page.textContent('.tr.pending'))
      && (await staffDesk.page.textContent('.facts')).includes('P-09'));
    check('8d. ...and no second change can be asked for while it waits',
      (await staffDesk.page.$$('#moveBtn')).length === 0
      && /already waiting/i.test(await staffDesk.page.textContent('.panel')),
      await staffDesk.page.textContent('.panel'));

    // The list flags it too, without moving the location.
    await staffDesk.page.click('#backBtn');
    await staffDesk.page.waitForSelector('.card', { timeout: 15000 });
    await staffDesk.page.fill('#fq', yellowBarcode);
    await staffDesk.page.waitForFunction(
      () => document.querySelectorAll('.card').length === 1, { timeout: 15000 });
    check('8e. the list flags a pending move but still shows the real location',
      (await staffDesk.page.textContent('.card')).includes('MOVE PENDING')
      && (await staffDesk.page.textContent('.card .card-where')).includes('P-09'));

    // ══ 9–12. the Admin decides ══════════════════════════════════
    step('9–12. the approval queue');

    check('9a. floor staff have no approvals tab at all',
      (await staffDesk.page.$$('[data-tab="approvals"]')).length === 0);

    /* AND THE HIDDEN TAB IS NOT THE GATE. Asked directly from the staff
       member's own logged-in browser, the server refuses -- which is the
       difference between a screen that hides a button and a system that
       will not do the thing. */
    const pendingId = (await prisma.placementChangeRequest.findFirst({
      where: { status: 'PENDING' }, select: { id: true },
    })).id;
    const staffTriesApi = await staffDesk.page.evaluate(async (id) => {
      const out = {};
      for (const verb of ['approve', 'reject']) {
        try {
          await window.CasaApi.samples[verb](id, 'trying it on');
          out[verb] = 'ALLOWED';
        } catch (e) { out[verb] = e.status || e.statusCode || String(e.message); }
      }
      try {
        await window.CasaApi.samples.requests({ status: 'PENDING' });
        out.queue = 'ALLOWED';
      } catch (e) { out.queue = e.status || e.statusCode || String(e.message); }
      return out;
    }, pendingId);
    check('9a-ii. ...and the server refuses them even when asked directly',
      staffTriesApi.approve === 403 && staffTriesApi.reject === 403
      && staffTriesApi.queue === 403,
      staffTriesApi);
    check('9a-iii. ...so nothing was decided',
      (await prisma.placementChangeRequest.findUnique({ where: { id: pendingId } })).status
        === 'PENDING');

    await ownerDesk.page.click('[data-tab="approvals"]');
    await ownerDesk.page.waitForSelector('.req', { timeout: 20000 });
    const req = await ownerDesk.page.textContent('.req');
    check('9b. the Admin sees it, with where from, where to, who and why',
      req.includes('C01 / P-09') && req.includes('C01 / P08')
      && /FLOOR STAFF/i.test(req) && /window/i.test(req), req.slice(0, 160));

    // A refusal needs a reason.
    await ownerDesk.page.click('[data-reject]');
    await ownerDesk.page.waitForSelector('.toast.on', { timeout: 15000 });
    check('9c. refusing without a reason is refused',
      /needs a reason/i.test(await ownerDesk.page.textContent('.toast'))
      && (await prisma.placementChangeRequest.count({ where: { status: 'PENDING' } })) === 1,
      await ownerDesk.page.textContent('.toast'));

    await ownerDesk.page.click('[data-approve]');
    await ownerDesk.page.waitForFunction(
      () => document.querySelectorAll('.req').length === 0, { timeout: 25000 });

    const moved = await prisma.samplePlacement.findMany({
      where: { physicalSampleId: yellow.id }, orderBy: { placedAt: 'asc' },
    });
    check('10a. approving is what moves it',
      moved.length === 2 && moved[1].cassetteNo === 'C01' && moved[1].panelNo === 'P08'
      && moved.filter((p) => p.isCurrent).length === 1 && moved[1].isCurrent,
      moved.map((p) => `${p.cassetteNo}/${p.panelNo}:${p.isCurrent}`));
    check('10b. ...and the previous placement stays in the history, closed off',
      moved[0].cassetteNo === 'C01' && moved[0].panelNo === 'P-09'
      && moved[0].isCurrent === false && !!moved[0].endedAt);

    const sameIds = await prisma.physicalSample.findUnique({ where: { id: yellow.id } });
    check('10c. THE SAMPLE ID AND BARCODE ARE UNCHANGED BY THE MOVE',
      sameIds.sampleId === yellow.sampleId && sameIds.barcode === yellow.barcode,
      { was: yellow.barcode, now: sameIds.barcode });

    // A second move, so the history is worth reading.
    await staffDesk.page.goto(`${base}/sample-placement.html`);
    await staffDesk.page.waitForSelector('#scanBox', { timeout: 20000 });
    await staffDesk.page.fill('#scanBox', yellowBarcode);
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('#moveBtn', { timeout: 20000 });
    await staffDesk.page.click('#moveBtn');
    await staffDesk.page.waitForSelector('#mSend', { timeout: 15000 });
    await staffDesk.page.fill('#mCass', 'C02');
    await staffDesk.page.fill('#mPanel', 'P03');
    await staffDesk.page.click('#mSend');
    await staffDesk.page.waitForSelector('.tr.pending', { timeout: 20000 });

    await ownerDesk.page.click('[data-tab="samples"]');
    await ownerDesk.page.click('[data-tab="approvals"]');
    await ownerDesk.page.waitForSelector('.req', { timeout: 20000 });
    await ownerDesk.page.click('[data-approve]');
    await ownerDesk.page.waitForFunction(
      () => document.querySelectorAll('.req').length === 0, { timeout: 25000 });

    // ...and one refused.
    await staffDesk.page.goto(`${base}/sample-placement.html`);
    await staffDesk.page.waitForSelector('#scanBox', { timeout: 20000 });
    await staffDesk.page.fill('#scanBox', yellowBarcode);
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('#moveBtn', { timeout: 20000 });
    await staffDesk.page.click('#moveBtn');
    await staffDesk.page.waitForSelector('#mSend', { timeout: 15000 });
    await staffDesk.page.fill('#mCass', 'C09');
    await staffDesk.page.fill('#mPanel', 'Z01');
    await staffDesk.page.click('#mSend');
    await staffDesk.page.waitForSelector('.tr.pending', { timeout: 20000 });

    await ownerDesk.page.click('[data-tab="samples"]');
    await ownerDesk.page.click('[data-tab="approvals"]');
    await ownerDesk.page.waitForSelector('.req', { timeout: 20000 });
    await ownerDesk.page.fill('[id^="note-"]', 'It stays where it is');
    await ownerDesk.page.click('[data-reject]');
    await ownerDesk.page.waitForFunction(
      () => document.querySelectorAll('.req').length === 0, { timeout: 25000 });

    const afterReject = await prisma.samplePlacement.findFirst({
      where: { physicalSampleId: yellow.id, isCurrent: true },
    });
    check('11a. a refusal leaves the sample exactly where it was',
      afterReject.cassetteNo === 'C02' && afterReject.panelNo === 'P03'
      && (await prisma.samplePlacement.count({ where: { physicalSampleId: yellow.id } })) === 3,
      `${afterReject.cassetteNo}/${afterReject.panelNo}`);

    // ══ the history, with the four things distinguished ══════════
    step('the history on the sample page');

    await staffDesk.page.goto(`${base}/sample-placement.html`);
    await staffDesk.page.waitForSelector('#scanBox', { timeout: 20000 });
    await staffDesk.page.fill('#scanBox', yellowBarcode);
    await staffDesk.page.press('#scanBox', 'Enter');
    await staffDesk.page.waitForSelector('.trail .tr', { timeout: 20000 });

    const trail = await staffDesk.page.$$eval('.trail .tr',
      (els) => els.map((e) => ({ cls: e.className, text: e.textContent.replace(/\s+/g, ' ').trim() })));
    check('12a. the current placement is marked as current, and only one is',
      trail.filter((t) => / now/.test(t.cls)).length === 1
      && /Currently at C02 \/ P03/.test(trail.find((t) => / now/.test(t.cls)).text),
      trail.map((t) => t.text.slice(0, 44)));
    check('12b. previous approved placements are there, as past ones',
      trail.filter((t) => /^Was at/.test(t.text)).length === 2,
      trail.filter((t) => /Was at/.test(t.text)).map((t) => t.text.slice(0, 40)));
    check('12c. the refusal is there, named as a refusal with its reason',
      trail.some((t) => /^Refused/.test(t.text) && /stays where it is/i.test(t.text)),
      trail.filter((t) => /Refused/.test(t.text)).map((t) => t.text.slice(0, 70)));
    check('12d. nothing pending is shown, because nothing is pending',
      trail.filter((t) => /pending/.test(t.cls)).length === 0);

    // ...and each entry stacks its line over its detail rather than
    // running them together, which inline spans did.
    const trailBox = await staffDesk.page.$eval('.trail .tr', (el) => {
      const t = el.querySelector('.tr-t').getBoundingClientRect();
      const m = el.querySelector('.tr-m').getBoundingClientRect();
      return { stacked: m.top >= t.bottom - 1, sameLeft: Math.abs(m.left - t.left) < 2 };
    });
    check('12e. each history line sits above its detail, not beside it',
      trailBox.stacked && trailBox.sameLeft, trailBox);

    // ══ 13. removal ══════════════════════════════════════════════
    step('13. removal is a request, and deletes nothing');

    await staffDesk.page.click('#removeBtn');
    await staffDesk.page.waitForSelector('#rSend', { timeout: 15000 });
    check('13a. the screen says plainly that nothing is deleted',
      /Nothing is deleted/i.test(await staffDesk.page.textContent('.panel')));
    await staffDesk.page.fill('#rReason', 'The piece has cracked');
    await staffDesk.page.click('#rSend');
    await staffDesk.page.waitForSelector('.tr.pending', { timeout: 20000 });

    check('13b. the sample is still on its panel while the removal waits',
      (await prisma.physicalSample.findUnique({ where: { id: yellow.id } })).status === 'ACTIVE'
      && !!(await prisma.samplePlacement.findFirst({
        where: { physicalSampleId: yellow.id, isCurrent: true },
      })));

    await ownerDesk.page.click('[data-tab="samples"]');
    await ownerDesk.page.click('[data-tab="approvals"]');
    await ownerDesk.page.waitForSelector('.req', { timeout: 20000 });
    const removalReq = await ownerDesk.page.textContent('.req');
    check('13c. the Admin sees it as a removal, going off the shelf, with the reason',
      /REMOVAL/.test(removalReq) && /off the shelf/i.test(removalReq)
      && /cracked/i.test(removalReq), removalReq.slice(0, 140));
    await ownerDesk.page.click('[data-approve]');
    await ownerDesk.page.waitForFunction(
      () => document.querySelectorAll('.req').length === 0, { timeout: 25000 });

    const removed = await prisma.physicalSample.findUnique({
      where: { id: yellow.id }, include: { placements: true, changeRequests: true },
    });
    check('13d. NOTHING WAS DELETED: record, barcode and history all intact',
      !!removed && removed.barcode === yellow.barcode && removed.status === 'REMOVED'
      && removed.placements.length === 3 && removed.changeRequests.length === 4,
      { status: removed && removed.status, placements: removed && removed.placements.length });
    check('13e. ...and it is on no panel',
      removed.placements.every((p) => !p.isCurrent));

    // ══ 14. ERP stock untouched ══════════════════════════════════
    step('14. the ERP’s own numbers');

    const stock = await prisma.tile.findMany({ select: { name: true, inStock: true, productCode: true } });
    check('14a. no product’s stock flag changed through any of this',
      stock.length === 2 && stock.every((t) => t.inStock === true),
      stock.map((t) => [t.name, t.inStock]));

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
