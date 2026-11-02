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

/**
 * The same page, but with an IntersectionObserver it can actually use.
 *
 * jsdom has none, and the page falls back to fetching every page up
 * front when that is so -- deliberately, because a browser that cannot
 * watch the scroll must not be left showing a partial history. These
 * tests are for the path a real browser takes: the observer records what
 * it is asked to watch, and the test decides when something comes into
 * view.
 */
function loadPageWatching(casaApiStub) {
  let html = fs.readFileSync(path.join(frontendDir, 'recent-generations.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/recent-generations.html' });
  const watched = [];
  dom.window.requestAnimationFrame = (cb) => cb();
  dom.window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { watched.push({ el, obs: this }); }
    unobserve() {}
    disconnect() { this.dead = true; }
  };
  dom.window.CasaApi = casaApiStub;
  dom.window.alert = () => { throw new Error('alert() should never be called on this page'); };

  const start = html.lastIndexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));

  /** Tells the page that these elements have come into view. */
  const reveal = (predicate) => {
    watched
      .filter(({ el }) => predicate(el))
      .forEach(({ el, obs }) => obs.cb([{ isIntersecting: true, target: el }], obs));
  };
  return { dom, watched, reveal };
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
      // The real one prefixes a backend-relative path with the API host.
      resolveBackendImageUrl: (v) => (
        !v ? '' : /^(https?:|data:|blob:)/i.test(v) ? v : 'https://api.example' + v
      ),
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
  // A row the server sent with NO products at all. The server turns a
  // base product code into a product entry before it gets here, so this
  // is only reachable when nothing was recorded.
  check('11. ...and says plainly that no tile was recorded',
    (doc.querySelector('.gen-products-none') || {}).textContent
      === 'The tiles were not recorded for this generation.',
    (doc.querySelector('.gen-products-none') || {}).textContent);
  check('11a. ...never printing a bare product code in a sentence',
    !doc.body.textContent.includes('Only the base tile was recorded'));

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

  // A backend-relative image must go through the resolver, or it lands
  // on THIS page's origin and 404s. Every other tile picture on the
  // site has always been resolved; this page was not.
  const relative = pagedStub(1, 60);
  relative.all[0].products = [{
    role: 'base', name: 'Relative Tile', code: 'REL-1',
    size: '', finish: '', imageUrl: '/uploads/extracted-images/REL-1.webp',
  }];
  doc = loadPage(relative.stub).window.document;
  await settle();
  check('29. a backend-relative product image is resolved against the API host',
    doc.querySelector('.gen-product img').getAttribute('src')
      === 'https://api.example/uploads/extracted-images/REL-1.webp',
    doc.querySelector('.gen-product img')
      && doc.querySelector('.gen-product img').getAttribute('src'));

  const absolute = pagedStub(1, 60);
  doc = loadPage(absolute.stub).window.document;
  await settle();
  check('30. an absolute URL is passed through unchanged',
    doc.querySelector('.gen-product img').getAttribute('src')
      === 'https://drive.example/URV-0014.webp');

  const imageless = pagedStub(1, 60);
  imageless.all[0].products = [{ role: 'base', name: 'No Picture', code: 'X', size: '', finish: '', imageUrl: '' }];
  doc = loadPage(imageless.stub).window.document;
  await settle();
  check('31. a product with no image still shows its name, with a placeholder',
    doc.querySelector('.gen-product-name').textContent === 'No Picture'
    && !!doc.querySelector('.gen-product-blank')
    && !doc.querySelector('.gen-product img'));

  // An older generation: its base tile shown like any other product,
  // and a line saying what the record does not hold.
  const older = pagedStub(1, 60);
  older.all[0].productsPartial = true;
  older.all[0].products = [product('base', 'Travertine Vain Lait', 'DME-ITACA-1', true)];
  doc = loadPage(older.stub).window.document;
  await settle();
  check('32. an old generation shows its base tile as a real product',
    doc.querySelectorAll('.gen-product').length === 1
    && doc.querySelector('.gen-product-name').textContent === 'Travertine Vain Lait');
  check('33. ...with its picture, not a bare code in a sentence',
    !!doc.querySelector('.gen-product img')
    && !doc.body.textContent.includes('Only the base tile was recorded'));
  check('34. ...and says the highlight and accent are not in the record',
    (doc.querySelector('.gen-products-none') || {}).textContent
      === 'Generated before the full combination was recorded. The highlight and '
        + 'accent are not in the record.',
    (doc.querySelector('.gen-products-none') || {}).textContent);

  const whole = pagedStub(1, 60);
  whole.all[0].productsPartial = false;
  doc = loadPage(whole.stub).window.document;
  await settle();
  check('35. a fully recorded board carries no partial note',
    doc.querySelectorAll('.gen-product').length === 2
    && !doc.querySelector('.gen-products-none'));

  // ----------------------------------------------------------------
  // THE SCENE ITSELF IS FETCHED WHEN IT IS LOOKED AT
  //
  // A generated scene is kept as an inline data: URL of a megabyte or
  // two. The card used to be written with those bytes inside its own
  // HTML, for every generation at once, and the page sat blank until all
  // of it had arrived. The row carries a path now, and the picture comes
  // down when the card is near the screen.
  // ----------------------------------------------------------------
  const inlineStub = pagedStub(3, 24);
  inlineStub.all.forEach((gen, i) => {
    gen.imageUrl = '';
    gen.imagePath = '/ai/visualizations/recent/gen-' + (i + 1) + '/image';
    gen.hasImage = true;
    gen.imageSource = 'inline';
  });
  const asked = [];
  inlineStub.stub.ai.recentGenerationImage = async (p) => {
    asked.push(p);
    return 'blob:scene-' + p.split('/')[4];
  };

  let watching = loadPageWatching(inlineStub.stub);
  doc = watching.dom.window.document;
  await settle();
  check('36. a card whose scene is stored inline draws no picture at first',
    doc.querySelectorAll('.gen-shot').length === 3
    && doc.querySelectorAll('.gen-shot img').length === 0
    && doc.querySelectorAll('.gen-shot-wait').length === 3,
    doc.querySelectorAll('.gen-shot img').length);
  check('37. ...and nothing has been fetched for it yet', asked.length === 0, asked);

  watching.reveal((el) => el.classList && el.classList.contains('gen-shot'));
  await settle();
  check('38. the scene arrives once the card comes into view',
    asked.length === 3 && doc.querySelectorAll('.gen-shot img').length === 3, asked);
  check('39. ...and it is the picture the row pointed at',
    doc.querySelector('.gen-shot img').getAttribute('src') === 'blob:scene-gen-1',
    doc.querySelector('.gen-shot img').getAttribute('src'));
  check('40. ...and the waiting frame is gone',
    doc.querySelectorAll('.gen-shot-wait').length === 0);

  // The lightbox shows whatever the frame is holding, which is the only
  // thing it can honestly show now that no data: URL is on the card.
  doc.querySelector('.gen-shot').dispatchEvent(
    new watching.dom.window.MouseEvent('click', { bubbles: true }),
  );
  check('41. clicking a loaded scene opens it full size',
    (doc.querySelector('.gen-lightbox img') || {}).getAttribute
      && doc.querySelector('.gen-lightbox img').getAttribute('src') === 'blob:scene-gen-1',
    (doc.querySelector('.gen-lightbox img') || {}).src);

  // A scene the fetch cannot return says so in its own frame, and does
  // not take the page down with it.
  const brokenStub = pagedStub(1, 24);
  brokenStub.all[0].imageUrl = '';
  brokenStub.all[0].imagePath = '/ai/visualizations/recent/gen-1/image';
  brokenStub.stub.ai.recentGenerationImage = async () => { throw new Error('gone'); };
  watching = loadPageWatching(brokenStub.stub);
  doc = watching.dom.window.document;
  await settle();
  watching.reveal((el) => el.classList && el.classList.contains('gen-shot'));
  await settle();
  check('42. a scene that cannot be loaded says so in its frame',
    /COULD NOT LOAD THIS SCENE/.test(doc.querySelector('.gen-shot').textContent)
    && doc.querySelectorAll('.gen-card').length === 1,
    doc.querySelector('.gen-shot').textContent);

  // ----------------------------------------------------------------
  // THE REST OF THE HISTORY IS ASKED FOR WHEN IT IS WANTED
  // ----------------------------------------------------------------
  const deep = pagedStub(90, 24);
  watching = loadPageWatching(deep.stub);
  doc = watching.dom.window.document;
  await settle();
  check('43. only the newest page is fetched on arrival',
    deep.calls.length === 1 && doc.querySelectorAll('.gen-card').length === 24,
    { calls: deep.calls.length, cards: doc.querySelectorAll('.gen-card').length });
  check('44. ...and the count says how many of the total are on screen',
    doc.getElementById('genCount').textContent === 'SHOWING 24 OF 90',
    doc.getElementById('genCount').textContent);

  watching.reveal((el) => el.id === 'genMore');
  await settle();
  check('45. the next page arrives when the bottom comes near',
    deep.calls.length === 2 && doc.querySelectorAll('.gen-card').length === 48,
    { calls: deep.calls.length, cards: doc.querySelectorAll('.gen-card').length });

  watching.reveal((el) => el.id === 'genMore');
  await settle();
  watching.reveal((el) => el.id === 'genMore');
  await settle();
  check('46. ...and keeps going to the end of the history',
    doc.querySelectorAll('.gen-card').length === 90
    && doc.getElementById('genCount').textContent === '90 GENERATIONS',
    { cards: doc.querySelectorAll('.gen-card').length, count: doc.getElementById('genCount').textContent });

  // A Drive link is a URL and tiny, so it stays on the card -- but the
  // browser is told it may wait until the card is on screen.
  const driveStub = pagedStub(1, 24);
  doc = loadPage(driveStub.stub).window.document;
  await settle();
  check('47. a scene stored as a plain URL loads from the card, lazily',
    doc.querySelector('.gen-shot img').getAttribute('src') === 'https://drive.example/scene-1.webp'
    && doc.querySelector('.gen-shot img').getAttribute('loading') === 'lazy',
    doc.querySelector('.gen-shot img').getAttribute('loading'));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
}

main();
