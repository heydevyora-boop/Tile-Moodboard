"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listApiKeysQuerySchema = exports.rotateApiKeySchema = exports.createApiKeySchema = void 0;
const zod_1 = require("zod");
exports.createApiKeySchema = zod_1.z.object({
    service: zod_1.z.enum(['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM']),
    label: zod_1.z.string().trim().min(1).max(120),
    value: zod_1.z.string().trim().min(1).max(4000),
});
exports.rotateApiKeySchema = zod_1.z.object({
    value: zod_1.z.string().trim().min(1).max(4000),
});
exports.listApiKeysQuerySchema = zod_1.z.object({
    service: zod_1.z.enum(['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM']).optional(),
});
//# sourceMappingURL=apiKey.validators.js.map