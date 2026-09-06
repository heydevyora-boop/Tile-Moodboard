"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.catalogLogsQuerySchema = exports.errorLogsQuerySchema = exports.loginHistoryQuerySchema = void 0;
const zod_1 = require("zod");
const boolFromQuery = zod_1.z
    .union([zod_1.z.literal('true'), zod_1.z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'));
exports.loginHistoryQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
    email: zod_1.z.string().trim().optional(),
    userId: zod_1.z.string().trim().optional(),
    success: boolFromQuery,
    from: zod_1.z.coerce.date().optional(),
    to: zod_1.z.coerce.date().optional(),
});
exports.errorLogsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
    statusCode: zod_1.z.coerce.number().int().optional(),
    path: zod_1.z.string().trim().optional(),
    from: zod_1.z.coerce.date().optional(),
    to: zod_1.z.coerce.date().optional(),
});
exports.catalogLogsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
    status: zod_1.z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
    brandId: zod_1.z.string().trim().optional(),
});
//# sourceMappingURL=loggingSystem.validators.js.map