// Rewritten for the frontend/v2 swap: the old reference-images.html /
// design-rules.html / 00-casa-de-aurum-tool-REFERENCE.html no longer exist.
// Case 1 now targets reference-image-library.html (delete-image toasts).
// Case 2 now targets version-history.html (restore/delete-version toasts).
// The old case 3 (empty-brief validation on the removed single-page tool)
// has no equivalent in the new multi-step moodboard-wizard.html (which has
// no blocking brief validation), so it is replaced with a shell allowedRoles
// gate check instead of forcing a bad mapping.
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

function loadPage(filename, casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, filename), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `http://localhost/${filename}` });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.confirm = () => true;
  window.alert = () => { throw new Error('alert() was called -- notifications should be used instead'); };

  dom.window.eval(notificationsSrc);
  dom.window.eval(shellSrc);
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

async function main() {
  // Case 1: reference-image-library.html — delete-image success/failure toasts.
  {
    let shouldFail = false;
    const SAMPLE_IMAGE = { id: 'img-1', styleTag: 'luxury_bathroom_02', style: 'LUXURY', room: 'BATHROOM', description: '', imageUrl: '/uploads/img-1.jpg' };
    const stub = {
      requireAuth: async () => ({ name: 'Priya D.', role: 'ADMIN' }),
      initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
      auth: { logout: async () => {} },
      geminiStatus: async () => ({ configured: true, model: 'gemini-2.5-flash' }),
      driveStatus: async () => ({ configured: true, rootFolder: 'CasaDeAurum' }),
      referenceImages: {
        list: async () => ({ images: [SAMPLE_IMAGE], meta: { total: 1 } }),
        categories: async () => ({ styles: ['LUXURY'], rooms: ['BATHROOM'] }),
        remove: async () => { if (shouldFail) throw new Error('Server rejected the delete'); },
      },
    };
    const dom = loadPage('reference-image-library.html', stub);
    await new Promise((r) => setTimeout(r, 60));

    const deleteBtn1 = dom.window.document.querySelector('[data-action="delete"]');
    check('1a. reference-image-library.html renders a real Delete button for the real image', !!deleteBtn1, deleteBtn1);
    if (deleteBtn1) {
      deleteBtn1.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
      check('1b. Deleting an image (success) calls CasaApi.referenceImages.remove() and shows the real success toast', [...successToasts].some((t) => t.textContent.includes('Reference image deleted.')), [...successToasts].map((t) => t.textContent));
    } else {
      fail++;
    }

    shouldFail = true;
    const deleteBtn2 = dom.window.document.querySelector('[data-action="delete"]');
    if (deleteBtn2) {
      deleteBtn2.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const errorToasts = dom.window.document.querySelectorAll('.casa-toast-error');
      check('1c. Deleting an image (server failure) shows the real error toast with the real server message', [...errorToasts].some((t) => t.textContent.includes('Server rejected the delete')), [...errorToasts].map((t) => t.textContent));
    } else {
      fail++;
    }
  }

  // Case 2: version-history.html — restore/delete-version toasts.
  {
    let shouldFailRestore = false;
    const SAMPLE_VERSIONS = [
      { id: 'v-2', versionNumber: 2, createdAt: '2026-08-20T10:00:00Z', createdBy: { name: 'Priya D.' }, changeSummary: 'Added quartz surcharge rule' },
      { id: 'v-1', versionNumber: 1, createdAt: '2026-08-10T10:00:00Z', createdBy: { name: 'Store Owner' }, changeSummary: 'Initial publish' },
    ];
    let restoreCalledWith = null;
    let removeCalledWith = null;
    const stub = {
      requireAuth: async () => ({ name: 'Store Owner', role: 'OWNER' }),
      initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
      auth: { logout: async () => {} },
      geminiStatus: async () => ({ configured: true, model: 'gemini-2.5-flash' }),
      driveStatus: async () => ({ configured: true, rootFolder: 'CasaDeAurum' }),
      designRules: {
        versions: async () => ({ versions: SAMPLE_VERSIONS }),
        // v-1 is the live-published one, so the auto-selected v-2 (list head) is restorable/deletable.
        preview: async () => ({ lastPublished: { id: 'v-1' } }),
        getVersion: async (id) => ({ content: `content for ${id}` }),
        compareVersions: async () => ({ diff: [] }),
        restoreVersion: async (id) => { restoreCalledWith = id; if (shouldFailRestore) throw new Error('Draft is locked by another edit'); },
        removeVersion: async (id) => { removeCalledWith = id; },
      },
    };
    const dom = loadPage('version-history.html', stub);
    await new Promise((r) => setTimeout(r, 60));

    const restoreBtn = dom.window.document.getElementById('restoreBtn');
    check('2a. version-history.html auto-selects the newest (non-current) version and shows Restore', restoreBtn && restoreBtn.style.display !== 'none', restoreBtn && restoreBtn.style.display);

    restoreBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
    check('2b. Restore (success) calls CasaApi.designRules.restoreVersion() with the real selected id and shows the real toast', restoreCalledWith === 'v-2' && [...successToasts].some((t) => t.textContent.includes('Draft restored from that version')), { restoreCalledWith, toasts: [...successToasts].map((t) => t.textContent) });

    shouldFailRestore = true;
    restoreBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const errorToasts = dom.window.document.querySelectorAll('.casa-toast-error');
    check('2c. Restore (server failure) shows the real error toast with the real server message', [...errorToasts].some((t) => t.textContent.includes('Draft is locked by another edit')), [...errorToasts].map((t) => t.textContent));

    const deleteVersionBtn = dom.window.document.getElementById('deleteVersionBtn');
    deleteVersionBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const deleteToasts = dom.window.document.querySelectorAll('.casa-toast-success');
    check('2d. Delete version calls CasaApi.designRules.removeVersion() with the real selected id and shows the real toast', removeCalledWith === 'v-2' && [...deleteToasts].some((t) => t.textContent.includes('Version deleted.')), { removeCalledWith, toasts: [...deleteToasts].map((t) => t.textContent) });
  }

  // Case 3: Staff is blocked by the shell's allowedRoles gate on these
  // ADMIN/OWNER-only pages (replaces the dropped empty-brief case, which
  // has no equivalent left in the new moodboard-wizard.html).
  {
    const stub = {
      requireAuth: async () => ({ name: 'Staff Member', role: 'STAFF' }),
      initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
      auth: { logout: async () => {} },
    };
    const dom = loadPage('version-history.html', stub);
    await new Promise((r) => setTimeout(r, 60));
    check("3. Staff is blocked by the shell's allowedRoles gate on version-history.html", dom.window.document.body.textContent.includes("don't have access"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
