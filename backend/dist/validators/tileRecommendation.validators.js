"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tileRecommendationsQuerySchema = void 0;
const zod_1 = require("zod");
exports.tileRecommendationsQuerySchema = zod_1.z.object({
    room: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    style: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    colorTone: zod_1.z.string().trim().max(40).optional(),
    brandId: zod_1.z.string().optional(),
    type: zod_1.z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
//# sourceMappingURL=tileRecommendation.validators.js.map