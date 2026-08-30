// Rewritten for the frontend/v2 swap: 07-application-settings.html ->
// settings.html, wrapped in shell.js. Real role is a plain string now,
// not { name: ... }. Markup/IDs and disableIfNotOwner()/restrictedBanner
// logic are otherwise unchanged from the original.
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

function loadPage(casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, 'settings.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/settings.html' });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.alert = () => { throw new Error('alert() should never be called on this page'); };

  dom.window.eval(notificationsSrc);
  dom.window.eval(shellSrc);
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

const DEFAULT_SETTINGS = {
  company: { name: 'Casa de Aurum', address: '', phone: '', email: '', taxId: '', website: '' },
  print: { defaultDpi: 300, defaultFormat: 'CASSETTE_PANEL', defaultFileFormat: 'PDF', defaultUnit: 'FT' },
  rules: { defaultMinTiles: 3, defaultMaxCombinations: 4, defaultRoomType: '', defaultStyleTag: '' },
  general: { timezone: 'Asia/Kolkata', currency: 'INR', dateFormat: 'DD/MM/YYYY', sessionTimeoutMinutes: 60 },
};

async function main() {
  let updateCalledWith = null;

  const stub = {
    requireAuth: async () => ({ name: 'Store Owner', role: 'OWNER' }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    settings: {
      getAll: async () => DEFAULT_SETTINGS,
      updateCategory: async (category, payload) => { updateCalledWith = { category, payload }; return payload; },
    },
  };

  const dom = loadPage(stub);
  await new Promise((r) => setTimeout(r, 60));

  check('1. Company name field is populated with the real fetched default', dom.window.document.getElementById('companyName').value === 'Casa de Aurum');
  check('2. Print DPI field is populated from real settings data', dom.window.document.getElementById('printDpi').value === '300');
  check('3. Default Rules min-tiles field is populated from real settings data', dom.window.document.getElementById('rulesMinTiles').value === '3');
  check('4. General currency field is populated from real settings data', dom.window.document.getElementById('generalCurrency').value === 'INR');

  dom.window.document.getElementById('printDpi').value = '600';
  dom.window.document.getElementById('printFormat').value = 'ACP_SIGNBOARD';
  dom.window.document.getElementById('savePrintBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  check('5a. Saving Print Settings genuinely calls CasaApi.settings.updateCategory("print", ...)', updateCalledWith && updateCalledWith.category === 'print', updateCalledWith);
  check('5b. The payload reflects the EDITED value (600), not the original default (300)', updateCalledWith && updateCalledWith.payload.defaultDpi === 600, updateCalledWith);
  check('5c. The payload reflects the edited format too', updateCalledWith && updateCalledWith.payload.defaultFormat === 'ACP_SIGNBOARD', updateCalledWith);
  const successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
  check('5d. A real success toast appears after saving', [...successToasts].some((t) => t.textContent.includes('saved')), [...successToasts].map((t) => t.textContent));

  updateCalledWith = null;
  const staffStub = { ...stub, requireAuth: async () => ({ name: 'Staff Member', role: 'STAFF' }) };
  const staffDom = loadPage(staffStub);
  await new Promise((r) => setTimeout(r, 60));

  check('6a. Non-owner sees the restricted banner', staffDom.window.document.getElementById('restrictedBanner').style.display === 'block');
  check('6b. Non-owner still sees the real loaded values (read-only)', staffDom.window.document.getElementById('companyName').value === 'Casa de Aurum');
  check('6c. Save buttons are disabled for non-owners', staffDom.window.document.getElementById('saveCompanyBtn').disabled === true);
  check('6d. Input fields are disabled for non-owners', staffDom.window.document.getElementById('printDpi').disabled === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
