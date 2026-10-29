/**
 * The design themes, as the COMBINATION step needs them.
 *
 * The ranking engine already scores a tile against the theme's finishes,
 * colour families and types (tileRecommendation.service.ts,
 * STYLE_PROFILES). What reached the model that PICKS the combination was
 * only the theme's name -- "Theme: Moroccan, with Ivory Matte grout." --
 * so the model had to recall what Moroccan means in order to choose
 * tiles for it. That is the same fault the image generator had before
 * its specification was sent there.
 *
 * THE SOURCE OF TRUTH IS shared/themes.json, which the Python generator
 * reads too (catalog_processor/app/themes.py). Node and Python run as
 * separate functions on Vercel with no shared disk and no shared
 * package -- they cannot import one module, but they can read one file,
 * and vercel.json bundles it into both. One file means the step that
 * picks the tiles and the step that draws them cannot hold different
 * ideas of what a theme is.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ThemeProfile {
  id: string;
  label: string;
  palette: string;
  slug: string;
  identity: string;
  mandatory: string[];
  avoid: string[];
  success: string;
  aliases?: string[];
  /** True when this theme has no reference photographs yet. */
  referencesPending?: boolean;
}

/**
 * Where the config sits relative to the compiled output.
 *
 * Several candidates because this runs from src/ under ts-node, from
 * dist/ after a build, and from a Vercel bundle -- and a theme table
 * that silently comes back empty would produce exactly the generic
 * board this file exists to prevent.
 */
const CANDIDATES = [
  path.join(__dirname, '..', '..', '..', 'shared', 'themes.json'),
  path.join(__dirname, '..', '..', '..', '..', 'shared', 'themes.json'),
  path.join(process.cwd(), 'shared', 'themes.json'),
  path.join(process.cwd(), '..', 'shared', 'themes.json'),
];

function load(): Record<string, ThemeProfile> {
  for (const candidate of CANDIDATES) {
    try {
      const document = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { themes?: Record<string, ThemeProfile> };
      if (document.themes && Object.keys(document.themes).length > 0) return document.themes;
    } catch {
      // Not here; try the next.
    }
  }
  // LOUD, but not fatal. Throwing here would take the whole mood-board
  // service down rather than one feature, and a client who asked for a
  // board would get an error instead of a board. An empty table puts
  // every theme on the path an unrecognised theme already takes: the
  // prompt says nothing about a theme rather than inventing one.
  //
  // It must never fail silently -- a combination step that quietly
  // knows no themes picks tiles against nothing at all.
  console.error(
    '[themes] THE THEME CONFIGURATION (shared/themes.json) COULD NOT BE FOUND. Every board '
    + 'will be composed WITHOUT its theme until this is fixed. On Vercel it is bundled by the '
    + `includeFiles entry in vercel.json. Looked in: ${CANDIDATES.join(', ')}`,
  );
  return {};
}

export const THEMES: Record<string, ThemeProfile> = load();

/**
 * Every name a theme answers to.
 *
 * The key is what the wizard's label normalises to. A theme may also
 * declare aliases, for an id that normalises differently -- "Black &
 * White" becomes "black and white", while its id `black_white` becomes
 * "black white", and both have to find the same theme.
 */
const BY_NAME: Record<string, ThemeProfile> = (() => {
  const index: Record<string, ThemeProfile> = {};
  for (const [key, theme] of Object.entries(THEMES)) {
    index[key] = theme;
    if (theme.id) index[themeKey(theme.id)] = theme;
    for (const alias of theme.aliases ?? []) index[themeKey(alias)] = theme;
  }
  delete index[''];
  return index;
})();

/** The same normalisation themes.py uses, so one label cannot mean two things. */
export function themeKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** The theme a brief names, by label, id or alias; null when it names none. */
export function describeTheme(value: unknown): ThemeProfile | null {
  return BY_NAME[themeKey(value)] ?? null;
}

/**
 * The theme as prompt text for the step that CHOOSES the products.
 *
 * The identity and the rules are written for a whole room, because that
 * is what the image step draws. What a TILE can carry is the surfaces --
 * colour, pattern, finish, contrast -- so the caller says which part of
 * this applies to the products and which part belongs to the room.
 */
export function themeBrief(value: unknown): string {
  const theme = describeTheme(value);
  if (!theme) return '';

  const lines = [
    `${theme.label} — ${theme.palette}.`,
    '',
    theme.identity,
    '',
    'MANDATORY for this theme:',
    ...theme.mandatory.map((rule) => `- ${rule}`),
    '',
    'FORBIDDEN in this theme:',
    ...theme.avoid.map((item) => `- ${item}`),
    '',
    `IT IS RIGHT WHEN: ${theme.success}`,
  ];
  return lines.join('\n');
}
