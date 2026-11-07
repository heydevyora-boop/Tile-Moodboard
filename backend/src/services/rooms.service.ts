/**
 * The room types, as the De'vyora Library's Theme -> Room hierarchy
 * needs them.
 *
 * THE SOURCE OF TRUTH IS shared/rooms.json, read the same way
 * themes.service reads shared/themes.json and for the same reason: one
 * file, so the part that stores a picture and the part that browses for
 * it cannot hold different ideas of what a room is.
 *
 * AND THEY ARE THE SYSTEM'S OWN ROOMS. Each entry carries `wizard` --
 * the label the mood-board wizard uses -- and `space`, the key Python's
 * describe_space matches on. A library room type that did not line up
 * with those would let a client choose a Kitchen reference and get a
 * bathroom back, which is the one thing this hierarchy exists to make
 * impossible.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RoomProfile {
  id: string;
  label: string;
  slug: string;
  /** The mood-board wizard's own name for this room. */
  wizard: string;
  /** The key Python's describe_space matches on. */
  space: string;
  blurb: string;
  /**
   * True for a space with no ceiling and no walls to speak of -- a
   * parapet, the sky above it and a floor.
   *
   * It changes how a starter is DRAWN and how its reading is worded
   * ("its parapet carries", not "its walls carry"). Nothing downstream
   * of the library reads it: the generator already knows a balcony is
   * an outdoor space from its own table.
   */
  outdoor?: boolean;
  aliases?: string[];
}

/**
 * Several candidates for the same reason themes.service has them: this
 * runs from src/ under ts-node, from dist/ after a build, and from a
 * Vercel bundle.
 */
const CANDIDATES = [
  path.join(__dirname, '..', '..', '..', 'shared', 'rooms.json'),
  path.join(__dirname, '..', '..', '..', '..', 'shared', 'rooms.json'),
  path.join(process.cwd(), 'shared', 'rooms.json'),
  path.join(process.cwd(), '..', 'shared', 'rooms.json'),
];

function load(): Record<string, RoomProfile> {
  for (const candidate of CANDIDATES) {
    try {
      const document = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { rooms?: Record<string, RoomProfile> };
      if (document.rooms && Object.keys(document.rooms).length > 0) return document.rooms;
    } catch {
      // Not here; try the next.
    }
  }

  // LOUD, and not fatal. Throwing would take the whole library down
  // rather than its room filter; an empty table puts every picture in
  // the "unsorted" bucket, which is visibly wrong rather than quietly
  // wrong. It must never pass unnoticed.
  console.error(
    '[rooms] THE ROOM CONFIGURATION (shared/rooms.json) COULD NOT BE FOUND. The De’vyora '
    + 'Library will show every picture as unsorted until this is fixed. On Vercel it is '
    + `bundled by the includeFiles entry in vercel.json. Looked in: ${CANDIDATES.join(', ')}`,
  );
  return {};
}

export const ROOMS: Record<string, RoomProfile> = load();

/** In the order the file lists them, which is the order the page shows. */
export const ROOM_LIST: RoomProfile[] = Object.values(ROOMS);

/** The same normalisation themes.service uses, so one name cannot mean two rooms. */
export function roomKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\//g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * Every name a room answers to: its id, its label, the wizard's name for
 * it, Python's key, and the free text that reached the old `room` column
 * before this list existed.
 */
const BY_NAME: Record<string, RoomProfile> = (() => {
  const index: Record<string, RoomProfile> = {};
  for (const [key, room] of Object.entries(ROOMS)) {
    index[roomKey(key)] = room;
    if (room.id) index[roomKey(room.id)] = room;
    if (room.label) index[roomKey(room.label)] = room;
    if (room.wizard) index[roomKey(room.wizard)] = room;
    if (room.space) index[roomKey(room.space)] = room;
    for (const alias of room.aliases ?? []) index[roomKey(alias)] = room;
  }
  delete index[''];
  return index;
})();

/** The room a value names, by id, label, wizard name, Python key or alias. */
export function describeRoom(value: unknown): RoomProfile | null {
  return BY_NAME[roomKey(value)] ?? null;
}

/**
 * Where a picture with this `room` value belongs.
 *
 * BACKWARD COMPATIBILITY LIVES HERE. Rows written before the hierarchy
 * existed carry null, or whatever free text somebody typed. Null and
 * anything unrecognised resolve to UNSORTED rather than being dropped
 * from the gallery -- a picture the studio uploaded must never become
 * invisible because a category was added after it.
 */
export const UNSORTED_ROOM = 'unsorted';

export function resolveRoomId(value: unknown): string {
  return describeRoom(value)?.id ?? UNSORTED_ROOM;
}

/**
 * The room id to STORE, for an upload.
 *
 * Strict, unlike resolveRoomId: an upload names its room from a
 * dropdown, so a value that matches nothing is a bug or a forged
 * request, and writing it would quietly create a sixth category nobody
 * can browse to. Null is allowed and means the caller did not say.
 */
export function storableRoomId(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const room = describeRoom(text);
  if (!room) return null;
  return room.id;
}

/** The wizard's own label for a stored room id, for pre-selecting it. */
export function wizardRoomFor(value: unknown): string {
  return describeRoom(value)?.wizard ?? '';
}
