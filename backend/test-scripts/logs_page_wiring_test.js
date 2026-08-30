// Rewritten for the frontend/v2 swap: 05-system-logs-monitoring.html ->
// admin-logs.html, wrapped in shell.js. Filter/log-type chips now share one
// class (.casa-chip, disambiguated by data-filter vs data-logtype) instead
// of the old .fchip. Real role is a plain string now, not { name: ... }.
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
  let html = fs.readFileSync(path.join(frontendDir, 'admin-logs.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin-logs.html' });
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

const SAMPLE_LOGS = [
  { id: 'log-1', action: 'api_key.rotated', entityType: 'ApiKey', entityId: 'ak-1', createdAt: '2026-08-11T10:00:00Z', user: { id: 'u-1', name: 'Store Owner' } },
  { id: 'log-2', action: 'mood_board.approved', entityType: 'MoodBoard', entityId: 'mb-9', createdAt: '2026-08-11T09:00:00Z', user: { id: 'u-2', name: 'Priya D.' } },
];
const SAMPLE_ACTIONS = ['api_key.rotated', 'api_key.created', 'mood_board.approved', 'mood_board.generated', 'print_board.exported'];
const SAMPLE_LOGIN_ATTEMPTS = [
  { id: 'la-1', email: 'staff@test.com', success: true, failureReason: null, ipAddress: '10.0.0.5', createdAt: '2026-08-11T08:00:00Z', user: { id: 'u-2', name: 'Priya D.' } },
  { id: 'la-2', email: 'unknown@test.com', success: false, failureReason: 'user_not_found', ipAddress: '10.0.0.9', createdAt: '2026-08-11T07:00:00Z', user: null },
];
const SAMPLE_ERROR_LOGS = [
  { id: 'el-1', message: 'Gemini API key is not configured', statusCode: 500, path: '/api/v1/mood-boards/generate', method: 'POST', createdAt: '2026-08-11T06:00:00Z' },
];
const SAMPLE_CATALOG_LOGS = [
  { id: 'cat-1', fileName: 'somany_catalog.pdf', status: 'COMPLETED', tilesExtracted: 42, errorMessage: null, createdAt: '2026-08-11T05:00:00Z' },
];
const SAMPLE_QUEUE_STATS = {
  catalog: { queueDepth: 1, runningCount: 0, counts: { PENDING: 1, PROCESSING: 0, COMPLETED: 12, FAILED: 0 } },
  imageProcessing: { PENDING: 0, PROCESSING: 0, COMPLETED: 8, FAILED: 1 },
  export: { PENDING: 0, PROCESSING: 1, COMPLETED: 5, FAILED: 0 },
};
const SAMPLE_FAILED_IMAGE_JOB = { id: 'job-fail-1', type: 'IMAGE_PROCESSING', status: 'FAILED', error: 'ENOENT: source file missing', attempts: 3, maxAttempts: 3 };

