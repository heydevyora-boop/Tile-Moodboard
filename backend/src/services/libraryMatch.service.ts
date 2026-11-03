/**
 * De'vyora Library -- reading a chosen reference room, and matching the
 * catalog to it.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: when a client has chosen a picture
 * from the library, that picture -- not the theme's generic description
 * -- is the primary visual guide. The tiles that end up in the generated
 * image have to be chosen FROM it.
 *
 * Nothing can choose from a picture it has not looked at, and the step
 * that picks the combination is a text prompt listing up to eighty
 * catalog rows (promptBuilder.service.ts). The tiles are words there and
 * will stay words: eighty photographs will not fit in one request, let
 * alone inside the sixty seconds this deployment allows.
 *
 * So the picture is turned into words ONCE, by one Gemini vision pass,
 * and those words are what the catalog is searched with. Two
 * consequences worth stating:
 *
 *   1. The reading is kept on the row (LibraryReference.visualProfile).
 *      The picture is immutable -- a library row's Drive file never
 *      changes -- so the reading cannot go stale, and a client
 *      generating twice from the same room does not pay for it twice.
 *
 *   2. The reading is used in TWO places, which is the whole point.
 *      Its dominant colour goes to the ranking engine as `colorTone`,
 *      so the eighty rows offered to the model are already drawn
 *      towards the reference's palette; and the full reading goes into
 *      the prompt, so the choice BETWEEN those rows is made against the
 *      picture rather than against a theme name.
 *
 * The picture itself is never replaced by these words. The image step
 * receives the real file (see DEVYORA_LIBRARY.md): composition,
 * lighting, perspective and mood come from the photograph, not from a
 * description of it.
 */

import { prisma } from '@db/connection';
import { geminiClient } from './gemini.service';
import { logger } from '@utils/logger';
import { isRealImageBuffer } from '@utils/fileSignature';
import { driveFileIdFromUrl } from './referenceImages.service';
import { isStarterId, starterById, STARTER_PATH } from './libraryStarters';

// ─────────────────────────────────────────────────────────────────────────
// What one reading holds
// ─────────────────────────────────────────────────────────────────────────

export interface LibraryVisualProfile {
  /** One or two sentences a person could read back and recognise. */
  summary: string;
  /**
   * The single colour this room is built on, named the way a tile is
   * named ("deep teal green", "warm cream"). This one is load-bearing:
   * it is handed to the ranking engine as `colorTone`, which is how the
   * reference reaches the catalog pool itself and not just the prompt.
   */
  dominantColour: string;
  /** Three to six colours, in the order they carry the room. */
  palette: string[];
  /** "zellige glazed ceramic", "honed travertine" -- what the surfaces are. */
  materials: string[];
  /** "small-format staggered", "star-and-cross", "wide plain field". */
  patterns: string[];
  /** "glossy", "matte", "polished", "textured". */
  finishes: string[];
  /** Tile formats the room reads as: "100x100 square", "600x1200". */
  formats: string[];
  /** "cool and quiet", "warm, low light, heavy contrast". */
  mood: string;
  /** What each surface of the room actually carries. */
  surfaces: { floor: string; walls: string; feature: string };
}

/** The reading, plus whether it had to be taken fresh. */
export interface ProfileReading {
  profile: LibraryVisualProfile | null;
  /** Null when it was read successfully; otherwise why it could not be. */
  error: string | null;
  /** True when this came off the row rather than from a Gemini call. */
  cached: boolean;
}

