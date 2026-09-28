"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMoodBoardsQuerySchema = exports.approveMoodBoardSchema = exports.updateMoodBoardSchema = exports.saveMoodBoardSchema = exports.combinationSchema = exports.generateBriefSchema = void 0;
const zod_1 = require("zod");
exports.generateBriefSchema = zod_1.z.object({
    customerId: zod_1.z.string().optional(),
    text: zod_1.z.string().trim().min(3, 'Describe the client brief in at least a few words').max(2000),
    style: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    room: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    budget: zod_1.z.string().trim().max(40).optional(),
    brandId: zod_1.z.string().optional(),
    combinationCount: zod_1.z.coerce.number().int().min(1).max(6).optional(),
});
const combinationTileSchema = zod_1.z.object({
    role: zod_1.z.enum(['base', 'highlight', 'border', 'accent']),
    tileId: zod_1.z.string().min(1),
    name: zod_1.z.string().default(''),
});
exports.combinationSchema = zod_1.z.object({
    board_name: zod_1.z.string().min(1),
    tiles: zod_1.z.array(combinationTileSchema).min(1, 'Each combination needs at least one tile'),
    grout_recommendation: zod_1.z.string().default(''),
    rooms_suitable: zod_1.z.array(zod_1.z.string()).default([]),
    reason_for_selection: zod_1.z.string().default(''),
});
exports.saveMoodBoardSchema = zod_1.z.object({
    customerId: zod_1.z.string().optional(),
    clientBrief: zod_1.z.string().trim().min(3).max(2000),
    style: zod_1.z.string().trim().toUpperCase().max(40),
    room: zod_1.z.string().trim().toUpperCase().max(40),
    combinations: zod_1.z.array(exports.combinationSchema).min(1, 'At least one combination is required to save a mood board'),
});
exports.updateMoodBoardSchema = zod_1.z
    .object({
    clientBrief: zod_1.z.string().trim().min(3).max(2000).optional(),
    style: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    room: zod_1.z.string().trim().toUpperCase().max(40).optional(),
    selectedIndex: zod_1.z.number().int().min(0).optional(),
    status: zod_1.z.enum(['DRAFT', 'GENERATED', 'REFINED', 'REJECTED', 'ARCHIVED']).optional(),
    combinations: zod_1.z.array(exports.combinationSchema).min(1).optional(),
})
    .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });
exports.approveMoodBoardSchema = zod_1.z.object({
    selectedIndex: zod_1.z.number().int().min(0),
});
exports.listMoodBoardsQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    status: zod_1.z.enum(['DRAFT', 'GENERATED', 'REFINED', 'APPROVED', 'REJECTED', 'ARCHIVED']).optional(),
    customerId: zod_1.z.string().optional(),
});
//# sourceMappingURL=moodBoard.validators.js.map