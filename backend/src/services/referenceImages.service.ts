import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { logActivity } from './activityLog.service';
import { UploadReferenceImageInput, UpdateReferenceImageInput, ListReferenceImagesQuery } from '@validators/referenceImages.validators';
import { enqueueJob } from './jobQueue.service';
import { isRealImageBuffer } from '@utils/fileSignature';
import { buildStoredFilename } from '@middlewares/uploadReferenceImage';
import { googleDriveClient } from './googleDrive.service';
import { logger } from '@utils/logger';

function toPublicPath(filename: string): string {
  return `/static/reference-images/${filename}`;
}

const DRIVE_SUBFOLDER = 'reference-images';

/** Key prefix for reference images inside the Vercel Blob store. */
const BLOB_PREFIX = 'reference-images';

/** Vercel Blob serves every public object from this host. */
function isBlobUrl(imageUrl: string | null): boolean {
  return !!imageUrl && imageUrl.includes('.public.blob.vercel-storage.com');
}

/** Resolved once per process — the folder lookup is two Drive round-trips we don't want on every upload. */
let cachedDriveFolderId: string | null = null;

async function getDriveFolderId(): Promise<string> {
  if (cachedDriveFolderId) return cachedDriveFolderId;
  const root = await googleDriveClient.getOrCreateFolder(config.google.driveRootFolder);
  const folder = await googleDriveClient.getOrCreateFolder(DRIVE_SUBFOLDER, root.id);
  cachedDriveFolderId = folder.id;
  return folder.id;
}

/**
 * The download form, not webViewLink. webViewLink points at Drive's HTML
 * viewer page, and the Python visualization service explicitly rejects an
 * image URL that answers with HTML ("returned HTML/JSON instead of an
 * image"). This is also the exact shape main_step6_complete.py normalizes
 * Drive URLs into, so it round-trips unchanged.
 */
export function toDriveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/** Recovers the Drive file id from a URL built by toDriveDownloadUrl — lets deletes work without adding a column to store it. */
export function driveFileIdFromUrl(imageUrl: string | null): string | null {
  if (!imageUrl || !imageUrl.includes('drive.google.com')) return null;
  return /[?&]id=([^&]+)/.exec(imageUrl)?.[1] ?? /\/d\/([^/]+)/.exec(imageUrl)?.[1] ?? null;
}

/**
 * The browser-embeddable form, which is NOT toDriveDownloadUrl's form.
 *
 * uc?export=download is a download endpoint: Google serves an HTML
 * interstitial from it rather than image bytes, so an <img> pointed at it
 * fails with naturalWidth 0 even when the file is world-readable. That is
 * deliberately still what toDriveDownloadUrl returns, because the Python
 * visualization service fetches server-side and wants the download form.
 * Only what a browser renders is switched here.
 */
function toDriveThumbnailUrl(fileId: string): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
}

/**
 * Tile.imageUrl can carry a Drive URL in whichever shape whatever wrote it
 * used — the pendrive extraction flow (main_step6_complete.py) stores
 * Drive's webViewLink, an HTML viewer page an <img> tag can't render (the
 * exact cause of tiles showing broken-image icons: the browser gets an
 * HTML document, not pixels). extract.py's own Drive mode returns the
 * uc?id= download form, which an <img> can't render either. This
 * normalizes any of those (webViewLink, uc?id=, uc?export=download&id=)
 * to the one form a browser actually renders, by reusing
 * driveFileIdFromUrl rather than storage writers each needing to agree on
 * a format. A non-Drive value (a local /static/... path, or null) passes
 * through unchanged.
 *
 * Read-time only: nothing is rewritten in the database, so rows keep
 * whatever their writer stored and this stays correct for both.
 */
export function normalizeDriveImageUrl(imageUrl: string | null): string | null {
  const fileId = driveFileIdFromUrl(imageUrl);
  return fileId ? toDriveThumbnailUrl(fileId) : imageUrl;
}

/**
 * Persists the uploaded bytes and returns the URL to record.
 *
 * Drive is preferred when it's configured, because a serverless host has no
 * durable disk: an image written to the bundle (read-only) or /tmp
 * (per-invocation) is gone by the time the Python service tries to fetch
 * it, which is what made every generation fail with a connection error or
 * a 404.
 *
 * A Drive failure falls back to local disk rather than failing the upload.
 * A plain service account owns no storage quota, so uploading into its own
 * My Drive is rejected outright ("Service Accounts do not have storage
 * quota") -- that needs a Shared Drive or OAuth delegation to fix, which is
 * a Google-side setup matter, and until it's done a developer running
 * locally must still be able to add reference images. Local disk is a
 * perfectly good store there; it is only on a read-only serverless host
 * that it isn't, and there this write throws and surfaces the real error
 * rather than silently appearing to succeed.
 */
