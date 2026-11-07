/**
 * De'vyora Library -- the foundation.
 *
 * Chunk 1 is the menu item, the architecture and the table. There is no
 * upload and no generation yet, so what is checked here is that the
 * foundation is actually in place and that it did not disturb anything:
 *
 *   the menu item is on EVERY page that has a sidebar, and leads
 *   somewhere real
 *
 *   the table exists with the fields the feature was specified with, and
 *   Drive is the only store a row can name
 *
 *   a theme id is a theme from shared/themes.json, not a free string
 *   nobody checks
 *
 *   the existing reference_images table, service, routes and page are
 *   untouched -- they are a different thing with a similar name
 *
 * Run:  node test-scripts/devyora_library_test.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const FRONTEND = path.join(REPO, 'frontend');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra));
    fail += 1;
  }
}

const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
const model = (schema.split('model LibraryReference {')[1] || '').split('\n}')[0];

function main() {
  // ── the menu item ────────────────────────────────────────────────
  const SIDEBAR_PAGES = [
    'dashboard.html', 'mood-board.html', 'recent-generations.html',
    'projects.html', 'catalog.html', 'devyora-library.html',
  ];

  SIDEBAR_PAGES.forEach((page) => {
    const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
    check(`1. ${page} carries the De’vyora Library menu item`,
      /id: 'library'/.test(html) && /devyora-library\.html/.test(html));
  });

  check('2. the page the item points at exists',
    fs.existsSync(path.join(FRONTEND, 'devyora-library.html')));

  // ...and the label is the studio's own name, with its apostrophe.
  const dash = fs.readFileSync(path.join(FRONTEND, 'dashboard.html'), 'utf8');
  check('3. the item is labelled De’vyora Library',
    /De\\u2019vyora Library|De’vyora Library/.test(dash), 
    (dash.match(/label: *["'][^"']*Library[^"']*["']/) || [])[0]);

  // ── the page renders, with the sidebar and no upload ─────────────
  {
    const html = fs.readFileSync(path.join(FRONTEND, 'devyora-library.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/devyora-library.html' });
    dom.window.CasaApi = {
      requireAuth: async () => ({ name: 'Priya Sharma', role: 'STAFF', email: 'p@x.test' }),
      initials: (n) => String(n || '?').split(/\s+/).map((p) => p[0]).join('').toUpperCase(),
      // The theme cards lead with a starter ROOM now, resolved through
      // the API client the way every other backend-hosted image is.
      resolveBackendImageUrl: (v) => v || '',
      auth: { logout: async () => {} },
      library: {
        // {themes, storage}, not a bare array: the endpoint reports
        // separately whether the counts could be read, so a database
        // without the library table still lists the studio's themes.
        // Themes carry their room breakdown now -- the library is a
        // Theme -> Room hierarchy, and the theme card shows which of
        // its rooms hold anything.
        themes: async () => ({
          themes: [
            {
              id: 'british', label: 'British', slug: 'british', palette: 'Heritage green', count: 5,
              rooms: [
                { id: 'bathroom', label: 'Bathroom', slug: 'bathroom', blurb: 'Full bathroom.', count: 1, starterCount: 1 },
                { id: 'kitchen', label: 'Kitchen', slug: 'kitchen', blurb: 'A run of counter.', count: 1, starterCount: 1 },
              ],
            },
            {
              id: 'floral', label: 'Floral', slug: 'floral', palette: 'Blush pink', count: 5,
              rooms: [
                { id: 'bathroom', label: 'Bathroom', slug: 'bathroom', blurb: 'Full bathroom.', count: 1, starterCount: 1 },
              ],
            },
          ],
          storage: { ok: true, reason: '' },
          // Whether this deployment can upload at all, asked at page
          // load so a studio is not told after picking a hundred files.
          uploads: { ok: true, reason: '' },
        }),
        rooms: async () => [
          { id: 'bathroom', label: 'Bathroom', slug: 'bathroom', blurb: 'Full bathroom.', wizard: 'Bathroom' },
          { id: 'kitchen', label: 'Kitchen', slug: 'kitchen', blurb: 'A run of counter.', wizard: 'Kitchen & Dining' },
        ],
        references: async () => ({ references: [], storage: { ok: true, reason: '' } }),
        selection: () => null,
        select: (r) => r,
        clearSelection: () => {},
      },
    };
    const start = html.lastIndexOf('<script>');
    const end = html.indexOf('</script>', start);
    dom.window.eval(html.slice(start + '<script>'.length, end));

    return new Promise((resolve) => setTimeout(() => {
      const doc = dom.window.document;
      check('4. the page draws its sidebar',
        doc.querySelectorAll('.nav-item').length === 6,
        doc.querySelectorAll('.nav-item').length);
      check('5. ...with De’vyora Library as the active item',
        /Library/.test((doc.querySelector('.nav-item.active') || {}).textContent || ''),
        (doc.querySelector('.nav-item.active') || {}).textContent);
      check('6. the themes are the first thing shown',
        doc.querySelectorAll('.lib-theme-card').length === 2,
        doc.querySelectorAll('.lib-theme-card').length);
      check('7. ...and the page says what choosing one is for',
        /the scene is generated from that same picture/.test(doc.body.textContent));
      // Controls, not prose: the page's own sentence explains that a
      // chosen reference is what the scene is generated from, and the
      // sidebar has Recent Generations in it. Neither is a control.
      const controls = Array.prototype.slice
        .call(doc.querySelectorAll('button, input, form, a[href]'))
        .filter((el) => !el.classList.contains('nav-item') && el.id !== 'logoutBtn');
      check('8. no upload control until a theme is chosen',
        !doc.querySelector('input[type="file"]'),
        doc.querySelectorAll('input[type="file"]').length);
      check('9. ...and nothing that generates anything',
        !controls.some((el) => /generate/i.test(el.textContent || '')),
        controls.map((el) => (el.textContent || '').trim()).filter(Boolean));

      rest();
      console.log(`\n${pass}/${pass + fail} checks passed`);
      resolve(fail ? 1 : 0);
    }, 60));
  }
}

function rest() {
  // ── the table ────────────────────────────────────────────────────
  check('10. the LibraryReference model exists', model.length > 0);

  [
    ['themeId', /themeId\s+String/],
    ['title', /title\s+String/],
    ['imageUrl', /imageUrl\s+String/],
    ['driveFileId', /driveFileId\s+String\s+@unique/],
    ['uploadedById', /uploadedById\s+String\?/],
    ['createdAt', /createdAt\s+DateTime\s+@default\(now\(\)\)/],
  ].forEach(([field, pattern]) => {
    check(`11. it has ${field}`, pattern.test(model));
  });

  check('12. the Drive file id is required, so Drive is the only store',
    /driveFileId\s+String\s+@unique/.test(model) && !/driveFileId\s+String\?/.test(model));
  check('13. ...and the table holds no local path and no blob key',
    !/localPath|localFilename|blobKey|filePath/i.test(model), model.match(/local\w*/i));
  check('14. an unpublished row can be kept without deleting it',
    /isActive\s+Boolean\s+@default\(true\)/.test(model));
  check('15. the uploader is recorded, and survives their account being removed',
    /uploadedBy\s+User\?/.test(model));
  check('16. it is indexed by theme, which is how the gallery reads it',
    /@@index\(\[themeId\]\)/.test(model) && /@@index\(\[themeId, isActive\]\)/.test(model));

  // ── the theme is the existing one, not a new table ───────────────
  check('17. no themes table was added',
    !/model Theme\b/.test(schema) && !/model Themes\b/.test(schema));

  const themes = JSON.parse(fs.readFileSync(path.join(REPO, 'shared/themes.json'), 'utf8'));
  const ids = Object.values(themes.themes).map((t) => t.id);
  check('18. the themes it links to are the nine in shared/themes.json',
    ids.length === 9 && ids.includes('british') && ids.includes('roman_touch'), ids);

  const docs = fs.readFileSync(path.join(REPO, 'DEVYORA_LIBRARY.md'), 'utf8');
  check('19. the architecture is written down',
    /De’vyora Library|De'vyora Library/.test(docs) && docs.length > 2000);
  check('20. ...including the rule that governs every later chunk',
    /the final scene is generated \*\*from that same picture\*\*/.test(docs));
  check('21. ...and the service-account quota blocker, before upload is built',
    /no Drive storage quota/.test(docs) && /Shared Drive/.test(docs));
  check('22. ...and that the migration has to be applied by hand',
    /prisma migrate deploy/.test(docs));

  // ── the existing reference images are a different thing ──────────
  check('23. the existing reference_images model is untouched',
    /model ReferenceImage \{/.test(schema) && /@@map\("reference_images"\)/.test(schema));
  check('24. ...and its own page still exists',
    fs.existsSync(path.join(FRONTEND, 'reference-image-library.html')));
  check('25. ...and the new table is not mapped onto it',
    !/@@map\("reference_images"\)/.test(model));
}

Promise.resolve(main()).then((code) => process.exit(code));
