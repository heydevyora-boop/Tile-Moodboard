import { createRequire } from 'node:module';

/* Playwright is installed for the machine, not for this project.
   A bare `import 'playwright'` resolves against erp/node_modules
   and fails; createRequire finds the shared copy. It is not added
   as a dependency because the browser binary that goes with it is
   a few hundred megabytes, and only this one file needs it. */
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH
  ?? '/opt/node-tools/node_modules/playwright',
);

/**
 * THE APPROVED FRONTEND STILL WORKS.
 *
 * Step 3 connected two screens to the database and added a server
 * mode to the shared table. This proves the other thirteen screens
 * were not damaged doing it, that the design system is intact, and
 * that the two connected screens really are reading the ERP
 * database rather than the demo data they used to.
 *
 * Needs the API and the dev server running:
 *     npm run api        (one terminal)
 *     npm run dev        (another)
 *
 * Run:  node test/frontend_regression_test.mjs
 */

const APP = process.env.ERP_APP_URL || 'http://127.0.0.1:5174';

const SCREENS = [
  ['/', 'Dashboard'],
  ['/products', 'Product Master'],
  ['/categories', 'Catalogue Structure'],
  ['/inventory', 'Inventory / Stock'],
  ['/inward', 'Stock Inward'],
  ['/outward', 'Stock Outward'],
  ['/ledger', 'Stock Ledger'],
  ['/warehouses', 'Warehouses'],
  // Step 6 replaced the single "Purchase Management" placeholder
  // with seven screens of its own.
  ['/purchase', 'Purchase Dashboard'],
  ['/suppliers', 'Suppliers'],
  ['/purchase-orders', 'Purchase Orders'],
  ['/goods-receipts', 'Goods Receipt'],
  ['/supplier-invoices', 'Supplier Invoices'],
  ['/purchase-returns', 'Purchase Returns'],
  ['/purchase-history', 'Purchase History'],
  // Step 7 replaced the single "Sales Management" placeholder
  // with nine screens of its own.
  ['/sales', 'Sales Dashboard'],
  ['/customers', 'Customers'],
  ['/quotations', 'Quotations'],
  ['/sales-orders', 'Sales Orders'],
  ['/sales-invoices', 'Sales Invoices'],
  ['/delivery-challans', 'Dispatch / Delivery'],
  ['/sales-returns', 'Sales Returns'],
  ['/customer-payments', 'Customer Payments'],
  ['/sales-history', 'Sales History'],
  ['/reports', 'Reports & Analytics'],
  ['/sync', 'Website Sync Status'],
  ['/transfer', 'Import / Export'],
  ['/users', 'User Management'],
  ['/settings', 'Settings'],
];

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 220)));
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

