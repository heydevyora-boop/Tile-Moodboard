/**
 * De'vyora Library -- the generation flow.
 *
 * THE CLAIM BEING TESTED, in the client's own words:
 *
 *   "Based on the visual style, colors, patterns and mood of this
 *    reference image, find the most suitable matching tiles from our
 *    existing tile catalog ... then generate a new interior image by
 *    applying those tiles, while strongly following the composition,
 *    lighting, perspective and overall style of the selected reference
 *    image."
 *
 * Which is two separate claims, and a test that only proves the first
 * is worthless:
 *
 *   1. THE TILES. The chosen picture must actually be LOOKED AT, and
 *      what is read from it must reach both the pool the catalog is
 *      drawn from and the prompt that chooses between it.
 *
 *   2. THE IMAGE. That same picture -- the exact file, not a
 *      description of it -- must be the scene the materials are
 *      installed into, so its composition, camera, light and
 *      perspective survive because they are the real thing.
 *
 * The real server, a real Postgres, the real route and the real prompt
 * builder. Three network boundaries are answered rather than mocked
 * past: Gemini, Drive, and the Python generator -- so what this reads
 * back is the actual outgoing request body in each case, not a
 * function's arguments.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_generation_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_libgen?host=/var/tmp';

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
  PYTHON_AI_BASE_URL: 'http://127.0.0.1:59999',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600));
    fail += 1; failures.push(label);
  }
}

// A real 1x1 PNG. Real, because library.service and libraryMatch both
// read the BYTES rather than trusting a content-type -- Drive answers a
// plain client with an HTML sign-in page for a file it will not serve,
// and a fake buffer here would walk straight past the guard that exists
// for exactly that.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── the three boundaries ────────────────────────────────────────────

const realFetch = global.fetch;

/** Every Gemini request body, in order. */
const geminiCalls = [];
/** Every request body sent to the Python generator, in order. */
const pythonCalls = [];
/** Every URL the server asked Drive for. */
const driveCalls = [];

/** What the next Gemini vision call should answer with. */
let visionAnswer = null;
/** What the next combination call should answer with. */
let combinationAnswer = null;
/** When set, Drive refuses -- the picture cannot be read. */
let driveDown = false;

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Gemini's own envelope around a model answer. */
function geminiResponse(text) {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

global.fetch = (async (url, init) => {
  const href = String(url && url.url ? url.url : url);

  if (href.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init.body);
    geminiCalls.push(body);
    // The two calls are told apart the way the API itself tells them
    // apart: one carries an image part, the other does not.
    const hasImage = (body.contents[0].parts || []).some((p) => p.inlineData);
    return geminiResponse(hasImage ? visionAnswer : combinationAnswer);
  }

  if (href.includes('drive.google.com')) {
    driveCalls.push(href);
    if (driveDown) return { ok: false, status: 403, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : '') },
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    };
  }

  if (href.includes('59999')) {
    pythonCalls.push(JSON.parse(init.body));
    return jsonResponse({
      success: true,
      status: 'COMPLETED',
      visualization_id: 'viz-1',
      visualization: { product_name: 'Zellige Cobalt', surface: 'WALL' },
      image: { data_url: 'data:image/png;base64,' + PNG.toString('base64') },
      theme_check: { status: 'pass', theme: 'Moroccan', present: [], missing: [] },
    });
  }

  return realFetch(url, init);
});

// ── the reading a vision pass would come back with ──────────────────

const READING = {
  summary: 'A small cobalt-and-cream hammam with a zellige dado and a honed stone floor.',
  dominantColour: 'deep cobalt blue',
  palette: ['deep cobalt blue', 'warm cream', 'brass', 'soft terracotta'],
  materials: ['zellige glazed ceramic', 'honed limestone'],
  patterns: ['small-format staggered brick', 'star-and-cross panel'],
  finishes: ['glossy', 'matte'],
  formats: ['100x100 square', '600x600'],
  mood: 'cool, quiet, high side-light',
  surfaces: {
    floor: 'honed cream limestone in a wide plain field',
    walls: 'cobalt zellige to dado height, cream plaster above',
    feature: 'the wall behind the basin, in a star-and-cross panel',
  },
};

/**
 * The board the model is made to return.
 *
 * Built from the REAL tile ids once the fixtures exist: the validator
 * checks every tileId against the pool it actually offered and drops
 * anything it did not, which is right -- and means a hard-coded id here
 * would be thrown away and this test would be asserting on an empty
 * board.
 */
