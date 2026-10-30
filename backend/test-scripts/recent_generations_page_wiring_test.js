/**
 * Regression: Recent Generations must show the tiles, and all of them.
 *
 * THE TWO FAILURES THIS COVERS
 * ----------------------------
 * The page drew a render, a date and a theme name. Which tiles built
 * the scene -- the one thing a history is consulted for -- was nowhere
 * on the card.
 *
 * And it called the endpoint once and drew what came back, so with more
 * generations than one page holds the older ones were missing, and
 * nothing on screen admitted it.
 *
 * This drives the real page against a stubbed CasaApi and reads the DOM
 * back, so what is asserted is what a person would actually see.
 *
 * Run:  node test-scripts/recent_generations_page_wiring_test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); fail++; }
}

const frontendDir = path.join(__dirname, '..', '..', 'frontend');

function loadPage(casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, 'recent-generations.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/recent-generations.html' });
  dom.window.requestAnimationFrame = (cb) => cb();
  dom.window.CasaApi = casaApiStub;
  dom.window.alert = () => { throw new Error('alert() should never be called on this page'); };

  const start = html.lastIndexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

function product(role, name, code, withImage) {
  return {
    role, name, code, size: '600x1200mm', finish: 'Matt',
    imageUrl: withImage ? `https://drive.example/${code}.webp` : '',
  };
}

function generation(n, products) {
  return {
    id: 'gen-' + n,
    createdAt: '2026-10-30T02:17:00Z',
    by: 'Priya',
    imageUrl: 'https://drive.example/scene-' + n + '.webp',
    imageSource: 'drive',
    productName: 'Urvi Statuario',
    room: 'Living Room',
    style: 'Floral',
    combinationName: 'Soft Botanical Garden ' + n,
    products: products === undefined
      ? [product('base', 'Urvi Statuario', 'URV-0014', true),
         product('highlight', 'Botanical Decor', 'DEC-0002', true)]
      : products,
  };
}

/** A stub that pages exactly as the route does, and counts the calls. */
function pagedStub(total, pageSize) {
  const all = Array.from({ length: total }, (_, i) => generation(i + 1));
  const calls = [];
  return {
    calls,
    all,
    stub: {
      requireAuth: async () => ({ name: 'Priya', role: 'STAFF', email: 'p@x.com' }),
      initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
      auth: { logout: async () => {} },
      ai: {
        recentGenerations: async () => { throw new Error('the page must use the paged call'); },
        recentGenerationsPage: async (options) => {
          const cursor = (options || {}).cursor || null;
          calls.push(cursor);
          const from = cursor ? all.findIndex((g) => g.id === cursor) + 1 : 0;
          const slice = all.slice(from, from + pageSize);
          const nextIndex = from + pageSize;
          return {
            generations: slice,
            nextCursor: nextIndex < all.length ? slice[slice.length - 1].id : null,
            total: all.length,
          };
        },
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

async function main() {
  // ----------------------------------------------------------------
  // THE PRODUCTS. On the card, with their images and their names.
  // ----------------------------------------------------------------
  const one = pagedStub(1, 60);
  let dom = loadPage(one.stub);
  await settle();
  let doc = dom.window.document;

  const cards = doc.querySelectorAll('.gen-card');
  check('1. the generation is drawn', cards.length === 1, cards.length);

  const strip = doc.querySelector('.gen-card .gen-products');
  check('2. the card carries a products section', !!strip);

  const rows = doc.querySelectorAll('.gen-card .gen-product');
  check('3. every product used is listed, not just the base',
    rows.length === 2, rows.length);

  const names = [...doc.querySelectorAll('.gen-product-name')].map((n) => n.textContent);
  check('4. each product is named on the card',
    names.join('|') === 'Urvi Statuario|Botanical Decor', names);

  const thumbs = [...doc.querySelectorAll('.gen-product img')].map((i) => i.getAttribute('src'));
  check('5. ...and shows its own catalog image',
    thumbs.length === 2
    && thumbs[0] === 'https://drive.example/URV-0014.webp'
    && thumbs[1] === 'https://drive.example/DEC-0002.webp', thumbs);

  const meta = [...doc.querySelectorAll('.gen-product-meta')].map((m) => m.textContent);
  check('6. the role, code, size and finish ride along',
    meta[0].includes('BASE') && meta[0].includes('URV-0014')
    && meta[0].includes('600X1200MM') && meta[0].includes('MATT'), meta);

  check('7. the scene image is still shown above them',
    doc.querySelector('.gen-shot img').getAttribute('src') === 'https://drive.example/scene-1.webp');

  // A product whose image was not kept must still be named, with a
  // placeholder -- a missing picture is not a missing tile.
  const noImage = pagedStub(1, 60);
  noImage.all[0].products = [product('base', 'Imageless Tile', 'NO-IMG', false)];
  doc = loadPage(noImage.stub).window.document;
  await settle();
  check('8. a product with no image is still named',
    doc.querySelector('.gen-product-name').textContent === 'Imageless Tile');
  check('9. ...and gets a placeholder rather than a broken image',
    !!doc.querySelector('.gen-product-blank') && !doc.querySelector('.gen-product img'));

  // An older row, recorded before products were stored, must appear and
  // say so rather than show an empty strip that reads as "no tiles".
  const legacy = pagedStub(1, 60);
  legacy.all[0].products = [];
  doc = loadPage(legacy.stub).window.document;
  await settle();
  check('10. a generation recorded before products existed is still shown',
    doc.querySelectorAll('.gen-card').length === 1);
  check('11. ...and says the tiles were not recorded, naming the base it has',
    (doc.querySelector('.gen-products-none') || {}).textContent
      === 'Only the base tile was recorded for this one: Urvi Statuario.',
    (doc.querySelector('.gen-products-none') || {}).textContent);

  const bare = pagedStub(1, 60);
  bare.all[0].products = [];
  bare.all[0].productName = '';
  doc = loadPage(bare.stub).window.document;
  await settle();
  check('12. ...or says so plainly when it has no name either',
    (doc.querySelector('.gen-products-none') || {}).textContent
      === 'The tiles were not recorded for this generation.');

  // ----------------------------------------------------------------
  // THE WHOLE HISTORY. Not the first page of it.
  // ----------------------------------------------------------------
  const many = pagedStub(137, 60);
  dom = loadPage(many.stub);
  await settle();
  doc = dom.window.document;

  check('13. every generation is on the page, not the first 30',
    doc.querySelectorAll('.gen-card').length === 137,
    doc.querySelectorAll('.gen-card').length);
  check('14. ...fetched by walking the cursor to the end',
    many.calls.length === 3 && many.calls[0] === null
    && many.calls[1] === 'gen-60' && many.calls[2] === 'gen-120', many.calls);
  check('15. the count says how many there are',
    doc.getElementById('genCount').textContent === '137 GENERATIONS',
    doc.getElementById('genCount').textContent);
  check('16. the oldest one is really drawn, not only counted',
    doc.body.textContent.includes('Soft Botanical Garden 137'));
  check('17. the newest is first',
    doc.querySelector('.gen-card .gen-name').textContent === 'Soft Botanical Garden 1');
  check('18. every card carries its own products',
    doc.querySelectorAll('.gen-card .gen-products').length === 137,
    doc.querySelectorAll('.gen-card .gen-products').length);

  // One page exactly: no second request, and the count does not lie.
  const exact = pagedStub(60, 60);
  dom = loadPage(exact.stub);
  await settle();
  check('19. a history that fits one page asks once',
    exact.calls.length === 1, exact.calls);
  check('20. ...and reports all of it',
    dom.window.document.getElementById('genCount').textContent === '60 GENERATIONS');

  // The runaway guard must stop the loop AND tell the truth about it,
  // rather than leaving the page implying it has everything.
  const runaway = pagedStub(5000, 60);
  dom = loadPage(runaway.stub);
  await settle();
  doc = dom.window.document;
  check('21. an enormous history stops at the page guard rather than looping forever',
    runaway.calls.length === 40, runaway.calls.length);
  check('22. ...and says it is showing part of the total, not all of it',
    doc.getElementById('genCount').textContent === 'SHOWING 2400 OF 5000',
    doc.getElementById('genCount').textContent);

  // ----------------------------------------------------------------
  // The states that must not regress.
  // ----------------------------------------------------------------
  const none = pagedStub(0, 60);
  doc = loadPage(none.stub).window.document;
  await settle();
  check('23. an empty history shows the empty state, not an error',
    !!doc.querySelector('.gen-empty') && doc.querySelectorAll('.gen-card').length === 0);
  check('24. ...and no count line claiming zero generations',
    !doc.getElementById('genCount'));

  const broken = {
    requireAuth: async () => ({ name: 'Priya', role: 'STAFF' }),
    initials: () => 'P',
    auth: { logout: async () => {} },
    ai: { recentGenerationsPage: async () => { throw new Error('history unavailable'); } },
  };
  doc = loadPage(broken).window.document;
  await settle();
  check('25. a failed load says why instead of showing an empty history',
    doc.body.textContent.includes('Could not load the history')
    && doc.body.textContent.includes('history unavailable'));

  // A scene whose image was not kept must still be listed.
  const noShot = pagedStub(1, 60);
  noShot.all[0].imageUrl = '';
  noShot.all[0].imageSource = 'too-large';
  doc = loadPage(noShot.stub).window.document;
  await settle();
  check('26. a scene whose image was not kept is still counted and shown',
    doc.querySelectorAll('.gen-card').length === 1
    && doc.body.textContent.includes('IMAGE NOT KEPT'));
  check('27. ...and still lists the tiles it was built from',
    doc.querySelectorAll('.gen-product').length === 2);

  // The page no longer calls itself a bathroom history; it shows every room.
  check('28. the page does not call every room a bathroom',
    !doc.querySelector('.step-sub').textContent.toLowerCase().includes('bathroom'),
    doc.querySelector('.step-sub').textContent);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
}

main();