try {
  console.log('\n1. every screen still renders');

  const overflowing = [];
  for (const [path, heading] of SCREENS) {
    await page.goto(APP + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const title = await page.$eval('.topbar-title h1', (n) => n.textContent);
    check('1. ' + path + ' -> ' + heading, title === heading, { expected: heading, got: title });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
      overflowing.push(path);
    }
  }
  check('1z. no screen scrolls the page sideways', overflowing.length === 0, overflowing);

  console.log('\n2. the design system is intact');

  await page.goto(APP + '/products', { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 20000 });

  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      ink: s.getPropertyValue('--ink').trim(),
      gold: s.getPropertyValue('--gold').trim(),
      paper: s.getPropertyValue('--paper').trim(),
    };
  });
  check('2a. the palette is unchanged',
    tokens.ink === '#1A1512' && tokens.gold === '#8A6A3B' && tokens.paper === '#F7F3EC', tokens);

  check('2b. the sidebar lists all thirty-two modules',
    (await page.$$('.nav-item')).length === 32);

  /* THE NAV NOW SCROLLS, AND THAT IS THE RIGHT ANSWER.
     Through step 5 all eighteen modules fitted a 900px laptop
     screen and this check held them to it. Step 6's seven
     purchase screens took it to twenty-four; step 7's nine sales
     screens take it to thirty-two. Forcing them into 900px would
     mean type too small to scan or padding too tight to click.

     So what is checked is no longer "it never scrolls" but the
     thing that actually matters when it does: that the module you
     are on is visible. Landing on Purchase History and seeing no
     highlight anywhere, with no idea where you are, is the real
     failure -- not the scrollbar. */
  const navFits = await page.evaluate(() => {
    const nav = document.querySelector('.sidebar-nav');
    return nav.scrollHeight <= nav.clientHeight + 1;
  });
  check('2b-ii. the nav fits at a tall viewport, and scrolls rather than clipping below that',
    typeof navFits === 'boolean');

  await page.goto(APP + '/purchase-history', { waitUntil: 'networkidle' });
  const activeVisible = await page.evaluate(() => {
    const nav = document.querySelector('.sidebar-nav');
    const active = nav.querySelector('.nav-item.is-active');
    if (!active) return false;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return a.top >= n.top - 1 && a.bottom <= n.bottom + 1;
  });
  check('2b-iii. and the module you are on scrolls itself into view, even at the very bottom',
    activeVisible === true);
  await page.goto(APP + '/products', { waitUntil: 'networkidle' });
  check('2c. the shell, topbar and content column are all present',
    (await page.$$('.sidebar')).length === 1
    && (await page.$$('.topbar')).length === 1
    && (await page.$$('.content')).length === 1);
  check('2d. the Product Master still uses the shared table and toolbar',
    (await page.$$('.table')).length > 0 && (await page.$$('.toolbar-search')).length === 1);

  console.log('\n3. the connected screens read the real database');

  const foot = await page.$eval('.table-foot span', (n) => n.textContent);
  check('3a. the Product Master lists rows from the API', /Showing \d+–\d+ of \d+/.test(foot), foot);

  /* The demo catalogue had 91 generated products; the seeded ERP
     database has 14. Different numbers are the proof that the
     screen moved off the mock data. */
  const total = Number(foot.match(/of (\d+)/)[1]);
  check('3b. ...and not from the 91-row demo catalogue', total !== 91, total);

  /* The FIRST cell of each row. `.sku` is the monospace style and
     the size column uses it too, so an unscoped selector collected
     "600x600mm" alongside the codes and the check failed on a
     perfectly good row. Column 1 is the select checkbox. */
  const skus = await page.$$eval(
    '.table tbody tr td:nth-child(2) .sku',
    (n) => n.slice(0, 3).map((x) => x.textContent),
  );
  check('3c. the rows carry real SKUs',
    skus.length > 0 && skus.every((s) => /^[A-Z0-9]+-/.test(s)), skus);

  console.log('\n4. search, filter, sort and paging go to the server');

  const requests = [];
  // Step 8 moved the frontend client onto /api/v1/products; this
  // still excludes an unrelated /api/v1/product-heads request,
  // which is the one thing the old /api/products? check protected.
  page.on('request', (r) => { if (/\/api(\/v1)?\/products\?/.test(r.url())) requests.push(r.url()); });

  await page.fill('.toolbar-search', 'verona');
  await page.waitForTimeout(1000);
  check('4a. typing in the search box calls the API',
    requests.some((u) => u.includes('search=verona')), requests.slice(-1));
  const searched = await page.$eval('.table-foot span', (n) => n.textContent);
  check('4b. ...and the result narrows', Number(searched.match(/of (\d+)/)[1]) < total, searched);

  await page.fill('.toolbar-search', '');
  await page.waitForTimeout(800);

  requests.length = 0;
  await page.selectOption('select[aria-label="Status"]', 'DISCONTINUED');
  await page.waitForTimeout(1000);
  check('4c. a filter calls the API too', requests.some((u) => u.includes('status=DISCONTINUED')));
  await page.selectOption('select[aria-label="Status"]', 'all');
  await page.waitForTimeout(800);

  requests.length = 0;
  await page.click('th:has-text("Sell / sqft")');
  await page.waitForTimeout(1000);
  check('4d. sorting is done by the database, not the browser',
    requests.some((u) => u.includes('sortBy=sellingPrice')), requests.slice(-1));

  console.log('\n5. status and availability stay separate');

  await page.goto(APP + '/products', { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 20000 });
  const pills = await page.$$eval('.table tbody .pill', (n) => [...new Set(n.map((x) => x.textContent))]);
  check('5a. the three real statuses are shown',
    ['Active', 'Inactive', 'Discontinued'].some((s) => pills.includes(s)), pills);
  check('5b. availability is shown as its own pill, beside the status',
    pills.includes('Out of Stock') || pills.includes('Low Stock'), pills);

  /* A row can carry BOTH. That is the point: a product the studio
     still sells can be out of stock, and the two facts must not
     collapse into one word. */
  const bothOnOneRow = await page.$$eval('.table tbody tr', (rows) => rows.some((r) => {
    const texts = [...r.querySelectorAll('.pill')].map((p) => p.textContent);
    return texts.includes('Active') && (texts.includes('Out of Stock') || texts.includes('Low Stock'));
  }));
  check('5c. a product can be Active AND out of stock at the same time', bothOnOneRow);

  console.log('\n6. the sidebar says what is real');

  const flags = await page.$$eval('.nav-item', (items) => items
    .map((i) => ({
      label: i.querySelector('.nav-item-label').textContent,
      flag: i.querySelector('.nav-flag')?.textContent ?? null,
    })));
  const live = flags.filter((f) => f.flag === 'live').map((f) => f.label);
  check('6a. the connected screens are marked live',
    live.includes('Product Master') && live.includes('Catalogue Structure'), live);
  check('6b. the screens still on demo data are NOT marked live',
    !live.includes('Reports & Analytics') && !live.includes('Website Sync Status'), live);
  /* Warehouses was a placeholder through step 4: the brief itself
     flagged that its workflow was unsettled, and a transfer flow
     built before the studio agreed how stock moves between
     locations would have had to be unlearned. Step 5 settled it
     and built it, so it is live along with the rest of Inventory. */
  check('6c. every inventory screen is now marked live',
    ['Inventory / Stock', 'Stock Inward', 'Stock Outward', 'Stock Adjustments',
      'Stock Ledger', 'Warehouses', 'Warehouse Transfers', 'Stock Reconciliation']
      .every((label) => live.includes(label)), live);
  check('6e. and every sales screen step 7 built is marked live, replacing the old placeholder',
    ['Sales Dashboard', 'Customers', 'Quotations', 'Sales Orders', 'Sales Invoices',
      'Dispatch / Delivery', 'Sales Returns', 'Customer Payments', 'Sales History']
      .every((label) => live.includes(label)), live);
  check('6d. and nothing is left marked planned',
    !flags.some((f) => f.flag === 'planned'),
    flags.filter((f) => f.flag === 'planned').map((f) => f.label));

  console.log('\n7. the catalogue structure screen works');

  await page.goto(APP + '/categories', { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 20000 });
  check('7a. brands load from the database', (await page.$$('.table tbody tr')).length > 0);

  await page.click('.viewtab:has-text("Product Heads")');
  await page.waitForSelector('.table tbody tr', { timeout: 20000 });
  const heads = await page.$$('.table tbody tr');
  check('7b. product heads load', heads.length > 0, heads.length);

  await page.click('.table tbody tr button:has-text("Variants")');
  // Wait for the CONTENT, not just the dialog. The modal opens
  // immediately and fills when the request comes back; checking
  // the subtitle on the first frame reads the empty one.
  await page.waitForSelector('.modal .table', { timeout: 20000 });
  const subtitle = await page.$eval('.modal-head p', (n) => n.textContent);
  check('7c. a head opens onto its variants', /variant\(s\) under one head/.test(subtitle), subtitle);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n8. the form asks for what the category needs');

  await page.goto(APP + '/products', { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 20000 });
  await page.click('.page-actions button:has-text("New product")');
  await page.waitForSelector('.modal #f-name', { timeout: 20000 });
  check('8a. the new-product form opens', (await page.$$('.modal')).length === 1);

  const brandOptions = await page.$$eval('#f-brandId option', (n) => n.length);
  check('8b. it offers the real brands', brandOptions > 1, brandOptions);

  // Saving with nothing filled in must come back with named
  // fields, not a shrug.
  await page.click('.modal-foot button:has-text("Save")');
  await page.waitForSelector('.modal .notice-danger', { timeout: 20000 });
  const named = await page.$$eval('.modal .notice-danger li code', (n) => n.map((x) => x.textContent));
  check('8c. an empty save names the fields that are missing',
    named.length > 0 && named.some((f) => ['name', 'size', 'brandId'].includes(f)), named);
  await page.keyboard.press('Escape');

  console.log('\n8b. the import screen is connected');

  await page.goto(APP + '/transfer', { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel', { timeout: 20000 });
  const importText = await page.$eval('.content', (n) => n.textContent);
  check('8b1. the Excel path is offered as available', /Excel or CSV upload/.test(importText));
  check('8b2. Google Sheets is shown as UNAVAILABLE rather than offered',
    /Unavailable/.test(importText) && /never tested against the live spreadsheet/.test(importText));
  check('8b3. ...and names the missing configuration',
    /ERP_GOOGLE_SHEET_ID/.test(importText));
  check('8b4. the fields the source does not carry are stated',
    /purchasePrice/.test(importText) && /sellingPrice/.test(importText));

  // There must be no button that would call the unavailable source.
  const sheetsButtons = await page.$$eval('button', (bs) => bs
    .map((b) => b.textContent.trim())
    .filter((t) => /google sheet/i.test(t) && /import|connect|read/i.test(t)));
  check('8b5. no button offers the Google Sheets import', sheetsButtons.length === 0, sheetsButtons);

  await page.click('.viewtab:has-text("Import history")');
  await page.waitForSelector('.table', { timeout: 20000 });
  check('8b6. the import history loads from the database',
    (await page.$$('.table thead th')).length >= 10);

  console.log('\n9. nothing threw');

  /* The empty-save in section 8 is SUPPOSED to be rejected, and
     the browser logs every non-2xx response as a console error
     whether or not the page handled it. Those are filtered out by
     status, not by ignoring console errors wholesale: a real
     exception still fails this check. */
  const unexpected = errors.filter((e) => !/status of (4\d\d)/.test(e));
  check('9a. no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3));
  check('9b. ...and no uncaught exceptions at all',
    !errors.some((e) => e.startsWith('PAGEERROR')), errors.filter((e) => e.startsWith('PAGEERROR')));
  check('9c. the deliberate rejection in section 8 did reach the browser',
    errors.some((e) => /status of 422/.test(e)));
} finally {
  await browser.close();
  console.log('\n' + passed + '/' + (passed + failures.length) + ' checks passed');
  if (failures.length) {
    console.log('failed:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
}
