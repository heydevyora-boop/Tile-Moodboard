"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recentActivityQuerySchema = void 0;
const zod_1 = require("zod");
exports.recentActivityQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
//# sourceMappingURL=dashboard.validators.js.map