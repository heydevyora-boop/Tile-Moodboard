/**
 * The De'vyora Library's STARTER ROOMS.
 *
 * WHY THEY EXIST. A studio that has just deployed has an empty library:
 * nothing has been uploaded, and until Drive and the migration are in
 * place nothing can be. The page was therefore nine themes with nothing
 * behind any of them -- which is indistinguishable from a feature that
 * does not work, and is exactly what the owner reported seeing.
 *
 * So two reference rooms per theme ship WITH the application. They need
 * no database row and no Drive file: they are PNG files in the repo
 * (frontend/img/library/, drawn by test-scripts/generate_library_starters.js)
 * served by this backend at a fixed path.
 *
 * THEY ARE NOT A MOCK. A starter can be browsed, chosen, carried to the
 * mood board and generated from, exactly as an uploaded room can. What
 * it cannot be is deleted -- it is part of the application, not of the
 * studio's own library -- and the page labels it STARTER so nobody
 * mistakes a drawing for a room the studio photographed.
 *
 * AND THEY COME WITH THEIR READING ALREADY DONE. libraryMatch normally
 * spends a Gemini vision pass working out what a picture holds. For
 * these there is nothing to work out: they were drawn to a palette and
 * a pattern that are written down right here. So a starter costs no
 * vision call, and tile matching from one works even on a deployment
 * with no Gemini key at all.
 */

import type { LibraryVisualProfile } from './libraryMatch.service';

/** Where this backend serves the starter image files from. */
export const STARTER_PATH = '/static/library-starters';

/** Ids are prefixed so nothing can confuse one with a database row. */
export const STARTER_PREFIX = 'starter:';

export interface StarterRoom {
  id: string;
  themeId: string;
  title: string;
  room: string;
  description: string;
  /** The file under STARTER_PATH. */
  file: string;
  profile: LibraryVisualProfile;
}

/** What the two variants of every theme are: a dado, and a feature bay. */
const LAYOUTS = [
  {
    suffix: '1',
    name: 'Dado',
    describe: 'The pattern runs the full width of the wall to dado height, plain above it.',
  },
  {
    suffix: '2',
    name: 'Feature Bay',
    describe: 'The pattern is held to one bay behind the vanity, floor to ceiling, plain either side.',
  },
] as const;

/**
 * Each theme's reading, written from the drawing itself.
 *
 * `floorText` and `wallText` describe the dado layout; the feature-bay
 * layout swaps which surface carries the pattern, which is done below
 * rather than repeated here.
 */
