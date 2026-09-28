"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listReferenceImagesQuerySchema = exports.updateReferenceImageSchema = exports.uploadReferenceImageSchema = void 0;
const zod_1 = require("zod");
exports.uploadReferenceImageSchema = zod_1.z.object({
    styleTag: zod_1.z.string().trim().min(1).max(80),
    description: zod_1.z.string().trim().max(500).optional(),
    style: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    room: zod_1.z.string().trim().toUpperCase().max(40).optional(),
});
exports.updateReferenceImageSchema = zod_1.z
    .object({
    styleTag: zod_1.z.string().trim().min(1).max(80).optional(),
    description: zod_1.z.string().trim().max(500).optional().nullable(),
    style: zod_1.z.string().trim().toUpperCase().max(40).optional().nullable(),
    room: zod_1.z.string().trim().toUpperCase().max(40).optional().nullable(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.listReferenceImagesQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(24),
    search: zod_1.z.string().trim().optional(),
    style: zod_1.z.string().trim().toUpperCase().optional(),
    room: zod_1.z.string().trim().toUpperCase().optional(),
});
//# sourceMappingURL=referenceImages.validators.js.map