function baseStub(role) {
  let logsCalledWith = null;
  let retryCalledWith = null;
  const stub = {
    requireAuth: async () => ({ name: role === 'OWNER' ? 'Store Owner' : role === 'ADMIN' ? 'Shop Admin' : 'Staff Member', role }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    geminiStatus: async () => ({ configured: true, model: 'gemini-2.5-flash' }),
    driveStatus: async () => ({ configured: true, rootFolder: 'CasaDeAurum' }),
    admin: {
      logs: async (params) => { logsCalledWith = params; return { logs: params.entityType === 'mood_board' ? SAMPLE_LOGS.filter((l) => l.entityType === 'MoodBoard') : SAMPLE_LOGS, meta: { total: 2 } }; },
      logActions: async () => SAMPLE_ACTIONS,
      loginHistory: async () => ({ attempts: SAMPLE_LOGIN_ATTEMPTS, meta: { total: 2 } }),
      errorLogs: async () => ({ errors: SAMPLE_ERROR_LOGS, meta: { total: 1 } }),
      catalogLogs: async () => ({ catalogs: SAMPLE_CATALOG_LOGS, meta: { total: 1 } }),
      moodBoardLogs: async () => ({ logs: [], meta: { total: 0 } }),
      printBoardLogs: async () => ({ logs: [], meta: { total: 0 } }),
      queueStats: async () => SAMPLE_QUEUE_STATS,
      queueJobs: async (params) => ({ jobs: params.type === 'IMAGE_PROCESSING' ? [SAMPLE_FAILED_IMAGE_JOB] : [], meta: { total: params.type === 'IMAGE_PROCESSING' ? 1 : 0 } }),
      retryJob: async (id) => { retryCalledWith = id; return { id, status: 'PENDING' }; },
    },
  };
  return { stub, get logsCalledWith() { return logsCalledWith; }, get retryCalledWith() { return retryCalledWith; } };
}

async function main() {
  const owner = baseStub('OWNER');
  const dom = loadPage(owner.stub);
  await new Promise((r) => setTimeout(r, 60));

  const rows = dom.window.document.querySelectorAll('#logTableBody tr');
  check('1. Real page renders real rows from CasaApi.admin.logs()', rows.length === 2 && [...rows].some((r) => r.textContent.includes('api_key.rotated')) && [...rows].some((r) => r.textContent.includes('Store Owner')), [...rows].map((r) => r.textContent));

  const filterChips = dom.window.document.querySelectorAll('#filterRow .casa-chip');
  check('2. Filter chips are built dynamically from CasaApi.admin.logActions() entity-type prefixes', filterChips.length > 1, [...filterChips].map((c) => c.textContent));

  const moodBoardChip = [...filterChips].find((c) => c.dataset.filter === 'mood_board');
  check('3a. A "mood_board" filter chip exists (derived from action prefixes)', !!moodBoardChip, [...filterChips].map((c) => c.dataset.filter));

  if (moodBoardChip) {
    moodBoardChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('3b. Clicking a filter chip genuinely re-fetches logs with the matching entityType param', owner.logsCalledWith && owner.logsCalledWith.entityType === 'mood_board', owner.logsCalledWith);
    const filteredRows = dom.window.document.querySelectorAll('#logTableBody tr');
    check('3c. The table re-renders to show only the filtered rows', filteredRows.length === 1 && filteredRows[0].textContent.includes('mood_board.approved'), [...filteredRows].map((r) => r.textContent));
  } else {
    fail += 2;
  }

  // Log-type switching
  const loginTypeChip = [...dom.window.document.querySelectorAll('#logTypeRow .casa-chip')].find((c) => c.dataset.logtype === 'login');
  loginTypeChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const loginRows = dom.window.document.querySelectorAll('#logTableBody tr');
  check('4a. Switching to Login History genuinely calls CasaApi.admin.loginHistory() and renders real attempts', loginRows.length === 2 && [...loginRows].some((r) => r.textContent.includes('unknown@test.com')) && [...loginRows].some((r) => r.textContent.includes('user_not_found')), [...loginRows].map((r) => r.textContent));
  check('4b. The entityType filter row is hidden for non-activity log types', dom.window.document.getElementById('filterRow').style.display === 'none');

  const errorsTypeChip = [...dom.window.document.querySelectorAll('#logTypeRow .casa-chip')].find((c) => c.dataset.logtype === 'errors');
  errorsTypeChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const errorRows = dom.window.document.querySelectorAll('#logTableBody tr');
  check('5. Switching to Errors genuinely calls CasaApi.admin.errorLogs() and renders the real error message', errorRows.length === 1 && errorRows[0].textContent.includes('Gemini API key is not configured'), [...errorRows].map((r) => r.textContent));

  const catalogTypeChip = [...dom.window.document.querySelectorAll('#logTypeRow .casa-chip')].find((c) => c.dataset.logtype === 'catalog');
  catalogTypeChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const catalogRows = dom.window.document.querySelectorAll('#logTableBody tr');
  check('6. Switching to Catalog genuinely calls CasaApi.admin.catalogLogs() and renders the real filename + tile count', catalogRows.length === 1 && catalogRows[0].textContent.includes('somany_catalog.pdf') && catalogRows[0].textContent.includes('42 tiles extracted'), [...catalogRows].map((r) => r.textContent));

  // Background Queues panel
  const queueRows = dom.window.document.querySelectorAll('#queueStatsBody tr');
  check('7a. Background Queues panel renders real stats from CasaApi.admin.queueStats()', queueRows.length === 3 && [...queueRows].some((r) => r.textContent.includes('Image Processing')), [...queueRows].map((r) => r.textContent));

  const failedTable = dom.window.document.getElementById('failedJobsTable');
  check('7b. A failed job list is shown when failed jobs exist', failedTable.style.display !== 'none');
  const retryLink = dom.window.document.querySelector('.retry-job');
  check('7c. A real Retry button renders for the failed job', !!retryLink && retryLink.dataset.id === 'job-fail-1', retryLink && retryLink.dataset.id);

  if (retryLink) {
    retryLink.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('8. Clicking Retry genuinely calls CasaApi.admin.retryJob() with the real job id', owner.retryCalledWith === 'job-fail-1', owner.retryCalledWith);
  } else {
    fail += 1;
  }

  // Admin (not Owner) passes the shell's allowedRoles gate but hits this
  // page's own second-tier check — /admin/logs stays OWNER-only at the
  // backend (admin.routes.ts's authorize('OWNER')).
  const admin = baseStub('ADMIN');
  const adminDom = loadPage(admin.stub);
  await new Promise((r) => setTimeout(r, 60));
  check('9. Admin (non-Owner) sees the restricted banner instead of real log data', adminDom.window.document.getElementById('restrictedBanner').style.display === 'block');

  // Staff never reaches this page's own script — blocked by CasaShell's
  // allowedRoles gate first.
  const staff = baseStub('STAFF');
  const staffDom = loadPage(staff.stub);
  await new Promise((r) => setTimeout(r, 60));
  check("10. Staff is blocked by the shell's allowedRoles gate", staffDom.window.document.body.textContent.includes("don't have access"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
