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

async function main() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'assets', 'notifications.js'), 'utf8');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;

  window.requestAnimationFrame = (cb) => cb();

  dom.window.eval(src);
  const CasaNotify = window.CasaNotify;

  check('1. CasaNotify is exposed on window after loading the script', typeof CasaNotify === 'object' && CasaNotify !== null);
  check('2. All four required methods exist', typeof CasaNotify.success === 'function' && typeof CasaNotify.error === 'function' && typeof CasaNotify.processing === 'function' && typeof CasaNotify.exportReady === 'function');

  CasaNotify.success('Rule saved successfully');
  let toasts = window.document.querySelectorAll('.casa-toast');
  check('3a. success() creates exactly one toast', toasts.length === 1, toasts.length);
  check('3b. Toast has the success styling class', toasts[0].classList.contains('casa-toast-success'), toasts[0].className);
  check('3c. Toast contains the message text', toasts[0].textContent.includes('Rule saved successfully'), toasts[0].textContent);

  CasaNotify.error('Could not delete tile: it is used in an approved mood board');
  toasts = window.document.querySelectorAll('.casa-toast');
  check('4a. error() adds a second toast (stacked, not replacing)', toasts.length === 2, toasts.length);
  const errorToast = [...toasts].find((t) => t.classList.contains('casa-toast-error'));
  check('4b. Error toast has the error styling class', !!errorToast, toasts);
  check('4c. Error toast contains the message', errorToast.textContent.includes('Could not delete tile'), errorToast.textContent);

  const handle = CasaNotify.processing('Generating combinations...');
  toasts = window.document.querySelectorAll('.casa-toast');
  check('5a. processing() adds a toast with a spinner (no icon)', window.document.querySelectorAll('.casa-toast-spinner').length === 1);
  check('5b. Processing toast contains the initial message', [...toasts].some((t) => t.textContent.includes('Generating combinations')));

  handle.update('Reading design rules...');
  const processingToast = [...window.document.querySelectorAll('.casa-toast-processing')][0];
  check('6. handle.update() changes the toast text in place (same toast, new content)', processingToast.textContent.includes('Reading design rules'), processingToast.textContent);

  handle.success('4 combinations ready');
  await new Promise((r) => setTimeout(r, 250));
  const remainingProcessing = window.document.querySelectorAll('.casa-toast-processing');
  check('7a. handle.success() removes the processing toast', remainingProcessing.length === 0, remainingProcessing.length);
  const successToasts = [...window.document.querySelectorAll('.casa-toast-success')];
  check('7b. handle.success() adds a new success toast with the final message', successToasts.some((t) => t.textContent.includes('4 combinations ready')), successToasts.map((t) => t.textContent));

  const handle2 = CasaNotify.processing('Uploading to Google Drive...');
  handle2.error('Drive upload failed: rate limit exceeded');
  await new Promise((r) => setTimeout(r, 250));
  const errorToasts = [...window.document.querySelectorAll('.casa-toast-error')];
  check('8. handle.error() resolves a processing toast into an error toast', errorToasts.some((t) => t.textContent.includes('Drive upload failed')), errorToasts.map((t) => t.textContent));

  handle.success('should be ignored -- already resolved');
  const successCount = window.document.querySelectorAll('.casa-toast-success').length;
  handle.error('also should be ignored');
  const successCountAfter = window.document.querySelectorAll('.casa-toast-success').length;
  check('9. An already-resolved handle ignores further success()/error() calls (no duplicate toasts)', successCountAfter === successCount, { before: successCount, after: successCountAfter });

  CasaNotify.exportReady('Print board ready', { url: 'https://drive.google.com/file/d/abc/view', label: 'Open in Drive' });
  const exportToasts = [...window.document.querySelectorAll('.casa-toast')].filter((t) => t.textContent.includes('Print board ready'));
  check('10a. exportReady() creates a toast with the message', exportToasts.length === 1, exportToasts.length);
  const actionLink = exportToasts[0].querySelector('.casa-toast-action');
  check('10b. exportReady() includes a clickable action link', !!actionLink, exportToasts[0].outerHTML);
  check('10c. Action link points at the correct URL', actionLink.getAttribute('href') === 'https://drive.google.com/file/d/abc/view', actionLink.getAttribute('href'));
  check('10d. Action link uses the custom label', actionLink.textContent === 'Open in Drive', actionLink.textContent);
  check('10e. Action link opens in a new tab (does not navigate away from the tool)', actionLink.getAttribute('target') === '_blank', actionLink.getAttribute('target'));

  CasaNotify.exportReady('Saved locally only');
  const noUrlToasts = [...window.document.querySelectorAll('.casa-toast')].filter((t) => t.textContent.includes('Saved locally only'));
  check('11. exportReady() without a url still works and has no action link', noUrlToasts.length === 1 && !noUrlToasts[0].querySelector('.casa-toast-action'), noUrlToasts[0] ? noUrlToasts[0].outerHTML : null);

  CasaNotify.error('Dismiss me manually');
  const target = [...window.document.querySelectorAll('.casa-toast')].find((t) => t.textContent.includes('Dismiss me manually'));
  const closeBtn = target.querySelector('.casa-toast-close');
  check('12a. Every toast has a manual close button', !!closeBtn);
  closeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const stillThere = [...window.document.querySelectorAll('.casa-toast')].some((t) => t.textContent.includes('Dismiss me manually'));
  check('12b. Clicking close actually removes the toast from the DOM', !stillThere);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
