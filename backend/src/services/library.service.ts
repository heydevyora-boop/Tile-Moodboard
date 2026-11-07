/**
 * De'vyora Library -- the reference rooms a client picks from.
 *
 * GOOGLE DRIVE IS THE ONLY STORE. referenceImages.service tries Vercel
 * Blob first, then Drive, then local disk, because that table serves an
 * internal flow that has to keep working on a developer's laptop. This
 * one does not fall back: a library picture that is not in the studio's
 * Drive is not in the library. A failed upload fails, loudly, with
 * Google's own words -- which is what tells the owner the real problem
 * rather than hiding it behind a copy on a disk that serverless throws
 * away.
 *
 * AND ONE FOLDER, NAMED BY THE STUDIO. Every picture is uploaded
 * directly into the Drive folder GOOGLE_DRIVE_LIBRARY_FOLDER names --
 * the studio's own "Reference Images" folder -- never into the Drive
 * root and never into a sub-folder this code invents for itself. With
 * that setting empty the library refuses to upload rather than quietly
 * putting the studio's pictures somewhere they did not choose.
 *
 * ONE PICTURE PER REQUEST. "Bulk" is a hundred requests, not one with a
 * hundred files in it: this deploys to a serverless function with a
 * sixty-second limit and a few megabytes of request body, so one big
 * POST could not carry fifty photographs and could not finish if it did.
 * The browser sends them a few at a time. The useful consequence is that
 * one bad file fails on its own and the other ninety-nine still land.
 */

import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';
import { describeTheme } from './themes.service';
import { describeRoom, storableRoomId, resolveRoomId, UNSORTED_ROOM } from './rooms.service';
import { googleDriveClient } from './googleDrive.service';
import { buildStoredFilename } from '@middlewares/uploadReferenceImage';
import { isRealImageBuffer } from '@utils/fileSignature';
import { toDriveDownloadUrl } from './referenceImages.service';

/**
 * THE ONE FOLDER EVERY LIBRARY PICTURE GOES INTO.
 *
 * The studio's own "Reference Images" folder, named by
 * GOOGLE_DRIVE_LIBRARY_FOLDER (or GOOGLE_DRIVE_REFERENCE_IMAGES_FOLDER
 * -- either name is read). Pictures are uploaded DIRECTLY inside it.
 *
 * This replaces finding-or-creating a `devyora-library` folder under
 * the Drive root. Two reasons that was wrong: it put the studio's
 * pictures somewhere the studio did not choose, and on a service
 * account it wrote into a My Drive that has no storage quota at all.
 * A folder the studio creates and shares is the configuration that
 * actually works.
 *
 * UNSET IS A REFUSAL, NOT A FALLBACK. Uploading to the root instead
 * would be exactly what this setting exists to prevent, and it would
 * do it silently.
 */

/** "https://drive.google.com/drive/folders/<id>?usp=..." -> "<id>". */
export function driveFolderIdFrom(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';

  // A link, in any of the shapes Google's own "Copy link" produces.
  const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(text);
  if (fromPath) return fromPath[1];

  const fromQuery = /[?&]id=([A-Za-z0-9_-]+)/.exec(text);
  if (fromQuery) return fromQuery[1];

  // Already a bare id. Anything with a slash or a space is not one, and
  // passing it to Drive as a file id would produce a confusing 404
  // rather than the clear message below.
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;

  return '';
}

let cachedFolderId: string | null = null;

