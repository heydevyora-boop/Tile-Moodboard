import fs from 'fs';
import multer from 'multer';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

if (!fs.existsSync(config.referenceImages.uploadsDir)) {
  fs.mkdirSync(config.referenceImages.uploadsDir, { recursive: true });
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.referenceImages.uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

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
