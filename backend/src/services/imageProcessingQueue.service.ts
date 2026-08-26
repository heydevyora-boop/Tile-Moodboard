import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { registerProcessor } from './jobQueue.service';

const THUMBNAIL_MAX_DIMENSION = 320;

function toPublicThumbnailPath(filename: string): string {
  return `/static/reference-images/${filename}`;
}

async function generateThumbnail(sourcePath: string, outputPath: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(sourcePath);
  const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);

  const buffer = await canvas.encode('png');
  fs.writeFileSync(outputPath, buffer);
  return { width, height };
}

interface ImageProcessingPayload {
  referenceImageId: string;
  sourceFilename: string;
}

async function processImageJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { referenceImageId, sourceFilename } = payload as unknown as ImageProcessingPayload;

  const sourcePath = path.join(config.referenceImages.uploadsDir, sourceFilename);
  const thumbnailFilename = `thumb-${sourceFilename.replace(/\.[^.]+$/, '')}.png`;
  const outputPath = path.join(config.referenceImages.uploadsDir, thumbnailFilename);

  const { width, height } = await generateThumbnail(sourcePath, outputPath);

  const thumbnailUrl = toPublicThumbnailPath(thumbnailFilename);
  await prisma.referenceImage.update({ where: { id: referenceImageId }, data: { thumbnailUrl } });

  return { thumbnailUrl, width, height };
}

/** Called once at startup to register this queue's worker — see src/app.ts. */
export function registerImageProcessingQueue(): void {
  registerProcessor('IMAGE_PROCESSING', processImageJob, { concurrency: 2 });
  logger.info('Image Processing Queue worker registered');
}