async function storeUploadedImage(file: Express.Multer.File): Promise<{ imageUrl: string; localFilename: string | null }> {
  if (!isRealImageBuffer(file.buffer)) {
    throw AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
  }

  const filename = buildStoredFilename(file.originalname);

  // Preferred on Vercel: the returned URL is public and absolute, so it
  // needs no /static route, no BACKEND_PUBLIC_URL, and no local disk --
  // the three things that made a deployed reference image unfetchable.
  if (config.referenceImages.blobToken) {
    const { put } = await import('@vercel/blob');
    const stored = await put(`${BLOB_PREFIX}/${filename}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
      token: config.referenceImages.blobToken,
      addRandomSuffix: false,
    });
    return { imageUrl: stored.url, localFilename: null };
  }

  if (googleDriveClient.isConfigured()) {
    try {
      const uploaded = await googleDriveClient.uploadFile({
        name: filename,
        mimeType: file.mimetype,
        content: file.buffer,
        parentFolderId: await getDriveFolderId(),
      });
      // Anyone-with-link reader: the Python service fetches this URL
      // unauthenticated, so a private file would 403.
      await googleDriveClient.generatePublicLink(uploaded.id);
      return { imageUrl: toDriveDownloadUrl(uploaded.id), localFilename: null };
    } catch (err) {
      logger.warn(
        `Reference image could not be stored in Google Drive, falling back to local disk: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  fs.mkdirSync(config.referenceImages.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.referenceImages.uploadsDir, filename), file.buffer);
  return { imageUrl: toPublicPath(filename), localFilename: filename };
}

/** Best-effort removal of the stored original — never blocks or fails the caller over a leftover file. */
function deleteStoredImage(imageUrl: string | null) {
  if (isBlobUrl(imageUrl) && config.referenceImages.blobToken) {
    void import('@vercel/blob')
      .then(({ del }) => del(imageUrl as string, { token: config.referenceImages.blobToken }))
      .catch((err) => logger.warn(`Could not delete reference image from Vercel Blob: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  const driveFileId = driveFileIdFromUrl(imageUrl);
  if (driveFileId) {
    void googleDriveClient
      .deleteFile(driveFileId)
      .catch((err) => logger.warn(`Could not delete reference image ${driveFileId} from Drive: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (!imageUrl || !imageUrl.startsWith('/static/reference-images/')) return;
  const filename = imageUrl.replace('/static/reference-images/', '');
  const filePath = path.join(config.referenceImages.uploadsDir, filename);
  fs.unlink(filePath, () => {});
}

export async function uploadReferenceImage(file: Express.Multer.File, input: UploadReferenceImageInput, userId: string, req?: Request) {
  const { imageUrl, localFilename } = await storeUploadedImage(file);

  const image = await prisma.referenceImage.create({
    data: {
      styleTag: input.styleTag,
      description: input.description,
      style: input.style,
      room: input.room,
      imageUrl,
      uploadedById: userId,
    },
  });

  await logActivity({
    userId,
    action: 'reference_image.uploaded',
    entityType: 'ReferenceImage',
    entityId: image.id,
    metadata: { styleTag: image.styleTag, style: image.style, room: image.room },
    req,
  });

  // Fire-and-forget: the upload response returns immediately with thumbnailUrl
  // null; the Image Processing Queue fills it in shortly after. A failed
  // thumbnail job never blocks or fails the upload itself — the original
  // full-size imageUrl is always usable on its own.
  //
  // Only for disk-stored images: the thumbnailer reads its source from
  // uploadsDir, which holds nothing when the original went to Drive. Such a
  // record simply keeps thumbnailUrl null, the same already-handled state
  // every upload is in between responding and the job finishing.
  if (localFilename) {
    void enqueueJob('IMAGE_PROCESSING', { referenceImageId: image.id, sourceFilename: localFilename }, { createdById: userId });
  }

  return image;
}

export async function listReferenceImages(query: ListReferenceImagesQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.style ? { style: query.style } : {}),
    ...(query.room ? { room: query.room } : {}),
    ...(query.search
      ? {
          OR: [
            { styleTag: { contains: query.search, mode: 'insensitive' as const } },
            { description: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [images, total] = await Promise.all([
    prisma.referenceImage.findMany({
      where,
      include: { uploadedBy: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.referenceImage.count({ where }),
  ]);

  return { images, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getReferenceImage(id: string) {
  const image = await prisma.referenceImage.findUnique({ where: { id }, include: { uploadedBy: { select: { id: true, name: true } } } });
  if (!image) throw AppError.notFound('Reference image not found');
  return image;
}

/** Distinct style/room values currently in use — powers the frontend's category filter dropdowns. */
export async function listCategories() {
  const images = await prisma.referenceImage.findMany({ select: { style: true, room: true } });
  const styles = new Set<string>();
  const rooms = new Set<string>();
  for (const img of images) {
    if (img.style) styles.add(img.style);
    if (img.room) rooms.add(img.room);
  }
  return {
    styles: [...styles].sort(),
    rooms: [...rooms].sort(),
  };
}

export async function updateReferenceImage(id: string, input: UpdateReferenceImageInput, userId: string, req?: Request) {
  const existing = await prisma.referenceImage.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Reference image not found');

  const updated = await prisma.referenceImage.update({ where: { id }, data: input });

  await logActivity({ userId, action: 'reference_image.updated', entityType: 'ReferenceImage', entityId: id, metadata: { changes: input }, req });

  return updated;
}

/** Swaps the underlying image file without touching styleTag/description/style/room or the record's id. */
export async function replaceReferenceImage(id: string, file: Express.Multer.File, userId: string, req?: Request) {
  const existing = await prisma.referenceImage.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Reference image not found');

  const oldImageUrl = existing.imageUrl;
  const { imageUrl } = await storeUploadedImage(file);
  const updated = await prisma.referenceImage.update({ where: { id }, data: { imageUrl } });

  deleteStoredImage(oldImageUrl);

  await logActivity({ userId, action: 'reference_image.replaced', entityType: 'ReferenceImage', entityId: id, req });

  return updated;
}

export async function deleteReferenceImage(id: string, userId: string, req?: Request) {
  const existing = await prisma.referenceImage.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Reference image not found');

  await prisma.referenceImage.delete({ where: { id } });
  deleteStoredImage(existing.imageUrl);

  await logActivity({
    userId,
    action: 'reference_image.deleted',
    entityType: 'ReferenceImage',
    entityId: id,
    metadata: { styleTag: existing.styleTag },
    req,
  });
}
