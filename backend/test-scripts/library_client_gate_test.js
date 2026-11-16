/**
 * De'vyora Library -- the question asked before the door opens.
 *
 * The library is browsed WITH a client sitting there, and every picture
 * chosen from it becomes the reference a board is built on. So the page
 * asks whose sitting it is first: a name and a number, both compulsory,
 * and nothing behind them until both are given.
 *
 * What this has to prove, in order:
 *   - the form stands in FRONT of the library, not beside it
 *   - neither field can be skipped, and a bad number is not a number
 *   - a valid answer opens the library that was always there
 *   - the question is asked once a sitting, not once a page load
 *   - and it is not inherited by whoever signs in next
 *
 * Real server, real Postgres, the real page in Chromium. Google Drive
 * is answered at its own boundary; everything in front of it is real.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_client_gate_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_clientgate?host=/var/tmp';

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

async function main() {
  const admin = DB_URL.replace(/\/tm_clientgate\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_clientgate'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_clientgate'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  // ["*"], exactly as prisma/seed.ts seeds the Owner.
  const role = await prisma.role.create({
    data: { name: 'OWNER', description: 'test', permissions: ['*'] },
  });
  const PASSWORD = 'dummy-password-clientgate';
  await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: role.id },
  });
  await prisma.user.create({
    data: { name: 'Arjun Mehta', email: 'arjun@example.test', passwordHash: await hashPassword(PASSWORD), roleId: role.id },
  });

  await prisma.libraryReference.create({
    data: {
      themeId: 'british', title: 'Panelled Bath', room: 'Bathroom',
      imageUrl: 'https://drive.google.com/uc?export=download&id=file-british-0',
      driveFileId: 'file-british-0',
      uploadedById: (await prisma.user.findFirst({ where: { email: 'priya@example.test' } })).id,
    },
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
  await context.route('https://drive.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  /** Every request the page makes for the library's own data. */
  let libraryCalls = 0;
  page.on('request', (req) => {
    if (/\/api\/v1\/library\/(themes|rooms|references)/.test(req.url())) libraryCalls += 1;
  });

  const signIn = async (email) => {
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('checkingState').style.display === 'none');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL('**/home.html', { timeout: 20000 });
  };

  const err = async (id) => (await page.locator('#' + id).textContent()) || '';

  await signIn('priya@example.test');

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the form stands in front of the library, not beside it');
  {
    // THE HOME PAGE'S OWN CARD, not a typed address: this is the way in
    // the studio actually takes.
    libraryCalls = 0;
    await page.click('#cardLibrary');
    await page.waitForURL('**/devyora-library.html', { timeout: 20000 });
    await page.waitForSelector('#libGateForm', { timeout: 20000 });

    check('1a. the Library card lands on the details form', true);
    check('1b. ...and the library itself is NOT behind it',
      await page.locator('.lib-theme-card').count() === 0
      && await page.locator('.lib-theme-grid').count() === 0);
    // Nothing is fetched for a sitting nobody has named yet.
    check('1c. ...and nothing was asked of the server for it',
      libraryCalls === 0, libraryCalls);

    check('1d. there are exactly two fields, and no more',
      await page.locator('#libGateForm input').count() === 2);
    check('1e. both are marked required, with a red asterisk',
      await page.locator('#libGateForm .lib-gate-k .req').count() === 2
      && await page.getAttribute('#libClientName', 'required') !== null
      && await page.getAttribute('#libClientPhone', 'required') !== null);
    const asteriskColour = await page.$eval('#libGateForm .lib-gate-k .req',
      (el) => getComputedStyle(el).color);
    check('1f. ...and the asterisk really is red, not inherited grey',
      asteriskColour === 'rgb(168, 85, 42)', asteriskColour);
    check('1g. the button says where it goes',
      /CONTINUE TO LIBRARY/.test(await page.textContent('#libGateGo') || ''),
      await page.textContent('#libGateGo'));
    // The sidebar is still the sidebar: this is a question, not a trap.
    check('1h. the rest of the page is untouched -- the studio can leave',
      await page.locator('#navItems .nav-item').count() > 0
      && await page.locator('#logoutBtn').count() === 1);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. neither field can be skipped');
  {
    libraryCalls = 0;
    await page.click('#libGateGo');
    check('2a. an empty form does not open the library',
      await page.locator('#libGateForm').count() === 1
      && await page.locator('.lib-theme-card').count() === 0);
    check('2b. ...it says the name is required',
      /required/i.test(await err('libClientNameErr')), await err('libClientNameErr'));
    check('2c. ...and that the number is required',
      /required/i.test(await err('libClientPhoneErr')), await err('libClientPhoneErr'));
    check('2d. ...both fields marked invalid for a screen reader',
      await page.getAttribute('#libClientName', 'aria-invalid') === 'true'
      && await page.getAttribute('#libClientPhone', 'aria-invalid') === 'true');
    check('2e. ...and still nothing asked of the server',
      libraryCalls === 0, libraryCalls);

    // A NAME IS NOT ENOUGH.
    await page.fill('#libClientName', 'Ananya Rao');
    await page.click('#libGateGo');
    check('2f. a name alone does not open it either',
      await page.locator('#libGateForm').count() === 1
      && /required/i.test(await err('libClientPhoneErr')), await err('libClientPhoneErr'));
    check('2g. ...and the name stops being complained about',
      await err('libClientNameErr') === '', await err('libClientNameErr'));

    // NOR IS A NUMBER.
    await page.fill('#libClientName', '   ');
    await page.fill('#libClientPhone', '9876543210');
    await page.click('#libGateGo');
    check('2h. spaces are not a name',
      await page.locator('#libGateForm').count() === 1
      && /required/i.test(await err('libClientNameErr')), await err('libClientNameErr'));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. a number has to be a number');
  {
    await page.fill('#libClientName', 'Ananya Rao');

    /** Fills the number, submits, and says whether the page let it through. */
    const tryPhone = async (value) => {
      await page.fill('#libClientPhone', value);
      await page.click('#libGateGo');
      const stillHere = await page.locator('#libGateForm').count() === 1;
      return { stillHere, message: await err('libClientPhoneErr') };
    };

    for (const [value, why] of [
      ['12345', 'too short'],
      ['98765432101', 'eleven digits'],
      ['1234567890', 'not a mobile series'],
      ['5876543210', 'starts with 5'],
      ['abcdefghij', 'not digits at all'],
      ['+1 415 555 0123', 'not an Indian number'],
    ]) {
      const got = await tryPhone(value);
      check(`3. "${value}" is refused (${why})`,
        got.stillHere && /valid/i.test(got.message), got);
    }

    // AND THE SHAPES THAT ARE THE SAME TEN DIGITS. A number typed with
    // +91, a leading 0, spaces or hyphens is the number it looks like,
    // and refusing it would be the page being fussy rather than careful.
    for (const [value, why] of [
      ['9876543210', 'plain'],
      ['+91 98765 43210', 'with the country code'],
      ['098765-43210', 'with a trunk 0 and a hyphen'],
      ['  7012345678  ', 'with stray spaces'],
    ]) {
      await page.fill('#libClientPhone', value);
      // Checked WITHOUT submitting, so accepting it does not navigate.
      await page.locator('#libClientPhone').blur();
      await page.locator('#libClientPhone').fill(value);
      const message = await err('libClientPhoneErr');
      check(`3. "${value.trim()}" is accepted (${why})`, message === '', message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. a valid answer opens the library that was always there');
  {
    libraryCalls = 0;
    await page.fill('#libClientName', 'Ananya Rao');
    await page.fill('#libClientPhone', '+91 98765 43210');
    await page.click('#libGateGo');

    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
    check('4a. the form goes and the library opens',
      await page.locator('#libGateForm').count() === 0
      && await page.locator('.lib-theme-card').count() === 10,
      await page.locator('.lib-theme-card').count());
    check('4b. ...on the same address it was always on',
      page.url().endsWith('/devyora-library.html'), page.url());
    check('4c. ...and only NOW is anything asked of the server',
      libraryCalls > 0, libraryCalls);

    // THE LIBRARY IS THE LIBRARY. The Mix still leads, the rooms are
    // still named in full, and a theme still opens.
    const names = await page.$$eval('.lib-theme-card .lib-theme-name',
      (els) => els.map((e) => e.textContent.trim()));
    check('4d. the Mix still leads it, British behind',
      names[0] === 'De’vyora Mix' && names[1] === 'British', names.slice(0, 2));
    await page.click('[data-theme="british"]');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    check('4e. ...and a theme still opens on its rooms',
      await page.locator('[data-room]').count() >= 6);

    // WHAT WAS COLLECTED, AND WHERE IT WENT. On this tab, normalised to
    // ten digits, and nowhere else.
    const kept = await page.evaluate(() => {
      const session = sessionStorage.getItem('casa_library_client');
      return { session: session ? JSON.parse(session) : null, local: localStorage.getItem('casa_library_client') };
    });
    check('4f. the client is kept for this sitting',
      kept.session && kept.session.name === 'Ananya Rao', kept.session);
    check('4g. ...with the number reduced to its ten digits',
      kept.session && kept.session.phone === '9876543210', kept.session);
    check('4h. ...on this tab only, never in localStorage',
      kept.local === null, kept.local);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. asked once a sitting, not once a page load');
  {
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card, #libGateForm', { timeout: 20000 });
    check('5a. coming back does not ask again',
      await page.locator('#libGateForm').count() === 0
      && await page.locator('.lib-theme-card').count() > 0);

    await page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cardLibrary', { timeout: 20000 });
    await page.click('#cardLibrary');
    await page.waitForSelector('.lib-theme-card, #libGateForm', { timeout: 20000 });
    check('5b. ...nor does going out to the home page and back in',
      await page.locator('#libGateForm').count() === 0);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. and it is not inherited by whoever signs in next');
  {
    // A SHOWROOM TABLET IS SHARED. The tab outlives a sign-out, so
    // without the stamp the next staff member would walk into somebody
    // else's client and never be asked whose sitting theirs is.
    // Signed out through the page's own client, then sent to the login
    // screen. The SIGN OUT button does exactly this -- logout, then
    // location.href -- but driving it from here races its own
    // navigation; what is being tested is the next sitting, not the
    // button.
    await page.evaluate(() => window.CasaApi.auth.logout().catch(() => {}));
    await signIn('arjun@example.test');

    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card, #libGateForm', { timeout: 20000 });
    check('6a. the next person signed in is asked for their own client',
      await page.locator('#libGateForm').count() === 1
      && await page.locator('.lib-theme-card').count() === 0);
    check('6b. ...with the last client’s name nowhere on the form',
      await page.inputValue('#libClientName') === ''
      && await page.inputValue('#libClientPhone') === '',
      { name: await page.inputValue('#libClientName'), phone: await page.inputValue('#libClientPhone') });

    await page.fill('#libClientName', 'Rhea Kapoor');
    await page.fill('#libClientPhone', '8123456789');
    await page.click('#libGateGo');
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
    check('6c. ...and their own answer opens it',
      await page.locator('.lib-theme-card').count() === 10);
    const kept = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('casa_library_client') || 'null'));
    check('6d. ...replacing the record, not adding to it',
      kept && kept.name === 'Rhea Kapoor' && kept.phone === '8123456789', kept);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n7. nothing was sent anywhere');
  {
    // THE WHOLE POINT OF "COLLECT ONLY". No row, no endpoint, no
    // third party -- the details sit on the tab until the Clients &
    // Detailings module exists to take them.
    const posted = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.method() === 'PUT' || req.method() === 'PATCH') {
        posted.push(req.url() + ' ' + (req.postData() || ''));
      }
    });
    await page.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
    await page.click('#cardLibrary');
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });

    check('7a. opening the library writes nothing anywhere',
      posted.filter((p) => /Rhea|8123456789/.test(p)).length === 0, posted);
    const rows = await prisma.$queryRawUnsafe(
      "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name ilike '%client_detail%'",
    );
    check('7b. ...and no table was invented to hold it',
      rows[0].n === 0, rows);
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
