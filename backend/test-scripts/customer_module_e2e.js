const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');
const bcrypt = require('bcryptjs');

async function main() {
  const roles = new Map();
  roles.set('role-owner', { id: 'role-owner', name: 'OWNER', permissions: ['*'] });
  roles.set('role-staff', { id: 'role-staff', name: 'STAFF', permissions: ['customers:read', 'customers:write'] });
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

  const customers = new Map();
  let cId = 0;
  prisma.customer.create = async ({ data }) => { const id = `c-${++cId}`; const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }; customers.set(id, row); return row; };
  prisma.customer.findUnique = async ({ where }) => customers.get(where.id) || null;
  prisma.customer.findMany = async ({ where = {}, skip = 0, take = 100 } = {}) => {
    let list = [...customers.values()];
    if (where.OR) {
      const term = where.OR[0].name.contains.toLowerCase();
      list = list.filter((c) => (c.name || '').toLowerCase().includes(term) || (c.phone || '').toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term));
    }
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take);
  };
  prisma.customer.count = async ({ where = {} } = {}) => {
    let list = [...customers.values()];
    if (where.OR) {
      const term = where.OR[0].name.contains.toLowerCase();
      list = list.filter((c) => (c.name || '').toLowerCase().includes(term) || (c.phone || '').toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term));
    }
    return list.length;
  };
  prisma.customer.update = async ({ where, data }) => { const row = customers.get(where.id); Object.assign(row, data); return row; };
  prisma.customer.delete = async ({ where }) => { const row = customers.get(where.id); customers.delete(where.id); return row; };

  const tiles = new Map();
  tiles.set('t-1', { id: 't-1', name: 'Ivory Stone Base', brandId: 'b-1' });
  prisma.tile.findUnique = async ({ where }) => tiles.get(where.id) || null;
  prisma.brand.findUnique = async () => ({ id: 'b-1', name: 'Somany' });

  const favorites = new Map();
  let fId = 0;
  prisma.customerFavorite.create = async ({ data }) => { const id = `fav-${++fId}`; const row = { id, createdAt: new Date(), ...data }; favorites.set(id, row); return { ...row, tile: { ...tiles.get(data.tileId), brand: { name: 'Somany' } } }; };
  prisma.customerFavorite.findFirst = async ({ where }) => [...favorites.values()].find((f) => f.customerId === where.customerId && f.tileId === where.tileId) || null;
  prisma.customerFavorite.findMany = async ({ where }) => [...favorites.values()].filter((f) => f.customerId === where.customerId).map((f) => ({ ...f, tile: { ...tiles.get(f.tileId), brand: { name: 'Somany' } } }));
  prisma.customerFavorite.delete = async ({ where }) => { const row = favorites.get(where.id); favorites.delete(where.id); return row; };

  const moodBoards = [
    { id: 'mb-1', customerId: null, style: 'LUXURY', room: 'BATHROOM', clientBrief: 'Spa vibes', status: 'APPROVED', combinations: [{}, {}], selectedIndex: 0, createdAt: new Date() },
  ];
  prisma.moodBoard.findMany = async ({ where }) => moodBoards.filter((m) => m.customerId === where.customerId).map((m) => ({ ...m, createdBy: null, printBoards: [] }));

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
  await new Promise((resolve) => server.listen(4814, resolve));

  const BASE = 'http://localhost:4814/api/v1';
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

  console.log('--- Customer CRUD ---');

  let res = await fetch(`${BASE}/customers`, { method: 'POST', headers: staffAuthed, body: JSON.stringify({ name: 'Priya Sharma', phone: '9876543210', email: 'priya@example.com', preferredStyle: 'luxury', preferredRoom: 'bathroom', budget: '2-3 Lakh' }) });
  let body = await res.json();
  check('1a. Staff (with customers:write) can create a customer', res.status === 201, body);
  check('1b. preferredStyle/preferredRoom are normalized to uppercase by the validator', body.data.customer.preferredStyle === 'LUXURY' && body.data.customer.preferredRoom === 'BATHROOM', body.data.customer);
  const customerId = body.data.customer.id;

  await fetch(`${BASE}/customers`, { method: 'POST', headers: staffAuthed, body: JSON.stringify({ name: 'Rohit Verma', phone: '9123456780' }) });

  res = await fetch(`${BASE}/customers?search=priya`, { headers: staffAuthed });
  body = await res.json();
  check('2. Search by name returns only the matching customer', body.data.customers.length === 1 && body.data.customers[0].name === 'Priya Sharma', body.data.customers);

  res = await fetch(`${BASE}/customers/${customerId}`, { headers: staffAuthed });
  body = await res.json();
  check('3. Get by id returns the real created customer', body.data.customer.email === 'priya@example.com', body.data.customer);

  res = await fetch(`${BASE}/customers/${customerId}`, { method: 'PATCH', headers: staffAuthed, body: JSON.stringify({ budget: '5-6 Lakh' }) });
  body = await res.json();
  check('4. Update persists the real change', body.data.customer.budget === '5-6 Lakh', body.data.customer);

  console.log('\n--- Mood Board History ---');

  moodBoards[0].customerId = customerId;
  res = await fetch(`${BASE}/customers/${customerId}/history`, { headers: staffAuthed });
  body = await res.json();
  check('5. History returns the real mood board linked to this customer', body.data.moodBoards.length === 1 && body.data.moodBoards[0].clientBrief === 'Spa vibes', body.data.moodBoards);

  console.log('\n--- Favorites ---');

  res = await fetch(`${BASE}/customers/${customerId}/favorites`, { method: 'POST', headers: staffAuthed, body: JSON.stringify({ tileId: 't-1', note: 'Loved this on her last visit' }) });
  body = await res.json();
  check('6a. Adding a favorite succeeds', res.status === 201, body);
  check('6b. Response includes the real tile name via the join', body.data.favorite.tile?.name === 'Ivory Stone Base', body.data.favorite);

  res = await fetch(`${BASE}/customers/${customerId}/favorites`, { method: 'POST', headers: staffAuthed, body: JSON.stringify({ tileId: 't-1' }) });
  check('7. Favoriting the same tile twice for the same customer is rejected (409)', res.status === 409, await res.json());

  res = await fetch(`${BASE}/customers/${customerId}/favorites`, { headers: staffAuthed });
  body = await res.json();
  check('8. Listing favorites returns the real favorite with note', body.data.favorites.length === 1 && body.data.favorites[0].note === 'Loved this on her last visit', body.data.favorites);

  res = await fetch(`${BASE}/customers/${customerId}/favorites/t-1`, { method: 'DELETE', headers: staffAuthed });
  check('9a. Removing a favorite succeeds', res.status === 200, await res.json());
  res = await fetch(`${BASE}/customers/${customerId}/favorites`, { headers: staffAuthed });
  body = await res.json();
  check('9b. The favorite is genuinely gone from the list', body.data.favorites.length === 0, body.data.favorites);

  console.log('\n--- Delete ---');

  res = await fetch(`${BASE}/customers/${customerId}`, { method: 'DELETE', headers: ownerAuthed });
  check('10a. Delete succeeds', res.status === 200, await res.json());
  res = await fetch(`${BASE}/customers/${customerId}`, { headers: ownerAuthed });
  check('10b. The deleted customer genuinely 404s afterward', res.status === 404, await res.json());

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
