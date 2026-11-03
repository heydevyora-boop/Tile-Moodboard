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

/** Forgets the verified folder -- for tests, and after a config change. */
export function clearLibraryFolderCache(): void {
  cachedFolderId = null;
}

async function libraryFolderId(): Promise<string> {
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
  title?: string;
  room?: string;
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
      parentFolderId: await libraryFolderId(),
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
      room: (input.room || '').trim() || null,
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
    metadata: { themeId, title: created.title, driveFileId: created.driveFileId },
    req,
  });

  return created;
}

export async function listReferences(themeId?: unknown, includeInactive = false) {
  const where = {
    ...(themeId ? { themeId: resolveThemeId(themeId) } : {}),
    ...(includeInactive ? {} : { isActive: true }),
  };

  const references = await prisma.libraryReference.findMany({
    where,
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: [{ themeId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

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
 * How many each theme holds, for the gallery's theme list.
 *
 * The CALLER decides what a failure means. The nine themes come from
 * shared/themes.json and need no table at all; only these counts do, so
 * a missing table must cost the counts and nothing else. See the themes
 * route.
 */
export async function countByTheme(): Promise<Record<string, number>> {
  const rows = await prisma.libraryReference.groupBy({
    by: ['themeId'],
    where: { isActive: true },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  rows.forEach((row: { themeId: string; _count: { _all: number } }) => {
    counts[row.themeId] = row._count._all;
  });
  return counts;
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
