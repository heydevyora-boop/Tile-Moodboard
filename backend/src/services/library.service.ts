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

/** The folder inside the studio's Drive root that holds the library. */
const DRIVE_FOLDER = 'devyora-library';

let cachedFolderId: string | null = null;

async function libraryFolderId(): Promise<string> {
  if (cachedFolderId) return cachedFolderId;
  const root = await googleDriveClient.getOrCreateFolder(config.google.driveRootFolder);
  const folder = await googleDriveClient.getOrCreateFolder(DRIVE_FOLDER, root.id);
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
      + 'Set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_ROOT_FOLDER first.',
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

/** How many each theme holds, for the gallery's theme list. */
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
