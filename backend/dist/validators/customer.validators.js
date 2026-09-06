"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addFavoriteSchema = exports.listCustomersQuerySchema = exports.updateCustomerSchema = exports.createCustomerSchema = void 0;
const zod_1 = require("zod");
exports.createCustomerSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(120),
    phone: zod_1.z.string().trim().max(30).optional(),
    email: zod_1.z.string().trim().email().optional().or(zod_1.z.literal('')),
    preferredStyle: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    preferredRoom: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    budget: zod_1.z.string().trim().max(40).optional(),
    notes: zod_1.z.string().trim().max(2000).optional(),
});
exports.updateCustomerSchema = zod_1.z
    .object({
    name: zod_1.z.string().trim().min(1).max(120).optional(),
    phone: zod_1.z.string().trim().max(30).optional(),
    email: zod_1.z.string().trim().email().optional().or(zod_1.z.literal('')),
    preferredStyle: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    preferredRoom: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    budget: zod_1.z.string().trim().max(40).optional(),
    notes: zod_1.z.string().trim().max(2000).optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.listCustomersQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    search: zod_1.z.string().trim().optional(),
});
exports.addFavoriteSchema = zod_1.z.object({
    tileId: zod_1.z.string().min(1),
    note: zod_1.z.string().trim().max(500).optional(),
});
//# sourceMappingURL=customer.validators.js.map