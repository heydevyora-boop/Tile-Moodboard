/**
 * The design themes, as the COMBINATION step needs them.
 *
 * The ranking engine already scores a tile against the theme's finishes,
 * colour families and types (tileRecommendation.service.ts,
 * STYLE_PROFILES). What reached the model that PICKS the combination was
 * only the theme's name -- "Theme: Moroccan, with Ivory Matte grout." --
 * plus a sentence listing the nine names. So the model had to recall
 * what Moroccan means in order to choose tiles for it, which is the same
 * fault the room generator had before the description was sent there.
 *
 * These descriptions are the catalog owner's own words, and they are the
 * SAME TEXT the Python generator uses (catalog_processor/app/themes.py).
 * Two runtimes cannot share one module here -- Node and Python are
 * separate functions on Vercel with no shared disk and no shared
 * package -- so the text is in both places and
 * theme_text_matches_test.ts reads themes.py and asserts every label,
 * palette and description is identical, character for character. Drift
 * fails the suite rather than quietly giving the two halves of the
 * system different ideas of what a theme is.
 */

export interface ThemeProfile {
  label: string;
  palette: string;
  description: string;
}

/** Keys are normalised labels: lower case, no separators, "&" spelled out. */
export const THEMES: Record<string, ThemeProfile> = {
  british: {
    label: 'British',
    palette: 'Heritage Green, Oxblood & Brass',
    description:
      'A classic British heritage bathroom: deep forest-green tiles, rich '
      + 'oxblood accents, antique brass fixtures and elegant Victorian '
      + 'detailing. Vintage mirrors, refined patterns, and timeless luxury '
      + 'with a sophisticated country-house aesthetic.',
  },
  'roman touch': {
    label: 'Roman Touch',
    palette: 'Travertine, Stone & Terracotta',
    description:
      'A Roman-inspired bathroom: warm travertine stone, natural limestone '
      + 'textures, arched niches and sculptural stone basins. Subtle '
      + 'terracotta accents, soft warm lighting and balanced architectural '
      + 'proportions, for a luxurious Mediterranean spa feel.',
  },
  floral: {
    label: 'Floral',
    palette: 'Blush, Sage & Ivory',
    description:
      'A floral-inspired bathroom: delicate flower patterns, botanical '
      + 'motifs, blush-pink surfaces, sage-green accents and ivory finishes. '
      + 'Floral tiles or wallpaper carry the focal point, with elegant '
      + 'fixtures and a soft, romantic, garden-inspired atmosphere.',
  },
  tropical: {
    label: 'Tropical',
    palette: 'Palm, Teal & Sand',
    description:
      'A tropical bathroom: palm-leaf patterns, lush green plants, teal '
      + 'accents and sand-toned natural stone. Organic textures, natural '
      + 'wood and abundant greenery, for a fresh, relaxing resort-style '
      + 'environment.',
  },
  geometrical: {
    label: 'Geometrical',
    palette: 'Ivory, Graphite & Terracotta',
    description:
      'A contemporary bathroom with bold geometric tiles, clean lines and '
      + 'structured patterns in ivory, graphite and terracotta. Hexagons, '
      + 'angular motifs or repeating shapes as feature elements, with visual '
      + 'balance and a modern architectural aesthetic.',
  },
  metallic: {
    label: 'Metallic',
    palette: 'Pearl, Gunmetal & Champagne',
    description:
      'A sophisticated metallic bathroom: pearl-toned surfaces, '
      + 'champagne-gold fittings, gunmetal accents and subtle reflective '
      + 'finishes. Elegant stone textures, sleek fixtures and carefully '
      + 'balanced metallic detail, for a premium contemporary look.',
  },
  rustic: {
    label: 'Rustic',
    palette: 'Natural Clay, Terracotta & Ochre',
    description:
      'An earthy rustic bathroom: terracotta tiles, natural clay textures, '
      + 'ochre accents and warm wooden elements. Handmade finishes, organic '
      + 'stone basins and imperfect natural textures, for an authentic, warm, '
      + 'handcrafted aesthetic.',
  },
  moroccan: {
    label: 'Moroccan',
    palette: 'Zellige, Cobalt & Saffron',
    description:
      'A Moroccan-inspired bathroom: handcrafted zellige tiles, rich '
      + 'cobalt-blue surfaces, saffron-yellow accents and decorative mosaic '
      + 'patterns. Arched niches, intricate tilework and brass details, for a '
      + 'vibrant, exotic, artisanal atmosphere.',
  },
  'black and white': {
    label: 'Black & White',
    palette: 'Ivory, Ash & Charcoal',
    description:
      'A monochrome bathroom in ivory, ash and charcoal: high contrast '
      + 'between pale fields and dark detail, graphic borders or chequer '
      + 'work, and fittings in a single finish. No third colour anywhere.',
  },
};

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

/** The theme a brief names, or null when it names none this knows. */
export function describeTheme(value: unknown): ThemeProfile | null {
  return THEMES[themeKey(value)] ?? null;
}

/**
 * The theme as prompt text, or "" when the brief names none.
 *
 * The descriptions are written for a bathroom, because that is the room
 * the catalog is built around. What they are being used for here is the
 * SURFACES -- colour, pattern, finish, contrast -- which is the part
 * that holds whatever room the client chose, so the caller says that.
 */
export function themeBrief(value: unknown): string {
  const theme = describeTheme(value);
  if (!theme) return '';
  return `${theme.label} — ${theme.palette}.\n${theme.description}`;
}
