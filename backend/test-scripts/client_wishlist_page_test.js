/**
 * De'vyora Client Wishlist -- the client's own screens.
 *
 * The real page in Chromium, against the real server and a real
 * Postgres with the real migration applied. Google Drive is replaced at
 * its own boundary with a genuine photograph (this machine has no
 * credential for Drive), so the grid lays out and decodes exactly as it
 * would with Drive up -- a 1x1 pixel would hide every aspect-ratio and
 * lazy-loading question this chunk is about.
 *
 * Two browser contexts, because the thing most worth proving is that
 * one client in a showroom cannot see another's selection.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/client_wishlist_page_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_wishpage?host=/var/tmp';

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
  const admin = DB_URL.replace(/\/tm_wishpage\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_wishpage'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_wishpage'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));
  drive.googleDriveClient.isConfigured = () => true;
  drive.googleDriveClient.deleteFile = async () => {};

  const ownerRole = await prisma.role.create({
    data: { name: 'OWNER', description: 'test', permissions: ['*'] },
  });
  const owner = await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'priya@example.test',
      passwordHash: await hashPassword('dummy-password-wishpage'),
      roleId: ownerRole.id,
    },
  });

  // A theme with enough rooms that the gallery MUST load in parts: 60
  // uploaded, plus the 6 that ship with every theme.
  const BRITISH = 60;
  for (let i = 0; i < BRITISH; i += 1) {
    await prisma.libraryReference.create({
      data: {
        themeId: 'british',
        title: `Heritage Room ${String(i + 1).padStart(2, '0')}`,
        imageUrl: `https://drive.google.com/uc?export=download&id=file-british-${i}`,
        driveFileId: `file-british-${i}`,
        room: 'Bathroom',
        uploadedById: owner.id,
      },
    });
  }
  await prisma.libraryReference.create({
    data: {
      themeId: 'moroccan',
      title: 'Zellige Courtyard',
      imageUrl: 'https://drive.google.com/uc?export=download&id=file-moroccan-1',
      driveFileId: 'file-moroccan-1',
      uploadedById: owner.id,
    },
  });

  const express = require('express');
  const host = express();
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  // A real photograph, with real dimensions, standing in for Drive.
  const PHOTO = fs.readFileSync(path.join(FRONTEND, 'img/library/british-bathroom.png'));

  const browser = await chromium.launch();

  async function showroom() {
    // A showroom tablet, in landscape.
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const widths = [];
    await context.route('https://drive.google.com/**', (route) => {
      const m = /[?&]sz=w(\d+)/.exec(route.request().url());
      widths.push(m ? Number(m[1]) : 0);
      route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    return { context, page, widths, errors };
  }

  const a = await showroom();

  try {
    // ── 1. registration ──────────────────────────────────────────
    await a.page.goto(`${base}/wishlist.html`);
    await a.page.waitForSelector('#regForm', { timeout: 15000 });

    check('1. the client is asked to register before anything else',
      await a.page.isVisible('#regName') && await a.page.isVisible('#regPhone'));
    check('2. the mobile number is marked optional, the name is not',
      /OPTIONAL/.test(await a.page.textContent('label[for="regPhone"]'))
      && !/OPTIONAL/.test(await a.page.textContent('label[for="regName"]')));

    // Nothing about budget, colour, rooms or preferences.
    const regText = (await a.page.textContent('#regForm')).toLowerCase();
    check('3. and nothing else is asked of them',
      !/budget|colour|color|preference|requirement|email/.test(regText)
      && (await a.page.$$('#regForm input')).length === 2, regText.slice(0, 120));

    await a.page.click('#regBtn');
    await a.page.waitForTimeout(250);
    check('4. a nameless registration is refused on the spot',
      /enter your name/i.test(await a.page.textContent('#regNameErr'))
      && await a.page.isVisible('#regForm'));

    // A name alone is enough -- no number typed.
    await a.page.fill('#regName', 'Aarti Mehta');
    await a.page.click('#regBtn');
    await a.page.waitForSelector('.theme-grid .theme-card', { timeout: 15000 });
    check('5. a name alone starts the wishlist and opens the themes', true);

    // ── 2. theme discovery ───────────────────────────────────────
    const cards = await a.page.$$('.theme-grid .theme-card');
    const apiThemes = await a.page.evaluate(() => window.CasaApi.clientWishlist.themes());
    check('6. every theme the server offers is shown, and no more',
      cards.length === apiThemes.themes.length && cards.length === 10,
      { shown: cards.length, fromServer: apiThemes.themes.length });

    const names = await a.page.$$eval('.theme-name', (els) => els.map((e) => e.textContent.trim()));
    const serverNames = apiThemes.themes.map((t) => t.label);
    check('7. the names are the server’s, not the page’s own list',
      JSON.stringify(names) === JSON.stringify(serverNames), { names, serverNames });

    const firstCard = await a.page.$('.theme-card:not(.is-others)');
    check('8. a theme card carries a room, its name and a short description',
      !!(await firstCard.$('.theme-art img')) && !!(await firstCard.$('.theme-name'))
      && ((await firstCard.$eval('.theme-desc', (e) => e.textContent.trim())).length > 8));

    const othersCard = await a.page.$('.theme-card.is-others');
    check('9. Others is offered as its own option',
      !!othersCard && /others/i.test(await othersCard.$eval('.theme-name', (e) => e.textContent)));
    check('10. ...and shows it is all of the themes, not one of them',
      (await othersCard.$$('.theme-art img')).length === 4
      && (await othersCard.$$('.theme-plate')).length === 0);

    // Every theme card's picture actually resolved.
    const brokenArt = await a.page.$$eval('.theme-art img',
      (els) => els.filter((e) => !e.complete || e.naturalWidth === 0).map((e) => e.getAttribute('src')));
    check('11. no theme card is left with an empty frame', brokenArt.length === 0, brokenArt);

    // ── 3. the gallery ───────────────────────────────────────────
    await a.page.click('.theme-card[data-theme="british"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 15000 });

    const firstBatch = (await a.page.$$('.grid .pic')).length;
    const total = BRITISH + 6;
    check('12. a big theme opens in one batch, not all at once',
      firstBatch === 24 && /SHOWING 24 OF ' + total + '/.test('') === false
      && new RegExp(`SHOWING 24 OF ${total}`).test(await a.page.textContent('.counting')),
      { firstBatch, counting: await a.page.textContent('.counting') });

    check('13. every picture is marked for lazy loading',
      (await a.page.$$eval('.grid .pic-shot img', (els) => els.every((e) => e.loading === 'lazy'))));

    // The grid asks Drive for a card-sized picture, never the big one.
    check('14. the grid never asks for a full-resolution picture',
      a.widths.length > 0 && a.widths.every((w) => w <= 600), a.widths.slice(0, 8));

    // Scrolling brings more -- without redrawing what is already there.
    const firstTitleBefore = await a.page.$eval('.grid .pic .pic-title', (e) => e.textContent);
    await a.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await a.page.waitForFunction(() => document.querySelectorAll('.grid .pic').length > 24, { timeout: 10000 });
    const second = (await a.page.$$('.grid .pic')).length;
    check('15. scrolling loads more rooms', second > firstBatch, { firstBatch, second });
    check('16. ...appended, not redrawn from scratch',
      (await a.page.$eval('.grid .pic .pic-title', (e) => e.textContent)) === firstTitleBefore);

    // Keep going to the end.
    for (let i = 0; i < 4; i += 1) {
      await a.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await a.page.waitForTimeout(350);
    }
    check('17. everything in the theme can be reached',
      (await a.page.$$('.grid .pic')).length === total,
      { shown: (await a.page.$$('.grid .pic')).length, total });

    // A picture is never stretched: the frame crops, and the enlarged
    // view shows the whole thing at its own proportions.
    /* Looked at, not only asserted: the title and the theme label are
       spans, and when they laid out inline the theme ran underneath
       the heart. Geometry catches that; a selector does not. */
    const foot = await a.page.$eval('.grid .pic', (fig) => {
      const box = (sel) => fig.querySelector(sel).getBoundingClientRect();
      const title = box('.pic-title'); const theme = box('.pic-theme'); const heart = box('.heart');
      return {
        stacked: theme.top >= title.bottom - 1,
        clearOfHeart: title.right <= heart.left + 1 && theme.right <= heart.left + 1,
      };
    });
    check('17b. the title sits above the theme, not beside it', foot.stacked, foot);
    check('17c. neither runs underneath the heart', foot.clearOfHeart, foot);

    check('18. a card frame crops rather than distorts',
      (await a.page.$eval('.grid .pic-shot img', (e) => getComputedStyle(e).objectFit)) === 'cover');

    await a.page.evaluate(() => window.scrollTo(0, 0));
    await a.page.click('.grid .pic .pic-shot');
    await a.page.waitForSelector('.zoom.on img', { timeout: 10000 });
    const ratios = await a.page.$eval('.zoom.on img', (e) => ({
      natural: e.naturalWidth / e.naturalHeight,
      drawn: e.getBoundingClientRect().width / e.getBoundingClientRect().height,
    }));
    check('19. the enlarged room keeps its true aspect ratio',
      Math.abs(ratios.natural - ratios.drawn) < 0.02, ratios);

    // ── 4. the heart ─────────────────────────────────────────────
    const inZoom = await a.page.$('.zoom.on .heart');
    check('20. a room can be kept from the enlarged view too', !!inZoom);
    await a.page.click('.zoom-close');
    await a.page.waitForTimeout(150);

    const firstPic = await a.page.$('.grid .pic');
    const firstId = await firstPic.getAttribute('data-pic');
    await firstPic.$eval('.heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '1', { timeout: 10000 });
    check('21. one tap keeps a room, and the count says so',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '1');
    check('22. the heart fills in',
      (await firstPic.$eval('.heart', (b) => b.getAttribute('aria-pressed'))) === 'true'
      && (await firstPic.$eval('.heart svg', (s) => s.getAttribute('fill'))) === 'currentColor');

    // Tapping again takes it back out.
    await firstPic.$eval('.heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '0', { timeout: 10000 });
    check('23. tapping again removes it',
      (await firstPic.$eval('.heart', (b) => b.getAttribute('aria-pressed'))) === 'false');

    // Keep three, and check the server agrees rather than the page.
    await firstPic.$eval('.heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '1', { timeout: 10000 });
    const pics = await a.page.$$('.grid .pic');
    await pics[1].$eval('.heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '2', { timeout: 10000 });

    // A double tap in quick succession must not double-add.
    await pics[2].$eval('.heart', (b) => { b.click(); b.click(); });
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '3', { timeout: 10000 });
    await a.page.waitForTimeout(600);
    check('24. a double tap keeps one room, not two',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '3');

    const token = await a.page.evaluate(() => localStorage.getItem('devyora.wishlist.token'));
    check('24b. the wishlist is remembered on the tablet, so a reload can find it',
      typeof token === 'string' && token.length > 20, { token: token ? 'present' : token });
    if (!token) throw new Error('no token was stored; the checks below cannot run');

    let server = await prisma.clientWishlist.findUnique({
      where: { token }, include: { items: true },
    });
    check('25. the server holds the same three, written as they were tapped',
      server.items.length === 3, server.items.map((i) => i.imageId));

    // ── 5. across themes ─────────────────────────────────────────
    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid .theme-card', { timeout: 10000 });
    check('26. the theme a client has kept from is marked',
      (await a.page.$$('.theme-card[data-theme="british"] .theme-mine')).length === 1);

    await a.page.click('.theme-card[data-theme="moroccan"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 10000 });
    check('27. switching themes keeps the count',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '3');
    await a.page.$eval('.grid .pic .heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '4', { timeout: 10000 });
    check('28. rooms can be kept from more than one theme', true);

    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid', { timeout: 10000 });
    await a.page.click('.theme-card[data-theme="british"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 10000 });
    check('29. going back into a theme still shows what was kept there',
      (await a.page.$$eval('.grid .pic .heart[aria-pressed="true"]', (els) => els.length)) === 3,
      await a.page.$$eval('.grid .pic .heart[aria-pressed="true"]', (els) => els.length));

    // ── 6. Others ────────────────────────────────────────────────
    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid', { timeout: 10000 });
    await a.page.click('.theme-card[data-theme="others"]');
    await a.page.waitForSelector('.grid .pic', { timeout: 15000 });
    const othersThemes = await a.page.$$eval('.grid .pic-theme',
      (els) => Array.from(new Set(els.map((e) => e.textContent.trim()))));
    check('30. Others gathers rooms from more than one theme',
      othersThemes.length > 1, othersThemes);
    check('31. ...and a room kept elsewhere is already hearted inside it',
      (await a.page.$$eval('.grid .pic .heart[aria-pressed="true"]', (els) => els.length)) > 0);

    const othersTotal = Number((await a.page.textContent('.counting')).match(/OF (\d+)/)[1]);
    check('32. Others is the whole library, not a copy of one theme',
      othersTotal > total, { othersTotal, british: total });

    // Nothing was duplicated in the database to build it.
    check('33. and it duplicated nothing to do it',
      (await prisma.libraryReference.count()) === BRITISH + 1,
      await prisma.libraryReference.count());

    // ── 7. a reload must not lose anything ───────────────────────
    await a.page.reload();
    await a.page.waitForSelector('.theme-grid .theme-card', { timeout: 15000 });
    check('34. a reload keeps the wishlist and does not ask again',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '4'
      && !(await a.page.$('#regForm')));

    // ── 8. the wishlist screen ───────────────────────────────────
    await a.page.click('#countBtn');
    await a.page.waitForSelector('.view .grid .pic', { timeout: 10000 });
    check('35. the wishlist shows every room kept, with its theme',
      (await a.page.$$('.grid .pic')).length === 4
      && (await a.page.$$eval('.grid .pic-theme', (els) => els.every((e) => e.textContent.trim().length > 1))));
    check('36. ...the total, a way to carry on, and a way to send it',
      (await a.page.textContent('.sum-n')) === '4'
      && !!(await a.page.$('[data-back]')) && !!(await a.page.$('#submitBtn')));

    const themesShown = await a.page.$$eval('.grid .pic-theme',
      (els) => Array.from(new Set(els.map((e) => e.textContent.trim()))));
    check('37. rooms from both themes are in it', themesShown.length === 2, themesShown);

    // Remove one from here.
    await a.page.$eval('.grid .pic .heart', (b) => b.click());
    await a.page.waitForFunction(() => document.getElementById('countN').textContent === '3', { timeout: 10000 });
    check('38. a room can be removed from the wishlist screen',
      (await a.page.$$('.grid .pic')).length === 3
      && (await a.page.textContent('.sum-n')) === '3');

    // Carrying on and coming back loses nothing.
    await a.page.click('[data-back]');
    await a.page.waitForSelector('.theme-grid', { timeout: 10000 });
    await a.page.click('#countBtn');
    await a.page.waitForSelector('.sum-n', { timeout: 10000 });
    check('39. browsing on and returning loses nothing',
      (await a.page.textContent('.sum-n')) === '3');

    // ── 9. ANOTHER CLIENT, ON ANOTHER TABLET ─────────────────────
    const b = await showroom();
    await b.page.goto(`${base}/wishlist.html`);
    await b.page.waitForSelector('#regForm', { timeout: 15000 });
    check('40. a second client is asked to register, not handed the first’s wishlist',
      (await b.page.$eval('#countN', (e) => e.textContent)) === '0'
      && !(await b.page.isVisible('#countBtn')));

    await b.page.fill('#regName', 'Rohit Nair');
    await b.page.fill('#regPhone', '9876543210');
    await b.page.click('#regBtn');
    await b.page.waitForSelector('.theme-grid .theme-card', { timeout: 15000 });
    check('41. ...and starts with an empty one',
      (await b.page.$eval('#countN', (e) => e.textContent)) === '0');

    await b.page.click('.theme-card[data-theme="moroccan"]');
    await b.page.waitForSelector('.grid .pic', { timeout: 10000 });
    const bSeesHearts = await b.page.$$eval('.grid .pic .heart[aria-pressed="true"]', (els) => els.length);
    check('42. the second client sees none of the first client’s hearts', bSeesHearts === 0);

    await b.page.$eval('.grid .pic .heart', (x) => x.click());
    await b.page.waitForFunction(() => document.getElementById('countN').textContent === '1', { timeout: 10000 });
    check('43. their own choice is their own',
      (await b.page.$eval('#countN', (e) => e.textContent)) === '1');

    // The first client's screen is untouched by any of it.
    await a.page.reload();
    await a.page.waitForSelector('.theme-grid', { timeout: 15000 });
    check('44. and the first client’s wishlist is unchanged',
      (await a.page.$eval('#countN', (e) => e.textContent)) === '3');

    const tokenB = await b.page.evaluate(() => localStorage.getItem('devyora.wishlist.token'));
    check('45. the two hold different credentials', !!tokenB && tokenB !== token);

    // ── 10. sending it ───────────────────────────────────────────
    await a.page.click('#countBtn');
    await a.page.waitForSelector('#submitBtn', { timeout: 10000 });
    await a.page.click('#submitBtn');
    await a.page.waitForSelector('#submitYes', { timeout: 10000 });
    check('46. submitting asks first, so it cannot happen by accident',
      !!(await a.page.$('#submitNo')) && /send/i.test(await a.page.textContent('#submitYes')));

    await a.page.click('#submitNo');
    await a.page.waitForSelector('#submitBtn', { timeout: 10000 });
    check('47. ...and can be backed out of',
      (await prisma.clientWishlist.findUnique({ where: { token } })).status === 'DRAFT');

    await a.page.click('#submitBtn');
    await a.page.waitForSelector('#submitYes', { timeout: 10000 });
    // Two taps on Send, as a nervous client would.
    await a.page.$eval('#submitYes', (x) => { x.click(); x.click(); });
    await a.page.waitForSelector('.code-chip', { timeout: 15000 });

    check('48. a confirmation screen follows, with the wishlist number',
      /DV-/.test(await a.page.textContent('.code-chip')));
    server = await prisma.clientWishlist.findUnique({ where: { token }, include: { items: true } });
    check('49. the studio has it, marked as sent, with all three rooms',
      server.status === 'SUBMITTED' && !!server.submittedAt && server.items.length === 3,
      { status: server.status, items: server.items.length });
    check('50. the confirmation shows what was sent',
      (await a.page.$$('.done-strip img')).length === 3);

    // ── 11. after it is sent ─────────────────────────────────────
    await a.page.reload();
    await a.page.waitForSelector('.code-chip', { timeout: 15000 });
    check('51. a reload opens the confirmation again, not the grid',
      !(await a.page.$('.theme-grid')) && /DV-/.test(await a.page.textContent('.code-chip')));

    const submittedAt = server.submittedAt.toISOString();
    const resubmit = await a.page.evaluate((t) => window.CasaApi.clientWishlist.submit(t).then(
      (d) => ({ ok: true, alreadySubmitted: d.alreadySubmitted, submittedAt: d.submittedAt }),
      (e) => ({ ok: false, message: e.message }),
    ), token);
    check('52. sending it a second time changes nothing',
      resubmit.ok && resubmit.alreadySubmitted === true
      && new Date(resubmit.submittedAt).toISOString() === submittedAt, resubmit);

    // The controlled way back in: a NEW round, leaving the sent one be.
    await a.page.click('#restartBtn');
    await a.page.waitForSelector('#regForm', { timeout: 10000 });
    check('53. a client can start again, and the sent wishlist is left alone',
      (await prisma.clientWishlist.findUnique({ where: { token } })).status === 'SUBMITTED'
      && (await a.page.$eval('#countN', (e) => e.textContent)) === '0');

    await a.page.fill('#regName', 'Aarti Mehta');
    await a.page.click('#regBtn');
    await a.page.waitForSelector('.theme-grid', { timeout: 15000 });
    const rounds = await prisma.clientWishlist.count();
    check('54. the new round is its own wishlist, not the old one reopened',
      rounds === 3 && (await a.page.$eval('#countN', (e) => e.textContent)) === '0', { rounds });

    // ── 12. the way in, and a quiet console ──────────────────────
    const staff = fs.readFileSync(path.join(FRONTEND, 'devyora-library.html'), 'utf8');
    check('55. the studio’s library page opens the client wishlist',
      /href="wishlist\.html"/.test(staff) && /libClientWishlist/.test(staff));

    check('56. the page threw nothing at any point',
      a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].slice(0, 3));

    await b.context.close();
  } finally {
    await browser.close();
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
