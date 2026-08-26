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
  async function addUser(name, email, plainPassword, roleId, isActive = true) {
    const id = `user-${++uid}`;
    const row = { id, name, email, passwordHash: await bcrypt.hash(plainPassword, 12), roleId, isActive, lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() };
    users.set(id, row);
    return row;
  }
  function withRole(row) { return row ? { ...row, role: roles.get(row.roleId) } : null; }
  await addUser('Store Owner', 'owner@test.com', 'OwnerPass123', 'role-owner');
  await addUser('Staff One', 'staff@test.com', 'StaffPass123', 'role-staff');
  await addUser('Disabled Person', 'disabled@test.com', 'DisabledPass123', 'role-staff', false);

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  const loginAttempts = [];
  prisma.loginAttempt.create = async ({ data }) => { const row = { id: `la-${loginAttempts.length + 1}`, createdAt: new Date(), ...data }; loginAttempts.push(row); return row; };
  prisma.loginAttempt.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...loginAttempts];
    if (where.email?.contains) list = list.filter((l) => l.email.includes(where.email.contains.toLowerCase()));
    if (where.success !== undefined) list = list.filter((l) => l.success === where.success);
    if (where.userId) list = list.filter((l) => l.userId === where.userId);
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take).map((l) => ({ ...l, user: users.get(l.userId) ? { id: l.userId, name: users.get(l.userId).name } : null }));
  };
  prisma.loginAttempt.count = async ({ where = {} } = {}) => {
    let list = [...loginAttempts];
    if (where.email?.contains) list = list.filter((l) => l.email.includes(where.email.contains.toLowerCase()));
    if (where.success !== undefined) list = list.filter((l) => l.success === where.success);
    return list.length;
  };

  const errorLogs = [];
  prisma.errorLog.create = async ({ data }) => { const row = { id: `el-${errorLogs.length + 1}`, createdAt: new Date(), ...data }; errorLogs.push(row); return row; };
  prisma.errorLog.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...errorLogs];
    if (where.statusCode) list = list.filter((e) => e.statusCode === where.statusCode);
    if (where.path?.contains) list = list.filter((e) => e.path.toLowerCase().includes(where.path.contains.toLowerCase()));
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take).map((e) => ({ ...e, user: null }));
  };
  prisma.errorLog.count = async ({ where = {} } = {}) => {
    let list = [...errorLogs];
    if (where.statusCode) list = list.filter((e) => e.statusCode === where.statusCode);
    if (where.path?.contains) list = list.filter((e) => e.path.toLowerCase().includes(where.path.contains.toLowerCase()));
    return list.length;
  };

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };
  prisma.activityLog.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...activityLogs];
    if (where.entityType) list = list.filter((l) => l.entityType === where.entityType);
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take).map((l) => ({ ...l, user: users.get(l.userId) ? { id: l.userId, name: users.get(l.userId).name } : null }));
  };
  prisma.activityLog.count = async ({ where = {} } = {}) => {
    let list = [...activityLogs];
    if (where.entityType) list = list.filter((l) => l.entityType === where.entityType);
    return list.length;
  };

  const catalogs = [
    { id: 'cat-1', fileName: 'somany_2026.pdf', status: 'COMPLETED', errorMessage: null, processingLog: 'PROGRESS 1/4\nPROGRESS 2/4\nDone — 42 tiles extracted', totalPages: 4, currentPage: 4, startedAt: new Date(), completedAt: new Date(), createdAt: new Date(), brandId: 'brand-1', uploadedById: 'user-1' },
    { id: 'cat-2', fileName: 'rak_new.pdf', status: 'FAILED', errorMessage: 'No brand prefix in filename', processingLog: 'PROGRESS 1/2\nFAILED — invalid filename', totalPages: 2, currentPage: 1, startedAt: new Date(), completedAt: null, createdAt: new Date(), brandId: 'brand-2', uploadedById: 'user-1' },
  ];
  prisma.catalog.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...catalogs];
    if (where.status) list = list.filter((c) => c.status === where.status);
    return list.slice(skip, skip + take).map((c) => ({ ...c, brand: { id: c.brandId, name: c.brandId === 'brand-1' ? 'Somany' : 'RAK' }, uploadedBy: { id: c.uploadedById, name: 'Store Owner' } }));
  };
  prisma.catalog.count = async ({ where = {} } = {}) => {
    let list = [...catalogs];
    if (where.status) list = list.filter((c) => c.status === where.status);
    return list.length;
  };

  prisma.ruleVersion.findFirst = async () => ({ id: 'rv-1', versionNumber: 1, fullContent: 'GENERAL: Test design rules.', createdAt: new Date() });
  prisma.tile.findMany = async () => [
    { id: 'tile-1', name: 'Ivory Stone Base', type: 'BASE', size: '600x600', finish: 'Matte', colorTone: 'Neutral', quantityInStock: 50, brand: { name: 'Somany' } },
  ];

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
  await new Promise((resolve) => server.listen(4812, resolve));
  console.log('Backend up on 4812\n');

  const BASE = 'http://localhost:4812/api/v1';
  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  async function attemptLogin(email, password) {
    return fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  }

  console.log('--- Login History ---');

  let res = await attemptLogin('nobody-real@test.com', 'whatever123');
  check('1a. Login with an unknown email still returns generic 401', res.status === 401);
  check('1b. ...but it IS now recorded in login_attempts with failureReason user_not_found', loginAttempts.some((a) => a.email === 'nobody-real@test.com' && a.failureReason === 'user_not_found'), loginAttempts);

  res = await attemptLogin('staff@test.com', 'WrongPassword999');
  check('2. Wrong password recorded with failureReason invalid_password', loginAttempts.some((a) => a.email === 'staff@test.com' && a.failureReason === 'invalid_password'));

  res = await attemptLogin('disabled@test.com', 'DisabledPass123');
  check('3a. Deactivated account login returns 403', res.status === 403);
  check('3b. Recorded with failureReason account_deactivated', loginAttempts.some((a) => a.email === 'disabled@test.com' && a.failureReason === 'account_deactivated'));

  res = await attemptLogin('owner@test.com', 'OwnerPass123');
  const loginBody = await res.json();
  check('4a. Correct credentials succeed', res.status === 200);
  check('4b. Success recorded with success:true and no failureReason', loginAttempts.some((a) => a.email === 'owner@test.com' && a.success === true && !a.failureReason));

  const ownerToken = loginBody.data.accessToken;
  const ownerAuthed = { Authorization: `Bearer ${ownerToken}` };

  res = await fetch(`${BASE}/admin/logs/login-history`, { headers: ownerAuthed });
  let body = await res.json();
  check('5. Login history endpoint returns all recorded attempts, including the unknown-email one', body.data.attempts.length >= 4 && body.data.attempts.some((a) => a.email === 'nobody-real@test.com'), body.data.attempts.length);

  res = await fetch(`${BASE}/admin/logs/login-history?success=false`, { headers: ownerAuthed });
  body = await res.json();
  check('6. Filtering login history by success=false returns only failures', body.data.attempts.every((a) => a.success === false), body.data.attempts.map((a) => a.success));

  const staffToken = (await (await attemptLogin('staff@test.com', 'StaffPass123')).json()).data.accessToken;
  res = await fetch(`${BASE}/admin/logs/login-history`, { headers: { Authorization: `Bearer ${staffToken}` } });
  check('7. STAFF is blocked from viewing login history (403)', res.status === 403);

  console.log('\n--- Error Logs ---');

  res = await fetch(`${BASE}/mood-boards/generate`, { method: 'POST', headers: { ...ownerAuthed, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'test brief for a bathroom', room: 'BATHROOM' }) });
  check('8a. Triggering a real 500 (unconfigured Gemini) returns 500', res.status === 500, res.status);
  check('8b. It was persisted to error_logs', errorLogs.some((e) => e.statusCode === 500), errorLogs);

  res = await fetch(`${BASE}/admin/logs/errors`, { headers: ownerAuthed });
  body = await res.json();
  check('9. Error logs endpoint returns the real captured error', body.data.errors.length > 0 && body.data.errors[0].statusCode === 500, body.data.errors);

  res = await fetch(`${BASE}/admin/logs/errors?statusCode=404`, { headers: ownerAuthed });
  body = await res.json();
  check('10. Filtering error logs by statusCode that has no matches returns an empty list, not an error', res.status === 200 && body.data.errors.length === 0);

  console.log('\n--- Catalog / Mood Board / Print Board Logs ---');

  res = await fetch(`${BASE}/admin/logs/catalog`, { headers: ownerAuthed });
  body = await res.json();
  check('11a. Catalog logs endpoint returns real catalog runs', body.data.catalogs.length === 2, body.data.catalogs.length);
  check('11b. Each entry includes the real processingLog text, not just a status', body.data.catalogs.some((c) => c.processingLog && c.processingLog.includes('tiles extracted')), body.data.catalogs);

  res = await fetch(`${BASE}/admin/logs/catalog?status=FAILED`, { headers: ownerAuthed });
  body = await res.json();
  check('12. Filtering catalog logs by status works and shows the real errorMessage', body.data.catalogs.length === 1 && body.data.catalogs[0].errorMessage === 'No brand prefix in filename', body.data.catalogs);

  activityLogs.push({ id: 'x1', action: 'mood_board.approved', entityType: 'MoodBoard', entityId: 'mb-1', userId: 'user-1', createdAt: new Date() });
  activityLogs.push({ id: 'x2', action: 'print_board.exported', entityType: 'PrintBoard', entityId: 'pb-1', userId: 'user-1', createdAt: new Date() });
  activityLogs.push({ id: 'x3', action: 'catalog.uploaded', entityType: 'Catalog', entityId: 'cat-1', userId: 'user-1', createdAt: new Date() });

  res = await fetch(`${BASE}/admin/logs/mood-boards`, { headers: ownerAuthed });
  body = await res.json();
  check('13. Mood board logs endpoint is genuinely pre-scoped to MoodBoard entities only', body.data.logs.length === 1 && body.data.logs[0].entityType === 'MoodBoard', body.data.logs);

  res = await fetch(`${BASE}/admin/logs/print-boards`, { headers: ownerAuthed });
  body = await res.json();
  check('14. Print board logs endpoint is genuinely pre-scoped to PrintBoard entities only', body.data.logs.length === 1 && body.data.logs[0].entityType === 'PrintBoard', body.data.logs);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
