"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadReferenceImage = void 0;
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
if (!fs_1.default.existsSync(index_1.config.referenceImages.uploadsDir)) {
    fs_1.default.mkdirSync(index_1.config.referenceImages.uploadsDir, { recursive: true });
}
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, index_1.config.referenceImages.uploadsDir),
    filename: (_req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${safeName}`);
    },
});
function imageOnly(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(AppError_1.AppError.badRequest('Only JPEG, PNG, or WebP images are accepted'));
        return;
    }
    cb(null, true);
}
exports.uploadReferenceImage = (0, multer_1.default)({
    storage,
    fileFilter: imageOnly,
    limits: { fileSize: index_1.config.referenceImages.maxUploadBytes },
}).single('file');
//# sourceMappingURL=uploadReferenceImage.js.map