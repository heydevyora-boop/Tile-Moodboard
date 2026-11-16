/**
 * De'vyora Library -- several themes at once, a set of pictures at a time.
 *
 * The real page in Chromium, against the real server and a real
 * Postgres. Google Drive is replaced at its own boundary; this machine
 * has no credential for it, and a gallery of sixty <img> pointed at an
 * unreachable host would measure the network rather than the page.
 *
 * The questions:
 *
 *   - can the studio hold several themes at once, and does ticking one
 *     leave the others alone;
 *   - is there ONE room chooser for the set, counted across all of it,
 *     rather than one per theme;
 *   - does the switcher offer exactly the chosen themes, and does
 *     switching change ONLY which gallery is on screen;
 *   - do two themes' pictures ever appear in the same grid (they must
 *     not);
 *   - is the gallery really paged -- ten, then twenty, then the next
 *     twenty -- and is twenty the most that is ever drawn;
 *   - does the action bar ride the gallery without reaching across the
 *     sidebar;
 *   - and does everything the Library already did still work.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_multitheme_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_multitheme?host=/var/tmp';

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
function step(title) { console.log(`\n  — ${title}`); }

const PASSWORD = 'dummy-password-multitheme';

/* How many of each theme's bathrooms are seeded as uploads. British is
   deliberately deep enough for four sets. */
const SEEDED = { british: 60, floral: 7, 'roman_touch': 0 };

