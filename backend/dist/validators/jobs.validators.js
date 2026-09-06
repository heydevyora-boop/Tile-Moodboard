"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobsQuerySchema = void 0;
const zod_1 = require("zod");
exports.jobsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(200).default(50),
    type: zod_1.z.enum(['IMAGE_PROCESSING', 'EXPORT']).optional(),
    status: zod_1.z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});
//# sourceMappingURL=jobs.validators.js.map