"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareVersionsQuerySchema = exports.listVersionsQuerySchema = exports.publishRulesSchema = exports.updateDesignRuleSchema = exports.createDesignRuleSchema = void 0;
const zod_1 = require("zod");
const RULE_SECTIONS = ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'];
exports.createDesignRuleSchema = zod_1.z
    .object({
    section: zod_1.z.enum(RULE_SECTIONS),
    key: zod_1.z.string().trim().toUpperCase().regex(/^[A-Z_]+$/, 'key must be uppercase letters/underscores only').optional(),
    title: zod_1.z.string().trim().min(1).max(120),
    content: zod_1.z.string().trim().min(1).max(4000),
    sortOrder: zod_1.z.number().int().default(0),
    isActive: zod_1.z.boolean().default(true),
})
    .refine((data) => (data.section === 'GENERAL' ? data.key === undefined : !!data.key), {
    message: 'key is required for STYLE/ROOM/CLIENT rules, and must be omitted for GENERAL',
    path: ['key'],
});
exports.updateDesignRuleSchema = zod_1.z
    .object({
    title: zod_1.z.string().trim().min(1).max(120).optional(),
    content: zod_1.z.string().trim().min(1).max(4000).optional(),
    sortOrder: zod_1.z.number().int().optional(),
    isActive: zod_1.z.boolean().optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.publishRulesSchema = zod_1.z.object({
    changeSummary: zod_1.z.string().trim().max(500).optional(),
});
exports.listVersionsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
exports.compareVersionsQuerySchema = zod_1.z.object({
    from: zod_1.z.string().min(1, 'from is required'),
    to: zod_1.z.string().min(1, 'to is required'),
});
//# sourceMappingURL=designRules.validators.js.map