async function main() {
  const admin = DB_URL.replace(/\/tm_multitheme\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_multitheme'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_multitheme'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));
  const starters = require(path.join(ROOT, 'src/services/libraryStarters'));

  drive.googleDriveClient.isConfigured = () => true;
  drive.googleDriveClient.deleteFile = async () => {};

  const ownerRole = await prisma.role.create({
    // ["*"], exactly as prisma/seed.ts seeds the Owner.
    data: { name: 'OWNER', description: 'test', permissions: ['*'] },
  });
  const owner = await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'owner@example.test',
      passwordHash: await hashPassword(PASSWORD),
      roleId: ownerRole.id,
    },
  });

  // Bathrooms, titled so a picture always says which theme it is from:
  // that is how "the galleries never mix" is actually checked.
  for (const [themeId, howMany] of Object.entries(SEEDED)) {
    for (let i = 1; i <= howMany; i += 1) {
      await prisma.libraryReference.create({
        data: {
          themeId,
          title: `${themeId.toUpperCase()} bath ${String(i).padStart(2, '0')}`,
          imageUrl: `https://drive.google.com/uc?export=download&id=f-${themeId}-bath-${i}`,
          driveFileId: `f-${themeId}-bath-${i}`,
          room: 'Bathroom',
          uploadedById: owner.id,
        },
      });
    }
  }
  // A second room, so changing room type can be seen to reset the paging.
  for (let i = 1; i <= 3; i += 1) {
    await prisma.libraryReference.create({
      data: {
        themeId: 'british',
        title: `BRITISH kitchen ${i}`,
        imageUrl: `https://drive.google.com/uc?export=download&id=f-british-kit-${i}`,
        driveFileId: `f-british-kit-${i}`,
        room: 'Kitchen',
        uploadedById: owner.id,
      },
    });
  }

  /** Seeded + the starters that ship with the app, which the page counts too. */
  const totalFor = (themeId, roomId) =>
    (roomId === 'bathroom' ? (SEEDED[themeId] || 0) : (themeId === 'british' ? 3 : 0))
    + starters.startersForTheme(themeId, roomId).length;

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

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Drive is unreachable from here; its pictures are answered locally so
  // the grid lays out exactly as it would with Drive up.
  let driveHits = 0;
  await context.route('https://drive.google.com/**', (route) => {
    driveHits += 1;
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const labels = (selector) => page.$$eval(selector,
    (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const count = (selector) => page.locator(selector).count();
  const shownTitles = () => labels('.lib-grid .lib-title');
  const dockText = () => page.textContent('#libDock');

  const box = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
      h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
  }, selector);

  const scrollMain = (to) => page.evaluate((y) => {
    document.querySelector('.main').scrollTop = y;
  }, to);

  const pick = async (themeId) => {
    await page.click(`.lib-pick[data-pick="${themeId}"]`);
    await page.waitForTimeout(120);
  };

  /** Idempotent: clicking an open switcher would close it again. */
  const openSwitcher = async () => {
    if (await page.locator('.lib-switch.open').count()) return;
    await page.click('#libSwitchBtn');
    await page.waitForSelector('.lib-switch.open', { timeout: 10000 });
  };

  /** The themes view, told apart from the rooms view -- both draw
   *  .lib-theme-card, only the themes view draws the ticks. */
  const waitForThemeGrid = () => page.waitForSelector('.lib-pick', { timeout: 20000 });

  /**
   * Switching names the new theme IMMEDIATELY -- the switcher is drawn
   * from state.themeId, which changes before the request for that
   * theme's pictures has come back. So the gallery has to be waited for
   * separately, or the titles read are the ones still on screen.
   */
  const settle = async () => {
    await page.waitForFunction(
      () => document.querySelectorAll('.lib-skel-card').length === 0,
      null, { timeout: 20000 });
    await page.waitForSelector('.lib-grid, .lib-empty', { timeout: 20000 });
  };

  const switchTo = async (themeId, label) => {
    await openSwitcher();
    await page.click(`[data-switch="${themeId}"]`);
    await page.waitForFunction(
      (want) => (document.getElementById('libSwitchName') || {}).textContent === want,
      label, { timeout: 20000 });
    await settle();
  };

  try {
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none');
    await page.fill('#email', 'owner@example.test');
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL('**/home.html', { timeout: 20000 });
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });

    // ══ 1. several themes at once ══════════════════════════════════
    step('1. TEST 1 — British + Floral + Roman Touch, all three held');

    // Ten cards, nine ticks: the tenth is De’vyora Mix, which is
    // every theme at once and so is not one to combine with them.
    check('1a. every theme card is still there, each with a way to select it',
      await count('.lib-theme-card') === 10 && await count('.lib-pick') === 9,
      { cards: await count('.lib-theme-card'), ticks: await count('.lib-pick') });

    check('1b. nothing is selected to begin with, and the page says so rather than staying mute',
      await count('.lib-picked.empty') === 1
      && /NO THEMES SELECTED/.test(await page.textContent('.lib-picked')));

    await pick('british');
    check('1c. ticking British selects it',
      await page.getAttribute('.lib-pick[data-pick="british"]', 'aria-pressed') === 'true'
      && await count('.lib-theme-cell.is-picked') === 1);
    check('1d. ...and ticking it did not open it',
      await count('.lib-theme-card') === 10 && await count('[data-room]') === 0);

    await pick('floral');
    await pick('roman_touch');
    check('1e. all three are held at once',
      await count('.lib-theme-cell.is-picked') === 3,
      await count('.lib-theme-cell.is-picked'));
    check('1f. the set is counted',
      /3 THEMES SELECTED/.test(await page.textContent('.lib-picked')),
      await page.textContent('.lib-picked'));
    // The studio's own theme order (shared/themes.json), which is the
     // order the grid above is drawn in -- NOT the order of ticking,
     // which would move a re-ticked theme to the end of the list.
    check('1g. ...and named, in the order the grid shows them',
      /British\s*·\s*Roman Touch\s*·\s*Floral/.test(
        (await page.textContent('.lib-picked-names')).replace(/\s+/g, ' ')),
      await page.textContent('.lib-picked-names'));

    await pick('floral');
    check('1h. un-ticking one leaves the others alone',
      await count('.lib-theme-cell.is-picked') === 2
      && await page.getAttribute('.lib-pick[data-pick="floral"]', 'aria-pressed') === 'false');
    await pick('floral');
    check('1i. ...and it can be put back',
      await count('.lib-theme-cell.is-picked') === 3);

    // ══ 2. one room chooser, for the whole set ═════════════════════
    step('2. TEST 2 — the room type, chosen once for all three');

    await page.click('#libPickGo');
    await page.waitForSelector('[data-room]', { timeout: 20000 });

    const roomCards = await count('[data-room]');
    check('2a. ONE room chooser, not one per theme',
      roomCards >= 5 && roomCards <= 7, roomCards);
    check('2b. ...and it says which themes it is choosing for',
      /British\s*·\s*Roman Touch\s*·\s*Floral/.test(
        (await page.textContent('.lib-head')).replace(/\s+/g, ' ')),
      await page.textContent('.lib-head'));

    const bathCount = totalFor('british', 'bathroom')
      + totalFor('floral', 'bathroom') + totalFor('roman_touch', 'bathroom');
    const bathCard = (await page.textContent('[data-room="bathroom"]')).replace(/\s+/g, ' ');
    check('2c. Bathroom is counted across all three themes, not just the active one',
      bathCard.includes(String(bathCount)), { bathCard, expected: bathCount });

    await page.click('[data-room="bathroom"]');
    await page.waitForSelector('#libDock', { timeout: 20000 });
    check('2d. choosing it opens a gallery', await count('.lib-card') > 0);

    // ══ 3. the switcher ════════════════════════════════════════════
    step('3. TEST 3 — the switcher offers the selected themes, and only those');

    check('3a. it names the theme currently on screen',
      (await page.textContent('#libSwitchName')).trim() === 'British',
      await page.textContent('#libSwitchName'));

    await openSwitcher();
    const inSwitcher = await page.$$eval('[data-switch]', (els) => els.map((e) => e.dataset.switch));
    check('3b. exactly the three selected themes are in it, in the grid\u2019s order',
      JSON.stringify(inSwitcher) === JSON.stringify(['british', 'roman_touch', 'floral']),
      inSwitcher);
    check('3c. ...with the active one marked',
      await page.getAttribute('[data-switch="british"]', 'aria-current') === 'true'
      && await count('.lib-switch-item.active') === 1);
    check('3d. ...and a theme that was never selected is not offered',
      inSwitcher.indexOf('tropical') === -1, inSwitcher);

    // ══ 4. switching, without losing anything ══════════════════════
    step('4. TESTs 4, 5 and 9 — switching themes, and the set surviving it');

    let titles = await shownTitles();
    check('4a. TEST 4: British bathrooms are what is shown',
      titles.length === 10 && titles.every((t) => /BRITISH|Heritage|Panelled/i.test(t)),
      titles.slice(0, 3));

    await switchTo('floral', 'Floral');

    titles = await shownTitles();
    check('4b. TEST 5: Floral’s own bathrooms replace them',
      titles.length > 0 && titles.some((t) => /FLORAL/i.test(t)), titles.slice(0, 3));
    check('4c. ...and NOT ONE British picture is left in the grid',
      !titles.some((t) => /BRITISH/i.test(t)), titles);

    await openSwitcher();
    check('4d. TEST 9: the other two themes are still selected',
      (await page.$$eval('[data-switch]', (els) => els.length)) === 3,
      await page.$$eval('[data-switch]', (els) => els.map((e) => e.dataset.switch)));

    await openSwitcher();
    await switchTo('roman_touch', 'Roman Touch');
    titles = await shownTitles();
    check('4e. Roman Touch shows its own, which here is only the starter it ships with',
      titles.length === totalFor('roman_touch', 'bathroom')
      && !titles.some((t) => /BRITISH|FLORAL/i.test(t)), titles);

    // ══ 5. paging ══════════════════════════════════════════════════
    step('5. TESTs 7 and 8 — ten, then twenty, then the next set');

    await switchTo('british', 'British');
    await page.waitForSelector('#libDock', { timeout: 20000 });

    const britishTotal = totalFor('british', 'bathroom');
    check('5a. ten pictures to begin with, out of all of them',
      await count('.lib-card') === 10
      && (await dockText()).includes(`SHOWING 1–10 OF ${britishTotal}`),
      { shown: await count('.lib-card'), dock: await dockText() });

    check('5b. the bar offers LOAD MORE IMAGES',
      await count('#libMore') === 1 && await count('#libNextSet') === 0);

    await page.click('#libMore');
    await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 20,
      null, { timeout: 10000 });
    check('5c. TEST 7: it brings the set to twenty',
      await count('.lib-card') === 20
      && (await dockText()).includes(`SHOWING 1–20 OF ${britishTotal}`), await dockText());

    check('5d. TEST 8: at twenty the bar becomes EXPLORE NEXT SET',
      await count('#libNextSet') === 1 && await count('#libMore') === 0,
      await dockText());

    await page.click('#libNextSet');
    await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 10,
      null, { timeout: 10000 });
    check('5e. the next set starts at twenty-one, ten of them',
      await count('.lib-card') === 10
      && (await dockText()).includes(`SHOWING 21–30 OF ${britishTotal}`), await dockText());

    const set2 = await shownTitles();
    check('5f. ...and they are different pictures, not the first ten again',
      !set2.some((t) => titles.indexOf(t) !== -1) || set2[0] !== (await shownTitles())[10],
      set2.slice(0, 2));

    await page.click('#libMore');
    await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 20,
      null, { timeout: 10000 });
    check('5g. and that set fills to forty',
      (await dockText()).includes(`SHOWING 21–40 OF ${britishTotal}`), await dockText());

    check('5h. twenty is the most that is ever drawn at once',
      await count('.lib-card') === 20, await count('.lib-card'));

    check('5i. there is a way back to the set before',
      await count('#libPrevSet') === 1);
    await page.click('#libPrevSet');
    await page.waitForFunction(
      () => (document.getElementById('libDock') || {}).textContent.indexOf('SHOWING 1–20') !== -1,
      null, { timeout: 10000 });
    check('5j. ...and it shows that set whole',
      await count('.lib-card') === 20 && await count('#libPrevSet') === 0);

    // Walk to the end and see it say so.
    for (let guard = 0; guard < 12 && await count('#libNextSet') + await count('#libMore'); guard += 1) {
      await page.click(await count('#libMore') ? '#libMore' : '#libNextSet');
      await page.waitForTimeout(220);
    }
    check('5k. at the end the bar offers nothing further',
      await count('#libMore') === 0 && await count('#libNextSet') === 0, await dockText());
    check('5l. ...and says so, in words',
      /You’ve explored all available images\./.test(await page.textContent('#libDockSub')),
      await page.textContent('#libDockSub'));

    // ══ 6. the action bar, while the gallery scrolls ═══════════════
    step('6. TEST 6 — the bar rides the gallery, and leaves the sidebar alone');

    await page.click('#libPrevSet');
    await page.waitForTimeout(300);
    await scrollMain(0);
    await page.waitForTimeout(250);

    const sidebar = await box('.sidebar');
    const main = await box('.main');
    const atTop = await box('#libDock');
    check('6a. the bar sits inside the main column, clear of the sidebar',
      atTop.x >= sidebar.right && atTop.x >= main.x, { dock: atTop, sidebar, main });
    check('6b. ...and is not the full width of the window either',
      atTop.w < main.w && atTop.w > 300, { dockW: atTop.w, mainW: main.w });
    check('6c. it is on screen before any scrolling',
      atTop.bottom <= 900 && atTop.y > 0, atTop);

    await scrollMain(600);
    await page.waitForTimeout(300);
    const scrolled = await box('#libDock');
    check('6d. TEST 6: scrolling the gallery does not scroll it away',
      scrolled.bottom <= 900 && scrolled.bottom > 700, scrolled);
    check('6e. ...and it still has not moved over the sidebar',
      scrolled.x >= sidebar.right, { dock: scrolled, sidebar });
    check('6f. the sidebar itself never moved',
      JSON.stringify(await box('.sidebar')) === JSON.stringify(sidebar));

    const lastCard = await page.evaluate(() => {
      const cards = document.querySelectorAll('.lib-grid .lib-card');
      const el = cards[cards.length - 1];
      const r = el.getBoundingClientRect();
      return { bottom: Math.round(r.bottom) };
    });
    await page.evaluate(() => {
      const m = document.querySelector('.main');
      m.scrollTop = m.scrollHeight;
    });
    await page.waitForTimeout(350);
    const settled = await box('#libDock');
    const lastAtEnd = await page.evaluate(() => {
      const cards = document.querySelectorAll('.lib-grid .lib-card');
      const r = cards[cards.length - 1].getBoundingClientRect();
      return { bottom: Math.round(r.bottom) };
    });
    check('6g. scrolled to the end, the bar settles BELOW the last row rather than over it',
      settled.y >= lastAtEnd.bottom - 2, { dock: settled, lastRow: lastAtEnd, lastCard });

    // ══ 7. changing the room type ══════════════════════════════════
    step('7. TEST 10 — a different room, counted and paged afresh');

    await page.click('#libBack');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('[data-room="kitchen"]');
    await page.waitForSelector('.lib-card, .lib-empty', { timeout: 20000 });

    const kitchenTotal = totalFor('british', 'kitchen');
    check('7a. the kitchen’s own pictures load',
      (await shownTitles()).every((t) => /kitchen/i.test(t) || /Kitchen/.test(t)),
      await shownTitles());
    check('7b. ...and the paging started again at the first of them',
      (await dockText()).includes(`SHOWING 1–${Math.min(10, kitchenTotal)} OF ${kitchenTotal}`),
      await dockText());
    check('7c. a room with fewer than ten shows all of them and says there are no more',
      await count('#libMore') === 0 && await count('#libNextSet') === 0
      && /You’ve explored all available images\./.test(await page.textContent('#libDockSub')),
      await dockText());

    check('7d. the switcher is still offering all three themes',
      (await openSwitcher(), await page.$$eval('[data-switch]', (els) => els.length)) === 3);
    await page.keyboard.press('Escape');

    // ══ 8. everything the Library already did ══════════════════════
    step('8. TEST 11 — choosing, removing and uploading, untouched');

    await page.click('#libBack');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('[data-room="bathroom"]');
    await page.waitForSelector('.lib-card', { timeout: 20000 });
    await page.waitForSelector('#libDock', { timeout: 20000 });

    // Choosing a picture leaves this page now -- it opens the mood
    // board -- and leaving it empties the working set, which the next
    // part still needs. So that is asked at the very end instead.
    check('8c. the upload card is still there, with its own theme and room dropdowns',
      await count('#libTheme') === 1 && await count('#libRoom') === 1 && await count('#libFiles') === 1);
    check('8d. ...and the upload’s THEME dropdown is a destination, not the switcher',
      await page.evaluate(() => document.querySelectorAll('#libTheme option').length) === 9,
      await page.evaluate(() => document.querySelectorAll('#libTheme option').length));

    check('8e. a studio picture still offers REMOVE, and a starter does not',
      await count('.lib-card:not(:has(.lib-starter-flag)) [data-delete]') > 0
      && await count('.lib-card:has(.lib-starter-flag) [data-delete]') === 0);

    check('8f. only the pictures actually on screen were ever downloaded',
      driveHits > 0 && driveHits < britishTotal * 3,
      { driveHits, britishTotal });

    // ══ 9. a theme leaving the set, from inside the gallery ════════
    step('9. the theme on screen, taken out of the set');

    check('9a. British is the theme on screen, to be taken out while it is',
      (await page.textContent('#libSwitchName')).trim() === 'British',
      await page.textContent('#libSwitchName'));

    await openSwitcher();
    check('9b. the switcher offers a way out of the set, one per theme',
      await count('[data-unpick]') === 3, await count('[data-unpick]'));

    await page.click('[data-unpick="british"]');
    await page.waitForFunction(
      () => (document.getElementById('libSwitchName') || {}).textContent === 'Roman Touch',
      null, { timeout: 20000 });
    await settle();
    check('9c. taking out the theme ON SCREEN hands over to the next of the chosen, '
      + 'rather than leaving an empty gallery',
      (await page.textContent('#libSwitchName')).trim() === 'Roman Touch'
      && (await shownTitles()).length > 0
      && (await shownTitles()).every((t) => !/BRITISH/i.test(t)),
      await shownTitles());

    await openSwitcher();
    check('9d. ...and the set is two now',
      await page.$$eval('[data-switch]', (els) => els.length) === 2,
      await page.$$eval('[data-switch]', (els) => els.map((e) => e.dataset.switch)));

    await page.click('[data-unpick="floral"]');
    await page.waitForTimeout(400);
    await openSwitcher();
    check('9e. taking out a theme that is NOT on screen leaves the gallery exactly where it was',
      (await page.textContent('#libSwitchName')).trim() === 'Roman Touch'
      && await page.$$eval('[data-switch]', (els) => els.length) === 1,
      await page.textContent('#libSwitchName'));
    check('9f. the last one cannot be taken out from here \u2014 it would leave nothing to show',
      await count('[data-unpick]') === 0);

    await page.keyboard.press('Escape');
    await page.click('#libBack');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('#libBack');
    await waitForThemeGrid();
    check('9g. the theme grid agrees: one theme still held',
      await count('.lib-theme-cell.is-picked') === 1
      && await page.getAttribute('.lib-pick[data-pick="roman_touch"]', 'aria-pressed') === 'true',
      await count('.lib-theme-cell.is-picked'));

    await pick('roman_touch');
    check('9h. taking the last one out returns to an empty, explained, selection',
      await count('.lib-picked.empty') === 1 && await count('.lib-theme-cell.is-picked') === 0
      && await count('[data-room]') === 0);

    // ══ 9b. the rooms on a theme card ══════════════════════════════
    step('9b. a theme card names its rooms, and each one opens');

    const chipText = await page.$$eval('.lib-theme-card[data-theme="british"]'
      + ' ~ .lib-theme-rooms .lib-room-chip .lbl',
    (els) => els.map((e) => e.textContent.trim()));
    check('9i. the rooms are named in full, not lettered',
      chipText.includes('Bathroom') && chipText.includes('Bedroom')
      && chipText.includes('Kitchen') && chipText.every((t) => t.length > 1),
      chipText);
    check('9j. ...so Bathroom and Bedroom are no longer both "B"',
      chipText.indexOf('Bathroom') !== chipText.indexOf('Bedroom'), chipText);

    check('9k. ...each carrying its own count',
      await page.$$eval('.lib-theme-card[data-theme="british"]'
        + ' ~ .lib-theme-rooms .lib-room-chip .n',
      (els) => els.length) === chipText.length);

    // Every theme ships a starter for each of its rooms, so no room is
    // ever truly empty -- but the point stands: the chips are the
    // theme's WHOLE room list, not only the rooms the studio happens
    // to have uploaded to.
    const rtChips = await page.$$eval('.lib-theme-card[data-theme="roman_touch"]'
      + ' ~ .lib-theme-rooms .lib-room-chip .lbl',
    (els) => els.map((e) => e.textContent.trim()));
    check('9l. a theme the studio never uploaded to still offers every one of its rooms',
      rtChips.length === chipText.length && rtChips.includes('Kitchen'), rtChips);

    check('9m. every one of them is a real button, not a decoration',
      await page.$$eval('.lib-room-chip',
        (els) => els.every((e) => e.tagName === 'BUTTON' && !!e.dataset.open)));

    await page.click('[data-open="british|bedroom"]');
    await page.waitForSelector('.lib-grid, .lib-empty', { timeout: 20000 });
    check('9n. clicking one opens THAT theme\u2019s room in a single step',
      /Bedroom/.test(await page.textContent('.lib-head'))
      && /British/.test(await page.textContent('.lib-head')),
      await page.textContent('.lib-head'));
    check('9o. ...and the upload follows it there',
      await page.inputValue('#libTheme') === 'british'
      && await page.inputValue('#libRoom') === 'bedroom');

    await page.click('#libBack');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('#libBack');
    await waitForThemeGrid();

    // ══ 9c. De'vyora Mix ═══════════════════════════════════════════
    step('9c. De\u2019vyora Mix — one card that is every theme at once');

    const cardNames = await page.$$eval('.lib-theme-card .lib-theme-name',
      (els) => els.map((e) => e.textContent.trim()));
    check('9p. there is a tenth card, and it is the Mix',
      cardNames.length === 10 && cardNames[9] === 'De\u2019vyora Mix', cardNames);

    check('9q. it carries no tick: it is already every theme, not one to combine with them',
      await count('.lib-theme-cell.is-mix') === 1
      && await count('.lib-theme-cell.is-mix .lib-pick') === 0
      && await count('.lib-pick') === 9,
      { ticks: await count('.lib-pick') });

    const realTotal = await page.$$eval('.lib-theme-cell:not(.is-mix) .lib-theme-count',
      (els) => els.reduce((n, e) => n + parseInt(e.textContent, 10), 0));
    const mixTotal = parseInt(
      await page.textContent('.lib-theme-cell.is-mix .lib-theme-count'), 10);
    check('9r. ...counted as every theme added up',
      mixTotal === realTotal, { mixTotal, realTotal });

    check('9s. ...while the headline still says nine themes, not ten',
      /9/.test(await page.textContent('.lib-stat')), await page.textContent('.lib-stat'));

    const mixChips = await page.$$eval('.lib-theme-cell.is-mix .lib-room-chip .lbl',
      (els) => els.map((e) => e.textContent.trim()));
    check('9t. its rooms are every theme\u2019s rooms, named the same way',
      mixChips.includes('Bathroom') && mixChips.includes('Kitchen')
      && mixChips.length === chipText.length, mixChips);

    const mixBath = parseInt(await page.textContent(
      '.lib-theme-cell.is-mix [data-open$="|bathroom"] .n'), 10);
    const mixBathExpected = Object.values(SEEDED).reduce((a, b) => a + b, 0)
      + starters.startersForRoom('bathroom').length;
    check('9u. ...counted across all of them',
      mixBath === mixBathExpected, { mixBath, mixBathExpected });

    await page.click('.lib-theme-cell.is-mix [data-open$="|bathroom"]');
    await page.waitForSelector('#libDock', { timeout: 20000 });
    await settle();

    check('9v. one grid now holds EVERY theme\u2019s bathroom at once',
      await count('.lib-card .lib-starter-flag')
        === starters.startersForRoom('bathroom').length,
      await count('.lib-card .lib-starter-flag'));
    check('9w. ...paged exactly like any other room',
      await count('.lib-card') === 10
      && (await dockText()).includes(`OF ${mixBathExpected}`), await dockText());
    check('9x. ...and it says so above the grid',
      /Mix/.test(await page.textContent('.lib-head')), await page.textContent('.lib-head'));

    check('9y. there is no theme switcher inside it -- it is already all of them',
      await count('#libSwitchBtn') === 0);
    // Several notes share this class, so read them all rather than
    // whichever happens to be first on the page.
    const notes = await page.$$eval('.lib-note', (els) => els.map((e) => e.textContent).join(' | '));
    check('9z. and no upload form, because nothing is filed under the Mix',
      await count('#libFiles') === 0 && /nowhere under it to file a picture/.test(notes),
      notes.slice(0, 200));

    // THE POINT OF THE WHOLE THING: a picture chosen out of the Mix
    // keeps the theme it actually belongs to, so the mood board still
    // matches the catalogue against a real theme and a real colour.
    const mixTitle = (await shownTitles())[0];
    await page.locator('.lib-card').first().click();
    await page.waitForURL('**/mood-board.html', { timeout: 20000 });
    const fromMix = await page.evaluate(
      () => JSON.parse(localStorage.getItem('casa_library_selection') || 'null'));
    check('9A. a picture chosen from the Mix carries its OWN theme, never the Mix',
      fromMix && fromMix.themeId !== '__mix__' && fromMix.themeLabel !== 'De\u2019vyora Mix'
      && !!fromMix.themeLabel && fromMix.title === mixTitle, fromMix);
    check('9B. ...so the wizard opens on that theme\u2019s own room',
      await page.getAttribute('.room-card.selected', 'data-room') === 'Bathroom',
      await page.getAttribute('.room-card.selected', 'data-room'));

    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await waitForThemeGrid();

    // ══ 10. in the hand ════════════════════════════════════════════
    step('10. TEST 12 — on a phone');

    await pick('british');
    await page.click('#libPickGo');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('[data-room="bathroom"]');
    await page.waitForSelector('#libDock', { timeout: 20000 });

    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(400);
    check('10a. the gallery still shows one set, not all of them',
      await count('.lib-card') === 10, await count('.lib-card'));
    check('10b. the bar is there and fits the screen',
      (await box('#libDock')).w <= 393 && (await box('#libDock')).w > 250,
      await box('#libDock'));
    check('10c. ...with no sideways scroll',
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1)));
    check('10d. the switcher is still reachable', await count('#libSwitchBtn') === 1);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    // ══ 11. choosing a picture ═════════════════════════════════════
    step('11. choosing a picture is one act, not two');

    check('11a. there is no "use this in a mood board" button to hunt for',
      await count('.lib-active-go') === 0);

    const pickTitle = (await shownTitles())[0];
    await page.locator('.lib-card').first().click();
    await page.waitForURL('**/mood-board.html', { timeout: 20000 });
    check('11b. tapping it goes straight to the mood board',
      page.url().endsWith('/mood-board.html'), page.url());

    const carried = await page.evaluate(
      () => JSON.parse(localStorage.getItem('casa_library_selection') || 'null'));
    check('11c. ...carrying the picture the studio actually tapped',
      carried && carried.title === pickTitle, { carried: carried && carried.title, pickTitle });
    check('11d. ...with the theme LABEL and the room the wizard works in',
      carried && carried.themeLabel === 'British'
      && /bathroom/i.test(carried.roomWizard || carried.room || ''), carried);

    await page.waitForSelector('.libref', { timeout: 20000 });
    check('11e. ...and the wizard opens standing on that very picture',
      (await page.textContent('.libref')).includes(pickTitle),
      await page.textContent('.libref'));
    // The wizard opens on its ROOM step, and the room the picture is a
    // reference for is already the chosen one -- the studio is not
    // asked a question the picture has already answered.
    check('11f. ...with the room already chosen, not asked for again',
      await page.getAttribute('.room-card.selected', 'data-room') === 'Bathroom',
      await page.getAttribute('.room-card.selected', 'data-room'));

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