async function libraryRootId(): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const configured = config.google.driveLibraryFolder;

  if (!configured) {
    throw AppError.badRequest(
      'The De\u2019vyora Library has no Google Drive folder configured, and it will not '
      + 'upload anywhere else. Create a folder in the studio\u2019s Drive (for example '
      + '"Reference Images"), share it with the service account as an Editor, and set '
      + 'GOOGLE_DRIVE_LIBRARY_FOLDER to its link or its id.',
    );
  }

  const folderId = driveFolderIdFrom(configured);

  if (!folderId) {
    throw AppError.badRequest(
      `GOOGLE_DRIVE_LIBRARY_FOLDER is set to "${configured}", which is neither a Google `
      + 'Drive folder link nor a folder id. Paste the folder\u2019s link '
      + '(https://drive.google.com/drive/folders/...) or just the id from the end of it.',
    );
  }

  // CHECKED ONCE, BEFORE ANYTHING IS SENT. A wrong id, or one the
  // service account was never given access to, otherwise surfaces as a
  // generic Drive failure on every single upload of a hundred, with
  // nothing to say which setting is at fault.
  const folder = await googleDriveClient.getFolderById(folderId);

  if (!folder) {
    throw AppError.badRequest(
      `The Google Drive folder ${folderId} could not be opened. Either the id in `
      + 'GOOGLE_DRIVE_LIBRARY_FOLDER is wrong, the folder is in the bin, or it has not been '
      + 'shared with this deployment\u2019s service account \u2014 share it as an Editor.',
    );
  }

  cachedFolderId = folder.id;
  return folder.id;
}

/**
 * THE FOLDER A PICTURE ACTUALLY LANDS IN:
 *
 *   <the studio's Reference Images folder>
 *     └── British
 *           └── Bathroom
 *                 └── the picture
 *
 * Found or created under the configured folder, never above it. The
 * studio asked for this shape on Drive and not only in the database,
 * so that the folder they open by hand reads the same way the gallery
 * does.
 *
 * CACHED PER THEME AND ROOM. Without it a hundred-picture upload pays
 * for two Drive lookups per picture -- two hundred round trips for the
 * same handful of folders, inside a sixty-second function.
 */
const cachedSubfolders = new Map<string, string>();

/** Forgets the folder tree -- for tests, and after a config change. */
export function clearLibraryFolderCache(): void {
  cachedFolderId = null;
  cachedSubfolders.clear();
}

async function folderForUpload(themeId: string, roomId: string | null): Promise<string> {
  const theme = describeTheme(themeId);
  const room = roomId ? describeRoom(roomId) : null;

  // The labels, not the ids: these are folders a person opens in Drive,
  // so they read "British / Bathroom", not "british / bathroom".
  const themeName = theme?.label || themeId;
  const roomName = room?.label || 'Unsorted';

  const key = `${themeName}/${roomName}`;
  const cached = cachedSubfolders.get(key);
  if (cached) return cached;

  const root = await libraryRootId();
  const themeFolder = await googleDriveClient.getOrCreateFolder(themeName, root);
  const roomFolder = await googleDriveClient.getOrCreateFolder(roomName, themeFolder.id);

  cachedSubfolders.set(key, roomFolder.id);
  return roomFolder.id;
}

/**
 * The theme this picture belongs to, as shared/themes.json spells it.
 *
 * Checked here rather than by a foreign key, because the themes are that
 * file and not a table -- see DEVYORA_LIBRARY.md. A theme nobody
 * recognises is refused outright: a row whose themeId matches nothing
 * would be invisible in the gallery and impossible to generate from.
 */
export function resolveThemeId(value: unknown): string {
  const theme = describeTheme(value);
  if (!theme) {
    throw AppError.badRequest(
      `"${String(value ?? '')}" is not one of the studio's themes.`,
    );
  }
  return theme.id;
}

export interface AddReferenceInput {
  themeId: unknown;
  /**
   * The room type, as the second level of the hierarchy. A room id,
   * label, or any of the aliases in shared/rooms.json -- the upload
   * form sends an id, but an API caller need not know that.
   *
   * Optional, and an unrecognised value is refused rather than stored:
   * writing one would create a sixth category nobody can browse to.
   */
  room?: string;
  title?: string;
  description?: string;
}

