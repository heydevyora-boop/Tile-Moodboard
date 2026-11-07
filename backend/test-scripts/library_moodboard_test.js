/**
 * De'vyora Library -- from the chosen room to the generated image, in a
 * real browser.
 *
 * library_generation_test.js proves the SERVER does the right thing
 * when it is told which reference was chosen. This proves it is ever
 * told: the choice is made on one page and spent on another, and a
 * carrier that quietly drops it would leave every check in that file
 * passing and the feature not working at all.
 *
 * So this walks it the way a client does -- choose in the Library, open
 * the mood board, generate, generate the scene -- and reads the actual
 * request bodies that leave the browser.
 *
 * Real server, real Postgres, real pages in Chromium. Gemini, Drive and
 * the Python generator are answered at their own boundaries; everything
 * in front of them is the real path.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_moodboard_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_libmb?host=/var/tmp';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
  GEMINI_API_KEY: 'dummy-gemini-key-not-a-real-key',
  GOOGLE_DRIVE_ROOT_FOLDER: 'TestDriveRoot',
  PYTHON_AI_BASE_URL: 'http://127.0.0.1:59998',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500));
    fail += 1; failures.push(label);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const realFetch = global.fetch;
let visionAnswer = null;
let combinationAnswer = null;
let driveDown = false;
const pythonCalls = [];

const READING = {
  summary: 'A cobalt-and-cream hammam with a zellige dado.',
  dominantColour: 'deep cobalt blue',
  palette: ['deep cobalt blue', 'warm cream'],
  materials: ['zellige glazed ceramic'],
  patterns: ['small-format staggered brick'],
  finishes: ['glossy'],
  formats: ['100x100 square'],
  mood: 'cool and quiet',
  surfaces: { floor: 'cream limestone', walls: 'cobalt zellige', feature: 'behind the basin' },
};

function jsonResponse(body) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

global.fetch = (async (url, init) => {
  const href = String(url && url.url ? url.url : url);

  if (href.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init.body);
    const hasImage = (body.contents[0].parts || []).some((p) => p.inlineData);
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: hasImage ? visionAnswer : combinationAnswer }] }, finishReason: 'STOP' }],
    });
  }

  if (href.includes('drive.google.com')) {
    if (driveDown) return { ok: false, status: 403, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    return {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : '') },
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    };
  }

  if (href.includes('59998')) {
    pythonCalls.push(JSON.parse(init.body));
    return jsonResponse({
      success: true, status: 'COMPLETED', visualization_id: 'viz-1',
      visualization: { product_name: 'Cream Limestone', surface: 'WALL' },
      image: { data_url: 'data:image/png;base64,' + PNG.toString('base64') },
      theme_check: { status: 'pass', theme: 'Moroccan', present: [], missing: [] },
    });
  }

  return realFetch(url, init);
});

async function main() {
  const admin = DB_URL.replace(/\/tm_libmb\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_libmb'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_libmb'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const role = await prisma.role.create({
    data: {
      name: 'OWNER', description: 'test',
      permissions: [
        'mood_boards:read', 'mood_boards:write', 'tiles:read',
        'visualizations:write', 'reference_images:read', 'reference_images:write',
      ],
    },
  });
  const PASSWORD = 'dummy-password-libmb';
  const user = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: role.id },
  });

  await prisma.ruleVersion.create({
    data: { versionNumber: 1, fullContent: '## RULES\n- Recommend a grout colour.', rulesSnapshot: {}, createdById: user.id },
  });

  const brand = await prisma.brand.create({ data: { name: 'Somany', slug: 'somany' } });
  const catalog = await prisma.catalog.create({
    data: { fileName: 'c.pdf', brandId: brand.id, status: 'COMPLETED' },
  });
  const tiles = {};
  for (const [code, data] of Object.entries({
    TILE_BASE: { name: 'Cream Limestone', type: 'BASE', colorTone: 'Cream', finish: 'matte', size: '600x600' },
    TILE_HIGH: { name: 'Cobalt Zellige', type: 'HIGHLIGHTER', colorTone: 'Blue', finish: 'glossy', size: '100x100' },
  })) {
    tiles[code] = await prisma.tile.create({
      data: {
        ...data, catalogId: catalog.id, brandId: brand.id, productCode: code, inStock: true,
        imageUrl: `https://drive.google.com/uc?export=download&id=img-${code}`,
      },
    });
  }

  combinationAnswer = JSON.stringify([{
    board_name: 'Cobalt Hammam',
    tiles: [
      { role: 'base', tileId: tiles.TILE_BASE.id, name: 'Cream Limestone' },
      { role: 'highlight', tileId: tiles.TILE_HIGH.id, name: 'Cobalt Zellige' },
    ],
    grout_recommendation: 'Ivory matte',
    rooms_suitable: ['Bathroom'],
    reason_for_selection: 'Matched to the reference floor and its dado.',
  }]);
  visionAnswer = JSON.stringify(READING);

  const moroccan = await prisma.libraryReference.create({
    data: {
      themeId: 'moroccan', title: 'Cobalt Hammam', room: 'Bathroom',
      imageUrl: 'https://drive.google.com/uc?export=download&id=ref-cobalt',
      driveFileId: 'ref-cobalt', uploadedById: user.id,
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

  // Drive is unreachable from here, so every <img> would sit broken.
  await context.route('https://drive.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  // Every request body the PAGE sends, which is the thing in question.
  const sentBodies = {};
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() !== 'POST') return;
    try {
      if (url.includes('/mood-boards/generate')) sentBodies.generate = JSON.parse(req.postData() || '{}');
      if (url.includes('/ai/visualizations')) sentBodies.scene = JSON.parse(req.postData() || '{}');
    } catch (err) { /* not JSON; not one of ours */ }
  });


  /** Theme -> Room -> pictures: reaching a picture is two clicks now. */
  const openThemeRoom = async (themeId, roomId) => {
    await page.click('[data-theme="' + themeId + '"]');
    await page.waitForSelector('[data-room]', { timeout: 20000 });
    await page.click('[data-room="' + roomId + '"]');
    await page.waitForSelector('.lib-card, .lib-empty', { timeout: 20000 });
  };

  await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('checkingState').style.display === 'none');
  await page.fill('#email', 'priya@example.test');
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 20000 });

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the choice is made in the Library and spent elsewhere');
  {
    await page.goto(`${base}/devyora-library.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lib-theme-card', { timeout: 20000 });
    await openThemeRoom('moroccan', 'bathroom');
    // The first card in a theme is now one of the STARTER rooms that
    // ship with the application, and that is deliberately what this
    // walks: it is the path a studio with nothing uploaded takes, and
    // the one that has to work on a deployment with no Drive and no
    // migration.
    await page.locator('.lib-card').first().click();
    await page.waitForSelector('#libActive', { timeout: 10000 });

    check('1a. the chosen room is shown as the active reference',
      /Cobalt Zellige/.test(await page.locator('#libActive').textContent() || ''),
      await page.locator('#libActive').textContent());
    check('1b. ...with a way to go and use it',
      await page.locator('.lib-active-go').count() === 1);

    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('casa_library_selection')));
    check('1c. the choice carries the reference’s id',
      kept.id === 'starter:moroccan-bathroom', kept.id);
    check('1d. ...and its theme’s LABEL, which is what the wizard works in',
      kept.themeLabel === 'Moroccan', kept);

    await page.locator('.lib-active-go').click();
    await page.waitForURL('**/mood-board.html', { timeout: 20000 });
    await page.waitForSelector('.room-card', { timeout: 20000 });
    check('1e. ...and that link lands on the mood board', true);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. the wizard shows what it is working against');
  {
    check('2a. the reference is on screen from the first step',
      await page.locator('.libref').count() === 1);
    const banner = await page.locator('.libref').textContent() || '';
    check('2b. ...named', /Cobalt Zellige/.test(banner) && /Bathroom/.test(banner), banner);
    check('2c. ...saying what it will be used for',
      /TILES AND THE IMAGE WILL BOTH BE MATCHED/.test(banner), banner);
    check('2d. ...with a way to change it and a way to drop it',
      await page.locator('.libref-acts a[href="devyora-library.html"]').count() === 1
      && await page.locator('#librefClear').count() === 1);
    check('2e. the picture itself is shown on the banner',
      /library-starters\/moroccan-bathroom\.png$/.test(
        await page.locator('.libref-thumb img').getAttribute('src') || ''),
      await page.locator('.libref-thumb img').getAttribute('src'));

    // The reference belongs to Moroccan; the wizard must not silently
    // open on British, which is its first theme.
    await page.click('[data-goto-step="5"]');
    await page.waitForSelector('[data-palette]', { timeout: 10000 });
    check('2f. the wizard’s theme is pre-selected to the reference’s own',
      await page.locator('.palette-card.selected').count() === 1
      && /Moroccan/.test(await page.locator('.palette-card.selected').textContent() || ''),
      await page.locator('.palette-card.selected').textContent());

    await page.click('[data-goto-step="6"]');
    await page.waitForSelector('.summary-card', { timeout: 10000 });
    check('2g. the review lists it with the rest of the specification',
      /LIBRARY REFERENCE/.test(await page.locator('.summary-card').textContent() || '')
      && /Cobalt Zellige/.test(await page.locator('.summary-card').textContent() || ''),
      await page.locator('.summary-card').textContent());
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. the choice reaches the generate call');
  {
    await page.click('[data-goto-step="1"]');
    await page.waitForSelector('.room-card', { timeout: 10000 });
    await page.locator('[data-room]').first().click();
    await page.click('[data-goto-step="7"]');
    await page.waitForSelector('[data-view]', { timeout: 10000 });
    await page.click('#nextBtn');
    await page.waitForSelector('.board-card', { timeout: 30000 });

    check('3a. the board is generated', await page.locator('.board-card').count() === 1);
    check('3b. ...and the request carried the reference’s id',
      sentBodies.generate && sentBodies.generate.libraryReferenceId === 'starter:moroccan-bathroom',
      sentBodies.generate && sentBodies.generate.libraryReferenceId);
    check('3c. ...the id ALONE -- not a URL this page could choose',
      sentBodies.generate && !JSON.stringify(sentBodies.generate).includes('drive.google.com'),
      sentBodies.generate);

    const banner = await page.locator('.libref').textContent() || '';
    check('3d. the results say the tiles were matched to the room',
      /TILES MATCHED TO THIS ROOM/.test(banner), banner);
    // A STARTER'S READING SHIPS WITH IT. libraryStarters.ts writes down
    // the palette each one was drawn to, so no vision call is spent and
    // matching works on a deployment with no Gemini key at all.
    check('3e. ...and the colour the catalog was searched with',
      /COBALT BLUE/.test(banner), banner);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. the choice reaches the IMAGE call');
  {
    pythonCalls.length = 0;
    await page.locator('[data-generate-scene]').first().click();
    await page.waitForSelector('.viz-image-frame img, .viz-error', { timeout: 60000 });

    check('4a. the scene request carried the reference’s id',
      sentBodies.scene && sentBodies.scene.library_reference_id === 'starter:moroccan-bathroom',
      sentBodies.scene && sentBodies.scene.library_reference_id);
    // A starter is a file this server hosts, so Python -- a separate
    // function fetching over the public internet -- needs it as an
    // ABSOLUTE url. A relative path would be choosable and then fail
    // at the one moment it mattered.
    check('4b. ...and the server turned it into an absolute URL Python can fetch',
      /^https?:\/\/[^/]+\/static\/library-starters\/moroccan-bathroom\.png$/.test(
        (pythonCalls[0] && pythonCalls[0].scene_image_url) || ''),
      pythonCalls[0] && pythonCalls[0].scene_image_url);
    // Which HOST that absolute URL carries is checked in
    // library_generation_test, where the request headers can be set:
    // from a browser on localhost, python-ai.service deliberately
    // rewrites a loopback origin to BACKEND_PUBLIC_URL, and that is
    // correct -- Python is a different process and there is nothing on
    // this test server's port for it.
    check('4c. ...with the room-inventing step switched off',
      pythonCalls[0] && pythonCalls[0].generate_random_scene === false);
    check('4d. ...and the generator told the room is the client’s own',
      pythonCalls[0] && String(pythonCalls[0].requirements.reference_room).includes('Cobalt Zellige'),
      pythonCalls[0] && pythonCalls[0].requirements.reference_room);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. dropping the reference actually drops it');
  {
    await page.locator('#librefClear').click();
    await page.waitForSelector('.room-card, .board-card', { timeout: 10000 });
    check('5a. the banner goes', await page.locator('.libref').count() === 0);
    check('5b. ...and so does the stored choice',
      await page.evaluate(() => localStorage.getItem('casa_library_selection')) === null);

    sentBodies.generate = null;
    pythonCalls.length = 0;
    await page.goto(`${base}/mood-board.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room-card', { timeout: 20000 });
    check('5c. a reload starts with no reference', await page.locator('.libref').count() === 0);
    await page.locator('[data-room]').first().click();
    await page.click('[data-goto-step="7"]');
    await page.waitForSelector('[data-view]', { timeout: 10000 });
    await page.click('#nextBtn');
    await page.waitForSelector('.board-card', { timeout: 30000 });
    check('5d. ...and generates without one',
      sentBodies.generate && sentBodies.generate.libraryReferenceId === undefined,
      sentBodies.generate);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. a reference that could not be read says so on the page');
  {
    // The one outcome this feature must never produce is a board that
    // LOOKS reference-matched and is not -- and the page is where a
    // client would be misled by it.
    const unread = await prisma.libraryReference.create({
      data: {
        themeId: 'moroccan', title: 'Unreachable Room',
        imageUrl: 'https://drive.google.com/uc?export=download&id=ref-gone',
        driveFileId: 'ref-gone', uploadedById: user.id,
      },
    });

    driveDown = true;
    await page.goto(`${base}/mood-board.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((ref) => {
      localStorage.setItem('casa_library_selection', JSON.stringify({
        id: ref.id, themeId: 'moroccan', themeLabel: 'Moroccan',
        title: ref.title, imageUrl: ref.imageUrl, room: '', chosenAt: new Date().toISOString(),
      }));
    }, { id: unread.id, title: unread.title, imageUrl: unread.imageUrl });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room-card', { timeout: 20000 });
    await page.locator('[data-room]').first().click();
    await page.click('[data-goto-step="7"]');
    await page.waitForSelector('[data-view]', { timeout: 10000 });
    await page.click('#nextBtn');
    await page.waitForSelector('.board-card', { timeout: 30000 });

    const banner = await page.locator('.libref').textContent() || '';
    check('6a. the page does NOT claim the tiles were matched',
      !/TILES MATCHED TO THIS ROOM/.test(banner), banner);
    check('6b. ...it says the picture could not be read',
      /COULD NOT BE READ/.test(banner), banner);
    check('6c. ...and that the image still uses the room, which is true',
      /THE IMAGE STILL USES THIS ROOM/.test(banner), banner);
    driveDown = false;
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
