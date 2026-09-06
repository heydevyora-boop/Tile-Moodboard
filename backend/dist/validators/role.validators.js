"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateRoleSchema = exports.PERMISSION_STRINGS = void 0;
const zod_1 = require("zod");
exports.PERMISSION_STRINGS = [
    'analytics:read',
    'catalogs:read',
    'catalogs:write',
    'customers:read',
    'customers:write',
    'design_rules:read',
    'design_rules:write',
    'logs:read',
    'mood_boards:read',
    'mood_boards:write',
    'print_boards:read',
    'print_boards:write',
    'reference_images:read',
    'reference_images:write',
    'tiles:read',
    'tiles:write',
    'users:read',
    'users:write',
];
exports.updateRoleSchema = zod_1.z.object({
    description: zod_1.z.string().trim().max(500).optional(),
    permissions: zod_1.z.array(zod_1.z.enum(exports.PERMISSION_STRINGS)).optional(),
});
//# sourceMappingURL=role.validators.js.map