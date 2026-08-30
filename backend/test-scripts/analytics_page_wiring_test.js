// Rewritten for the frontend/v2 swap: 06-analytics-usage-stats.html ->
// admin-analytics.html, wrapped in shell.js (CasaShell.init with
// allowedRoles: ['ADMIN','OWNER']), real role is a plain string now.
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
  let html = fs.readFileSync(path.join(frontendDir, 'admin-analytics.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin-analytics.html' });
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

function makeAnalyticsResponse(days) {
  return {
    printExports: { byFormat: [{ format: 'CASSETTE_PANEL', count: 2 }], byFileFormat: [{ fileFormat: 'PDF', count: 2 }, { fileFormat: 'PNG', count: 1 }], byDpi: [{ dpi: 300, count: 3 }], total: 3 },
    moodBoards: { generated: days === 7 ? 10 : 42, approved: days === 7 ? 5 : 25, approvalRate: days === 7 ? 50 : 60, byStyle: [{ style: 'Subtle', count: 6 }, { style: 'Luxury', count: 4 }], byRoom: [{ room: 'Bathroom', count: 7 }, { room: 'Kitchen', count: 3 }] },
    topFavoritedTiles: [{ tileId: 't-1', tileName: 'Ivory Stone Base', favoriteCount: 4 }],
    catalogUploads: { total: 10, completed: 8, failed: 2, successRate: 80 },
    staffActivity: [{ userId: 'u-1', userName: 'Priya Deshmukh', actionCount: 12 }, { userId: 'u-2', userName: 'Sameer Varma', actionCount: 9 }],
  };
}

function baseStub(role) {
  let analyticsCalledWith = null;
  const stub = {
    requireAuth: async () => ({ name: role === 'OWNER' ? 'Store Owner' : role === 'ADMIN' ? 'Shop Admin' : 'Staff Member', role }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    admin: {
      analytics: async (days) => { analyticsCalledWith = days; return makeAnalyticsResponse(days); },
    },
  };
  return { stub, get calledWith() { return analyticsCalledWith; } };
}

async function main() {
  const owner = baseStub('OWNER');
  const dom = loadPage(owner.stub);
  await new Promise((r) => setTimeout(r, 60));

  check('1. Analytics is fetched for the default 30-day range on load', owner.calledWith === 30, owner.calledWith);
  check('2. KPI "generated" shows the real fetched number', dom.window.document.getElementById('kpiGenerated').textContent === '42');
  check('3. KPI "exported" shows the real printExports.total', dom.window.document.getElementById('kpiExported').textContent === '3');
  check('4. KPI "approval rate" shows the real percentage', dom.window.document.getElementById('kpiApprovalRate').textContent === '60%');
  check('5. Style breakdown bars render real style names and counts', dom.window.document.getElementById('styleBarsBody').textContent.includes('Subtle') && dom.window.document.getElementById('styleBarsBody').textContent.includes('6'));
  check('6. Room breakdown bars render real room data', dom.window.document.getElementById('roomBarsBody').textContent.includes('Bathroom'));
  check('7. Top favorited tiles table renders the real tile name', dom.window.document.getElementById('topTilesBody').textContent.includes('Ivory Stone Base'));
  check('8. Staff activity renders real names and action counts', dom.window.document.getElementById('staffActivityBody').textContent.includes('Priya Deshmukh') && dom.window.document.getElementById('staffActivityBody').textContent.includes('12'));

  const chip7d = [...dom.window.document.querySelectorAll('#rangeRow .rchip')].find((c) => c.dataset.range === '7');
  chip7d.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  check('9a. Clicking the "7d" chip genuinely re-fetches analytics with days=7', owner.calledWith === 7, owner.calledWith);
  check("9b. The KPI numbers update to reflect the new range's real data (10, not 42)", dom.window.document.getElementById('kpiGenerated').textContent === '10');

  // Admin (not Owner) passes the shell's allowedRoles gate but this page's
  // own second-tier check hides the real content — /admin/analytics stays
  // OWNER-only at the backend (admin.routes.ts's authorize('OWNER')).
  const admin = baseStub('ADMIN');
  const adminDom = loadPage(admin.stub);
  await new Promise((r) => setTimeout(r, 60));
  check('10a. Admin (non-Owner) sees the restricted banner', adminDom.window.document.getElementById('restrictedBanner').style.display === 'block');
  check('10b. Admin (non-Owner) triggers no analytics fetch', admin.calledWith === null);

  // Staff never reaches this page's own script — blocked by CasaShell's
  // allowedRoles gate before anything above runs.
  const staff = baseStub('STAFF');
  const staffDom = loadPage(staff.stub);
  await new Promise((r) => setTimeout(r, 60));
  check("11. Staff is blocked by the shell's allowedRoles gate", staffDom.window.document.body.textContent.includes("don't have access"));
  check('12. Staff triggers no analytics fetch either', staff.calledWith === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