export interface ChosenReference {
  id: string;
  themeId: string;
  title: string;
  imageUrl: string;
  room: string | null;
  description: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// The picture's bytes
// ─────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Gemini is sent base64, which is 4 bytes per 3 of image, and this rides
 * inside a request that also carries eighty catalog rows. A library
 * picture is a room photograph, not a poster: six megabytes is generous
 * for one and small enough that the request cannot be the thing that
 * times out.
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** One attempt at a URL. Null means "not from here". */
async function fetchOnce(url: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      // The shape the <img> tag that already displays these pictures
      // sends. Drive answers a plain client differently.
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    // Drive hands a plain client an HTML sign-in page for a file it will
    // not serve, with a 200 and a cheerful content-type. Reading the
    // bytes is the only way to know, and sending that page to a vision
    // model would come back as a confident description of a login form.
    if (!isRealImageBuffer(bytes)) return null;
    const declared = (response.headers.get('content-type') || '').split(';')[0].trim();
    return {
      bytes,
      mimeType: declared.startsWith('image/') ? declared : 'image/jpeg',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reference picture's bytes.
 *
 * Two addresses are tried, because a Drive file has two and they fail
 * differently: the stored download URL, and the thumbnail endpoint,
 * which serves a bounded-size copy of the same file and is what the
 * gallery itself displays. A picture that cannot be had from either is
 * reported, not guessed at.
 */
export async function fetchReferenceImage(
  imageUrl: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const candidates = [imageUrl];
  const fileId = driveFileIdFromUrl(imageUrl);
  if (fileId) {
    // 2048px: the vision pass judges colour, pattern and finish, none of
    // which needs the original's full resolution, and the smaller copy
    // is both faster to fetch and cheaper to send. 1000 is the width the
    // gallery itself requests, kept as a second chance because it is the
    // one address these pictures are known to answer on.
    candidates.push(`https://drive.google.com/thumbnail?id=${fileId}&sz=w2048`);
    candidates.push(`https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`);
  }

  for (const candidate of candidates) {
    const got = await fetchOnce(candidate);
    if (got) return got;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// The vision pass
// ─────────────────────────────────────────────────────────────────────────

const READ_INSTRUCTIONS = `
You are the senior buyer for De'vyora, a tile and stone studio. A client has chosen the photograph below as the room they want. Your job is to write down what a tile buyer would need in order to walk the showroom and find the products that would build THIS room.

Describe only what is actually in the picture. Do not improve it, do not name a style period it does not show, and do not describe a room you think it was trying to be.

Return ONLY a JSON object (no markdown, no code fences, no commentary) with exactly these keys:

{
  "summary": string,
  "dominantColour": string,
  "palette": string[],
  "materials": string[],
  "patterns": string[],
  "finishes": string[],
  "formats": string[],
  "mood": string,
  "surfaces": { "floor": string, "walls": string, "feature": string }
}

How to fill each one:
- "summary": one or two sentences. What this room is, in a buyer's words.
- "dominantColour": the ONE colour the room is built on, named the way a tile is named — "deep teal green", "warm cream", "charcoal grey", "terracotta". Two or three words. Not a sentence, not a hex code, not a list. This single value is used to search the catalog, so it has to be the colour you would actually ask for at the counter.
- "palette": three to six colours, in the order they carry the room, most to least. Name them as tile colours.
- "materials": what the tiled surfaces actually are — "zellige glazed ceramic", "honed travertine", "polished marble with grey veining", "unglazed terracotta". Judge from the picture's own surfaces.
- "patterns": the layouts and motifs on those surfaces — "small-format staggered brick", "star-and-cross", "wide plain field", "vertical stack bond", "scalloped border at the dado". Say "plain, unpatterned field" when that is the truth; an invented motif is worse than none.
- "finishes": the light behaviour of those surfaces, from this list where it fits: glossy, polished, matte, satin, textured, honed. More than one is normal — a room usually has a matte floor and a glossier wall.
- "formats": the tile sizes the surfaces read as, in millimetres where you can judge it — "100x100 square", "600x1200 large format", "75x300 brick", "hexagon". Say "cannot tell from this view" rather than guessing a number.
- "mood": the light and the temperature of the room in a few words — "cool, quiet, high daylight", "warm, low lamplight, heavy contrast".
- "surfaces": what each one carries. "feature" is the one wall or plane the room makes its focus; write "none — no feature surface in this room" when there isn't one, which is a real and common answer.

Every string must be plain text. Every array must hold at least one entry. Never return null, and never return an empty string.
`.trim();

/** Trims a model string into something safe to put in a prompt. */
function line(value: unknown, limit = 240): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** A model array into a bounded list of clean strings. */
function list(value: unknown, max = 8, limit = 120): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    const text = line(entry, limit);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The model's answer, made into a LibraryVisualProfile or refused.
 *
 * Never trusted as it arrives. A reading with no dominant colour and no
 * palette is not a reading -- it would reach the ranking engine as an
 * empty `colorTone` and the prompt as a block of blank lines, which
 * reads to the model as "the reference holds nothing", the opposite of
 * the truth.
 */
export function normaliseProfile(raw: unknown): LibraryVisualProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const surfaces = (r.surfaces && typeof r.surfaces === 'object' && !Array.isArray(r.surfaces)
    ? r.surfaces
    : {}) as Record<string, unknown>;

  const profile: LibraryVisualProfile = {
    summary: line(r.summary, 400),
    dominantColour: line(r.dominantColour, 60),
    palette: list(r.palette, 6, 60),
    materials: list(r.materials, 6),
    patterns: list(r.patterns, 6),
    finishes: list(r.finishes, 6, 40),
    formats: list(r.formats, 6, 60),
    mood: line(r.mood, 160),
    surfaces: {
      floor: line(surfaces.floor, 240),
      walls: line(surfaces.walls, 240),
      feature: line(surfaces.feature, 240),
    },
  };

  // The two the rest of the system actually depends on.
  if (!profile.dominantColour && profile.palette.length === 0) return null;
  if (!profile.dominantColour) [profile.dominantColour] = profile.palette;

  return profile;
}

/** Whatever is on the row, if it is still a usable reading. */
function cachedProfile(stored: unknown): LibraryVisualProfile | null {
  if (!stored) return null;
  try {
    return normaliseProfile(stored);
  } catch {
    return null;
  }
}

/**
 * What the studio's eye reads in one reference picture.
 *
 * Cached on the row. The cache is best-effort in BOTH directions: a
 * database that has not had the migration applied has no column to read
 * or write, and that must cost a Gemini call rather than a failed
 * generation -- so both halves are wrapped and a failure is logged once,
 * not raised.
 */
export async function readVisualProfile(
  reference: ChosenReference,
  stored?: unknown,
): Promise<ProfileReading> {
  const existing = cachedProfile(stored);
  if (existing) return { profile: existing, error: null, cached: true };

  if (!(await geminiClient.isConfigured())) {
    return {
      profile: null,
      cached: false,
      error:
        'the Gemini key is not configured, so the reference picture could not be read',
    };
  }

  const image = await fetchReferenceImage(reference.imageUrl);
  if (!image) {
    return {
      profile: null,
      cached: false,
      error:
        `the reference picture could not be fetched from Drive (${reference.imageUrl}), `
        + 'so there was nothing to read',
    };
  }

  let profile: LibraryVisualProfile | null;
  try {
    const raw = await geminiClient.generateJSON<unknown>(READ_INSTRUCTIONS, {
      images: [{ mimeType: image.mimeType, data: image.bytes.toString('base64') }],
      // A description, not a design. Low, so two generations from the
      // same picture search the catalog for the same thing.
      temperature: 0.1,
    });
    profile = normaliseProfile(raw);
  } catch (err) {
    return {
      profile: null,
      cached: false,
      error: `reading the reference picture failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!profile) {
    return {
      profile: null,
      cached: false,
      error: 'the reference picture was read, but the reading came back with no palette in it',
    };
  }

  try {
    await prisma.libraryReference.update({
      where: { id: reference.id },
      data: {
        visualProfile: profile as unknown as object,
        visualReadAt: new Date(),
      },
    });
  } catch (err) {
    // The reading is good; only keeping it failed. Saying so once is
    // what tells an owner why every generation is paying for a vision
    // call -- the usual cause is the migration not having been run.
    logger.warn(
      `[library] could not store the reading for reference ${reference.id}, so it will be `
      + `read again next time: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { profile, error: null, cached: false };
}

// ─────────────────────────────────────────────────────────────────────────
// The reference, as the combination prompt needs it
// ─────────────────────────────────────────────────────────────────────────

/**
 * The block that goes into the tile-choosing prompt.
 *
 * It states the precedence out loud. The theme's own specification is in
 * that prompt too, several hundred words of it, and without a line
 * saying which wins, a model reconciling "Moroccan asks for blue and
 * green" with a reference room that is cream and terracotta will pick
 * the theme -- it is longer, more detailed and more emphatic. The
 * client's own chosen picture has to outrank it.
 */
export function referenceBriefBlock(
  reference: ChosenReference,
  profile: LibraryVisualProfile,
): string {
  const lines = [
    'THE CLIENT HAS CHOSEN A REFERENCE ROOM FROM THE DE’VYORA LIBRARY.',
    '',
    `Reference: "${reference.title}"${reference.room ? ` (${reference.room})` : ''}.`,
    reference.description ? `The studio's note on it: ${reference.description}` : '',
    '',
    'This is what that photograph holds. It was read from the picture itself, not from a theme:',
    `- In one line: ${profile.summary || '(not recorded)'}`,
    `- The colour it is built on: ${profile.dominantColour}`,
    `- Its palette, strongest first: ${profile.palette.join(', ') || '(not recorded)'}`,
    `- The materials on its surfaces: ${profile.materials.join('; ') || '(not recorded)'}`,
    `- Its patterns and layouts: ${profile.patterns.join('; ') || '(not recorded)'}`,
    `- Its finishes: ${profile.finishes.join(', ') || '(not recorded)'}`,
    `- The formats it reads as: ${profile.formats.join(', ') || '(not recorded)'}`,
    `- Its light and mood: ${profile.mood || '(not recorded)'}`,
    `- Its floor carries: ${profile.surfaces.floor || '(not recorded)'}`,
    `- Its walls carry: ${profile.surfaces.walls || '(not recorded)'}`,
    `- Its feature surface: ${profile.surfaces.feature || '(not recorded)'}`,
    '',
    'HOW TO USE IT -- this is the part that matters:',
    '- This reference room is THE PRIMARY VISUAL GUIDE for this board. The client pointed at it and said "that one". Every product you choose has to be defensible as a product that would help build THAT room.',
    '- Where the reference and the theme description disagree, THE REFERENCE WINS. The theme is written for the theme in general; the reference is the one room this client actually asked for. Do not pull the board back towards the theme’s usual palette because the theme section below is longer and more emphatic than this one.',
    '- Match on what a tile can carry: the colour, the pattern, the material, the finish and the format. Those five are the whole of the match. The room’s fittings, its furniture, its plants, its towels and its architecture are not products this studio sells and must not steer a single choice.',
    '- Pick the "base" for the reference’s own ground — the colour and finish its floor and plain walls carry. Pick the decorated role ("highlight", "accent" or "border") for the pattern and the contrast the reference actually shows. A reference with a plain, unpatterned field should get a quiet decorated piece, not a loud one bolted on to make the board look designed.',
    '- The generated image will be built ON this exact photograph, so the products you choose will be drawn into this room, at this camera, in this light. A product that would fight the reference’s light or its scale is the wrong product even when its colour is right.',
    '- Say in "reason_for_selection", for EVERY combination, which parts of the reference each product answers — name the colour, the pattern or the finish you matched it to. "Suits the reference" is not an answer.',
    '- If the listed stock genuinely cannot carry this reference, say that plainly in "reason_for_selection" and build the closest honest combination from what is there. Do not quietly substitute the theme’s usual palette and present it as a match.',
  ];

  return lines.filter((entry) => entry !== '').join('\n');
}

/**
 * The line the showroom sees when the picture could not be read.
 *
 * The reference is NOT dropped in that case -- it still goes to the
 * image step, which fetches the photograph itself and needs no reading.
 * What is lost is the tile matching, and that has to be said rather than
 * leaving a board that looks reference-matched and is not.
 */
export function unreadWarning(reference: ChosenReference, error: string): string {
  return (
    `The chosen reference room "${reference.title}" could not be read, so the products on `
    + `this board were chosen from the theme alone, not from that picture — ${error}. `
    + 'The picture is still used to generate the image itself, so the room, its light and its '
    + 'camera will match; the tiles in it may not.'
  );
}

/** The chosen reference, as the row holds it. Null when it is gone or unpublished. */
export async function loadReference(id: string): Promise<{
  reference: ChosenReference;
  stored: unknown;
} | null> {
  // A STARTER NEEDS NO DATABASE AND NO VISION CALL.
  //
  // It ships with the application, and it was drawn to a palette and a
  // pattern that are written down in libraryStarters.ts -- so its
  // reading is handed over already done. Two consequences worth
  // stating: tile matching from a starter works on a deployment with no
  // Gemini key at all, and it works before the migration has been run.
  if (isStarterId(id)) {
    const starter = starterById(id);
    if (!starter) return null;
    return {
      reference: {
        id: starter.id,
        themeId: starter.themeId,
        title: starter.title,
        imageUrl: `${STARTER_PATH}/${starter.file}`,
        room: starter.room,
        description: starter.description,
      },
      stored: starter.profile,
    };
  }

  // THE COLUMN MAY NOT BE THERE.
  //
  // visualProfile arrived in a later migration, and migrations are not
  // run by this project's deploy (vercel.json buildCommand is `prisma
  // generate` alone). Prisma selects every scalar field by default, so
  // on a database that has not had it applied this query fails on the
  // missing column -- and the client would be told their chosen
  // reference does not exist, which is both wrong and unfixable from
  // the page.
  //
  // So the fields the feature cannot do without are named explicitly in
  // the fallback, and the cache is simply skipped there. The reference
  // works; it is re-read on each generation until somebody runs the
  // migration, and readVisualProfile already logs that.
  const fields = {
    id: true,
    themeId: true,
    title: true,
    imageUrl: true,
    room: true,
    description: true,
  } as const;

  let row:
    | ({ id: string; themeId: string; title: string; imageUrl: string; room: string | null; description: string | null } & { visualProfile?: unknown })
    | null;

  try {
    row = await prisma.libraryReference.findFirst({
      where: { id, isActive: true },
      select: { ...fields, visualProfile: true },
    });
  } catch {
    row = await prisma.libraryReference.findFirst({
      where: { id, isActive: true },
      select: fields,
    });
  }

  if (!row) return null;

  return {
    reference: {
      id: row.id,
      themeId: row.themeId,
      title: row.title,
      imageUrl: row.imageUrl,
      room: row.room,
      description: row.description,
    },
    stored: row.visualProfile ?? null,
  };
}
