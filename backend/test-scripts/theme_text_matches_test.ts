/**
 * The two halves of the system must mean the same thing by a theme.
 *
 * The theme descriptions exist twice: in themes.service.ts, which the
 * COMBINATION step reads, and in catalog_processor/app/themes.py, which
 * the IMAGE step reads. They cannot share a module -- Node and Python
 * are separate functions on Vercel with no shared disk and no shared
 * package -- so this reads the Python file and asserts the text is
 * identical, character for character.
 *
 * If someone edits one and not the other, this fails. That is the whole
 * point: a board picked for one idea of "Moroccan" and rendered for
 * another is worse than either idea on its own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { THEMES, describeTheme, themeBrief, themeKey } from '@services/themes.service';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass += 1; console.log(`OK   ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

/** The Python table, read as text — no Python runtime needed. */
function pythonThemes(): Record<string, { label: string; palette: string; description: string }> {
  const file = path.join(__dirname, '..', '..', 'catalog_processor', 'app', 'themes.py');
  const source = fs.readFileSync(file, 'utf8');
  const out: Record<string, { label: string; palette: string; description: string }> = {};

  // Each entry is   "key": { "label": ..., "palette": ..., "slug": ..., "description": ( ... ) },
  const entry = /"([^"]+)":\s*\{\s*"label":\s*"([^"]*)",\s*"palette":\s*"([^"]*)",\s*"slug":\s*"[^"]*",\s*"description":\s*\(([\s\S]*?)\n\s*\),\s*\n\s*\}/g;
  for (const match of source.matchAll(entry)) {
    // Python implicit string concatenation: join the quoted pieces.
    const description = [...match[4].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((piece) => piece[1].replace(/\\"/g, '"'))
      .join('');
    out[match[1]] = { label: match[2], palette: match[3], description };
  }
  return out;
}

const python = pythonThemes();

check('1. The Python theme table was read', Object.keys(python).length >= 9, Object.keys(python));
check('2. Both halves hold the same themes',
  JSON.stringify(Object.keys(python).sort()) === JSON.stringify(Object.keys(THEMES).sort()),
  { python: Object.keys(python).sort(), node: Object.keys(THEMES).sort() });

for (const [key, py] of Object.entries(python)) {
  const ts = THEMES[key];
  if (!ts) { check(`3. "${key}" exists on the Node side`, false); continue; }
  check(`3. ${py.label}: the label matches`, ts.label === py.label, { ts: ts.label, py: py.label });
  check(`4. ${py.label}: the palette matches`, ts.palette === py.palette, { ts: ts.palette, py: py.palette });
  check(`5. ${py.label}: the description matches, character for character`,
    ts.description === py.description,
    ts.description === py.description ? '' : { ts: ts.description.slice(0, 120), py: py.description.slice(0, 120) });
}

// ── the lookup behaves the same way themes.py does ──────────────────
check('6. A label is matched however it is spelled',
  describeTheme('roman-touch') === describeTheme('ROMAN TOUCH')
  && describeTheme('Roman_Touch') === describeTheme('Roman Touch')
  && describeTheme('Roman Touch') !== null);
check('7. ...including the ampersand', describeTheme('Black & White') === describeTheme('black and white')
  && describeTheme('Black & White') !== null);
check('8. A theme nobody named yields nothing, not a guess',
  describeTheme('') === null && describeTheme('Brutalist') === null && describeTheme(undefined) === null);
check('9. themeKey normalises the way themes.py does',
  themeKey('  Roman-Touch ') === 'roman touch' && themeKey('Black & White') === 'black and white');
check('10. themeBrief is empty for an unknown theme, not invented', themeBrief('Brutalist') === '');
check('11. ...and carries label, palette and description for a known one',
  themeBrief('Moroccan').includes('Moroccan — Zellige, Cobalt & Saffron')
  && themeBrief('Moroccan').includes('zellige'),
  themeBrief('Moroccan').slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