const boardsFor = (tiles) => [{
  board_name: 'Cobalt Hammam',
  tiles: [
    { role: 'base', tileId: tiles.TILE_BASE.id, name: 'Cream Limestone' },
    { role: 'highlight', tileId: tiles.TILE_HIGH.id, name: 'Cobalt Zellige' },
  ],
  grout_recommendation: 'Ivory matte',
  rooms_suitable: ['Bathroom'],
  reason_for_selection: 'The cream limestone answers the reference floor; the cobalt zellige answers its dado.',
}];

async function main() {
  const admin = DB_URL.replace(/\/tm_libgen\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_libgen'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_libgen'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const role = await prisma.role.create({
    data: {
      name: 'OWNER',
      description: 'test',
      permissions: [
        'mood_boards:read', 'mood_boards:write',
        'tiles:read', 'visualizations:write',
        'reference_images:read', 'reference_images:write',
      ],
    },
  });
  const PASSWORD = 'dummy-password-libgen';
  const user = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'priya@example.test', passwordHash: await hashPassword(PASSWORD), roleId: role.id },
  });

  // generateCombinations refuses to run without published design rules,
  // which is correct and is not what this test is about.
  await prisma.ruleVersion.create({
    data: {
      versionNumber: 1,
      fullContent: '## GENERAL RULES\n- Always recommend a grout colour.',
      rulesSnapshot: {},
      createdById: user.id,
    },
  });

  const brand = await prisma.brand.create({ data: { name: 'Somany', slug: 'somany' } });
  const catalog = await prisma.catalog.create({
    data: { fileName: 'test-catalog.pdf', brandId: brand.id, status: 'COMPLETED' },
  });
  const tiles = {};
  for (const [id, data] of Object.entries({
    TILE_BASE: { name: 'Cream Limestone', type: 'BASE', colorTone: 'Cream', finish: 'matte', size: '600x600' },
    TILE_HIGH: { name: 'Cobalt Zellige', type: 'HIGHLIGHTER', colorTone: 'Blue', finish: 'glossy', size: '100x100' },
    TILE_OTHER: { name: 'Charcoal Slate', type: 'BASE', colorTone: 'Charcoal', finish: 'matte', size: '600x600' },
  })) {
    tiles[id] = await prisma.tile.create({
      data: {
        ...data,
        catalogId: catalog.id,
        brandId: brand.id,
        productCode: id,
        inStock: true,
        imageUrl: `https://drive.google.com/uc?export=download&id=img-${id}`,
      },
    });
  }

  const reference = await prisma.libraryReference.create({
    data: {
      themeId: 'moroccan',
      title: 'Cobalt Hammam',
      room: 'Bathroom',
      description: 'Shot for the Jaipur showroom.',
      imageUrl: 'https://drive.google.com/uc?export=download&id=ref-cobalt',
      driveFileId: 'ref-cobalt',
      uploadedById: user.id,
    },
  });

  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;

  // Signed in through the real login, so every call below carries a real
  // token through the real middleware.
  const login = await realFetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'priya@example.test', password: PASSWORD }),
  });
  const token = (await login.json()).data.accessToken;

  const call = async (route, body) => {
    const res = await realFetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const reset = () => {
    geminiCalls.length = 0;
    pythonCalls.length = 0;
    driveCalls.length = 0;
    visionAnswer = JSON.stringify(READING);
    combinationAnswer = JSON.stringify(boardsFor(tiles));
    driveDown = false;
  };

  const BRIEF = {
    text: 'Design a bathroom with a feature wall behind the basin.',
    room: 'BATHROOM',
    style: 'Moroccan',
    combinationCount: 1,
  };

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the chosen picture is actually looked at');
  {
    reset();
    const out = await call('/mood-boards/generate', { ...BRIEF, libraryReferenceId: reference.id });

    check('1a. the board is generated', out.status === 200 && out.body.data.combinations.length === 1,
      out.body);

    const vision = geminiCalls.find((c) => (c.contents[0].parts || []).some((p) => p.inlineData));
    check('1b. a request carrying the picture itself was sent to Gemini', Boolean(vision));

    const part = vision && vision.contents[0].parts.find((p) => p.inlineData);
    check('1c. ...and the bytes in it are the reference’s own file',
      Boolean(part) && part.inlineData.data === PNG.toString('base64'), part && part.inlineData.mimeType);

    check('1d. ...fetched from that reference’s Drive link',
      driveCalls.some((u) => u.includes('ref-cobalt')), driveCalls);

    const text = vision ? vision.contents[0].parts[0].text : '';
    check('1e. ...asked for the things a tile can carry, not a room description',
      /colour|color/i.test(text) && /pattern/i.test(text) && /finish/i.test(text) && /format/i.test(text),
      text.slice(0, 200));

    check('1f. the prompt comes before the picture, not after it',
      Boolean(vision) && typeof vision.contents[0].parts[0].text === 'string'
      && Boolean(vision.contents[0].parts[1].inlineData));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. what was read reaches the step that picks the tiles');
  {
    const combination = geminiCalls.find((c) => !(c.contents[0].parts || []).some((p) => p.inlineData));
    const prompt = combination ? combination.contents[0].parts[0].text : '';

    check('2a. the prompt names the chosen reference', /Cobalt Hammam/.test(prompt));
    check('2b. ...and what was read in it: palette, materials, patterns, finishes, mood',
      prompt.includes('deep cobalt blue')
      && prompt.includes('zellige glazed ceramic')
      && prompt.includes('star-and-cross panel')
      && prompt.includes('glossy')
      && prompt.includes('cool, quiet, high side-light'),
      prompt.slice(0, 400));
    check('2c. ...surface by surface, so a base and a highlight can be told apart',
      prompt.includes('honed cream limestone') && prompt.includes('cobalt zellige to dado height'));
    check('2d. ...stated as the PRIMARY guide', /PRIMARY VISUAL GUIDE/.test(prompt));
    check('2e. ...and as outranking the theme, which is the rule the feature rests on',
      /THE REFERENCE WINS/.test(prompt));

    // Position matters as much as wording: the theme block is hundreds
    // of words of mandatory rules, and a reference underneath it reads
    // as a footnote to the theme.
    const refAt = prompt.indexOf('DE’VYORA LIBRARY');
    const themeAt = prompt.indexOf('MANDATORY for this theme');
    check('2f. ...placed ABOVE the theme specification, not under it',
      refAt >= 0 && themeAt >= 0 && refAt < themeAt, { refAt, themeAt });

    check('2g. the room’s own fittings are ruled out as a basis for choosing',
      /fittings, its furniture, its plants, its towels/.test(prompt));
    check('2h. ...and every board has to say what it matched',
      /which parts of the reference each product answers/.test(prompt));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. the reading reaches the POOL, not only the prompt');
  {
    // The prompt can only choose between the rows the ranking engine
    // returned. A reference whose colour reached the prompt but not the
    // ranking is matched against whatever the theme happened to surface
    // -- so this is checked at the engine itself.
    const { getAvailableTiles } = require(path.join(ROOT, 'src/services/promptBuilder.service'));
    const withColour = await getAvailableTiles({ room: 'BATHROOM', style: 'Moroccan', colorTone: 'deep cobalt blue' });
    const cobalt = withColour.find((t) => t.id === tiles.TILE_HIGH.id);
    const charcoal = withColour.find((t) => t.id === tiles.TILE_OTHER.id);
    check('3a. the reference’s colour is accepted by the pool at all', Boolean(cobalt));

    const { rankTiles } = require(path.join(ROOT, 'src/services/tileRecommendation.service'));
    const pool = [
      { id: 'a', name: 'Cobalt Zellige', type: 'HIGHLIGHTER', colorTone: 'Blue', finish: 'glossy', bestRoom: null, size: null },
      { id: 'b', name: 'Charcoal Slate', type: 'BASE', colorTone: 'Charcoal', finish: 'matte', bestRoom: null, size: null },
    ];
    const ranked = rankTiles(pool, { room: 'BATHROOM', colorTone: 'deep cobalt blue' });
    check('3b. ...and it moves a matching tile ahead of a non-matching one',
      ranked[0].id === 'a' && ranked[0].score > ranked[1].score,
      ranked.map((t) => [t.id, t.score]));
    check('3c. ...for a stated reason the showroom can read',
      ranked[0].matchReasons.some((r) => /color family/i.test(r)), ranked[0].matchReasons);
    check('3d. both tiles are still offered -- it is a ranking, never a filter',
      Boolean(cobalt) && Boolean(charcoal));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. the reading is kept, so it is paid for once');
  {
    const row = await prisma.libraryReference.findUnique({ where: { id: reference.id } });
    check('4a. the reading is stored on the reference', Boolean(row.visualProfile));
    check('4b. ...as what was actually read', row.visualProfile.dominantColour === 'deep cobalt blue',
      row.visualProfile);
    check('4c. ...and when it was taken', row.visualReadAt instanceof Date);

    reset();
    const again = await call('/mood-boards/generate', { ...BRIEF, libraryReferenceId: reference.id });
    check('4d. a second board on the same reference still generates', again.status === 200);
    check('4e. ...without looking at the picture again',
      geminiCalls.every((c) => !(c.contents[0].parts || []).some((p) => p.inlineData)),
      geminiCalls.length);
    check('4f. ...and without fetching it from Drive again',
      !driveCalls.some((u) => u.includes('ref-cobalt')), driveCalls);
    const prompt = geminiCalls[0].contents[0].parts[0].text;
    check('4g. ...and the kept reading is what the prompt carries',
      prompt.includes('deep cobalt blue') && prompt.includes('zellige glazed ceramic'));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. the response says what was matched, and what was not');
  {
    reset();
    const out = await call('/mood-boards/generate', { ...BRIEF, libraryReferenceId: reference.id });
    const echoed = out.body.data.libraryReference;
    check('5a. the board reports the reference it was matched to', Boolean(echoed));
    check('5b. ...by name and picture, so the page can show it',
      echoed.title === 'Cobalt Hammam' && echoed.imageUrl.includes('ref-cobalt'));
    check('5c. ...saying the match actually happened', echoed.matched === true);
    check('5d. ...and the colour the catalog was searched with',
      echoed.dominantColour === 'deep cobalt blue', echoed);

    const logged = await prisma.activityLog.findFirst({
      where: { action: 'mood_board.prompt_generated' },
      orderBy: { createdAt: 'desc' },
    });
    check('5e. ...and the history records it too',
      logged.metadata.libraryReferenceId === reference.id
      && logged.metadata.libraryReferenceMatched === true,
      logged.metadata);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. a picture that cannot be read is said so, never implied');
  {
    // The one outcome this feature must never produce is a board that
    // LOOKS reference-matched and is not.
    const fresh = await prisma.libraryReference.create({
      data: {
        themeId: 'moroccan', title: 'Unreachable Room',
        imageUrl: 'https://drive.google.com/uc?export=download&id=ref-gone',
        driveFileId: 'ref-gone', uploadedById: user.id,
      },
    });

    reset();
    driveDown = true;
    const out = await call('/mood-boards/generate', { ...BRIEF, libraryReferenceId: fresh.id });

    check('6a. the board is still generated', out.status === 200 && out.body.data.combinations.length === 1,
      out.body);
    check('6b. ...and does NOT claim the reference was matched',
      out.body.data.libraryReference.matched === false, out.body.data.libraryReference);
    const warnings = out.body.data.warnings.join(' | ');
    check('6c. ...the reason is reported in plain words',
      /could not be read/.test(warnings) && /chosen from the theme alone/.test(warnings), warnings);
    check('6d. ...including that the IMAGE will still use the room',
      /still used to generate the image/.test(warnings), warnings);

    const prompt = geminiCalls[0].contents[0].parts[0].text;
    check('6e. ...and no reference block is put in the prompt',
      !/PRIMARY VISUAL GUIDE/.test(prompt));
    check('6f. nothing was stored from a failed reading',
      (await prisma.libraryReference.findUnique({ where: { id: fresh.id } })).visualProfile === null);

    // A reference deleted between choosing it and generating.
    reset();
    const gone = await call('/mood-boards/generate', { ...BRIEF, libraryReferenceId: 'no-such-reference' });
    check('6g. a reference that is gone does not fail the board', gone.status === 200);
    check('6h. ...and says so rather than silently ignoring it',
      /no longer in the De’vyora Library/.test(gone.body.data.warnings.join(' ')),
      gone.body.data.warnings);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n7. THE IMAGE IS BUILT ON THE PICTURE ITSELF');
  {
    reset();
    const out = await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      library_reference_id: reference.id,
      materials: [
        { role: 'base', tile_id: tiles.TILE_BASE.id },
        { role: 'highlight', tile_id: tiles.TILE_HIGH.id },
      ],
      requirements: { room: 'BATHROOM', style: 'Moroccan', combination_name: 'Cobalt Hammam' },
    });

    check('7a. the scene is generated', out.status === 200, out.body);
    const sent = pythonCalls[0];
    check('7b. the reference’s own file is the scene image',
      sent.scene_image_url === reference.imageUrl, sent && sent.scene_image_url);
    check('7c. ...treated as a reference, not as a starting point',
      sent.scene_image_mode === 'reference', sent && sent.scene_image_mode);
    check('7d. ...and the step that INVENTS a room does not run',
      sent.generate_random_scene === false, sent && sent.generate_random_scene);
    check('7e. the generator is told the room is the client’s own choice',
      typeof sent.requirements.reference_room === 'string'
      && sent.requirements.reference_room.includes('Cobalt Hammam')
      && sent.requirements.reference_room.includes('Bathroom'),
      sent && sent.requirements.reference_room);
    check('7f. ...and the whole combination still travels with it',
      Array.isArray(sent.materials) && sent.materials.length === 2
      && sent.materials.map((m) => m.role).join(',') === 'base,highlight',
      sent && sent.materials);
    check('7g. the theme is NOT dropped -- it still governs how they are laid',
      sent.requirements.style === 'Moroccan');
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n8. the browser cannot name the scene it is handed');
  {
    reset();
    await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      library_reference_id: reference.id,
      // A page that could choose this would be pointing the server's own
      // fetcher at an address of its choosing.
      scene_image_url: 'https://evil.example.test/not-the-reference.png',
      scene_image_mode: 'random',
      generate_random_scene: true,
      requirements: { room: 'BATHROOM' },
    });
    const sent = pythonCalls[0];
    check('8a. the row’s URL wins over the one the page sent',
      sent.scene_image_url === reference.imageUrl, sent && sent.scene_image_url);
    check('8b. ...and a page asking for a random room cannot override the choice',
      sent.generate_random_scene === false && sent.scene_image_mode === 'reference',
      [sent && sent.generate_random_scene, sent && sent.scene_image_mode]);
    check('8c. ...and the page’s own address is not sent anywhere',
      !JSON.stringify(sent).includes('evil.example.test'));

    // Without a reference, the old behaviour is untouched.
    reset();
    await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      generate_random_scene: true,
      requirements: { room: 'BATHROOM', style: 'Moroccan' },
    });
    const plain = pythonCalls[0];
    check('8d. a board with no reference still generates its own room',
      plain.generate_random_scene === true, plain && plain.generate_random_scene);
    check('8e. ...and is told nothing about a reference room',
      plain.requirements.reference_room === undefined, plain && plain.requirements);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n9. a reference gone by generation time fails loudly');
  {
    const doomed = await prisma.libraryReference.create({
      data: {
        themeId: 'british', title: 'Deleted Room',
        imageUrl: 'https://drive.google.com/uc?export=download&id=ref-doomed',
        driveFileId: 'ref-doomed', uploadedById: user.id,
      },
    });
    await prisma.libraryReference.update({ where: { id: doomed.id }, data: { isActive: false } });

    reset();
    const out = await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      library_reference_id: doomed.id,
      requirements: { room: 'BATHROOM' },
    });

    check('9a. it is refused', out.status === 404, out.status);
    check('9b. ...in words that say what to do about it',
      /no longer in the De’vyora Library/.test(out.body.error.message)
      && /Choose a reference again/.test(out.body.error.message),
      out.body.error);
    check('9c. ...and NOT answered with an invented room instead',
      pythonCalls.length === 0, pythonCalls.length);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n10. the history can answer "what was this built on?"');
  {
    reset();
    await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      library_reference_id: reference.id,
      materials: [{ role: 'base', tile_id: tiles.TILE_BASE.id }],
      requirements: { room: 'BATHROOM', style: 'Moroccan' },
    });

    const res = await realFetch(`${base}/ai/visualizations/recent?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = (await res.json()).data.generations;
    check('10a. the newest generation names its library reference',
      rows[0].libraryReference === 'Cobalt Hammam', rows[0] && rows[0].libraryReference);
    check('10b. ...and carries its id, so it can be opened again',
      rows[0].libraryReferenceId === reference.id);

    // A generation made without one must not read as though it had one.
    reset();
    await call('/ai/visualizations', {
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      generate_random_scene: true,
      requirements: { room: 'BATHROOM' },
    });
    const after = await realFetch(`${base}/ai/visualizations/recent?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const newest = (await after.json()).data.generations[0];
    check('10c. a scene built without a reference says so by saying nothing',
      newest.libraryReference === '', newest.libraryReference);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n11. a STARTER room needs no database and no vision call');
  {
    // The rooms that ship with the application. They exist so a studio
    // that has uploaded nothing -- and whose migration has not been run
    // -- still has a library to choose from and generate with.
    reset();
    const out = await call('/mood-boards/generate', {
      ...BRIEF, libraryReferenceId: 'starter:moroccan-1',
    });

    check('11a. a board can be built on one', out.status === 200
      && out.body.data.combinations.length === 1, out.body);
    check('11b. ...reported as matched', out.body.data.libraryReference.matched === true,
      out.body.data.libraryReference);
    check('11c. ...WITHOUT a vision call, because its reading ships with it',
      geminiCalls.every((c) => !(c.contents[0].parts || []).some((p) => p.inlineData)),
      geminiCalls.length);
    check('11d. ...and without fetching anything',
      driveCalls.length === 0, driveCalls);

    const prompt = geminiCalls[0].contents[0].parts[0].text;
    check('11e. the shipped reading is what the prompt carries',
      prompt.includes('cobalt blue')
      && prompt.includes('zellige glazed ceramic')
      && prompt.includes('eight-point star'),
      prompt.slice(prompt.indexOf('LIBRARY'), prompt.indexOf('LIBRARY') + 500));
    check('11f. ...including which surface carries what, so roles can be told apart',
      /floor carries: warm ivory squares/i.test(prompt)
      && /walls carry: cobalt and saffron eight-point stars/i.test(prompt)
      && /to dado height, warm ivory, unpatterned above/i.test(prompt),
      prompt.slice(prompt.indexOf('floor carries'), prompt.indexOf('floor carries') + 260));
    check('11g. ...and the colour the catalog was searched with',
      out.body.data.libraryReference.dominantColour === 'cobalt blue',
      out.body.data.libraryReference);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n12. ...and the image is built on the file this server hosts');
  {
    reset();
    // A real public host, which is what a deployment sends. From a
    // loopback host python-ai.service deliberately rewrites the origin
    // to BACKEND_PUBLIC_URL, so this is the case that proves the URL is
    // built from the REQUEST rather than from a setting that goes stale
    // on every Vercel deploy.
    // Raw http, not fetch: undici forbids setting a Host header, and
    // the Host is the whole point here -- a loopback one is rewritten
    // to BACKEND_PUBLIC_URL downstream (correctly), so only a real
    // public Host shows whether the URL is built from the REQUEST or
    // from a setting that goes stale on every Vercel deploy.
    const body = JSON.stringify({
      product_id: tiles.TILE_BASE.id,
      surface: 'WALL',
      library_reference_id: 'starter:moroccan-1',
      materials: [{ role: 'base', tile_id: tiles.TILE_BASE.id }],
      requirements: { room: 'BATHROOM', style: 'Moroccan' },
    });

    const res = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/v1/ai/visualizations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
          Host: 'casa-de-aurum.example.test',
        },
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      request.on('error', reject);
      request.end(body);
    });

    check('12a. the scene is generated', res.status === 200, res.text && res.text.slice(0, 200));
    const sent = pythonCalls[0];
    check('12b. the scene image is an absolute URL',
      /^https?:\/\/[^/]+\/static\/library-starters\/moroccan-1\.png$/.test(
        (sent && sent.scene_image_url) || ''),
      sent && sent.scene_image_url);
    check('12c. ...built from the host the request actually arrived on',
      String((sent || {}).scene_image_url || '').includes('casa-de-aurum.example.test'),
      sent && sent.scene_image_url);
    check('12d. ...and the room-inventing step does not run',
      sent && sent.generate_random_scene === false);
    check('12e. the generator is told whose room it is',
      sent && String(sent.requirements.reference_room).includes('Cobalt Zellige'),
      sent && sent.requirements.reference_room);

    // And it must actually be servable, or the URL is a promise this
    // server cannot keep.
    const origin = base.replace(/\/api\/v1$/, '');
    const file = await realFetch(`${origin}/static/library-starters/moroccan-1.png`);
    const bytes = Buffer.from(await file.arrayBuffer());
    check('12f. that URL really serves a PNG from this server',
      file.status === 200 && bytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a',
      [file.status, bytes.length]);

    // Pillow opens PNG; it cannot open SVG, so a starter had to be
    // raster or it would be choosable and then fail in Python.
    check('12g. ...which is what the Python side can actually open',
      file.headers.get('content-type') === 'image/png',
      file.headers.get('content-type'));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n13. a starter cannot be deleted, and says why');
  {
    const res = await realFetch(`${base}/library/references/starter:moroccan-1`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    check('13a. it is refused', res.status === 400, res.status);
    check('13b. ...because it ships with the application, not the studio',
      /ships with De/.test(body.message || ''), body);
  }

  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
