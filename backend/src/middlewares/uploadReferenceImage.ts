import fs from 'fs';
import multer from 'multer';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

// routes/index.ts pulls this middleware in, so this runs on every request --
// including auth. On Vercel/Lambda the bundle is read-only (only /tmp is
// writable) and the mkdir throws ENOENT at import time, which crashed the
// whole API. Failing here must not take unrelated routes down; a disk upload
// on a read-only deployment still fails, but only when one is attempted.
try {
  if (!fs.existsSync(config.referenceImages.uploadsDir)) {
    fs.mkdirSync(config.referenceImages.uploadsDir, { recursive: true });
  }
} catch {
  // Left for the upload request to surface; see comment above.
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// memoryStorage, not diskStorage: on Vercel/Lambda the uploads directory is
// on the read-only bundle, so multer's own write failed before the request
// ever reached the service layer. Holding the bytes in file.buffer lets the
// service push them straight to Drive; the local-disk fallback (used when
// Drive isn't configured) writes them itself. maxUploadBytes already bounds
// how much can be held in memory.
const storage = multer.memoryStorage();

/** Same collision-resistant, path-safe name diskStorage used to generate. */
export function buildStoredFilename(originalname: string): string {
  return `${Date.now()}-${originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
}

function imageOnly(_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(AppError.badRequest('Only JPEG, PNG, or WebP images are accepted'));
    return;
  }
  cb(null, true);
}

export const uploadReferenceImage = multer({
  storage,
  fileFilter: imageOnly,
  limits: { fileSize: config.referenceImages.maxUploadBytes },
}).single('file');