const THEME_READINGS: Record<string, {
  title: string;
  summary: string;
  dominantColour: string;
  palette: string[];
  materials: string[];
  patterns: string[];
  finishes: string[];
  formats: string[];
  mood: string;
  floor: string;
  plain: string;
  figured: string;
}> = {
  british: {
    title: 'Heritage Green',
    summary: 'A panelled cloakroom in heritage green with brass, warm ivory above the rail.',
    dominantColour: 'heritage green',
    palette: ['heritage green', 'warm ivory', 'oxblood', 'antique brass'],
    materials: ['painted timber panelling', 'matt glazed ceramic', 'antique brass'],
    patterns: ['vertical bead-and-stile panelling', 'a rail at dado height', 'plain field above'],
    finishes: ['matte', 'satin'],
    formats: ['tall narrow panels', '600x600 floor'],
    mood: 'quiet, warm, low even daylight',
    floor: 'pale stone-effect squares in a plain grid',
    plain: 'warm ivory, unpatterned',
    figured: 'heritage green panelling under an oxblood rail, brass trim at its edges',
  },
  roman_touch: {
    title: 'Travertine Bath',
    summary: 'A warm travertine room in large blocks, banded and honed, with sand and terracotta.',
    dominantColour: 'warm travertine beige',
    palette: ['warm travertine beige', 'sand', 'muted terracotta', 'warm limestone'],
    materials: ['honed travertine', 'warm limestone'],
    patterns: ['large running-bond blocks', 'horizontal banding in the stone'],
    finishes: ['honed', 'matte'],
    formats: ['600x300 blocks', '600x600 floor'],
    mood: 'warm, still, soft side-light',
    floor: 'warm limestone squares, plain',
    plain: 'pale limestone, unpatterned',
    figured: 'honed travertine laid in large running-bond blocks with visible banding',
  },
  floral: {
    title: 'Blush Botanical',
    summary: 'A blush and sage room with a repeating six-petal motif on ivory.',
    dominantColour: 'blush pink',
    palette: ['blush pink', 'sage green', 'ivory', 'soft rose'],
    materials: ['glossy glazed ceramic', 'matt ivory ceramic'],
    patterns: ['a six-petal rosette in repeat', 'plain ivory field'],
    finishes: ['glossy', 'matte'],
    formats: ['150x150 decorated', '600x600 floor'],
    mood: 'soft, bright, high diffuse daylight',
    floor: 'ivory squares, plain',
    plain: 'soft ivory, unpatterned',
    figured: 'a blush and sage rosette repeat on an ivory ground',
  },
  tropical: {
    title: 'Palm House',
    summary: 'Palm green and teal fronds over a sand ground, with rattan warmth.',
    dominantColour: 'palm green',
    palette: ['palm green', 'teal', 'sand', 'warm rattan'],
    materials: ['glossy glazed ceramic', 'textured sand-toned ceramic'],
    patterns: ['scattered palm fronds', 'plain sand field'],
    finishes: ['glossy', 'textured'],
    formats: ['200x200 decorated', '600x600 floor'],
    mood: 'bright, warm, strong daylight',
    floor: 'sand-toned squares, plain',
    plain: 'warm sand, unpatterned',
    figured: 'palm fronds in green and teal scattered across a sand ground',
  },
  geometrical: {
    title: 'Graphite Triangles',
    summary: 'Ivory, graphite and terracotta triangles in a tight alternating grid.',
    dominantColour: 'graphite grey',
    palette: ['graphite grey', 'ivory', 'terracotta'],
    materials: ['matt porcelain', 'glossy glazed ceramic'],
    patterns: ['alternating half-square triangles', 'a tight repeating grid'],
    finishes: ['matte', 'glossy'],
    formats: ['100x100 square', '600x600 floor'],
    mood: 'cool, graphic, even light',
    floor: 'ivory squares, plain',
    plain: 'ivory, unpatterned',
    figured: 'graphite and terracotta triangles alternating across an ivory ground',
  },
  metallic: {
    title: 'Pearl & Gunmetal',
    summary: 'A brushed metallic wall running pearl to gunmetal, banded in champagne.',
    dominantColour: 'gunmetal grey',
    palette: ['gunmetal grey', 'pearl', 'champagne'],
    materials: ['brushed metallic porcelain', 'polished champagne trim'],
    patterns: ['vertical brushed grain', 'narrow champagne banding'],
    finishes: ['polished', 'glossy'],
    formats: ['300x600 vertical', '600x600 floor'],
    mood: 'cool, reflective, directional light',
    floor: 'pearl-grey squares, plain',
    plain: 'pearl, unpatterned',
    figured: 'brushed metal running pearl to gunmetal, banded vertically in champagne',
  },
  rustic: {
    title: 'Clay & Lime',
    summary: 'Uneven clay and terracotta brick over lime plaster, ochre warmth throughout.',
    dominantColour: 'terracotta clay',
    palette: ['terracotta clay', 'ochre', 'lime plaster', 'earthy stone'],
    materials: ['unglazed terracotta', 'lime plaster', 'rough-cut clay brick'],
    patterns: ['irregular running-bond brick', 'a hand-laid, uneven face'],
    finishes: ['matte', 'textured'],
    formats: ['75x300 brick', '600x600 floor'],
    mood: 'warm, earthy, low afternoon light',
    floor: 'clay-toned squares, plain',
    plain: 'lime plaster, unpatterned',
    figured: 'uneven terracotta brick in running bond, each face a slightly different tone',
  },
  moroccan: {
    title: 'Cobalt Zellige',
    summary: 'Cobalt and saffron eight-point stars on warm ivory, with brass trim.',
    dominantColour: 'cobalt blue',
    palette: ['cobalt blue', 'saffron', 'warm ivory', 'brass'],
    materials: ['zellige glazed ceramic', 'warm ivory glazed ceramic', 'brass'],
    patterns: ['eight-point star-and-cross in repeat', 'plain ivory field'],
    finishes: ['glossy', 'matte'],
    formats: ['100x100 square', '600x600 floor'],
    mood: 'cool, bright, high side-light',
    floor: 'warm ivory squares, plain',
    plain: 'warm ivory, unpatterned',
    figured: 'cobalt and saffron eight-point stars in tight repeat on warm ivory',
  },
  black_white: {
    title: 'Ash Checker',
    summary: 'A charcoal and ash checkerboard on ivory, nothing else.',
    dominantColour: 'charcoal black',
    palette: ['charcoal black', 'ivory', 'ash grey'],
    materials: ['polished porcelain', 'matt porcelain'],
    patterns: ['a checkerboard in charcoal and ash', 'plain ivory field'],
    finishes: ['polished', 'matte'],
    formats: ['100x100 square', '600x600 floor'],
    mood: 'cool, graphic, even light',
    floor: 'ivory squares, plain',
    plain: 'ivory, unpatterned',
    figured: 'a charcoal and ash checkerboard on ivory',
  },
};

