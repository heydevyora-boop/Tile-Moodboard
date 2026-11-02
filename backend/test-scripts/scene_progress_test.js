/**
 * The progress bar under the generate button, on the real page.
 *
 * Generating a scene is two image calls to Gemini and one check of what
 * came back, and the model answers once, at the end -- there is no
 * progress to report from inside it. So the bar measures the one thing
 * that is honestly measurable: how much of the usual wait has passed. It
 * must never read 100% before the picture is in hand, and it must not
 * appear at all for a generation that comes back quickly.
 *
 * This drives frontend/mood-board.html in jsdom against a stubbed
 * CasaApi, through the real button, and reads the real DOM.
 *
 * Run:  node test-scripts/scene_progress_test.js
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BOARD = {
  id: 'board-1',
  room: 'BATHROOM',
  style: 'Modern Luxe',
  combinations: [{
    board_name: 'Quiet Stone',
    rooms_suitable: ['Bathroom'],
    design_rationale: 'A quiet stone field with one dark accent.',
    tiles: [
      { role: 'base', tileId: 't-base', name: 'Statuario', size: '600x1200mm', finish: 'Matt' },
      { role: 'highlight', tileId: 't-high', name: 'Nero Decor', size: '300x600mm', finish: 'Gloss' },
    ],
  }],
};

/** The page, with a scene generator the test controls. */
function loadBoard(generateScene) {
  let html = fs.readFileSync(path.join(frontendDir, 'mood-board.html'), 'utf8');
  html = html.replace(/<script src="assets\/api-client\.js"><\/script>\s*/, '');

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/mood-board.html?boardId=board-1',
  });
  dom.window.requestAnimationFrame = (cb) => cb();
  dom.window.scrollTo = () => {};
  dom.window.alert = () => { throw new Error('alert() should never be called'); };
  dom.window.CasaApi = {
    requireAuth: async () => ({ name: 'Priya', role: 'STAFF', email: 'p@x.com' }),
    initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
    auth: { logout: async () => {} },
    resolveBackendImageUrl: (v) => v || '',
    moodBoards: {
      get: async () => BOARD,
      tiles: async () => BOARD.combinations[0].tiles.map((t) => ({ id: t.tileId, name: t.name, imageUrl: '' })),
    },
    ai: { generateScene },
  };

  const start = html.lastIndexOf('<script>');
  const end = html.indexOf('</script>', start);
  dom.window.eval(html.slice(start + '<script>'.length, end));
  return dom;
}

function clickGenerate(dom) {
  const btn = dom.window.document.querySelector('[data-generate-scene]');
  if (!btn) throw new Error('the generate button is not on the page');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return btn;
}

const pctOf = (doc) => {
  const el = doc.querySelector('.viz-progress-pct');
  return el ? Number(String(el.textContent).replace('%', '')) : null;
};

async function main() {
  // ----------------------------------------------------------------
  // A GENERATION NOBODY WAITED FOR GETS NO BAR
  // ----------------------------------------------------------------
  let dom = loadBoard(async () => ({ imageUrl: 'data:image/png;base64,AAAA', themeCheck: null }));
  await wait(120);
  let doc = dom.window.document;
  check('1. the card offers to generate before anything is asked of it',
    /GENERATE/.test((doc.querySelector('[data-generate-scene]') || {}).textContent || ''),
    (doc.querySelector('[data-generate-scene]') || {}).textContent);

  clickGenerate(dom);
  await wait(300);
  check('2. a scene that comes back at once shows no progress bar',
    !doc.querySelector('.viz-progress') && !!doc.querySelector('.viz-image-frame'),
    { bar: !!doc.querySelector('.viz-progress'), image: !!doc.querySelector('.viz-image-frame') });

  // ----------------------------------------------------------------
  // A GENERATION THAT TAKES A WHILE SAYS SO
  // ----------------------------------------------------------------
  let release;
  dom = loadBoard(() => new Promise((resolve) => { release = () => resolve({ imageUrl: 'data:image/png;base64,BBBB', themeCheck: null }); }));
  await wait(120);
  doc = dom.window.document;
  clickGenerate(dom);

  await wait(150);
  check('3. nothing is shown while the wait is still short',
    !!doc.querySelector('.viz-progress') && doc.querySelector('.viz-progress').hidden,
    doc.querySelector('.viz-progress') ? doc.querySelector('.viz-progress').hidden : 'no bar');

  await wait(900);
  const bar = doc.querySelector('.viz-progress');
  check('4. the bar appears once the wait is worth mentioning', bar && !bar.hidden, bar && bar.hidden);
  check('5. ...directly below the generate button',
    bar && bar.previousElementSibling
    && bar.previousElementSibling.hasAttribute('data-generate-scene'),
    bar && bar.previousElementSibling && bar.previousElementSibling.className);

  const early = pctOf(doc);
  check('6. ...reading a share of the usual wait, not zero and not done',
    early !== null && early > 0 && early < 100, early);

  await wait(900);
  const later = pctOf(doc);
  check('7. ...and it goes on filling, left to right', later > early, { early, later });
  check('8. ...without ever claiming the picture has arrived', later < 100, later);

  const fillWidth = () => {
    const el = doc.querySelector('.viz-progress-fill');
    return el ? el.style.width : '';
  };
  check('9. the fill is drawn to the same share the number says',
    fillWidth() === later + '%', { width: fillWidth(), pct: later });

  release();
  await wait(600);
  check('10. the generated scene replaces the bar when it lands',
    !doc.querySelector('.viz-progress') && !!doc.querySelector('.viz-image-frame'),
    { bar: !!doc.querySelector('.viz-progress'), image: !!doc.querySelector('.viz-image-frame') });

  // ----------------------------------------------------------------
  // WHAT IT LEARNS, AND WHAT IT DOES WHEN THE GENERATION FAILS
  // ----------------------------------------------------------------
  const remembered = Number(dom.window.localStorage.getItem('casa_scene_ms'));
  check('11. the time that generation actually took is remembered',
    Number.isFinite(remembered) && remembered > 0, remembered);

  dom = loadBoard(async () => { await wait(1000); throw new Error('the model refused'); });
  await wait(120);
  doc = dom.window.document;
  clickGenerate(dom);
  await wait(900);
  check('12. a slow generation that is going to fail still shows the bar',
    !!doc.querySelector('.viz-progress') && !doc.querySelector('.viz-progress').hidden);

  await wait(700);
  check('13. ...and the bar is gone when it fails, with the reason in its place',
    !doc.querySelector('.viz-progress')
    && /the model refused/.test((doc.querySelector('.viz-error') || {}).textContent || ''),
    (doc.querySelector('.viz-error') || {}).textContent);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
}

main();
