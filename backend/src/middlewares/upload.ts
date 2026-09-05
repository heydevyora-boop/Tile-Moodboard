import fs from 'fs';
import multer from 'multer';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

if (!fs.existsSync(config.catalog.uploadsDir)) {
  fs.mkdirSync(config.catalog.uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.catalog.uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

function pdfOnly(_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (file.mimetype !== 'application/pdf') {
    // AppError is a real Error subclass, so passing it straight to multer's
    // callback works fine — it propagates via next(err) and the global
    // error handler recognizes it immediately (checked before the
    // MulterError branch), giving a clean 400 instead of a masked 500.
    cb(AppError.badRequest('Only PDF files are accepted'));
    return;
  }
  cb(null, true);
}

console.log(
  `[upload.ts] Catalog PDF upload limit: ${config.catalog.maxUploadBytes} bytes ` +
    `(${(config.catalog.maxUploadBytes / (1024 * 1024)).toFixed(0)} MB)`,
);

// Size-limit violations still come through as a genuine MulterError,
// which errorHandler.ts already normalizes separately.
export const uploadCatalogPdf = multer({
  storage,
  fileFilter: pdfOnly,
  limits: { fileSize: config.catalog.maxUploadBytes },
}).single('file');
