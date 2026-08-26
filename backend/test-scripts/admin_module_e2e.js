const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');
const bcrypt = require('bcryptjs');

async function main() {
  const roles = new Map();
  roles.set('role-owner', { id: 'role-owner', name: 'OWNER', permissions: ['*'] });
  roles.set('role-staff', { id: 'role-staff', name: 'STAFF', permissions: [] });
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
  await addUser('Staff One', 'staff@test.com', 'StaffPass123', 'role-staff');

  const apiKeys = new Map();
  const activityLogs = [];
  let akId = 0;

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  prisma.apiKey.create = async ({ data }) => { const id = `ak-${++akId}`; const row = { id, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...data }; apiKeys.set(id, row); return row; };
  prisma.apiKey.findUnique = async ({ where }) => apiKeys.get(where.id) || null;
  prisma.apiKey.findFirst = async ({ where }) => [...apiKeys.values()].find((k) => k.service === where.service && (where.isActive === undefined || k.isActive === where.isActive)) || null;
  prisma.apiKey.findMany = async ({ where = {} } = {}) => [...apiKeys.values()].filter((k) => !where.service || k.service === where.service).sort((a, b) => b.createdAt - a.createdAt);
  prisma.apiKey.update = async ({ where, data }) => { const row = apiKeys.get(where.id); Object.assign(row, data, { updatedAt: new Date() }); return row; };
  prisma.apiKey.delete = async ({ where }) => { const row = apiKeys.get(where.id); apiKeys.delete(where.id); return row; };

  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };
  prisma.activityLog.findMany = async ({ where = {}, skip = 0, take = 50, distinct } = {}) => {
    let list = [...activityLogs];
    if (where.action?.contains) list = list.filter((l) => l.action.toLowerCase().includes(where.action.contains.toLowerCase()));
    if (where.entityType) list = list.filter((l) => l.entityType === where.entityType);
    if (where.userId) list = list.filter((l) => l.userId === where.userId);
    if (distinct) {
      const seen = new Set();
      list = list.filter((l) => { if (seen.has(l.action)) return false; seen.add(l.action); return true; });
    }
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take).map((l) => ({ ...l, user: users.get(l.userId) ? { id: l.userId, name: users.get(l.userId).name, email: users.get(l.userId).email } : null }));
  };
  prisma.activityLog.count = async ({ where = {} } = {}) => {
    let list = [...activityLogs];
    if (where.action?.contains) list = list.filter((l) => l.action.toLowerCase().includes(where.action.contains.toLowerCase()));
    if (where.entityType) list = list.filter((l) => l.entityType === where.entityType);
    if (where.userId) list = list.filter((l) => l.userId === where.userId);
    return list.length;
  };

  prisma.printBoard.findMany = async () => [
    { format: 'CASSETTE_PANEL', fileFormat: 'PDF', dpi: 300 },
    { format: 'CASSETTE_PANEL', fileFormat: 'PNG', dpi: 300 },
    { format: 'CUSTOM', fileFormat: 'PDF', dpi: 600 },
  ];
  prisma.moodBoard.groupBy = async ({ by }) => {
    if (by[0] === 'status') return [{ status: 'APPROVED', _count: { status: 3 } }, { status: 'GENERATED', _count: { status: 2 } }];
    if (by[0] === 'style') return [{ style: 'Subtle', _count: { style: 3 } }, { style: 'Luxury', _count: { style: 2 } }];
    if (by[0] === 'room') return [{ room: 'Bathroom', _count: { room: 4 } }, { room: 'Kitchen', _count: { room: 1 } }];
    return [];
  };
  prisma.customerFavorite.groupBy = async () => [{ tileId: 'tile-1', _count: { tileId: 4 } }];
  prisma.tile.findMany = async ({ where }) => [{ id: 'tile-1', name: 'Ivory Stone Base' }].filter((t) => !where?.id?.in || where.id.in.includes(t.id));
  prisma.catalog.groupBy = async () => [{ status: 'COMPLETED', _count: { status: 8 } }, { status: 'FAILED', _count: { status: 2 } }];

  let rtId = 0;
  const refreshTokens = new Map();
  prisma.refreshToken.create = async ({ data }) => { const row = { id: String(++rtId), ...data, revokedAt: null }; refreshTokens.set(data.tokenHash, row); return row; };
  prisma.refreshToken.findUnique = async ({ where }) => refreshTokens.get(where.tokenHash) || null;
  prisma.refreshToken.update = async ({ where, data }) => { const row = [...refreshTokens.values()].find((r) => r.id === where.id); Object.assign(row, data); return row; };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4810, resolve));
  console.log('Backend up on 4810\n');

  const BASE = 'http://localhost:4810/api/v1';
  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  async function login(email, password) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await res.json();
    return body.data.accessToken;
  }
  const ownerToken = await login('owner@test.com', 'OwnerPass123');
  const staffToken = await login('staff@test.com', 'StaffPass123');
  const ownerAuthed = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
  const staffAuthed = { Authorization: `Bearer ${staffToken}` };

  console.log('--- API Keys ---');

  let res = await fetch(`${BASE}/admin/api-keys`, { headers: staffAuthed });
  check('1. STAFF blocked from API keys (403)', res.status === 403, await res.json());

  res = await fetch(`${BASE}/admin/api-keys`, { method: 'POST', headers: ownerAuthed, body: JSON.stringify({ service: 'GEMINI', label: 'Primary Gemini Key', value: 'AIzaSyD-real-looking-fake-key-1234567890abcdef' }) });
  let body = await res.json();
  check('2a. OWNER can create an API key (201)', res.status === 201, body);
  check('2b. Response NEVER contains the plaintext value', JSON.stringify(body).includes('AIzaSyD-real-looking-fake-key-1234567890abcdef') === false, body);
  check('2c. Response includes a masked value instead', body.data.key.maskedValue.includes('...'), body.data.key);
  const keyId = body.data.key.id;

  res = await fetch(`${BASE}/admin/api-keys`, { headers: ownerAuthed });
  body = await res.json();
  check('3. List returns the created key, still masked', body.data.keys.some((k) => k.id === keyId) && !JSON.stringify(body).includes('AIzaSyD-real-looking-fake'), body.data.keys);

  res = await fetch(`${BASE}/admin/api-keys/${keyId}/rotate`, { method: 'POST', headers: ownerAuthed, body: JSON.stringify({ value: 'AIzaSyD-rotated-new-key-9876543210zyxwvu' }) });
  body = await res.json();
  check('4a. Rotate succeeds', res.status === 200, body);
  check('4b. lastRotatedAt is set', !!body.data.key.lastRotatedAt, body.data.key);
  check('4c. Masked value reflects the NEW key, not the old one', body.data.key.maskedValue.includes('zyxw') || body.data.key.maskedValue.includes('wvu'), body.data.key);

  const { GeminiClient } = require('../src/services/gemini.service');
  let capturedUrl = null;
  const client = new GeminiClient(async (url) => { capturedUrl = url; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) }; });
  check('5a. GeminiClient.isConfigured() reflects the DB-stored key even with no env var set', await client.isConfigured());
  await client.generateContent('test prompt');
  check('5b. GeminiClient actually used the DB-stored (rotated) key value in its request', capturedUrl && capturedUrl.includes('AIzaSyD-rotated-new-key-9876543210zyxwvu'), capturedUrl);

  res = await fetch(`${BASE}/admin/api-keys/${keyId}/deactivate`, { method: 'POST', headers: ownerAuthed });
  body = await res.json();
  check('6a. Deactivate succeeds', body.data.key.isActive === false, body.data.key);
  check('6b. After deactivation, GeminiClient falls back (no active DB key found)', (await new GeminiClient(async () => ({}), null).isConfigured()) === false);

  res = await fetch(`${BASE}/admin/api-keys/${keyId}/activate`, { method: 'POST', headers: ownerAuthed });
  body = await res.json();
  check('7. Reactivate succeeds', body.data.key.isActive === true, body.data.key);

  res = await fetch(`${BASE}/admin/api-keys/${keyId}`, { method: 'DELETE', headers: ownerAuthed });
  check('8a. Delete succeeds', res.status === 200, await res.json());
  res = await fetch(`${BASE}/admin/api-keys/${keyId}/rotate`, { method: 'POST', headers: ownerAuthed, body: JSON.stringify({ value: 'x' }) });
  check('8b. Rotating a deleted key gives 404', res.status === 404, await res.json());

  console.log('\n--- Logs ---');

  res = await fetch(`${BASE}/admin/logs`, { headers: ownerAuthed });
  body = await res.json();
  check('9. Logs endpoint returns entries (from the API key actions above)', body.data.logs.length > 0, body.data.logs.length);

  res = await fetch(`${BASE}/admin/logs?action=api_key.created`, { headers: ownerAuthed });
  body = await res.json();
  check('10. Filtering by action returns only matching entries', body.data.logs.every((l) => l.action.includes('api_key.created')), body.data.logs.map((l) => l.action));

  res = await fetch(`${BASE}/admin/logs/actions`, { headers: ownerAuthed });
  body = await res.json();
  check('11. Distinct actions list is non-empty and has no duplicates', body.data.actions.length === new Set(body.data.actions).size && body.data.actions.length > 0, body.data.actions);

  console.log('\n--- Analytics ---');

  res = await fetch(`${BASE}/admin/analytics`, { headers: ownerAuthed });
  body = await res.json();
  check('12a. Analytics endpoint succeeds', res.status === 200, body);
  check('12b. Print export breakdown by format is correct', body.data.printExports.byFormat.find((f) => f.format === 'CASSETTE_PANEL')?.count === 2, body.data.printExports);
  check('12c. Mood board approval rate computed correctly (3 approved / 5 total = 60%)', body.data.moodBoards.approvalRate === 60, body.data.moodBoards);
  check('12d. Top favorited tiles includes the real tile name (not just an id)', body.data.topFavoritedTiles[0]?.tileName === 'Ivory Stone Base', body.data.topFavoritedTiles);
  check('12e. Catalog success rate computed correctly (8 completed / 10 total = 80%)', body.data.catalogUploads.successRate === 80, body.data.catalogUploads);
  check('12f. Print export total is correct (3 boards)', body.data.printExports.total === 3, body.data.printExports);
  check('12g. Mood board style breakdown is real (from MoodBoard.style groupBy)', body.data.moodBoards.byStyle.find((s) => s.style === 'Subtle')?.count === 3, body.data.moodBoards.byStyle);
  check('12h. Mood board room breakdown is real (from MoodBoard.room groupBy)', body.data.moodBoards.byRoom.find((r) => r.room === 'Bathroom')?.count === 4, body.data.moodBoards.byRoom);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
