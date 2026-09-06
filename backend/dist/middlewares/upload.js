"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadCatalogPdf = void 0;
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
if (!fs_1.default.existsSync(index_1.config.catalog.uploadsDir)) {
    fs_1.default.mkdirSync(index_1.config.catalog.uploadsDir, { recursive: true });
}
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, index_1.config.catalog.uploadsDir),
    filename: (_req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${safeName}`);
    },
});
function pdfOnly(_req, file, cb) {
    if (file.mimetype !== 'application/pdf') {
        cb(AppError_1.AppError.badRequest('Only PDF files are accepted'));
        return;
    }
    cb(null, true);
}
console.log(`[upload.ts] Catalog PDF upload limit: ${index_1.config.catalog.maxUploadBytes} bytes ` +
    `(${(index_1.config.catalog.maxUploadBytes / (1024 * 1024)).toFixed(0)} MB)`);
exports.uploadCatalogPdf = (0, multer_1.default)({
    storage,
    fileFilter: pdfOnly,
    limits: { fileSize: index_1.config.catalog.maxUploadBytes },
}).single('file');
//# sourceMappingURL=upload.js.map