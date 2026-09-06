"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshSchema = exports.resetPasswordSchema = exports.forgotPasswordSchema = exports.loginSchema = void 0;
const zod_1 = require("zod");
const passwordSchema = zod_1.z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number');
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Enter a valid email address'),
    password: zod_1.z.string().min(1, 'Password is required'),
});
exports.forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email('Enter a valid email address'),
});
exports.resetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string().min(1, 'Reset token is required'),
    newPassword: passwordSchema,
});
exports.refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().optional(),
});
//# sourceMappingURL=auth.validators.js.map