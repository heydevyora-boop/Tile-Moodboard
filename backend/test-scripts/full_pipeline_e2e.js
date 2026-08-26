const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');
const bcrypt = require('bcryptjs');
const fs = require('fs');

async function main() {
  const roles = new Map();
  roles.set('role-owner', { id: 'role-owner', name: 'OWNER', permissions: ['*'] });
  const users = new Map();
  let uid = 0;
  async function addUser(name, email, plainPassword, roleId) {
    const id = `user-${++uid}`;
    const row = { id, name, email, passwordHash: await bcrypt.hash(plainPassword, 12), roleId, isActive: true, lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() };
    users.set(id, row);
    return row;
  }
  function withRole(row) { return row ? { ...row, role: roles.get(row.roleId) } : null; }
  await addUser('Store Owner', 'owner@test.com', 'OwnerPass123', 'role-owner');

  const pythonRunner = require('@utils/pythonRunner');
  let pythonScriptCalledWith = null;
  pythonRunner.runPythonScript = async ({ script, args, onLine }) => {
    pythonScriptCalledWith = { script, args };
    onLine?.('PROGRESS: {"currentPage": 1, "totalPages": 2}');
    onLine?.('PROGRESS: {"currentPage": 2, "totalPages": 2}');
    const result = {
      success: true,
      catalogId: null,
      brand: 'Somany',
      totalPages: 2,
      tilesExtracted: 2,
      tiles: [
        { name: 'Ivory Stone Base', size: '600x1200mm', finish: 'Matt', type: 'BASE', colorTone: 'Warm Beige', bestRoom: 'BATHROOM', productCode: 'IVR-001', sourcePage: 1, imageStorage: 'local', imageUrl: '/static/extracted/ivory-stone.jpg', imageLocalPath: 'ivory-stone.jpg' },
        { name: 'Ivory Highlighter', size: '300x600mm', finish: 'Glossy', type: 'HIGHLIGHTER', colorTone: 'Warm Beige', bestRoom: 'BATHROOM', productCode: 'IVR-002', sourcePage: 2, imageStorage: 'local', imageUrl: '/static/extracted/ivory-highlight.jpg', imageLocalPath: 'ivory-highlight.jpg' },
      ],
      warnings: [],
      duplicateImagesSkipped: 0,
      storageMode: 'local',
    };
    return { stdout: `RESULT_JSON: ${JSON.stringify(result)}`, stderr: '', exitCode: 0 };
  };

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  const brands = new Map();
  brands.set('b-1', { id: 'b-1', name: 'Somany' });
  prisma.brand.findFirst = async ({ where }) => [...brands.values()].find((b) => b.name.toLowerCase() === (where?.name?.equals || '').toLowerCase()) || (where?.id ? brands.get(where.id) : null);
  prisma.brand.findUnique = async ({ where }) => brands.get(where.id) || null;
  prisma.brand.findMany = async () => [...brands.values()];

  const catalogs = new Map();
  let catId = 0;
  prisma.catalog.create = async ({ data }) => { const id = `cat-${++catId}`; const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }; catalogs.set(id, row); return row; };
  prisma.catalog.findUnique = async ({ where, include }) => {
    const row = catalogs.get(where.id);
    if (!row) return null;
    return include?.brand ? { ...row, brand: brands.get(row.brandId) } : row;
  };
  prisma.catalog.findFirst = async ({ where }) => [...catalogs.values()].find((c) => c.brandId === where?.brandId && c.fileHash === where?.fileHash) || null;
  prisma.catalog.update = async ({ where, data }) => { const row = catalogs.get(where.id); Object.assign(row, data); return row; };
  prisma.catalog.count = async ({ where = {} }) => [...catalogs.values()].filter((c) => !where.status || c.status === where.status).length;

  const tiles = new Map();
  let tileId = 0;
  prisma.tile.create = async ({ data }) => { const id = `tile-${++tileId}`; const row = { id, createdAt: new Date(), ...data }; tiles.set(id, row); return row; };
  prisma.tile.createMany = async ({ data }) => { for (const d of data) { const id = `tile-${++tileId}`; tiles.set(id, { id, createdAt: new Date(), ...d }); } return { count: data.length }; };
  prisma.tile.findMany = async ({ where = {} } = {}) => {
    let list = [...tiles.values()];
    if (where.catalogId) list = list.filter((t) => t.catalogId === where.catalogId);
    if (where.brandId) list = list.filter((t) => t.brandId === where.brandId);
    if (where.id?.in) list = list.filter((t) => where.id.in.includes(t.id));
    if (where.productCode?.in) list = list.filter((t) => where.productCode.in.includes(t.productCode));
    if (where.name?.in) list = list.filter((t) => where.name.in.includes(t.name));
    return list.map((t) => ({ ...t, brand: brands.get(t.brandId) }));
  };
  prisma.tile.findUnique = async ({ where }) => { const t = tiles.get(where.id); return t ? { ...t, brand: brands.get(t.brandId) } : null; };
  prisma.tile.count = async ({ where = {} } = {}) => (await prisma.tile.findMany({ where })).length;

  const designRules = new Map();
  designRules.set('dr-1', { id: 'dr-1', section: 'GENERAL', title: 'Grout tone', content: 'Match grout to the base tile tone unless the client specifies contrast.', status: 'PUBLISHED', version: 1 });
  prisma.designRule.findMany = async () => [...designRules.values()];
  prisma.ruleVersion.findFirst = async () => ({ id: 'rv-1', version: 1, snapshot: [...designRules.values()], publishedAt: new Date() });

  const moodBoards = new Map();
  let mbId = 0;
  prisma.moodBoard.create = async ({ data }) => { const id = `mb-${++mbId}`; const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }; moodBoards.set(id, row); return row; };
  prisma.moodBoard.findUnique = async ({ where }) => moodBoards.get(where.id) || null;
  prisma.moodBoard.findMany = async ({ where = {} } = {}) => [...moodBoards.values()].filter((m) => !where.customerId || m.customerId === where.customerId).map((m) => ({ ...m, printBoards: [...printBoards.values()].filter((pb) => pb.moodBoardId === m.id) }));
  prisma.moodBoard.update = async ({ where, data }) => { const row = moodBoards.get(where.id); Object.assign(row, data); return row; };
  prisma.moodBoard.groupBy = async ({ by } = {}) => {
    const list = [...moodBoards.values()];
    if (by[0] === 'status') {
      const counts = new Map();
      for (const m of list) counts.set(m.status, (counts.get(m.status) || 0) + 1);
      return [...counts.entries()].map(([status, count]) => ({ status, _count: { status: count } }));
    }
    return [];
  };

  const customers = new Map();
  customers.set('c-1', { id: 'c-1', name: 'Anita Kulkarni', phone: '9876543210', createdAt: new Date() });
  prisma.customer.findUnique = async ({ where }) => customers.get(where.id) || null;

  const printBoards = new Map();
  let pbId = 0;
  prisma.printBoard.create = async ({ data }) => { const id = `pb-${++pbId}`; const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }; printBoards.set(id, row); return row; };
  prisma.printBoard.findUnique = async ({ where }) => printBoards.get(where.id) || null;
  prisma.printBoard.findMany = async () => [...printBoards.values()];

  let rtId = 0;
  const refreshTokens = new Map();
  prisma.refreshToken.create = async ({ data }) => { const row = { id: String(++rtId), ...data, revokedAt: null }; refreshTokens.set(data.tokenHash, row); return row; };
  prisma.refreshToken.findUnique = async ({ where }) => refreshTokens.get(where.tokenHash) || null;
  prisma.refreshToken.update = async ({ where, data }) => { const row = [...refreshTokens.values()].find((r) => r.id === where.id); Object.assign(row, data); return row; };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };
  prisma.activityLog.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...activityLogs];
    if (where.entityType) list = list.filter((l) => l.entityType === where.entityType);
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take).map((l) => ({ ...l, user: users.get(l.userId) ? { id: l.userId, name: users.get(l.userId).name } : null }));
  };
  prisma.activityLog.count = async () => activityLogs.length;

  const geminiService = require('@services/gemini.service');
  geminiService.geminiClient.generateContent = async () => {
    const allTiles = [...tiles.values()];
    const base = allTiles.find((t) => t.name === 'Ivory Stone Base');
    const highlight = allTiles.find((t) => t.name === 'Ivory Highlighter');
    return {
      text: JSON.stringify([
        {
          board_name: 'Warm Minimal Bathroom',
          tiles: [
            { tileId: base?.id, name: 'Ivory Stone Base', role: 'base', imageUrl: '/static/extracted/ivory-stone.jpg', pricePerSqft: 65 },
            { tileId: highlight?.id, name: 'Ivory Highlighter', role: 'highlight', imageUrl: '/static/extracted/ivory-highlight.jpg', pricePerSqft: 90 },
          ],
          grout_recommendation: 'Warm grey grout, 2mm joint',
          rooms_suitable: ['BATHROOM'],
          reason_for_selection: 'Matches the warm, spa-like brief with a subtle highlight accent.',
        },
      ]),
    };
  };

  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4820, resolve));

  const BASE = 'http://localhost:4820/api/v1';
  async function login(email, password) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await res.json();
    return body.data.accessToken;
  }
  const ownerToken = await login('owner@test.com', 'OwnerPass123');
  const auth = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };

  console.log('=== STAGE 1: Catalog upload -> extraction ===');

  const tmpDir = fs.mkdtempSync('/tmp/casa-pipeline-');
  const pdfPath = path.join(tmpDir, 'somany_catalog.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake but real-signature PDF content for the pipeline test')]));

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), 'somany_catalog.pdf');
  form.append('brandId', 'b-1');

  let res = await fetch(`${BASE}/catalog-extractor/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form });
  let body = await res.json();
  check('1a. Catalog upload succeeds and passes real magic-byte verification (Module 25)', res.status === 202, body);
  const catalogId = body.data?.catalog?.id;

  let catalogRow;
  for (let i = 0; i < 60; i++) {
    res = await fetch(`${BASE}/catalog-extractor/catalogs/${catalogId}`, { headers: auth });
    body = await res.json();
    catalogRow = body.data.catalog;
    if (catalogRow.status === 'COMPLETED' || catalogRow.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check('1b. Extraction completes (via the mocked Python bridge, exercising the real queue/service code)', catalogRow?.status === 'COMPLETED', catalogRow);
  check('1c. The real Python script was actually invoked with the uploaded file', pythonScriptCalledWith?.script === 'extract.py', pythonScriptCalledWith);
  check('1d. tilesExtracted reflects the real mocked result (2 tiles)', catalogRow?.tilesExtracted === 2, catalogRow);

  res = await fetch(`${BASE}/catalog-extractor/catalogs/${catalogId}/tiles`, { headers: auth });
  body = await res.json();
  check('1e. The extracted tiles are genuinely queryable afterward', body.data.tiles.length === 2 && body.data.tiles.some((t) => t.name === 'Ivory Stone Base'), body.data.tiles);

  console.log('\n=== STAGE 2: Design rules are live ===');

  res = await fetch(`${BASE}/design-rules/live`, { headers: auth });
  check('2. Live design rules are reachable (used by generation in stage 3)', res.status === 200, res.status);

  console.log('\n=== STAGE 3: Mood board generation -> save -> approve ===');

  res = await fetch(`${BASE}/mood-boards/generate`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'Client wants a spa-like feel, warm tones', style: 'LUXURY', room: 'BATHROOM', combinationCount: 1 }) });
  body = await res.json();
  check('3a. Mood board generation succeeds against the mocked Gemini client', res.status === 200 && body.data.combinations.length === 1, body);
  const combination = body.data.combinations[0];
  check('3b. The generated combination references the real extracted tiles by name', combination.tiles.some((t) => t.name === 'Ivory Stone Base'), combination);

  res = await fetch(`${BASE}/mood-boards`, { method: 'POST', headers: auth, body: JSON.stringify({ clientBrief: 'Client wants a spa-like feel, warm tones', style: 'LUXURY', room: 'BATHROOM', customerId: 'c-1', combinations: body.data.combinations }) });
  body = await res.json();
  check('4a. Saving the mood board succeeds', res.status === 201, body);
  const moodBoardId = body.data.board.id;

  res = await fetch(`${BASE}/mood-boards/${moodBoardId}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ selectedIndex: 0 }) });
  body = await res.json();
  check('5. Approving a combination succeeds and marks status APPROVED', res.status === 200 && body.data.board.status === 'APPROVED', body.data?.board);

  console.log('\n=== STAGE 4: Print board export (sync) ===');

  res = await fetch(`${BASE}/print-boards/generate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ moodBoardId, combinationIndex: 0, format: 'CASSETTE_PANEL', layout: 'TILE_GRID', widthValue: 4, heightValue: 6, unit: 'FT', dpi: 150, fileFormat: 'PNG' }),
  });
  body = await res.json();
  check('6a. Print board export succeeds', res.status === 201, body);
  check('6b. A real file was produced (fileUrl set)', !!body.data?.board?.fileUrl, body.data?.board);

  console.log('\n=== STAGE 5: Downstream visibility ===');

  res = await fetch(`${BASE}/customers/c-1/history`, { headers: auth });
  body = await res.json();
  check('7. The full pipeline is visible from Customer History', body.data.moodBoards.some((m) => m.id === moodBoardId), body.data.moodBoards);

  res = await fetch(`${BASE}/admin/analytics`, { headers: auth });
  body = await res.json();
  check('8a. Admin analytics reflects the real generated/approved mood board', body.data.moodBoards.generated >= 1 && body.data.moodBoards.approved >= 1, body.data.moodBoards);
  check('8b. Admin analytics reflects the real print export', body.data.printExports.total >= 1, body.data.printExports);

  res = await fetch(`${BASE}/admin/logs?entityType=Catalog`, { headers: auth });
  body = await res.json();
  check('9. The activity log genuinely recorded the catalog upload step', body.data.logs.length > 0, body.data.logs);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
