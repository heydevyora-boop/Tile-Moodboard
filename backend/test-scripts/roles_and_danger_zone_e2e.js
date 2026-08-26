const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');
const bcrypt = require('bcryptjs');

async function main() {
  const roles = new Map();
  roles.set('role-owner', { id: 'role-owner', name: 'OWNER', description: 'Full access', permissions: ['*'] });
  roles.set('role-admin', { id: 'role-admin', name: 'ADMIN', description: 'Store manager', permissions: ['customers:read', 'customers:write'] });
  roles.set('role-staff', { id: 'role-staff', name: 'STAFF', description: 'Sales staff', permissions: ['customers:read', 'users:read'] });
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

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  prisma.role.findMany = async () => [...roles.values()].sort((a, b) => a.name.localeCompare(b.name));
  prisma.role.findUnique = async ({ where }) => roles.get(where.id) || null;
  prisma.role.update = async ({ where, data }) => { const row = roles.get(where.id); Object.assign(row, data); return row; };

  const apiKeys = new Map();
  apiKeys.set('ak-1', { id: 'ak-1', service: 'GEMINI', label: 'Primary Gemini Key', encryptedValue: 'x:y:z', isActive: true, lastRotatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  apiKeys.set('ak-2', { id: 'ak-2', service: 'GOOGLE_DRIVE', label: 'Drive Service Account', encryptedValue: 'x:y:z', isActive: true, lastRotatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  apiKeys.set('ak-3', { id: 'ak-3', service: 'CUSTOM', label: 'Already inactive', encryptedValue: 'x:y:z', isActive: false, lastRotatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  prisma.apiKey.findMany = async ({ where = {} } = {}) => [...apiKeys.values()].filter((k) => where.isActive === undefined || k.isActive === where.isActive);
  prisma.apiKey.update = async ({ where, data }) => { const row = apiKeys.get(where.id); Object.assign(row, data, { updatedAt: new Date() }); return row; };
  prisma.apiKey.findUnique = async ({ where }) => apiKeys.get(where.id) || null;

  let rtId = 0;
  const refreshTokens = new Map();
  prisma.refreshToken.create = async ({ data }) => { const row = { id: String(++rtId), ...data, revokedAt: null }; refreshTokens.set(data.tokenHash, row); return row; };
  prisma.refreshToken.findUnique = async ({ where }) => refreshTokens.get(where.tokenHash) || null;
  prisma.refreshToken.update = async ({ where, data }) => { const row = [...refreshTokens.values()].find((r) => r.id === where.id); Object.assign(row, data); return row; };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4817, resolve));

  const BASE = 'http://localhost:4817/api/v1';
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

  console.log('--- Roles & Permissions editing ---');

  let res = await fetch(`${BASE}/roles`, { headers: staffAuthed });
  let body = await res.json();
  check('1. STAFF can list roles (read-only permission)', res.status === 200 && body.data.roles.length === 3, body);

  res = await fetch(`${BASE}/roles/role-admin`, { method: 'PATCH', headers: staffAuthed, body: JSON.stringify({ permissions: ['customers:read', 'customers:write', 'tiles:read'] }) });
  check('2. Non-owner (STAFF) is blocked from editing a role (403)', res.status === 403, await res.json());

  res = await fetch(`${BASE}/roles/role-admin`, { method: 'PATCH', headers: ownerAuthed, body: JSON.stringify({ permissions: ['customers:read', 'customers:write', 'tiles:read', 'tiles:write'] }) });
  body = await res.json();
  check("3a. OWNER can update a role's real permissions", res.status === 200, body);
  check('3b. The response reflects the exact new permission set', JSON.stringify(body.data.role.permissions.sort()) === JSON.stringify(['customers:read', 'customers:write', 'tiles:read', 'tiles:write'].sort()), body.data.role.permissions);

  res = await fetch(`${BASE}/roles`, { headers: ownerAuthed });
  body = await res.json();
  const adminRole = body.data.roles.find((r) => r.id === 'role-admin');
  check('3c. The change genuinely persisted — re-fetching roles shows the updated permissions, not the old ones', adminRole.permissions.includes('tiles:write'), adminRole);

  res = await fetch(`${BASE}/roles/role-owner`, { method: 'PATCH', headers: ownerAuthed, body: JSON.stringify({ permissions: ['customers:read'] }) });
  check('4. Editing the OWNER role itself is rejected — its wildcard access must stay fixed', res.status === 400, await res.json());

  res = await fetch(`${BASE}/roles/role-admin`, { method: 'PATCH', headers: ownerAuthed, body: JSON.stringify({ permissions: ['not_a_real_permission:read'] }) });
  check('5. An unknown permission string is rejected by validation, not silently accepted', res.status === 400, await res.json());

  console.log('\n--- API Keys bulk deactivate (Danger Zone) ---');

  res = await fetch(`${BASE}/admin/api-keys`, { method: 'POST', headers: staffAuthed, body: JSON.stringify({}) });
  check('6. Non-owner is blocked from the API keys area entirely (403)', res.status === 403, await res.json());

  res = await fetch(`${BASE}/admin/api-keys/deactivate-all`, { method: 'POST', headers: ownerAuthed });
  body = await res.json();
  check('7a. Bulk deactivate succeeds', res.status === 200, body);
  check('7b. It reports the real count of keys that were actually active (2, not the 3rd which was already inactive)', body.data.deactivatedCount === 2, body.data);

  res = await fetch(`${BASE}/admin/api-keys`, { headers: ownerAuthed });
  body = await res.json();
  check('8. Every key is genuinely inactive afterward, verified by re-fetching the list', body.data.keys.every((k) => k.isActive === false), body.data.keys);

  res = await fetch(`${BASE}/admin/api-keys/deactivate-all`, { method: 'POST', headers: ownerAuthed });
  body = await res.json();
  check('9. Running it again when nothing is active reports 0, not an error', res.status === 200 && body.data.deactivatedCount === 0, body.data);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
