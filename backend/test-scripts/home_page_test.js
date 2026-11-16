/**
 * THE GATEWAY -- the page a sign-in lands on.
 *
 * The Stitch homepage, converted into this application rather than
 * bolted beside it. The questions worth asking are not "does it look
 * like the picture" but:
 *
 *   - does signing in actually end up here, with no destination asked
 *     for, for the Owner and for floor staff alike;
 *   - do the two cards that lead somewhere open THE pages that already
 *     exist -- the same De'vyora Library and the same Mood Board the
 *     sidebar has always opened, not copies of them;
 *   - does the third card, which has nowhere to go, go nowhere -- no
 *     invented route, no blank page, no href="#";
 *   - is the Dashboard actually gone: the page, every sidebar item,
 *     and every link that pointed at it;
 *   - is there still a way back, now that the sidebar has no Home item
 *     and the gateway has no sidebar;
 *   - and does it hold its shape on a desk, a tablet and a phone.
 *
 * The three card pictures are hosted on Google's CDN, which this
 * machine cannot reach, so they are served locally here. That is a fact
 * about this machine, not about the page.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/home_page_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_homepage?host=/var/tmp';

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

const PASSWORD = 'dummy-password-homepage';

/* The seven pages that carry the workspace sidebar. */
const SIDEBAR_PAGES = [
  'mood-board.html', 'recent-generations.html', 'projects.html',
  'catalog.html', 'devyora-library.html', 'sample-placement.html',
  'client-wishlists.html',
];

