"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPrintBoardTemplateSchema = exports.exportHistoryQuerySchema = exports.listPrintBoardsQuerySchema = exports.updatePrintBoardSchema = exports.generatePrintBoardSchema = void 0;
const zod_1 = require("zod");
const dimensionFields = {
    format: zod_1.z.enum(['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM']),
    layout: zod_1.z.enum(['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE']),
    widthValue: zod_1.z.number().positive(),
    heightValue: zod_1.z.number().positive(),
    unit: zod_1.z.enum(['FT', 'IN', 'CM', 'MM']),
    dpi: zod_1.z.number().int().min(72).max(1200).default(300),
};
exports.generatePrintBoardSchema = zod_1.z
    .object({
    moodBoardId: zod_1.z.string().min(1),
    combinationIndex: zod_1.z.number().int().min(0).optional(),
    templateId: zod_1.z.string().optional(),
    format: dimensionFields.format.optional(),
    layout: dimensionFields.layout.optional(),
    widthValue: dimensionFields.widthValue.optional(),
    heightValue: dimensionFields.heightValue.optional(),
    unit: dimensionFields.unit.optional(),
    dpi: dimensionFields.dpi.optional(),
    fileFormat: zod_1.z.enum(['PDF', 'PNG']).default('PDF'),
})
    .refine((data) => data.templateId || (data.format && data.layout && data.widthValue && data.heightValue && data.unit), {
    message: 'Provide either templateId or format+layout+widthValue+heightValue+unit',
});
exports.updatePrintBoardSchema = zod_1.z
    .object({
    format: dimensionFields.format.optional(),
    layout: dimensionFields.layout.optional(),
    widthValue: dimensionFields.widthValue.optional(),
    heightValue: dimensionFields.heightValue.optional(),
    unit: dimensionFields.unit.optional(),
    dpi: zod_1.z.number().int().min(72).max(1200).optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.listPrintBoardsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    moodBoardId: zod_1.z.string().optional(),
    fileFormat: zod_1.z.enum(['PDF', 'PNG']).optional(),
});
exports.exportHistoryQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
exports.createPrintBoardTemplateSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(80),
    ...dimensionFields,
});
//# sourceMappingURL=printBoard.validators.js.map