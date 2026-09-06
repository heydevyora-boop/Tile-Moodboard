"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.masterTileSyncSchema = exports.updateExtractedTileSchema = exports.listCatalogTilesQuerySchema = exports.listCatalogsQuerySchema = exports.uploadCatalogSchema = void 0;
const zod_1 = require("zod");
exports.uploadCatalogSchema = zod_1.z
    .object({
    brandId: zod_1.z.string().optional(),
    brandName: zod_1.z.string().trim().min(1).optional(),
})
    .refine((data) => data.brandId || data.brandName, {
    message: 'Provide either brandId or brandName',
});
exports.listCatalogsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    brandId: zod_1.z.string().optional(),
    status: zod_1.z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});
exports.listCatalogTilesQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
});
exports.updateExtractedTileSchema = zod_1.z
    .object({
    name: zod_1.z.string().trim().min(1).optional(),
    size: zod_1.z.string().trim().optional().nullable(),
    finish: zod_1.z.string().trim().optional().nullable(),
    type: zod_1.z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
    colorTone: zod_1.z.string().trim().optional().nullable(),
    bestRoom: zod_1.z.string().trim().optional().nullable(),
    collection: zod_1.z.string().trim().optional().nullable(),
    productCode: zod_1.z.string().trim().optional().nullable(),
    inStock: zod_1.z.boolean().optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.masterTileSyncSchema = zod_1.z.object({
    productCode: zod_1.z.string().trim().min(1),
    productName: zod_1.z.string().trim().optional(),
    brandName: zod_1.z.string().trim().min(1),
    imageUrl: zod_1.z.string().trim().optional(),
    size: zod_1.z.string().trim().optional(),
    finish: zod_1.z.string().trim().optional(),
    colorTone: zod_1.z.string().trim().optional(),
    bestRoom: zod_1.z.string().trim().optional(),
    collection: zod_1.z.string().trim().optional(),
    type: zod_1.z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
    sheetRowRef: zod_1.z.coerce.number().int().min(0).optional(),
});
//# sourceMappingURL=catalogExtractor.validators.js.map