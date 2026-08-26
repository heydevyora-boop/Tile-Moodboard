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
  let html = fs.readFileSync(path.join(frontendDir, '06-analytics-usage-stats.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/06-analytics-usage-stats.html' });
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

function makeAnalyticsResponse(days) {
  return {
    printExports: { byFormat: [{ format: 'CASSETTE_PANEL', count: 2 }], byFileFormat: [{ fileFormat: 'PDF', count: 2 }, { fileFormat: 'PNG', count: 1 }], byDpi: [{ dpi: 300, count: 3 }], total: 3 },
    moodBoards: { generated: days === 7 ? 10 : 42, approved: days === 7 ? 5 : 25, approvalRate: days === 7 ? 50 : 60, byStyle: [{ style: 'Subtle', count: 6 }, { style: 'Luxury', count: 4 }], byRoom: [{ room: 'Bathroom', count: 7 }, { room: 'Kitchen', count: 3 }] },
    topFavoritedTiles: [{ tileId: 't-1', tileName: 'Ivory Stone Base', favoriteCount: 4 }],
    catalogUploads: { total: 10, completed: 8, failed: 2, successRate: 80 },
    staffActivity: [{ userId: 'u-1', userName: 'Priya Deshmukh', actionCount: 12 }, { userId: 'u-2', userName: 'Sameer Varma', actionCount: 9 }],
  };
}

async function main() {
  let analyticsCalledWith = null;

  const stub = {
    requireAuth: async () => ({ name: 'Store Owner', role: { name: 'OWNER' } }),
    auth: { logout: async () => {} },
    admin: {
      analytics: async (days) => { analyticsCalledWith = days; return makeAnalyticsResponse(days); },
    },
  };

  const dom = loadPage(stub);
  await new Promise((r) => setTimeout(r, 60));

  check('1. Analytics is fetched for the default 30-day range on load', analyticsCalledWith === 30, analyticsCalledWith);
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

  check('9a. Clicking the "7d" chip genuinely re-fetches analytics with days=7', analyticsCalledWith === 7, analyticsCalledWith);
  check("9b. The KPI numbers update to reflect the new range's real data (10, not 42)", dom.window.document.getElementById('kpiGenerated').textContent === '10');

  analyticsCalledWith = null;
  const staffStub = { ...stub, requireAuth: async () => ({ name: 'Staff Member', role: { name: 'STAFF' } }) };
  const staffDom = loadPage(staffStub);
  await new Promise((r) => setTimeout(r, 60));
  check('10a. Non-owner sees the restricted banner', staffDom.window.document.getElementById('restrictedBanner').style.display === 'block');
  check('10b. Non-owner triggers no analytics fetch', analyticsCalledWith === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
