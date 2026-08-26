const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
    fail++;
  }
}

const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const notificationsSrc = fs.readFileSync(path.join(frontendDir, 'assets', 'notifications.js'), 'utf8');

function loadPage(filename, casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, filename), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `http://localhost/${filename}` });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.confirm = () => true;
  window.alert = () => { throw new Error('alert() was called -- a leftover from before Module 20, should never happen now'); };

  dom.window.eval(notificationsSrc);

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error(`No inline script found in ${filename}`);
  dom.window.eval(scriptMatch[1]);

  return dom;
}

async function main() {
  {
    let shouldFail = false;
    const stub = {
      requireAuth: async () => ({ name: 'Test User', role: { name: 'STAFF' } }),
      referenceImages: {
        list: async () => ({ images: [], meta: {} }),
        categories: async () => ({ styles: [], rooms: [] }),
        remove: async () => { if (shouldFail) throw new Error('Server rejected the delete'); },
      },
    };
    const dom = loadPage('reference-images.html', stub);
    await new Promise((r) => setTimeout(r, 30));

    await dom.window.deleteImage('img-1');
    await new Promise((r) => setTimeout(r, 30));
    let successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
    check('1a. reference-images.html deleteImage() success calls CasaNotify.success (real DOM toast appears)', [...successToasts].some((t) => t.textContent.includes('deleted')), [...successToasts].map((t) => t.textContent));

    shouldFail = true;
    await dom.window.deleteImage('img-2');
    await new Promise((r) => setTimeout(r, 30));
    const errorToasts = dom.window.document.querySelectorAll('.casa-toast-error');
    check('1b. reference-images.html deleteImage() failure calls CasaNotify.error with the real error message', [...errorToasts].some((t) => t.textContent.includes('Server rejected the delete')), [...errorToasts].map((t) => t.textContent));
  }

  {
    const stub = {
      requireAuth: async () => ({ name: 'Test User', role: { name: 'OWNER' } }),
      designRules: {
        list: async () => [],
        preview: async () => ({ content: '', activeRuleCount: 0, lastPublished: null, hasUnpublishedChanges: false }),
        versions: async () => ({ versions: [] }),
        restoreVersion: async () => [],
      },
    };
    const dom = loadPage('design-rules.html', stub);
    await new Promise((r) => setTimeout(r, 30));

    await dom.window.restoreVersion('v-1');
    await new Promise((r) => setTimeout(r, 30));
    const successToasts = dom.window.document.querySelectorAll('.casa-toast-success');
    check('2a. design-rules.html restoreVersion() success calls CasaNotify.success', [...successToasts].some((t) => t.textContent.includes('restored')), [...successToasts].map((t) => t.textContent));

    dom.window.document.getElementById('compareBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const errorToasts = dom.window.document.querySelectorAll('.casa-toast-error');
    check('2b. design-rules.html Compare-with-wrong-selection-count uses CasaNotify.error, not alert()', [...errorToasts].some((t) => t.textContent.includes('exactly 2 versions')), [...errorToasts].map((t) => t.textContent));
  }

  {
    const stub = {
      requireAuth: async () => ({ name: 'Test User', role: { name: 'STAFF' } }),
    };
    const dom = loadPage('00-casa-de-aurum-tool-REFERENCE.html', stub);
    await new Promise((r) => setTimeout(r, 30));

    dom.window.document.getElementById('briefText').value = '';
    dom.window.document.getElementById('genBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const errorToasts = dom.window.document.querySelectorAll('.casa-toast-error');
    check('3. Mood Board Generator empty-brief validation uses CasaNotify.error, not alert()', [...errorToasts].some((t) => t.textContent.includes('client brief')), [...errorToasts].map((t) => t.textContent));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
