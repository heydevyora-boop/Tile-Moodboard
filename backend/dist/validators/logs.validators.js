"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logsQuerySchema = void 0;
const zod_1 = require("zod");
exports.logsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
    action: zod_1.z.string().trim().optional(),
    entityType: zod_1.z.string().trim().optional(),
    userId: zod_1.z.string().trim().optional(),
    from: zod_1.z.coerce.date().optional(),
    to: zod_1.z.coerce.date().optional(),
});
//# sourceMappingURL=logs.validators.js.map