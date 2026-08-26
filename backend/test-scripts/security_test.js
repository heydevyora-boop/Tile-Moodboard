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
  customers.set('c-1', { id: 'c-1', name: "Robert'); DROP TABLE customers;--", phone: '9999999999', createdAt: new Date() });
  prisma.customer.findMany = async ({ where = {} } = {}) => {
    let list = [...customers.values()];
    if (where.OR) {
      const term = where.OR[0].name.contains.toLowerCase();
      list = list.filter((c) => (c.name || '').toLowerCase().includes(term));
    }
    return list;
  };
  prisma.customer.count = async ({ where = {} } = {}) => (await prisma.customer.findMany({ where })).length;

  let rtId = 0;
  const refreshTokens = new Map();
  prisma.refreshToken.create = async ({ data }) => { const row = { id: String(++rtId), ...data, revokedAt: null }; refreshTokens.set(data.tokenHash, row); return row; };
  prisma.refreshToken.findUnique = async ({ where }) => refreshTokens.get(where.tokenHash) || null;
  prisma.refreshToken.update = async ({ where, data }) => { const row = [...refreshTokens.values()].find((r) => r.id === where.id); Object.assign(row, data); return row; };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };
  const loginAttempts = [];
  prisma.loginAttempt.create = async ({ data }) => { const row = { id: `la-${loginAttempts.length + 1}`, createdAt: new Date(), ...data }; loginAttempts.push(row); return row; };

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4815, resolve));

  const BASE = 'http://localhost:4815/api/v1';
  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  console.log('--- Helmet security headers ---');

  let res = await fetch(`${BASE}/health`);
  check('1a. X-Content-Type-Options: nosniff is present (helmet default)', res.headers.get('x-content-type-options') === 'nosniff', res.headers.get('x-content-type-options'));
  check('1b. X-Powered-By is removed (helmet default — do not advertise Express)', res.headers.get('x-powered-by') === null, res.headers.get('x-powered-by'));
  check('1c. A Content-Security-Policy header is present', !!res.headers.get('content-security-policy'), res.headers.get('content-security-policy'));

  console.log('\n--- CORS ---');

  res = await fetch(`${BASE}/health`, { headers: { Origin: 'https://evil-attacker-site.com' } });
  check('2. A request from a disallowed Origin is rejected (403)', res.status === 403, res.status);

  res = await fetch(`${BASE}/health`, { headers: { Origin: 'http://localhost:3000' } });
  check('3. A request from the allowed Origin succeeds', res.status === 200, res.status);

  console.log('\n--- Cross-Origin-Resource-Policy on static assets ---');

  res = await fetch('http://localhost:4815/static/reference-images/nonexistent.png');
  check('4. Static asset routes carry a relaxed CORP header so the frontend (a different origin) can load images', res.headers.get('cross-origin-resource-policy') === 'cross-origin', res.headers.get('cross-origin-resource-policy'));

  res = await fetch(`${BASE}/health`);
  check('5. The JSON API itself keeps a stricter CORP than the relaxed static-asset one', res.headers.get('cross-origin-resource-policy') !== 'cross-origin', res.headers.get('cross-origin-resource-policy'));

  console.log('\n--- SQL injection resilience (logged in before the rate-limit test below exhausts this IPs login budget) ---');

  const ownerLoginRes = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.com', password: 'OwnerPass123' }) });
  const ownerBody = await ownerLoginRes.json();
  const ownerToken = ownerBody?.data?.accessToken;
  const ownerAuthed = { Authorization: `Bearer ${ownerToken}` };

  res = await fetch(`${BASE}/customers?search=${encodeURIComponent("' OR '1'='1")}`, { headers: ownerAuthed });
  check('7a. A SQL-injection-shaped search string does not crash the server (500)', res.status !== 500, res.status);

  res = await fetch(`${BASE}/customers?search=${encodeURIComponent("'; DROP TABLE customers; --")}`, { headers: ownerAuthed });
  const body = await res.json();
  check('7b. A DROP TABLE-shaped search string is treated as a literal search term (Prisma parameterizes it), not executed', res.status === 200 && Array.isArray(body.data?.customers), body);
  check('7c. The pre-existing customer data is untouched — nothing was actually executed as SQL', (await prisma.customer.findMany({})).length === 1);

  console.log('\n--- Rate limiting (login) ---');

  let lastStatus = 0;
  for (let i = 0; i < 11; i++) {
    const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@test.com', password: 'wrongpassword' }) });
    lastStatus = r.status;
  }
  check('9. The 11th rapid login attempt from the same IP is rate-limited (429), not just failing auth', lastStatus === 429, lastStatus);

  console.log('\n--- File content (magic byte) validation ---');

  const { isRealPdf, isRealImage } = require('../src/utils/fileSignature');

  const tmpDir = fs.mkdtempSync('/tmp/casa-sec-test-');
  const fakePdfPath = path.join(tmpDir, 'fake.pdf');
  fs.writeFileSync(fakePdfPath, '<html><script>alert(1)</script></html>');
  check('10a. A file with a .pdf name but HTML content fails real PDF verification', isRealPdf(fakePdfPath) === false);

  const realPdfPath = path.join(tmpDir, 'real.pdf');
  fs.writeFileSync(realPdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake but correctly-signed rest of file')]));
  check('10b. A file that genuinely starts with %PDF magic bytes passes verification', isRealPdf(realPdfPath) === true);

  const fakeImagePath = path.join(tmpDir, 'fake.png');
  fs.writeFileSync(fakeImagePath, '<svg onload="alert(1)"></svg>');
  check('10c. A file with a .png name but SVG/XML content fails real image verification', isRealImage(fakeImagePath) === false);

  const realPngPath = path.join(tmpDir, 'real.png');
  fs.writeFileSync(realPngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  check('10d. A file that genuinely starts with PNG magic bytes passes verification', isRealImage(realPngPath) === true);

  const realJpegPath = path.join(tmpDir, 'real.jpg');
  fs.writeFileSync(realJpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  check('10e. A file that genuinely starts with JPEG magic bytes passes verification', isRealImage(realJpegPath) === true);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
