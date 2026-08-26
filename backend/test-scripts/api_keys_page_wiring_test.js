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
  let html = fs.readFileSync(path.join(frontendDir, '04-api-keys-integrations.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/04-api-keys-integrations.html' });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.confirm = () => true;
  window.prompt = () => 'AIzaSyD-rotated-value-from-prompt-9999';
  window.alert = () => { throw new Error('alert() should never be called on this page'); };

  dom.window.eval(notificationsSrc);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  dom.window.eval(scriptMatch[1]);
  return dom;
}

async function main() {
  let currentKeys = [{ id: 'ak-1', service: 'GEMINI', label: 'Primary Gemini Key', maskedValue: 'AIza...9fX2', isActive: true, lastRotatedAt: '2026-08-10T10:00:00Z' }];
  let createCalledWith = null;
  let rotateCalledWith = null;
  let deactivateCalledWith = null;
  let deactivateAllCalled = false;

  const stub = {
    requireAuth: async () => ({ name: 'Owner', role: { name: 'OWNER' } }),
    auth: { logout: async () => {} },
    geminiStatus: async () => ({ configured: true, model: 'gemini-2.5-flash', timeoutMs: 30000, maxRetries: 3, retryBaseDelayMs: 500, temperature: 0.7, maxOutputTokens: 2048 }),
    driveStatus: async () => ({ configured: true, rootFolder: 'CasaDeAurum' }),
    apiKeys: {
      list: async () => currentKeys,
      create: async (payload) => {
        createCalledWith = payload;
        currentKeys = [...currentKeys, { id: 'ak-2', ...payload, maskedValue: `${payload.value.slice(0, 4)}...${payload.value.slice(-4)}`, isActive: true, lastRotatedAt: new Date().toISOString() }];
        return currentKeys[currentKeys.length - 1];
      },
      rotate: async (id, value) => {
        rotateCalledWith = { id, value };
        currentKeys = currentKeys.map((k) => (k.id === id ? { ...k, maskedValue: `${value.slice(0, 4)}...${value.slice(-4)}`, lastRotatedAt: new Date().toISOString() } : k));
        return currentKeys.find((k) => k.id === id);
      },
      deactivate: async (id) => {
        deactivateCalledWith = id;
        currentKeys = currentKeys.map((k) => (k.id === id ? { ...k, isActive: false } : k));
        return currentKeys.find((k) => k.id === id);
      },
      activate: async (id) => {
        currentKeys = currentKeys.map((k) => (k.id === id ? { ...k, isActive: true } : k));
        return currentKeys.find((k) => k.id === id);
      },
      remove: async (id) => {
        currentKeys = currentKeys.filter((k) => k.id !== id);
      },
      deactivateAll: async () => {
        deactivateAllCalled = true;
        const count = currentKeys.filter((k) => k.isActive).length;
        currentKeys = currentKeys.map((k) => ({ ...k, isActive: false }));
        return { deactivatedCount: count };
      },
    },
  };

  const dom = loadPage(stub);
  await new Promise((r) => setTimeout(r, 60));

  const rows = dom.window.document.querySelectorAll('#apiKeysBody tr');
  check('1. Real page renders the real key row from CasaApi.apiKeys.list()', rows.length === 1 && rows[0].textContent.includes('Primary Gemini Key') && rows[0].textContent.includes('AIza...9fX2'), rows[0]?.textContent);

  dom.window.document.getElementById('newKeyService').value = 'GEMINI';
  dom.window.document.getElementById('newKeyLabel').value = 'Backup Gemini Key';
  dom.window.document.getElementById('newKeyValue').value = 'AIzaSyD-backup-key-value-abcdef1234';
  dom.window.document.getElementById('saveKeyBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  check('2a. Submitting the Add-a-Key form genuinely calls CasaApi.apiKeys.create with the entered values', createCalledWith && createCalledWith.label === 'Backup Gemini Key' && createCalledWith.value === 'AIzaSyD-backup-key-value-abcdef1234', createCalledWith);
  const rowsAfterCreate = dom.window.document.querySelectorAll('#apiKeysBody tr');
  check('2b. The table re-renders to show the newly created key', rowsAfterCreate.length === 2 && [...rowsAfterCreate].some((r) => r.textContent.includes('Backup Gemini Key')), rowsAfterCreate.length);
  const successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
  check('2c. A real success toast appears after saving', [...successToasts].some((t) => t.textContent.includes('saved')), [...successToasts].map((t) => t.textContent));

  const rotateLink = dom.window.document.querySelector('.rotate-key');
  rotateLink.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('3. Clicking Rotate genuinely calls CasaApi.apiKeys.rotate with the prompted value', rotateCalledWith && rotateCalledWith.id === 'ak-1' && rotateCalledWith.value === 'AIzaSyD-rotated-value-from-prompt-9999', rotateCalledWith);

  const deactivateLink = dom.window.document.querySelector('.toggle-key[data-action="deactivate"]');
  deactivateLink.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('4a. Clicking Deactivate genuinely calls CasaApi.apiKeys.deactivate', deactivateCalledWith === 'ak-1', deactivateCalledWith);
  const rowsAfterDeactivate = dom.window.document.querySelectorAll('#apiKeysBody tr');
  check('4b. The row now shows Inactive status and an Activate action', [...rowsAfterDeactivate].some((r) => r.textContent.includes('Inactive') && r.textContent.includes('Activate')), [...rowsAfterDeactivate].map((r) => r.textContent));

  const disconnectAllBtn = dom.window.document.getElementById('disconnectAllBtn');
  check('5a. A real Disconnect all button exists (Danger Zone is no longer "Preview only")', !!disconnectAllBtn);
  if (disconnectAllBtn) {
    disconnectAllBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('5b. Clicking it genuinely calls CasaApi.apiKeys.deactivateAll()', deactivateAllCalled === true);
  } else {
    fail += 1;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
