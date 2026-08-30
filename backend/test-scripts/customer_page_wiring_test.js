// Rewritten for the frontend/v2 swap: 08-customer-management.html ->
// customers.html, wrapped in shell.js. Real role is a plain string now,
// not { name: ... }. Markup/IDs are otherwise unchanged from the original.
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
  let html = fs.readFileSync(path.join(frontendDir, 'customers.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/notifications\.js"><\/script>\s*/, '');
  html = html.replace(/<script src="assets\/shell\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/customers.html' });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => cb();
  window.CasaApi = casaApiStub;
  window.confirm = () => true;
  window.alert = () => { throw new Error('alert() should never be called on this page'); };

  dom.window.eval(notificationsSrc);
  dom.window.eval(shellSrc);
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

const SAMPLE_CUSTOMERS = [
  { id: 'c-1', name: 'Priya Sharma', phone: '9876543210', email: 'priya@example.com', preferredStyle: 'LUXURY', preferredRoom: 'BATHROOM', budget: '2-3 Lakh', notes: 'Prefers matte finishes', createdAt: '2026-08-01T10:00:00Z' },
  { id: 'c-2', name: 'Rohit Verma', phone: '9123456780', email: '', preferredStyle: '', preferredRoom: '', budget: '', notes: '', createdAt: '2026-08-05T10:00:00Z' },
];
const SAMPLE_MOOD_BOARDS = [
  { id: 'mb-1', style: 'LUXURY', room: 'BATHROOM', clientBrief: 'Wants a spa-like feel', status: 'APPROVED', combinations: [{}, {}], printBoards: [{}], createdAt: '2026-08-02T10:00:00Z' },
];
const SAMPLE_FAVORITES = [
  { id: 'fav-1', tileId: 't-99', note: 'Loved this on her last visit', tile: { id: 't-99', name: 'Ivory Stone Base', brand: { name: 'Somany' } } },
];

async function main() {
  let createCalledWith = null;
  let updateCalledWith = null;
  let deleteCalledWith = null;
  let addFavoriteCalledWith = null;
  let removeFavoriteCalledWith = null;
  let customers = [...SAMPLE_CUSTOMERS];

  const stub = {
    requireAuth: async () => ({ name: 'Store Owner', role: 'OWNER' }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    customers: {
      list: async () => ({ customers, meta: { total: customers.length } }),
      get: async (id) => customers.find((c) => c.id === id),
      create: async (payload) => { createCalledWith = payload; const c = { id: 'c-new', ...payload, createdAt: new Date().toISOString() }; customers = [...customers, c]; return c; },
      update: async (id, payload) => { updateCalledWith = { id, payload }; customers = customers.map((c) => (c.id === id ? { ...c, ...payload } : c)); return customers.find((c) => c.id === id); },
      remove: async (id) => { deleteCalledWith = id; customers = customers.filter((c) => c.id !== id); },
      history: async () => SAMPLE_MOOD_BOARDS,
      favorites: async () => SAMPLE_FAVORITES,
      addFavorite: async (id, tileId, note) => { addFavoriteCalledWith = { id, tileId, note }; return { id: 'fav-new', tileId, note }; },
      removeFavorite: async (id, tileId) => { removeFavoriteCalledWith = { id, tileId }; },
    },
  };

  const dom = loadPage(stub);
  await new Promise((r) => setTimeout(r, 60));

  const rows = dom.window.document.querySelectorAll('#customerTableBody tr');
  check('1. Real page renders real customer rows from CasaApi.customers.list()', rows.length === 2 && [...rows].some((r) => r.textContent.includes('Priya Sharma')) && [...rows].some((r) => r.textContent.includes('9876543210')), [...rows].map((r) => r.textContent));

  dom.window.document.getElementById('addCustomerBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  dom.window.document.getElementById('editName').value = 'New Customer';
  dom.window.document.getElementById('editPhone').value = '9000000000';
  dom.window.document.getElementById('saveCustomerBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  check('2a. Adding a customer genuinely calls CasaApi.customers.create with the entered values', createCalledWith && createCalledWith.name === 'New Customer' && createCalledWith.phone === '9000000000', createCalledWith);
  const rowsAfterAdd = dom.window.document.querySelectorAll('#customerTableBody tr');
  check('2b. The table re-renders to show the newly added customer', rowsAfterAdd.length === 3 && [...rowsAfterAdd].some((r) => r.textContent.includes('New Customer')), rowsAfterAdd.length);

  const editBtn = [...dom.window.document.querySelectorAll('[data-action="edit"]')].find((el) => el.dataset.id === 'c-1');
  editBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('3a. Opening Edit genuinely loads the real customer data into the form', dom.window.document.getElementById('editName').value === 'Priya Sharma' && dom.window.document.getElementById('editBudget').value === '2-3 Lakh');

  dom.window.document.getElementById('editBudget').value = '5-6 Lakh';
  dom.window.document.getElementById('saveCustomerBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('3b. Saving the edit genuinely calls CasaApi.customers.update with the changed value', updateCalledWith && updateCalledWith.id === 'c-1' && updateCalledWith.payload.budget === '5-6 Lakh', updateCalledWith);

  const viewEl = [...dom.window.document.querySelectorAll('[data-action="view"]')].find((el) => el.dataset.id === 'c-1');
  viewEl.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('4a. Opening a customer detail shows their real info', dom.window.document.getElementById('detailInfoGrid').textContent.includes('9876543210'));

  const historyTab = [...dom.window.document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'history');
  historyTab.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('4b. Switching to Mood Board History genuinely calls CasaApi.customers.history() and renders the real brief', dom.window.document.getElementById('historyList').textContent.includes('Wants a spa-like feel'));

  const favTab = [...dom.window.document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'favorites');
  favTab.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('4c. Switching to Favorited Tiles genuinely calls CasaApi.customers.favorites() and renders the real tile name + note', dom.window.document.getElementById('favoritesList').textContent.includes('Ivory Stone Base') && dom.window.document.getElementById('favoritesList').textContent.includes('Loved this on her last visit'));

  dom.window.document.getElementById('newFavoriteTileId').value = 't-50';
  dom.window.document.getElementById('newFavoriteNote').value = 'Test note';
  dom.window.document.getElementById('addFavoriteBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('5. Adding a favorite genuinely calls CasaApi.customers.addFavorite with the entered tile id and note', addFavoriteCalledWith && addFavoriteCalledWith.id === 'c-1' && addFavoriteCalledWith.tileId === 't-50' && addFavoriteCalledWith.note === 'Test note', addFavoriteCalledWith);

  const removeFavBtn = dom.window.document.querySelector('[data-action="remove-favorite"]');
  if (removeFavBtn) {
    removeFavBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('6. Removing a favorite genuinely calls CasaApi.customers.removeFavorite with the real tile id', removeFavoriteCalledWith && removeFavoriteCalledWith.id === 'c-1' && removeFavoriteCalledWith.tileId === 't-99', removeFavoriteCalledWith);
  } else {
    fail += 1;
  }

  const infoTab = [...dom.window.document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'info');
  infoTab.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  dom.window.document.getElementById('deleteFromDetailBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('7. Deleting from the detail view genuinely calls CasaApi.customers.remove with the real customer id', deleteCalledWith === 'c-1', deleteCalledWith);

  // customers.html has no allowedRoles restriction — Staff has customers
  // read/write permission on the backend, so the page should render fully
  // for Staff too, not get shell-blocked or restricted.
  const staffStub = {
    requireAuth: async () => ({ name: 'Staff Member', role: 'STAFF' }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    customers: { list: async () => ({ customers: SAMPLE_CUSTOMERS, meta: { total: 2 } }) },
  };
  const staffDom = loadPage(staffStub);
  await new Promise((r) => setTimeout(r, 60));
  const staffRows = staffDom.window.document.querySelectorAll('#customerTableBody tr');
  check('8. Staff (no restriction on this page) sees the full real customer table, not blocked', staffRows.length === 2 && !staffDom.window.document.body.textContent.includes("don't have access"), [...staffRows].map((r) => r.textContent));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
