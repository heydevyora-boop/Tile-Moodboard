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
import { isRealImage } from '@utils/fileSignature';

function toPublicPath(filename: string): string {
  return `/static/reference-images/${filename}`;
}

/** Best-effort local file removal — never blocks or fails the caller over a leftover file on disk. */
function deleteLocalFile(imageUrl: string | null) {
  if (!imageUrl || !imageUrl.startsWith('/static/reference-images/')) return;
  const filename = imageUrl.replace('/static/reference-images/', '');
  const filePath = path.join(config.referenceImages.uploadsDir, filename);
  fs.unlink(filePath, () => {});
}

export async function uploadReferenceImage(file: Express.Multer.File, input: UploadReferenceImageInput, userId: string, req?: Request) {
  if (!isRealImage(file.path)) {
    fs.unlinkSync(file.path);
    throw AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
  }

  const image = await prisma.referenceImage.create({
    data: {
      styleTag: input.styleTag,
      description: input.description,
      style: input.style,
      room: input.room,
      imageUrl: toPublicPath(file.filename),
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
  void enqueueJob('IMAGE_PROCESSING', { referenceImageId: image.id, sourceFilename: file.filename }, { createdById: userId });

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
  if (!isRealImage(file.path)) {
    fs.unlinkSync(file.path);
    throw AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
  }

  const existing = await prisma.referenceImage.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Reference image not found');

  const oldImageUrl = existing.imageUrl;
  const updated = await prisma.referenceImage.update({ where: { id }, data: { imageUrl: toPublicPath(file.filename) } });

  deleteLocalFile(oldImageUrl);

  await logActivity({ userId, action: 'reference_image.replaced', entityType: 'ReferenceImage', entityId: id, req });

  return updated;
}

export async function deleteReferenceImage(id: string, userId: string, req?: Request) {
  const existing = await prisma.referenceImage.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Reference image not found');

  await prisma.referenceImage.delete({ where: { id } });
  deleteLocalFile(existing.imageUrl);

  await logActivity({
    userId,
    action: 'reference_image.deleted',
    entityType: 'ReferenceImage',
    entityId: id,
    metadata: { styleTag: existing.styleTag },
    req,
  });
}