/** slug, for the file name. Kept here so this module needs no theme file read. */
const SLUGS: Record<string, string> = {
  british: 'british',
  roman_touch: 'roman-touch',
  floral: 'floral',
  tropical: 'tropical',
  geometrical: 'geometrical',
  metallic: 'metallic',
  rustic: 'rustic',
  moroccan: 'moroccan',
  black_white: 'black-white',
};

function build(): StarterRoom[] {
  const rooms: StarterRoom[] = [];

  for (const [themeId, reading] of Object.entries(THEME_READINGS)) {
    for (const layout of LAYOUTS) {
      const dado = layout.suffix === '1';
      rooms.push({
        id: `${STARTER_PREFIX}${SLUGS[themeId]}-${layout.suffix}`,
        themeId,
        title: `${reading.title} — ${layout.name}`,
        room: 'Bathroom',
        description: `${reading.summary} ${layout.describe}`,
        file: `${SLUGS[themeId]}-${layout.suffix}.png`,
        profile: {
          summary: `${reading.summary} ${layout.describe}`,
          dominantColour: reading.dominantColour,
          palette: reading.palette,
          materials: reading.materials,
          patterns: reading.patterns,
          finishes: reading.finishes,
          formats: reading.formats,
          mood: reading.mood,
          surfaces: {
            floor: reading.floor,
            // In the dado layout the pattern IS the lower wall; in the
            // feature bay the walls either side are plain and the bay
            // carries it. Saying which is which is the whole reason a
            // board can put the right product in the right role.
            walls: dado
              ? `${reading.figured} to dado height, ${reading.plain} above`
              : reading.plain,
            feature: dado
              ? 'none — the pattern runs the full width rather than concentrating on one plane'
              : `${reading.figured}, floor to ceiling in one bay behind the vanity`,
          },
        },
      });
    }
  }

  return rooms;
}

export const STARTER_ROOMS: StarterRoom[] = build();

const BY_ID = new Map(STARTER_ROOMS.map((room) => [room.id, room]));

/** True for an id that names a starter rather than a database row. */
export function isStarterId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(STARTER_PREFIX);
}

export function starterById(id: string): StarterRoom | null {
  return BY_ID.get(id) ?? null;
}

export function startersForTheme(themeId: string): StarterRoom[] {
  return STARTER_ROOMS.filter((room) => room.themeId === themeId);
}

/** How many starters each theme has, to add to the gallery's counts. */
export function starterCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of STARTER_ROOMS) counts[room.themeId] = (counts[room.themeId] ?? 0) + 1;
  return counts;
}

/**
 * The starter as the gallery renders it, shaped like a LibraryReference
 * row so the page needs no second code path.
 *
 * `isStarter` is what the page keys its STARTER badge and its missing
 * REMOVE button off -- the one place the two kinds differ on screen.
 */
export function asReference(room: StarterRoom) {
  return {
    id: room.id,
    themeId: room.themeId,
    title: room.title,
    imageUrl: `${STARTER_PATH}/${room.file}`,
    driveFileId: '',
    room: room.room,
    description: room.description,
    isActive: true,
    sortOrder: 0,
    uploadedById: null,
    uploadedBy: null,
    createdAt: null,
    updatedAt: null,
    isStarter: true,
  };
}
