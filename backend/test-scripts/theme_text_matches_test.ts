/**
 * One source of truth for the themes, and both halves read it.
 *
 * The theme text used to live twice: once for the step that PICKS the
 * tiles and once for the step that DRAWS them. A board picked for one
 * idea of "Moroccan" and rendered for another is worse than either idea
 * on its own, so the text now lives in shared/themes.json and both
 * runtimes read that file.
 *
 * This asserts the arrangement actually holds: that the file is the
 * source, that the Node reader returns exactly what is in it, that the
 * Python reader is pointed at the same file, and that neither has a
 * table of its own to drift from.
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

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'shared', 'themes.json');
const document = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) as {
  themes: Record<string, {
    id: string; label: string; palette: string; slug: string;
    identity: string; mandatory: string[]; avoid: string[]; success: string;
  }>;
};
const onDisk = document.themes;

// All nine themes now carry a strict configuration.
const SPECIFIED = ['british', 'roman touch', 'floral', 'tropical', 'geometrical',
  'metallic', 'rustic', 'moroccan', 'black and white'];

// Eight of them have photographs on disk; Black & White does not yet, and
// nothing may pretend otherwise.
const WITH_PHOTOGRAPHS = SPECIFIED.filter((k) => k !== 'black and white');

check('1. shared/themes.json is readable and holds themes', Object.keys(onDisk).length >= 9, Object.keys(onDisk).length);
check('2. All eight specified themes are configured',
  SPECIFIED.every((k) => onDisk[k]), SPECIFIED.filter((k) => !onDisk[k]));
check('3. The Node reader returns exactly what the file holds',
  JSON.stringify(THEMES) === JSON.stringify(onDisk));

for (const key of SPECIFIED) {
  const theme = onDisk[key];
  check(`4. ${theme.label}: has an explicit id`, Boolean(theme.id), theme.id);
  check(`5. ${theme.label}: has a core palette`, theme.palette.length > 10, theme.palette);
  check(`6. ${theme.label}: has a visual identity, not a one-liner`, theme.identity.length > 250, theme.identity.length);
  check(`7. ${theme.label}: has mandatory characteristics`, theme.mandatory.length >= 4, theme.mandatory.length);
  check(`8. ${theme.label}: has prohibited deviations`, theme.avoid.length >= 4, theme.avoid.length);
  check(`9. ${theme.label}: has a success condition`, theme.success.length > 40, theme.success);
  check(`10. ${theme.label}: names its reference folder`, Boolean(theme.slug), theme.slug);
  const folder = path.join(ROOT, 'catalog_processor', 'assets', 'theme_references', theme.slug);
  const photographs = fs.existsSync(folder) ? fs.readdirSync(folder).length : 0;
  if (WITH_PHOTOGRAPHS.includes(key)) {
    check(`11. ${theme.label}: that folder exists with photographs`, photographs >= 3, photographs);
  } else {
    // Honest absence: it must be MARKED as pending, not quietly empty,
    // and it must not be pointed at another theme's folder.
    check(`11. ${theme.label}: has no photographs, and says so`,
      photographs === 0 && (theme as { referencesPending?: boolean }).referencesPending === true,
      { photographs, slug: theme.slug });
  }
}

// ── no second table anywhere ────────────────────────────────────────
const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'themes.service.ts'), 'utf8');
check('12. themes.service.ts holds no theme text of its own',
  !/zellige|travertine|oxblood|champagne-gold|palm-leaf/i.test(service));
check('13. ...and reads shared/themes.json', service.includes("'shared', 'themes.json'"));

// themes.py explains in prose WHY this exists ("...rather than zellige,
// arches and brasswork"), so the check is for a theme TABLE, not for the
// vocabulary: no inline entry may define a theme's rules.
const python = fs.readFileSync(path.join(ROOT, 'catalog_processor', 'app', 'themes.py'), 'utf8');
check('14. themes.py holds no theme table of its own',
  !/"mandatory"\s*:\s*\[/.test(python) && !/"identity"\s*:\s*"/.test(python));
check('15. ...and reads the same shared/themes.json',
  python.includes('"shared" / "themes.json"'));

// ── the lookup behaves the same way themes.py does ──────────────────
check('16. A label is matched however it is spelled',
  describeTheme('roman-touch') === describeTheme('ROMAN TOUCH')
  && describeTheme('Roman_Touch') === describeTheme('Roman Touch')
  && describeTheme('Roman Touch') !== null);
check('17. ...including the ampersand',
  describeTheme('Black & White') === describeTheme('black and white') && describeTheme('Black & White') !== null);
check('18. A theme nobody named yields nothing, not a guess',
  describeTheme('') === null && describeTheme('Brutalist') === null && describeTheme(undefined) === null);
check('19. themeKey normalises the way themes.py does',
  themeKey('  Roman-Touch ') === 'roman touch' && themeKey('Black & White') === 'black and white');
check('20. themeBrief is empty for an unknown theme, not invented', themeBrief('Brutalist') === '');
check('21. ...and carries palette, identity, rules and prohibitions for a known one',
  themeBrief('Moroccan').includes('Cobalt blue, saffron')
  && themeBrief('Moroccan').includes('zellige')
  && themeBrief('Moroccan').includes('MANDATORY for this theme')
  && themeBrief('Moroccan').includes('FORBIDDEN in this theme')
  && themeBrief('Moroccan').includes('IT IS RIGHT WHEN'));

// ── the eight must not read as one another ──────────────────────────
const marker: Record<string, string> = {
  british: 'oxblood', 'roman touch': 'travertine', floral: 'blush-pink', tropical: 'palm-leaf',
  geometrical: 'hexagonal', metallic: 'champagne-gold', rustic: 'ochre', moroccan: 'zellige',
  'black and white': 'monochromatic',
};
for (const [key, word] of Object.entries(marker)) {
  const own = themeBrief(onDisk[key].label).toLowerCase();
  check(`22. ${onDisk[key].label} carries its own marker ("${word}")`, own.includes(word));
  const foreign = Object.entries(marker).filter(([k]) => k !== key)
    .filter(([, w]) => own.includes(w)).map(([k]) => k);
  check(`23. ${onDisk[key].label} carries no other theme's marker`, foreign.length === 0, foreign);
}

// ── every theme is reachable by the id it was given ─────────────────
for (const key of SPECIFIED) {
  const theme = onDisk[key];
  check(`24. ${theme.label} is reachable by its id "${theme.id}"`,
    describeTheme(theme.id) === describeTheme(theme.label) && describeTheme(theme.id) !== null,
    theme.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
