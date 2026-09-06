"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsCategoryParamSchema = exports.settingsSchemasByCategory = exports.generalSettingsSchema = exports.rulesSettingsSchema = exports.printSettingsSchema = exports.companySettingsSchema = void 0;
const zod_1 = require("zod");
exports.companySettingsSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(200).default('Casa de Aurum'),
    address: zod_1.z.string().trim().max(500).optional().default(''),
    phone: zod_1.z.string().trim().max(50).optional().default(''),
    email: zod_1.z.string().trim().email().optional().or(zod_1.z.literal('')).default(''),
    taxId: zod_1.z.string().trim().max(100).optional().default(''),
    website: zod_1.z.string().trim().max(200).optional().default(''),
});
exports.printSettingsSchema = zod_1.z.object({
    defaultDpi: zod_1.z.coerce.number().int().min(72).max(1200).default(300),
    defaultFormat: zod_1.z.enum(['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM']).default('CASSETTE_PANEL'),
    defaultFileFormat: zod_1.z.enum(['PNG', 'PDF']).default('PDF'),
    defaultUnit: zod_1.z.enum(['FT', 'IN', 'CM', 'MM']).default('FT'),
});
exports.rulesSettingsSchema = zod_1.z.object({
    defaultMinTiles: zod_1.z.coerce.number().int().min(1).max(50).default(3),
    defaultMaxCombinations: zod_1.z.coerce.number().int().min(1).max(20).default(4),
    defaultMinCatalogs: zod_1.z.coerce.number().int().min(1).max(20).default(3),
    defaultRoomType: zod_1.z.string().trim().max(100).optional().default(''),
    defaultStyleTag: zod_1.z.string().trim().max(100).optional().default(''),
});
exports.generalSettingsSchema = zod_1.z.object({
    timezone: zod_1.z.string().trim().min(1).max(100).default('Asia/Kolkata'),
    currency: zod_1.z.string().trim().min(1).max(10).default('INR'),
    dateFormat: zod_1.z.string().trim().min(1).max(30).default('DD/MM/YYYY'),
    sessionTimeoutMinutes: zod_1.z.coerce.number().int().min(5).max(1440).default(60),
});
exports.settingsSchemasByCategory = {
    company: exports.companySettingsSchema,
    print: exports.printSettingsSchema,
    rules: exports.rulesSettingsSchema,
    general: exports.generalSettingsSchema,
};
exports.settingsCategoryParamSchema = zod_1.z.object({
    category: zod_1.z.enum(['company', 'print', 'rules', 'general']),
});
//# sourceMappingURL=settings.validators.js.map