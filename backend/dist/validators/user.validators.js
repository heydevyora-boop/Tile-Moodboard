"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.changePasswordSchema = exports.updateProfileSchema = exports.userIdParamSchema = exports.listUsersQuerySchema = exports.assignRoleSchema = exports.updateUserSchema = exports.createUserSchema = void 0;
const zod_1 = require("zod");
const passwordSchema = zod_1.z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number');
const nameSchema = zod_1.z.string().trim().min(2, 'Name must be at least 2 characters').max(100);
const emailSchema = zod_1.z.string().trim().toLowerCase().email('Enter a valid email address');
exports.createUserSchema = zod_1.z.object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    roleId: zod_1.z.string().min(1, 'roleId is required'),
    isActive: zod_1.z.boolean().default(true),
});
exports.updateUserSchema = zod_1.z
    .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    isActive: zod_1.z.boolean().optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.assignRoleSchema = zod_1.z.object({
    roleId: zod_1.z.string().min(1, 'roleId is required'),
});
exports.listUsersQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    search: zod_1.z.string().trim().optional(),
    roleId: zod_1.z.string().optional(),
    isActive: zod_1.z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true')),
});
exports.userIdParamSchema = zod_1.z.object({
    id: zod_1.z.string().min(1, 'User id is required'),
});
exports.updateProfileSchema = zod_1.z
    .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.changePasswordSchema = zod_1.z
    .object({
    currentPassword: zod_1.z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
})
    .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
});
//# sourceMappingURL=user.validators.js.map