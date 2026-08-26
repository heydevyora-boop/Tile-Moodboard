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

function loadPage(casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, '03-user-staff-management.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/03-user-staff-management.html' });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.alert = () => { throw new Error('alert() should never be called on this page'); };

  dom.window.eval(notificationsSrc);
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  const scriptBody = html.slice(start + '<script>'.length, end);
  dom.window.eval(scriptBody);
  return dom;
}

const SAMPLE_ROLES = [
  { id: 'role-owner', name: 'OWNER', description: 'Full access', permissions: ['*'] },
  { id: 'role-admin', name: 'ADMIN', description: 'Manager', permissions: ['customers:read', 'customers:write', 'catalogs:read', 'catalogs:write'] },
  { id: 'role-staff', name: 'STAFF', description: 'Sales staff', permissions: ['customers:read'] },
];

async function main() {
  let updateCalledWith = null;

  const baseStub = {
    requireAuth: async () => ({ name: 'Store Owner', role: { name: 'OWNER' } }),
    auth: { logout: async () => {} },
    users: { list: async () => ({ users: [], meta: { total: 0 } }) },
    roles: {
      list: async () => SAMPLE_ROLES,
      update: async (id, payload) => { updateCalledWith = { id, payload }; const role = SAMPLE_ROLES.find((r) => r.id === id); role.permissions = payload.permissions; return role; },
    },
  };

  const dom = loadPage(baseStub);
  await new Promise((r) => setTimeout(r, 60));

  const rows = dom.window.document.querySelectorAll('#matrixBody tr');
  check('1. The matrix renders real rows from CasaApi.roles.list(), not hardcoded mockup rows', rows.length >= 10, rows.length);
  check('2. A row for a resource the Manager role genuinely has access to shows "on"', [...rows].some((r) => r.textContent.includes('Catalog Extractor') && r.querySelector('td:nth-child(3) .check.on')), [...rows].map((r) => r.textContent.trim().slice(0, 30)));
  check('3. A row for a resource the Manager role does NOT have shows off', [...rows].some((r) => r.textContent.includes('Design Rules Setup') && !r.querySelector('td:nth-child(3) .check.on')));

  const ownerOnlyRow = [...rows].find((r) => r.textContent.includes('API Keys'));
  check('4. Owner-only rows (hard-coded authorize(OWNER) in the backend) show locked checks for Manager/Staff, not fake toggleable ones', ownerOnlyRow && ownerOnlyRow.querySelectorAll('.check.locked').length === 3, ownerOnlyRow?.innerHTML);

  const designRulesAdminCheck = [...dom.window.document.querySelectorAll('[data-role-id="role-admin"]')].find((el) => el.dataset.perms.includes('design_rules'));
  check('5. A togglable checkbox exists for a real editable permission pair', !!designRulesAdminCheck);

  if (designRulesAdminCheck) {
    designRulesAdminCheck.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('6a. Clicking a checkbox genuinely calls CasaApi.roles.update with the real role id', updateCalledWith?.id === 'role-admin', updateCalledWith);
    check('6b. The new permissions array includes the newly-granted permission', updateCalledWith?.payload.permissions.includes('design_rules:read') && updateCalledWith?.payload.permissions.includes('design_rules:write'), updateCalledWith?.payload);
    check("6c. The new permissions array still includes the role's pre-existing permissions (additive, not replaced)", updateCalledWith?.payload.permissions.includes('customers:read'), updateCalledWith?.payload);
  } else {
    fail += 3;
  }

  updateCalledWith = null;
  const customersAdminCheck = [...dom.window.document.querySelectorAll('[data-role-id="role-admin"]')].find((el) => el.dataset.perms === 'customers:read,customers:write');
  if (customersAdminCheck) {
    customersAdminCheck.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('7. Toggling an already-on permission off genuinely removes it from the saved array', updateCalledWith && !updateCalledWith.payload.permissions.includes('customers:write'), updateCalledWith?.payload);
  } else {
    fail += 1;
  }

  const staffDom = loadPage({ ...baseStub, requireAuth: async () => ({ name: 'Staff Member', role: { name: 'STAFF' } }) });
  await new Promise((r) => setTimeout(r, 60));
  let staffUpdateCalled = false;
  staffDom.window.CasaApi.roles.update = async () => { staffUpdateCalled = true; };
  const staffCheck = staffDom.window.document.querySelector('[data-role-id="role-admin"]');
  if (staffCheck) {
    staffCheck.dispatchEvent(new staffDom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  }
  check('8. Non-owners cannot trigger a permissions update at all — the click handler is never attached for them', staffUpdateCalled === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