async function main() {
  const admin = DB_URL.replace(/\/tm_homepage\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_homepage'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_homepage'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const ownerRole = await prisma.role.create({
    data: { name: 'OWNER', description: 't', permissions: ['*'] },
  });
  const staffRole = await prisma.role.create({
    data: { name: 'STAFF', description: 't', permissions: ['tiles:read', 'mood_boards:read'] },
  });
  await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'owner@example.test',
      passwordHash: await hashPassword(PASSWORD),
      roleId: ownerRole.id,
    },
  });
  await prisma.user.create({
    data: {
      name: 'Floor Staff',
      email: 'staff@example.test',
      passwordHash: await hashPassword(PASSWORD),
      roleId: staffRole.id,
    },
  });
  const brand = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria' } });
  await prisma.tile.create({
    data: { name: 'Tile A', brandId: brand.id, productCode: 'TILE-A-600', inStock: true },
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

  const PICTURE = fs.readFileSync(path.join(FRONTEND, 'img/library/british-drawing-room.png'));

  const browser = await chromium.launch();
  const pageErrors = [];

  async function openContext(size) {
    const context = await browser.newContext({ viewport: size });
    // This machine has no route to Google's CDN; the page's own pictures
    // are stood in for so the layout can be measured for real.
    await context.route('https://lh3.googleusercontent.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    return { context, page };
  }

  /** Sign in through the real form, asking for nowhere in particular. */
  async function signInThroughTheForm(page, email) {
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginForm', { state: 'visible', timeout: 20000 });
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
  }

  const box = (page, selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) };
  }, selector);

  const cardBoxes = (page) => page.evaluate(() => Array.from(
    document.querySelectorAll('.disciplines .disc')).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      bottom: Math.round(r.bottom), right: Math.round(r.right) };
  }));

  const overflows = (page) => page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1);

  const desk = await openContext({ width: 1440, height: 900 });

  try {
    // ══ 1. signing in lands here ═══════════════════════════════════
    step('1. a sign-in with nowhere asked for lands on the gateway');

    await signInThroughTheForm(desk.page, 'owner@example.test');
    await desk.page.waitForURL('**/home.html', { timeout: 20000 });
    check('1a. the Owner lands on home.html, not on a dashboard',
      desk.page.url().endsWith('/home.html'), desk.page.url());

    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });

    const staff = await openContext({ width: 1440, height: 900 });
    await signInThroughTheForm(staff.page, 'staff@example.test');
    await staff.page.waitForURL('**/home.html', { timeout: 20000 });
    check('1b. ...and so does floor staff', staff.page.url().endsWith('/home.html'),
      staff.page.url());
    await staff.context.close();

    // ══ 2. three cards, and the words on them ══════════════════════
    step('2. the gateway, as drawn');

    check('2a. exactly three cards',
      (await desk.page.$$('.disciplines .disc')).length === 3);

    const titles = await desk.page.$$eval('.disciplines .disc h2',
      (els) => els.map((e) => e.textContent.trim()));
    check('2b. named DEVYORA LIBRARY, DEVYORA SELECT and CLIENTS & DETAILINGS',
      JSON.stringify(titles) === JSON.stringify(
        ['DEVYORA LIBRARY', 'DEVYORA SELECT', 'CLIENTS & DETAILINGS']), titles);

    const taglines = await desk.page.$$eval('.disciplines .disc .tagline',
      (els) => els.map((e) => e.textContent.trim()));
    check('2c. ...each with the tagline the design gives it',
      JSON.stringify(taglines) === JSON.stringify([
        'Explore materials, Discover possibilities.',
        'Curated mood board, Just for you.',
        'Your vision, Our detailed execution.']), taglines);

    const ctas = await desk.page.$$eval('.disciplines .disc .cta .lbl',
      (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    check('2d. ...and the call to action the design gives it',
      ctas[0] === 'Explore Library' && ctas[1] === 'Discover Select'
      && ctas[2] === 'Explore Services', ctas);

    check('2e. the editorial heading is the one from the design',
      (await desk.page.textContent('.intro h1')).trim()
        === 'The Gateway to Material Synthesis');

    // The design hard-codes "Staff — Priya". A real application cannot.
    const who = (await desk.page.textContent('#whoName')).trim();
    check('2f. the header names whoever actually signed in',
      /OWNER/.test(who) && /Priya/.test(who), who);
    check('2g. ...with their own initials on the avatar',
      (await desk.page.textContent('#avatarBtn')).trim() === 'PS',
      await desk.page.textContent('#avatarBtn'));

    check('2h. every card picture loaded',
      await desk.page.evaluate(() => Array.from(document.querySelectorAll('.disc .frame img'))
        .every((i) => i.complete && i.naturalWidth > 0)));

    check('2i. ...each with alt text that says what it shows',
      await desk.page.$$eval('.disc .frame img',
        (els) => els.every((e) => (e.getAttribute('alt') || '').length > 30)));

    check('2j. the gateway carries no sidebar -- it is where you land, not a tool page',
      (await desk.page.$$('.sidebar')).length === 0
      && (await desk.page.$$('#navItems')).length === 0);

    // ══ 3. the Library card opens the Library that already exists ══
    step('3. DEVYORA LIBRARY opens the Library the sidebar opens');

    check('3a. the card is a real link, so it can be opened in a new tab',
      await desk.page.getAttribute('#cardLibrary', 'href') === 'devyora-library.html');

    await desk.page.click('#cardLibrary');
    await desk.page.waitForURL('**/devyora-library.html', { timeout: 20000 });
    check('3b. clicking it goes to devyora-library.html',
      desk.page.url().endsWith('/devyora-library.html'));

    await desk.page.waitForSelector('.lib-theme-card', { timeout: 20000 });
    check('3c. ...and it is the real page: the studio’s themes are drawn',
      (await desk.page.$$('.lib-theme-card')).length >= 9,
      (await desk.page.$$('.lib-theme-card')).length);
    check('3d. ...with its own sidebar item marked active',
      /Library/.test(await desk.page.textContent('#navItems .nav-item.active')));
    check('3e. there is only one Library page: the card did not make a second one',
      fs.readdirSync(FRONTEND).filter((f) => /library/i.test(f) && f.endsWith('.html')).length === 2,
      fs.readdirSync(FRONTEND).filter((f) => /library/i.test(f) && f.endsWith('.html')));

    // ══ 4. Select opens the Mood Board that already exists ═════════
    step('4. DEVYORA SELECT opens the Mood Board the sidebar opens');

    await desk.page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });

    check('4a. the card is a real link too',
      await desk.page.getAttribute('#cardSelect', 'href') === 'mood-board.html');

    await desk.page.click('#cardSelect');
    await desk.page.waitForURL('**/mood-board.html', { timeout: 20000 });
    await desk.page.waitForSelector('#prevBtn', { timeout: 20000 });
    check('4b. the Mood Board opens, at step 1 of its own wizard',
      desk.page.url().endsWith('/mood-board.html')
      && (await desk.page.$$('.stage')).length >= 1);

    check('4c. ...and its back button now says HOME, because that is where it goes',
      (await desk.page.textContent('#prevBtn')).includes('HOME'),
      await desk.page.textContent('#prevBtn'));

    await desk.page.click('#prevBtn');
    await desk.page.waitForURL('**/home.html', { timeout: 20000 });
    check('4d. ...and it really goes there', desk.page.url().endsWith('/home.html'));

    check('4e. there is only one Mood Board page: Select is a door, not a copy',
      fs.readdirSync(FRONTEND).filter((f) => /mood-?board|select/i.test(f) && f.endsWith('.html')).length === 1,
      fs.readdirSync(FRONTEND).filter((f) => /mood-?board|select/i.test(f) && f.endsWith('.html')));

    // ══ 5. the third card has nowhere to go, and goes nowhere ══════
    step('5. CLIENTS & DETAILINGS is reserved, and says so');

    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });
    check('5a. it is not a link at all -- no route was invented for it',
      await desk.page.evaluate(() => {
        const el = document.getElementById('cardClients');
        return el.tagName === 'BUTTON' && !el.getAttribute('href');
      }));

    const before = desk.page.url();
    await desk.page.click('#cardClients');
    await desk.page.waitForTimeout(500);
    check('5b. clicking it leaves you exactly where you were',
      desk.page.url() === before, { before, after: desk.page.url() });

    check('5c. ...and it says, quietly, that it is coming',
      (await desk.page.textContent('#soonNote')).trim().toLowerCase() === 'coming soon'
      && await desk.page.evaluate(
        () => document.getElementById('cardClients').classList.contains('is-soon')));

    check('5d. the card is whole either way: picture, title, tagline and button',
      await desk.page.evaluate(() => {
        const c = document.getElementById('cardClients');
        return !!c.querySelector('.frame img') && !!c.querySelector('h2')
          && !!c.querySelector('.tagline') && !!c.querySelector('.cta .lbl');
      }));

    // ══ 6. the Dashboard is gone, everywhere ═══════════════════════
    step('6. the Dashboard is gone -- page, menu item and link');

    check('6a. dashboard.html is no longer a file',
      !fs.existsSync(path.join(FRONTEND, 'dashboard.html')));

    const dashResponse = await desk.page.request.get(`${base}/dashboard.html`);
    check('6b. ...and the server does not serve it', dashResponse.status() === 404,
      dashResponse.status());

    const navLists = {};
    for (const name of SIDEBAR_PAGES) {
      await desk.page.goto(`${base}/${name}`, { waitUntil: 'domcontentloaded' });
      await desk.page.waitForSelector('#navItems .nav-item', { timeout: 20000 });
      navLists[name] = await desk.page.$$eval('#navItems .nav-item',
        (els) => els.map((e) => e.textContent.trim()));
    }
    check('6c. no sidebar lists a Dashboard any more',
      Object.values(navLists).every((labels) => !labels.includes('Dashboard')), navLists);

    check('6d. ...and none of them grew a Home item either: the gateway is landed on, not navigated to',
      Object.values(navLists).every(
        (labels) => !labels.some((l) => /^home$/i.test(l))), navLists);

    check('6e. the rest of the workspace is untouched',
      Object.values(navLists).every((labels) => ['Mood Board', 'Recent Generations',
        'Projects', 'Catalog', 'Sample Placement'].every((l) => labels.includes(l))
        && labels.some((l) => /Library/.test(l))), navLists);

    const stillLinking = fs.readdirSync(FRONTEND)
      .filter((f) => f.endsWith('.html'))
      .concat(['assets/api-client.js', 'assets/shell.js', 'assets/sidebar.js'])
      .filter((f) => {
        const full = path.join(FRONTEND, f);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
        return /[^-\w]dashboard\.html/.test(fs.readFileSync(full, 'utf8'));
      });
    check('6f. nothing in the frontend still points at it', stillLinking.length === 0,
      stillLinking);

    // ══ 7. and there is still a way back ═══════════════════════════
    step('7. the way home, now that no menu item offers one');

    await desk.page.goto(`${base}/catalog.html`, { waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('a.brand-row', { timeout: 20000 });
    check('7a. the wordmark at the top of the sidebar is the link home',
      await desk.page.getAttribute('a.brand-row', 'href') === 'home.html');

    await desk.page.click('a.brand-row');
    await desk.page.waitForURL('**/home.html', { timeout: 20000 });
    check('7b. ...and it goes there', desk.page.url().endsWith('/home.html'));

    const missingBrandLink = SIDEBAR_PAGES.filter(
      (name) => !/<a class="brand-row" href="home\.html"/.test(
        fs.readFileSync(path.join(FRONTEND, name), 'utf8')));
    check('7c. every sidebar page carries it', missingBrandLink.length === 0, missingBrandLink);

    // ══ 8. the browser's own navigation ════════════════════════════
    step('8. refresh, Back, Forward and a typed address');

    await desk.page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });
    check('8a. the gateway answers a typed address',
      (await desk.page.$$('.disciplines .disc')).length === 3);

    await desk.page.reload({ waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });
    check('8b. ...and a refresh keeps you on it, still signed in',
      desk.page.url().endsWith('/home.html')
      && (await desk.page.$$('.disciplines .disc')).length === 3
      && /Priya/.test(await desk.page.textContent('#whoName')));

    await desk.page.click('#cardLibrary');
    await desk.page.waitForURL('**/devyora-library.html', { timeout: 20000 });
    await desk.page.goBack({ waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });
    check('8c. Back returns to the gateway', desk.page.url().endsWith('/home.html'));

    await desk.page.goForward({ waitUntil: 'domcontentloaded' });
    await desk.page.waitForURL('**/devyora-library.html', { timeout: 20000 });
    check('8d. ...and Forward returns to the Library',
      desk.page.url().endsWith('/devyora-library.html'));

    // ══ 9. the shape of it, on three screens ═══════════════════════
    step('9. desktop, tablet and phone');

    await desk.page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await desk.page.waitForSelector('.disciplines .disc', { timeout: 20000 });
    await desk.page.waitForTimeout(300);

    let cards = await cardBoxes(desk.page);
    check('9a. desktop: three columns, all on one row',
      cards.length === 3 && cards[0].y === cards[1].y && cards[1].y === cards[2].y, cards);
    check('9b. ...of equal width',
      Math.abs(cards[0].w - cards[1].w) <= 1 && Math.abs(cards[1].w - cards[2].w) <= 1,
      cards.map((c) => c.w));
    check('9c. ...and all three fit on the screen together',
      cards.every((c) => c.bottom <= 900), cards.map((c) => c.bottom));
    check('9d. ...with no sideways scroll', !(await overflows(desk.page)));

    const frame = await box(desk.page, '#cardLibrary .frame');
    const body = await box(desk.page, '#cardLibrary .body');
    check('9e. the picture sits ABOVE the words, not beside them',
      frame.bottom <= body.top + 2 && frame.h > 120, { frame, body });

    const h2 = await box(desk.page, '#cardLibrary h2');
    const tag = await box(desk.page, '#cardLibrary .tagline');
    check('9f. ...and the title above its tagline, each on its own line',
      h2.bottom <= tag.top + 2 && h2.h > 0 && tag.h > 0, { h2, tag });

    const cta = await box(desk.page, '#cardLibrary .cta');
    check('9g. ...and the call to action below both, inside the card',
      cta.top >= tag.bottom - 2 && cta.bottom <= cards[0].bottom + 1, { cta, card: cards[0] });

    await desk.page.setViewportSize({ width: 834, height: 1112 });
    await desk.page.waitForTimeout(350);
    cards = await cardBoxes(desk.page);
    check('9h. tablet: two cards side by side, the third beneath them',
      cards[0].y === cards[1].y && cards[2].y > cards[0].y, cards.map((c) => c.y));
    check('9i. ...the third running the full width',
      cards[2].w > cards[0].w + 100, cards.map((c) => c.w));
    check('9j. ...with no sideways scroll', !(await overflows(desk.page)));

    await desk.page.setViewportSize({ width: 393, height: 852 });
    await desk.page.waitForTimeout(350);
    cards = await cardBoxes(desk.page);
    check('9k. phone: the three cards stack',
      cards[0].y < cards[1].y && cards[1].y < cards[2].y, cards.map((c) => c.y));
    check('9l. ...each the full width of the page',
      cards.every((c) => Math.abs(c.w - cards[0].w) <= 1 && c.w > 300),
      cards.map((c) => c.w));
    check('9m. ...with pictures that kept a real height',
      await desk.page.evaluate(() => Array.from(document.querySelectorAll('.disc .frame'))
        .every((f) => f.getBoundingClientRect().height > 200)),
      await desk.page.evaluate(() => Array.from(document.querySelectorAll('.disc .frame'))
        .map((f) => Math.round(f.getBoundingClientRect().height))));
    check('9n. ...titles and taglines still readable, not clipped away',
      await desk.page.evaluate(() => Array.from(document.querySelectorAll('.disc')).every((c) => {
        const t = c.querySelector('h2');
        const g = c.querySelector('.tagline');
        return t.getBoundingClientRect().height >= 20
          && g.getBoundingClientRect().height >= 20
          && parseFloat(getComputedStyle(g).fontSize) >= 15;
      })));
    check('9o. ...and no sideways scroll', !(await overflows(desk.page)));

    const phoneTitle = await box(desk.page, '#cardLibrary h2');
    const phoneTag = await box(desk.page, '#cardLibrary .tagline');
    check('9p. the title is still above its tagline on a phone',
      phoneTitle.bottom <= phoneTag.top + 2, { phoneTitle, phoneTag });

    await desk.page.setViewportSize({ width: 1440, height: 900 });
    await desk.page.waitForTimeout(300);

    // ══ 10. signing out, from the page that has no sidebar ═════════
    step('10. signing out of the gateway');

    await desk.page.click('#avatarBtn');
    check('10a. the avatar opens an account sheet',
      await desk.page.isVisible('#signOutBtn'));
    check('10b. ...naming the account it would sign out of',
      (await desk.page.textContent('#whoEmail')).includes('owner@example.test'));

    // Both of these are redirects the page makes itself, after the
    // document has loaded -- waitForURL races the second navigation and
    // reports the first as aborted, so wait on where we have ended up.
    const landedOnLogin = () => desk.page.waitForFunction(
      () => location.pathname.indexOf('login.html') !== -1, null, { timeout: 20000 });

    await desk.page.click('#signOutBtn');
    await landedOnLogin();
    check('10c. signing out returns to the sign-in page',
      desk.page.url().includes('login.html'), desk.page.url());

    await desk.page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await landedOnLogin();
    check('10d. ...and the gateway then turns an unsigned visitor away',
      desk.page.url().includes('login.html'), desk.page.url());

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