export async function addReference(
  file: Express.Multer.File | undefined,
  input: AddReferenceInput,
  userId: string,
  req?: Request,
) {
  if (!file) throw AppError.badRequest('No image was sent.');

  const themeId = resolveThemeId(input.themeId);

  // THE SECOND LEVEL OF THE HIERARCHY.
  //
  // Refused rather than quietly stored when it names nothing, for the
  // same reason an unknown theme is: a picture filed under a room that
  // does not exist is invisible in the gallery and impossible to
  // generate from. Omitted entirely is still allowed -- that is the
  // "Unsorted" bucket, and it is what every row written before this
  // hierarchy carries.
  const roomId = storableRoomId(input.room);

  if (input.room && !roomId) {
    throw AppError.badRequest(
      `"${String(input.room)}" is not one of the studio\u2019s room types. `
      + 'Choose Bathroom, Bedroom, Drawing Room, Powder Room or Kitchen.',
    );
  }

  // The declared mime type is the browser's claim; this reads the bytes.
  if (!isRealImageBuffer(file.buffer)) {
    throw AppError.badRequest(
      `"${file.originalname}" is not actually a JPEG, PNG or WebP image.`,
    );
  }

  if (!googleDriveClient.isConfigured()) {
    throw AppError.badRequest(
      'Google Drive is not configured, and the library is stored in Drive only. '
      + 'Set GOOGLE_SERVICE_ACCOUNT_JSON (the credential) and GOOGLE_DRIVE_LIBRARY_FOLDER '
      + '(the folder every library picture goes into) first.',
    );
  }

  const filename = buildStoredFilename(file.originalname);

  let uploaded;
  try {
    uploaded = await googleDriveClient.uploadFile({
      name: filename,
      mimeType: file.mimetype,
      content: file.buffer,
      // <Reference Images>/<Theme>/<Room> -- see folderForUpload.
      parentFolderId: await folderForUpload(themeId, roomId),
    });
    // The Python visualization service fetches this URL unauthenticated,
    // so a private file would 403 at generation time rather than here.
    await googleDriveClient.generatePublicLink(uploaded.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deliberately not caught-and-carried-on. A service account owns no
    // Drive storage of its own, and that failure says so in these words;
    // hiding it behind a local copy is how it stayed unnoticed elsewhere
    // in this system.
    throw AppError.badRequest(
      `"${file.originalname}" could not be stored in Google Drive: ${message}`,
    );
  }

  const created = await prisma.libraryReference.create({
    data: {
      themeId,
      title: (input.title || '').trim() || file.originalname.replace(/\.[^.]+$/, ''),
      imageUrl: toDriveDownloadUrl(uploaded.id),
      driveFileId: uploaded.id,
      room: roomId,
      description: (input.description || '').trim() || null,
      uploadedById: userId,
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  await logActivity({
    userId,
    action: 'library_reference.uploaded',
    entityType: 'LibraryReference',
    entityId: created.id,
    metadata: { themeId, room: roomId, title: created.title, driveFileId: created.driveFileId },
    req,
  });

  return created;
}

export async function listReferences(
  themeId?: unknown,
  /**
   * The second level of the hierarchy. Omitted means every room in the
   * theme, which is what the theme's own overview shows.
   *
   * UNSORTED_ROOM selects the rows whose room is null or unrecognised --
   * everything uploaded before this hierarchy existed. Those are not
   * reachable by any room id, so without this they would be browsable
   * from nowhere.
   */
  roomId?: unknown,
  includeInactive = false,
) {
  const wanted = roomId ? String(roomId).trim() : '';
  const known = wanted && wanted !== UNSORTED_ROOM ? describeRoom(wanted) : null;

  if (wanted && wanted !== UNSORTED_ROOM && !known) {
    throw AppError.badRequest(`"${wanted}" is not one of the studio\u2019s room types.`);
  }

  const references = await prisma.libraryReference.findMany({
    where: {
      ...(themeId ? { themeId: resolveThemeId(themeId) } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: [{ themeId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

  // WHICH ROOM A PICTURE IS IN IS DECIDED HERE, NOT IN SQL.
  //
  // `room = 'bathroom'` looks obvious and is wrong: a row written
  // before the hierarchy existed carries free text -- "Bathroom", or
  // "ensuite" -- and an equality test misses every one of them. The
  // theme's own COUNT resolves those aliases, so the two disagreed: a
  // room card said two pictures and opening it showed one.
  //
  // resolveRoomId is the single definition of "which room is this in",
  // and using it for both the list and the counts is what keeps them
  // telling the same story. It also gives the unsorted bucket its
  // meaning -- "null, or a name this list does not know" -- which is
  // not a condition a query can express at all.
  //
  // The cost is filtering one theme's rows in memory rather than in
  // Postgres. A theme holds hundreds of pictures, not millions, and
  // the query is still narrowed by the indexed themeId + isActive. If
  // a library ever grows past that, the fix is a one-off backfill of
  // `room` to canonical ids and an equality test here -- not a second
  // definition of what a room is.
  if (wanted) {
    const target = known ? known.id : UNSORTED_ROOM;
    return references.filter(
      (row: { room: string | null }) => resolveRoomId(row.room) === target,
    );
  }

  return references;
}

/**
 * Why a library storage call failed, in words a studio can act on.
 *
 * P2021 is Prisma's "the table does not exist", and on this deployment
 * it has exactly one cause: `prisma migrate deploy` has not been run.
 * vercel.json's buildCommand is `prisma generate` alone, so a deploy
 * ships the code without the table and every library call fails --
 * which reached the screen as "Database request error (P2021)" and told
 * the owner nothing about what to do.
 */
export function describeStorageFailure(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;

  if (code === 'P2021' || code === 'P2022') {
    return (
      'The library’s database table has not been created yet. Run '
      + '`cd backend && npx prisma migrate deploy` against this database — '
      + 'this project’s build runs `prisma generate` only, so a deployment '
      + 'does not create it.'
    );
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * How many each theme holds, and how those break down by room.
 *
 * BOTH IN ONE PASS. The gallery needs the theme totals for its first
 * screen and the per-room numbers for its second, and asking twice
 * would be two scans of the same rows.
 *
 * The CALLER decides what a failure means. The nine themes come from
 * shared/themes.json and need no table at all; only these counts do, so
 * a missing table must cost the counts and nothing else. See the themes
 * route.
 */
export interface LibraryCounts {
  /** themeId -> total pictures. */
  byTheme: Record<string, number>;
  /** themeId -> roomId -> pictures. Unrecognised rooms fold into "unsorted". */
  byRoom: Record<string, Record<string, number>>;
}

export async function countByTheme(): Promise<LibraryCounts> {
  const rows = await prisma.libraryReference.groupBy({
    by: ['themeId', 'room'],
    where: { isActive: true },
    _count: { _all: true },
  });

  const byTheme: Record<string, number> = {};
  const byRoom: Record<string, Record<string, number>> = {};

  rows.forEach((row: { themeId: string; room: string | null; _count: { _all: number } }) => {
    const n = row._count._all;
    byTheme[row.themeId] = (byTheme[row.themeId] ?? 0) + n;

    // Resolved rather than taken raw, so an older row's free text lands
    // in the room it names and anything unrecognised folds into the
    // unsorted bucket instead of inventing a sixth category.
    const room = resolveRoomId(row.room);
    byRoom[row.themeId] = byRoom[row.themeId] ?? {};
    byRoom[row.themeId][room] = (byRoom[row.themeId][room] ?? 0) + n;
  });

  return { byTheme, byRoom };
}

/**
 * Removes a picture from the library, and from Drive.
 *
 * The row goes either way. A Drive file that cannot be deleted -- it was
 * already removed by hand, or the credential has lost its reach -- must
 * not leave the studio with a picture they cannot get rid of; the
 * failure is reported in the response instead.
 */
export async function deleteReference(id: string, userId: string, req?: Request) {
  const existing = await prisma.libraryReference.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('That reference is not in the library.');

  let driveDeleted = true;
  let driveError: string | null = null;
  try {
    await googleDriveClient.deleteFile(existing.driveFileId);
  } catch (err) {
    driveDeleted = false;
    driveError = err instanceof Error ? err.message : String(err);
  }

  await prisma.libraryReference.delete({ where: { id } });

  await logActivity({
    userId,
    action: 'library_reference.deleted',
    entityType: 'LibraryReference',
    entityId: id,
    metadata: { themeId: existing.themeId, driveFileId: existing.driveFileId, driveDeleted },
    req,
  });

  return { id, driveDeleted, driveError };
}
