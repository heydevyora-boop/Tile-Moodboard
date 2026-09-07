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
function toDriveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/** Recovers the Drive file id from a URL built by toDriveDownloadUrl — lets deletes work without adding a column to store it. */
function driveFileIdFromUrl(imageUrl: string | null): string | null {
  if (!imageUrl || !imageUrl.includes('drive.google.com')) return null;
  return /[?&]id=([^&]+)/.exec(imageUrl)?.[1] ?? /\/d\/([^/]+)/.exec(imageUrl)?.[1] ?? null;
}

/**
 * Persists the uploaded bytes and returns the URL to record.
 *
 * Drive is used whenever it's configured, because a serverless host has no
 * durable disk: an image written to the bundle (read-only) or /tmp
 * (per-invocation) is gone by the time the Python service tries to fetch
 * it, which is what made every generation fail with a connection error or
 * a 404. Without Drive configured this writes to disk exactly as multer's
 * diskStorage used to, so local/Docker behaviour is unchanged.
 */
async function storeUploadedImage(file: Express.Multer.File): Promise<{ imageUrl: string; localFilename: string | null }> {
  if (!isRealImageBuffer(file.buffer)) {
    throw AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
  }

  const filename = buildStoredFilename(file.originalname);

  if (googleDriveClient.isConfigured()) {
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
  }

  fs.mkdirSync(config.referenceImages.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.referenceImages.uploadsDir, filename), file.buffer);
  return { imageUrl: toPublicPath(filename), localFilename: filename };
}

/** Best-effort removal of the stored original — never blocks or fails the caller over a leftover file. */
function deleteStoredImage(imageUrl: string | null) {
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
