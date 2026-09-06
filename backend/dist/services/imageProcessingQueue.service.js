"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerImageProcessingQueue = registerImageProcessingQueue;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const canvas_1 = require("@napi-rs/canvas");
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const logger_1 = require("@utils/logger");
const jobQueue_service_1 = require("./jobQueue.service");
const THUMBNAIL_MAX_DIMENSION = 320;
function toPublicThumbnailPath(filename) {
    return `/static/reference-images/${filename}`;
}
async function generateThumbnail(sourcePath, outputPath) {
    const image = await (0, canvas_1.loadImage)(sourcePath);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = (0, canvas_1.createCanvas)(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const buffer = await canvas.encode('png');
    fs_1.default.writeFileSync(outputPath, buffer);
    return { width, height };
}
async function processImageJob(payload) {
    const { referenceImageId, sourceFilename } = payload;
    const sourcePath = path_1.default.join(index_1.config.referenceImages.uploadsDir, sourceFilename);
    const thumbnailFilename = `thumb-${sourceFilename.replace(/\.[^.]+$/, '')}.png`;
    const outputPath = path_1.default.join(index_1.config.referenceImages.uploadsDir, thumbnailFilename);
    const { width, height } = await generateThumbnail(sourcePath, outputPath);
    const thumbnailUrl = toPublicThumbnailPath(thumbnailFilename);
    await connection_1.prisma.referenceImage.update({ where: { id: referenceImageId }, data: { thumbnailUrl } });
    return { thumbnailUrl, width, height };
}
function registerImageProcessingQueue() {
    (0, jobQueue_service_1.registerProcessor)('IMAGE_PROCESSING', processImageJob, { concurrency: 2 });
    logger_1.logger.info('Image Processing Queue worker registered');
}
//# sourceMappingURL=imageProcessingQueue.service.js.map