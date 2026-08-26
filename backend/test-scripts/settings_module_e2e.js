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

  const settingsRows = new Map();

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  prisma.setting.findUnique = async ({ where }) => settingsRows.get(where.key) || null;
  prisma.setting.upsert = async ({ where, create, update }) => {
    const existing = settingsRows.get(where.key);
    const row = existing ? { ...existing, ...update, updatedAt: new Date() } : { id: `setting-${settingsRows.size + 1}`, ...create, createdAt: new Date(), updatedAt: new Date() };
    settingsRows.set(where.key, row);
    return row;
  };

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };

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
  await new Promise((resolve) => server.listen(4811, resolve));
  console.log('Backend up on 4811\n');

  const BASE = 'http://localhost:4811/api/v1';
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
  const staffAuthed = { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json' };

  console.log('--- Settings CRUD ---');

  let res = await fetch(`${BASE}/settings`, { headers: staffAuthed });
  let body = await res.json();
  check('1a. STAFF CAN read settings (200)', res.status === 200, body);
  check('1b. Before any configuration, defaults are returned for every category', body.data.settings.print.defaultDpi === 300 && body.data.settings.general.currency === 'INR', body.data.settings);

  res = await fetch(`${BASE}/settings/print`, { method: 'PUT', headers: staffAuthed, body: JSON.stringify({ defaultDpi: 600, defaultFormat: 'CUSTOM', defaultFileFormat: 'PNG', defaultUnit: 'CM' }) });
  check('2. STAFF is blocked from WRITING settings (403)', res.status === 403, await res.json());

  res = await fetch(`${BASE}/settings/print`, { method: 'PUT', headers: ownerAuthed, body: JSON.stringify({ defaultDpi: 600, defaultFormat: 'CUSTOM', defaultFileFormat: 'PNG', defaultUnit: 'CM' }) });
  body = await res.json();
  check('3a. OWNER can update print settings', res.status === 200, body);
  check('3b. Response reflects the new values', body.data.settings.defaultDpi === 600 && body.data.settings.defaultUnit === 'CM', body.data.settings);

  res = await fetch(`${BASE}/settings/print`, { headers: staffAuthed });
  body = await res.json();
  check('4. Re-reading print settings shows the persisted update, not the default', body.data.settings.defaultDpi === 600, body.data.settings);

  res = await fetch(`${BASE}/settings/rules`, { headers: staffAuthed });
  body = await res.json();
  check('5. An unconfigured category (rules) still returns its schema defaults, not an error', body.data.settings.defaultMinTiles === 3 && body.data.settings.defaultMaxCombinations === 4, body.data.settings);

  res = await fetch(`${BASE}/settings/company`, { method: 'PUT', headers: ownerAuthed, body: JSON.stringify({ name: '' }) });
  check('6. Invalid update (empty required company name) is rejected with 400', res.status === 400, await res.json());

  res = await fetch(`${BASE}/settings/not-a-real-category`, { headers: ownerAuthed });
  check('7. An unknown category in the URL is rejected, not silently treated as empty', res.status === 400, await res.json());

  console.log('\n--- Wiring into generation (Settings > Default Rules) ---');

  res = await fetch(`${BASE}/settings/rules`, { method: 'PUT', headers: ownerAuthed, body: JSON.stringify({ defaultMinTiles: 5, defaultMaxCombinations: 2, defaultRoomType: 'kitchen', defaultStyleTag: 'modern' }) });
  check('8. Owner configures Default Rules (min tiles 5, max combos 2, default room/style)', res.status === 200, await res.json());

  const { resolveBriefContext } = require('../src/services/promptBuilder.service');
  const { getSettings } = require('../src/services/settings.service');
  const rulesSettings = await getSettings('rules');
  check('9a. getSettings("rules") reflects the just-saved configuration', rulesSettings.defaultMinTiles === 5 && rulesSettings.defaultMaxCombinations === 2, rulesSettings);

  const brief = await resolveBriefContext({ text: 'something nice' }, { defaultRoomType: rulesSettings.defaultRoomType, defaultStyleTag: rulesSettings.defaultStyleTag });
  check('9b. resolveBriefContext() falls back to the configured default room/style when the brief specifies neither', brief.room === 'KITCHEN' && brief.style === 'MODERN', brief);

  const briefWithExplicitRoom = await resolveBriefContext({ text: 'something nice', room: 'BATHROOM' }, { defaultRoomType: rulesSettings.defaultRoomType, defaultStyleTag: rulesSettings.defaultStyleTag });
  check('9c. ...but an explicitly-specified room in the brief still wins over the configured default', briefWithExplicitRoom.room === 'BATHROOM', briefWithExplicitRoom);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
