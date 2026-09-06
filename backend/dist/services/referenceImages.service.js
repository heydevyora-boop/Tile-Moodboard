"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadReferenceImage = uploadReferenceImage;
exports.listReferenceImages = listReferenceImages;
exports.getReferenceImage = getReferenceImage;
exports.listCategories = listCategories;
exports.updateReferenceImage = updateReferenceImage;
exports.replaceReferenceImage = replaceReferenceImage;
exports.deleteReferenceImage = deleteReferenceImage;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const pagination_1 = require("@utils/pagination");
const activityLog_service_1 = require("./activityLog.service");
const jobQueue_service_1 = require("./jobQueue.service");
const fileSignature_1 = require("@utils/fileSignature");
function toPublicPath(filename) {
    return `/static/reference-images/${filename}`;
}
function deleteLocalFile(imageUrl) {
    if (!imageUrl || !imageUrl.startsWith('/static/reference-images/'))
        return;
    const filename = imageUrl.replace('/static/reference-images/', '');
    const filePath = path_1.default.join(index_1.config.referenceImages.uploadsDir, filename);
    fs_1.default.unlink(filePath, () => { });
}
async function uploadReferenceImage(file, input, userId, req) {
    if (!(0, fileSignature_1.isRealImage)(file.path)) {
        fs_1.default.unlinkSync(file.path);
        throw AppError_1.AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
    }
    const image = await connection_1.prisma.referenceImage.create({
        data: {
            styleTag: input.styleTag,
            description: input.description,
            style: input.style,
            room: input.room,
            imageUrl: toPublicPath(file.filename),
            uploadedById: userId,
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId,
        action: 'reference_image.uploaded',
        entityType: 'ReferenceImage',
        entityId: image.id,
        metadata: { styleTag: image.styleTag, style: image.style, room: image.room },
        req,
    });
    void (0, jobQueue_service_1.enqueueJob)('IMAGE_PROCESSING', { referenceImageId: image.id, sourceFilename: file.filename }, { createdById: userId });
    return image;
}
async function listReferenceImages(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.style ? { style: query.style } : {}),
        ...(query.room ? { room: query.room } : {}),
        ...(query.search
            ? {
                OR: [
                    { styleTag: { contains: query.search, mode: 'insensitive' } },
                    { description: { contains: query.search, mode: 'insensitive' } },
                ],
            }
            : {}),
    };
    const [images, total] = await Promise.all([
        connection_1.prisma.referenceImage.findMany({
            where,
            include: { uploadedBy: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.referenceImage.count({ where }),
    ]);
    return { images, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getReferenceImage(id) {
    const image = await connection_1.prisma.referenceImage.findUnique({ where: { id }, include: { uploadedBy: { select: { id: true, name: true } } } });
    if (!image)
        throw AppError_1.AppError.notFound('Reference image not found');
    return image;
}
async function listCategories() {
    const images = await connection_1.prisma.referenceImage.findMany({ select: { style: true, room: true } });
    const styles = new Set();
    const rooms = new Set();
    for (const img of images) {
        if (img.style)
            styles.add(img.style);
        if (img.room)
            rooms.add(img.room);
    }
    return {
        styles: [...styles].sort(),
        rooms: [...rooms].sort(),
    };
}
async function updateReferenceImage(id, input, userId, req) {
    const existing = await connection_1.prisma.referenceImage.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Reference image not found');
    const updated = await connection_1.prisma.referenceImage.update({ where: { id }, data: input });
    await (0, activityLog_service_1.logActivity)({ userId, action: 'reference_image.updated', entityType: 'ReferenceImage', entityId: id, metadata: { changes: input }, req });
    return updated;
}
async function replaceReferenceImage(id, file, userId, req) {
    if (!(0, fileSignature_1.isRealImage)(file.path)) {
        fs_1.default.unlinkSync(file.path);
        throw AppError_1.AppError.badRequest('This file is not actually a valid JPEG, PNG, or WebP image (failed content verification)');
    }
    const existing = await connection_1.prisma.referenceImage.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Reference image not found');
    const oldImageUrl = existing.imageUrl;
    const updated = await connection_1.prisma.referenceImage.update({ where: { id }, data: { imageUrl: toPublicPath(file.filename) } });
    deleteLocalFile(oldImageUrl);
    await (0, activityLog_service_1.logActivity)({ userId, action: 'reference_image.replaced', entityType: 'ReferenceImage', entityId: id, req });
    return updated;
}
async function deleteReferenceImage(id, userId, req) {
    const existing = await connection_1.prisma.referenceImage.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Reference image not found');
    await connection_1.prisma.referenceImage.delete({ where: { id } });
    deleteLocalFile(existing.imageUrl);
    await (0, activityLog_service_1.logActivity)({
        userId,
        action: 'reference_image.deleted',
        entityType: 'ReferenceImage',
        entityId: id,
        metadata: { styleTag: existing.styleTag },
        req,
    });
}
//# sourceMappingURL=referenceImages.service.js.map