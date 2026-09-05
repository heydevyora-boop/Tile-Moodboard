// Rewritten for the frontend/v2 swap: 03-user-staff-management.html ->
// admin-users.html. Significant behavior change, not just a rename: the
// old page had a live, per-permission checkbox matrix editor that called
// CasaApi.roles.update() on every toggle. The v2 rebuild replaced that
// with (a) a static "at a glance" reference matrix (MATRIX_ROWS, hardcoded
// — no API call, nothing to click) and (b) real user management (list/
// create/update/remove/assignRole via CasaApi.users.*) with role
// reassignment done through editUser()'s prompt() flow rather than
// checkboxes. This test now covers what's actually there; the old
// checkbox-toggle behavior has no equivalent to test until/unless that
// editor is rebuilt.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   ${label}`); pass++; }
  else { console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); fail++; }
}

const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const notificationsSrc = fs.readFileSync(path.join(frontendDir, 'assets', 'notifications.js'), 'utf8');
const shellSrc = fs.readFileSync(path.join(frontendDir, 'assets', 'shell.js'), 'utf8');

function loadPage(casaApiStub, windowStubs) {
  let html = fs.readFileSync(path.join(frontendDir, 'admin-users.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin-users.html' });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.alert = () => { throw new Error('alert() should never be called on this page'); };
  Object.assign(window, windowStubs);

  dom.window.eval(notificationsSrc);
  dom.window.eval(shellSrc);
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

const SAMPLE_ROLES = [
  { id: 'role-owner', name: 'OWNER', description: 'Full access', permissions: ['*'] },
  { id: 'role-admin', name: 'ADMIN', description: 'Manager', permissions: ['customers:read', 'customers:write', 'catalogs:read', 'catalogs:write'] },
  { id: 'role-staff', name: 'STAFF', description: 'Sales staff', permissions: ['customers:read'] },
];

const SAMPLE_USERS = [
  { id: 'u-owner', name: 'Store Owner', email: 'owner@casadeaurum.com', role: { name: 'OWNER' }, isActive: true, createdAt: '2026-01-10T00:00:00Z' },
  { id: 'u-admin', name: 'Shop Admin', email: 'admin@casadeaurum.com', role: { name: 'ADMIN' }, isActive: true, createdAt: '2026-02-10T00:00:00Z' },
  { id: 'u-staff', name: 'Priya D.', email: 'priya@casadeaurum.com', role: { name: 'STAFF' }, isActive: false, createdAt: '2026-03-10T00:00:00Z' },
];

function baseStub(role) {
  let users = SAMPLE_USERS.map((u) => ({ ...u }));
  const calls = { create: null, update: null, remove: null, assignRole: null, listSearch: undefined };
  const stub = {
    requireAuth: async () => ({ name: role === 'OWNER' ? 'Store Owner' : role === 'ADMIN' ? 'Shop Admin' : 'Staff Member', role }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    roles: { list: async () => SAMPLE_ROLES },
    users: {
      list: async (params) => { calls.listSearch = params?.search; return { users, meta: { total: users.length } }; },
      create: async (payload) => { calls.create = payload; users = [...users, { id: 'u-new', name: payload.name, email: payload.email, role: SAMPLE_ROLES.find((r) => r.id === payload.roleId), isActive: true, createdAt: new Date().toISOString() }]; },
      update: async (id, payload) => { calls.update = { id, payload }; users = users.map((u) => (u.id === id ? { ...u, ...payload } : u)); },
      remove: async (id) => { calls.remove = id; users = users.filter((u) => u.id !== id); },
      assignRole: async (id, roleId) => { calls.assignRole = { id, roleId }; },
    },
  };
  return { stub, calls, get users() { return users; } };
}

async function main() {
  const owner = baseStub('OWNER');
  const dom = loadPage(owner.stub);
  await new Promise((r) => setTimeout(r, 60));

  // Static reference matrix — not interactive, but should render real content.
  const matrixRows = dom.window.document.querySelectorAll('#matrixBody tr');
  check('1. The at-a-glance permission matrix renders its reference rows', matrixRows.length >= 4, matrixRows.length);
  check('2. A row for a tool Staff genuinely has access to shows "on" in the Staff column', [...matrixRows].some((r) => r.textContent.includes('Mood Board Generator') && r.querySelector('td:nth-child(4) .check.on')), [...matrixRows].map((r) => r.textContent.trim().slice(0, 40)));
  check('3. A row for a tool Staff does NOT have shows off in the Staff column', [...matrixRows].some((r) => r.textContent.includes('API Keys') && !r.querySelector('td:nth-child(4) .check.on')));

  // Real staff table, from CasaApi.users.list() — not hardcoded.
  const staffRows = dom.window.document.querySelectorAll('#staffTbody tr');
  check('4. The staff table renders real rows from CasaApi.users.list()', staffRows.length === 3 && [...staffRows].some((r) => r.textContent.includes('priya@casadeaurum.com')), [...staffRows].map((r) => r.textContent));
  check('5. A suspended user shows the real Suspended status', [...staffRows].some((r) => r.textContent.includes('Priya D.') && r.textContent.includes('Suspended')));
  const ownerRow = [...staffRows].find((r) => r.textContent.includes('Store Owner'));
  check('6. The Owner row has no Remove action (only Edit)', ownerRow && !ownerRow.querySelector('[data-action="remove"]') && !!ownerRow.querySelector('[data-action="edit"]'));

  // Real search, debounced then calling users.list with the query.
  dom.window.document.getElementById('searchBox').value = 'priya';
  dom.window.document.getElementById('searchBox').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  check('7. Typing in the search box genuinely re-fetches with the real search term', owner.calls.listSearch === 'priya', owner.calls.listSearch);

  // Real create-user form.
  dom.window.document.getElementById('newName').value = 'Kavita Rao';
  dom.window.document.getElementById('newEmail').value = 'kavita@casadeaurum.com';
  dom.window.document.getElementById('newPassword').value = 'TempPass123!';
  dom.window.document.getElementById('newRole').value = 'role-staff';
  dom.window.document.getElementById('createBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('8. Submitting Add Staff genuinely calls CasaApi.users.create with the real form values', owner.calls.create && owner.calls.create.name === 'Kavita Rao' && owner.calls.create.email === 'kavita@casadeaurum.com' && owner.calls.create.roleId === 'role-staff', owner.calls.create);

  // Empty-form validation shows the real inline error, not alert().
  const emptyOwner = baseStub('OWNER');
  const emptyDom = loadPage(emptyOwner.stub);
  await new Promise((r) => setTimeout(r, 60));
  emptyDom.window.document.getElementById('createBtn').dispatchEvent(new emptyDom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check('9. Submitting the empty form shows a real inline error, not alert()', emptyDom.window.document.getElementById('createError').style.display === 'block' && !emptyOwner.calls.create);

  // Edit flow: prompt()-driven name/email/active update, then a role
  // reassignment prompt for non-Owner rows only.
  const editOwner = baseStub('OWNER');
  const prompts = [];
  const editDom = loadPage(editOwner.stub, {
    prompt: (msg, def) => { prompts.push(msg); if (/Full name/.test(msg)) return 'Priya Deshmukh'; if (/^Email/.test(msg)) return 'priya@casadeaurum.com'; if (/Role id/.test(msg)) return 'role-admin'; return def ?? null; },
    confirm: () => true,
  });
  await new Promise((r) => setTimeout(r, 60));
  const staffEditLink = [...editDom.window.document.querySelectorAll('#staffTbody tr')].find((r) => r.textContent.includes('Priya D.')).querySelector('[data-action="edit"]');
  staffEditLink.dispatchEvent(new editDom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('10a. Editing a non-Owner user genuinely calls CasaApi.users.update with the prompted values', editOwner.calls.update && editOwner.calls.update.id === 'u-staff' && editOwner.calls.update.payload.name === 'Priya Deshmukh', editOwner.calls.update);
  check('10b. Editing a non-Owner user also offers a role reassignment prompt', prompts.some((p) => /Role id/.test(p)), prompts);
  check('10c. Choosing a new role id genuinely calls CasaApi.users.assignRole', editOwner.calls.assignRole && editOwner.calls.assignRole.id === 'u-staff' && editOwner.calls.assignRole.roleId === 'role-admin', editOwner.calls.assignRole);

  // Editing the Owner never offers a role-change prompt (can't demote the
  // only Owner from this flow).
  const editOwner2 = baseStub('OWNER');
  const prompts2 = [];
  const editDom2 = loadPage(editOwner2.stub, {
    prompt: (msg, def) => { prompts2.push(msg); if (/Full name/.test(msg)) return 'Store Owner'; if (/^Email/.test(msg)) return 'owner@casadeaurum.com'; return def ?? null; },
    confirm: () => true,
  });
  await new Promise((r) => setTimeout(r, 60));
  const ownerEditLink = [...editDom2.window.document.querySelectorAll('#staffTbody tr')].find((r) => r.textContent.includes('Store Owner')).querySelector('[data-action="edit"]');
  ownerEditLink.dispatchEvent(new editDom2.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('11. Editing the Owner never offers a role-change prompt', !prompts2.some((p) => /Role id/.test(p)), prompts2);

  // Remove flow.
  const removeOwner = baseStub('OWNER');
  const removeDom = loadPage(removeOwner.stub, { confirm: () => true });
  await new Promise((r) => setTimeout(r, 60));
  const removeLink = [...removeDom.window.document.querySelectorAll('#staffTbody tr')].find((r) => r.textContent.includes('Priya D.')).querySelector('[data-action="remove"]');
  removeLink.dispatchEvent(new removeDom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('12. Clicking Remove genuinely calls CasaApi.users.remove with the real user id', removeOwner.calls.remove === 'u-staff', removeOwner.calls.remove);

  // Admin (not Owner) can still fully use this page — Users & Staff isn't
  // OWNER-gated the way API Keys/Logs/Analytics are.
  const admin = baseStub('ADMIN');
  const adminDom = loadPage(admin.stub);
  await new Promise((r) => setTimeout(r, 60));
  check('13. Admin (non-Owner) sees the real staff table too, not a restricted screen', adminDom.window.document.querySelectorAll('#staffTbody tr').length === 3);

  // Staff never reaches this page's own script — blocked by CasaShell's
  // allowedRoles gate first.
  const staff = baseStub('STAFF');
  const staffDom = loadPage(staff.stub);
  await new Promise((r) => setTimeout(r, 60));
  check("14. Staff is blocked by the shell's allowedRoles gate", staffDom.window.document.body.textContent.includes("don't have access"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
