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
import { ROOM_LIST, describeRoom } from './rooms.service';

/** Where this backend serves the starter image files from. */
export const STARTER_PATH = '/static/library-starters';

/** Ids are prefixed so nothing can confuse one with a database row. */
export const STARTER_PREFIX = 'starter:';

export interface StarterRoom {
  id: string;
  themeId: string;
  /** A room id from shared/rooms.json -- the hierarchy's second level. */
  roomId: string;
  title: string;
  /** The room's label, as the gallery prints it. */
  room: string;
  description: string;
  /** The file under STARTER_PATH. */
  file: string;
  profile: LibraryVisualProfile;
}

/**
 * The lay-up every starter uses: a dado, with the pattern running the
 * full width of the wall and plain above it.
 *
 * ONE PER THEME PER ROOM, not two per theme. The library is a Theme ->
 * Room hierarchy now, so a second variant of the same room matters far
 * less than having every room filled at all -- nine themes times five
 * rooms is forty-five cells, and thirty-six of them would otherwise be
 * empty.
 *
 * The dado is the layout that reads as a tiled room in every room type.
 * A floor-to-ceiling feature bay behind a bed or a sofa looks like a
 * mistake rather than a scheme.
 */
const LAYOUT_NOTE =
  'The pattern runs the full width of the wall to dado height, plain above it.';

/**
 * ...except outdoors, where there is no wall to run a dado up. A
 * balcony is a parapet, the sky above it and a floor, so the pattern
 * fills the parapet and that is the whole of it.
 *
 * Saying this correctly matters more than it looks: the reading is what
 * the tile-matching step searches the catalog WITH, and a board told to
 * answer "plain above dado height" on a surface that has no above will
 * pick a product for a wall that is not there.
 */
const OUTDOOR_LAYOUT_NOTE =
  'The pattern fills the parapet, with open sky above it and an outdoor floor below.';

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
  const made: StarterRoom[] = [];

  for (const [themeId, reading] of Object.entries(THEME_READINGS)) {
    for (const room of ROOM_LIST) {
      const note = room.outdoor ? OUTDOOR_LAYOUT_NOTE : LAYOUT_NOTE;

      made.push({
        id: `${STARTER_PREFIX}${SLUGS[themeId]}-${room.slug}`,
        themeId,
        roomId: room.id,
        // "Cobalt Zellige Kitchen" -- the theme's own name for its
        // scheme, then the room it is drawn as.
        title: `${reading.title} ${room.label}`,
        room: room.label,
        description: `${reading.summary} ${note}`,
        file: `${SLUGS[themeId]}-${room.slug}.png`,
        profile: {
          summary: `A ${room.label.toLowerCase()}. ${reading.summary} ${note}`,
          dominantColour: reading.dominantColour,
          palette: reading.palette,
          materials: reading.materials,
          patterns: reading.patterns,
          finishes: reading.finishes,
          formats: reading.formats,
          mood: reading.mood,
          surfaces: {
            floor: room.outdoor
              ? `${reading.floor}, laid as an outdoor floor`
              : reading.floor,
            // The pattern IS the lower wall in this lay-up -- or the
            // whole parapet, outdoors, where there is nothing above it
            // but sky. Saying which is the whole reason a board can put
            // the right product in the right role: the base answers the
            // plain field and the floor, the decorated piece answers
            // this.
            walls: room.outdoor
              ? `a chest-high parapet carrying ${reading.figured}, open sky above it`
              : `${reading.figured} to dado height, ${reading.plain} above`,
            feature:
              'none \u2014 the pattern runs the full width rather than concentrating '
              + 'on one plane',
          },
        },
      });
    }
  }

  return made;
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

/**
 * A theme's starters, optionally narrowed to one room.
 *
 * An unrecognised roomId returns nothing rather than everything: it
 * means the caller asked for a room that does not exist, and answering
 * with the whole theme would quietly show a Kitchen's pictures under a
 * heading that says something else.
 */
export function startersForTheme(themeId: string, roomId?: unknown): StarterRoom[] {
  const inTheme = STARTER_ROOMS.filter((room) => room.themeId === themeId);
  if (!roomId) return inTheme;

  const room = describeRoom(roomId);
  if (!room) return [];
  return inTheme.filter((entry) => entry.roomId === room.id);
}

/** How many starters each theme has, to add to the gallery's counts. */
export function starterCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of STARTER_ROOMS) counts[room.themeId] = (counts[room.themeId] ?? 0) + 1;
  return counts;
}

/** How many starters one theme has in each room, for its room list. */
export function starterRoomCounts(themeId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of STARTER_ROOMS) {
    if (room.themeId !== themeId) continue;
    counts[room.roomId] = (counts[room.roomId] ?? 0) + 1;
  }
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
    roomId: room.roomId,
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
