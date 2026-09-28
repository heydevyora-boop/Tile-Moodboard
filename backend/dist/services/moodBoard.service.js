"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveMoodBoard = saveMoodBoard;
exports.listMoodBoards = listMoodBoards;
exports.getMoodBoardById = getMoodBoardById;
exports.updateMoodBoard = updateMoodBoard;
exports.deleteMoodBoard = deleteMoodBoard;
exports.approveMoodBoard = approveMoodBoard;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const pagination_1 = require("@utils/pagination");
const activityLog_service_1 = require("./activityLog.service");
async function assertTilesExist(combinations) {
    const referencedIds = new Set();
    combinations.forEach((c) => c.tiles.forEach((t) => referencedIds.add(t.tileId)));
    const existing = await connection_1.prisma.tile.findMany({ where: { id: { in: [...referencedIds] } }, select: { id: true } });
    const existingIds = new Set(existing.map((t) => t.id));
    const missing = [...referencedIds].filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
        throw AppError_1.AppError.badRequest('One or more combinations reference tiles that no longer exist', { missingTileIds: missing });
    }
}
function moodBoardTileRows(moodBoardId, combinations) {
    return combinations.flatMap((combo, combinationIndex) => combo.tiles.map((t) => ({
        moodBoardId,
        tileId: t.tileId,
        combinationIndex,
        role: t.role,
    })));
}
async function saveMoodBoard(input, actorId, req) {
    if (input.customerId) {
        const customer = await connection_1.prisma.customer.findUnique({ where: { id: input.customerId } });
        if (!customer)
            throw AppError_1.AppError.notFound('Customer not found');
    }
    await assertTilesExist(input.combinations);
    const board = await connection_1.prisma.moodBoard.create({
        data: {
            customerId: input.customerId,
            createdById: actorId,
            clientBrief: input.clientBrief,
            style: input.style,
            room: input.room,
            combinations: input.combinations,
            status: 'GENERATED',
        },
        include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
    });
    const tileRows = moodBoardTileRows(board.id, input.combinations);
    if (tileRows.length > 0) {
        await connection_1.prisma.moodBoardTile.createMany({ data: tileRows });
    }
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'mood_board.saved',
        entityType: 'MoodBoard',
        entityId: board.id,
        metadata: { combinationsCount: input.combinations.length, style: input.style, room: input.room },
        req,
    });
    return board;
}
async function listMoodBoards(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
    };
    const [boards, total] = await Promise.all([
        connection_1.prisma.moodBoard.findMany({
            where,
            include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.moodBoard.count({ where }),
    ]);
    return { boards, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getMoodBoardById(id) {
    const board = await connection_1.prisma.moodBoard.findUnique({
        where: { id },
        include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
    });
    if (!board)
        throw AppError_1.AppError.notFound('Mood board not found');
    return board;
}
async function updateMoodBoard(id, input, actorId, req) {
    const existing = await connection_1.prisma.moodBoard.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Mood board not found');
    const existingCombinations = existing.combinations;
    const effectiveCombinations = input.combinations ?? existingCombinations;
    if (input.selectedIndex !== undefined && input.selectedIndex >= effectiveCombinations.length) {
        throw AppError_1.AppError.badRequest(`selectedIndex ${input.selectedIndex} is out of range — this board has ${effectiveCombinations.length} combination(s)`);
    }
    if (input.combinations) {
        await assertTilesExist(input.combinations);
    }
    const updated = await connection_1.prisma.$transaction(async (tx) => {
        if (input.combinations) {
            await tx.moodBoardTile.deleteMany({ where: { moodBoardId: id } });
            const tileRows = moodBoardTileRows(id, input.combinations);
            if (tileRows.length > 0) {
                await tx.moodBoardTile.createMany({ data: tileRows });
            }
        }
        return tx.moodBoard.update({
            where: { id },
            data: {
                ...(input.clientBrief !== undefined ? { clientBrief: input.clientBrief } : {}),
                ...(input.style !== undefined ? { style: input.style } : {}),
                ...(input.room !== undefined ? { room: input.room } : {}),
                ...(input.selectedIndex !== undefined ? { selectedIndex: input.selectedIndex } : {}),
                ...(input.status !== undefined ? { status: input.status } : {}),
                ...(input.combinations !== undefined ? { combinations: input.combinations } : {}),
            },
            include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
        });
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'mood_board.updated',
        entityType: 'MoodBoard',
        entityId: id,
        metadata: { changes: { ...input, combinations: input.combinations ? `${input.combinations.length} combination(s) replaced` : undefined } },
        req,
    });
    return updated;
}
async function deleteMoodBoard(id, actorId, req) {
    const existing = await connection_1.prisma.moodBoard.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Mood board not found');
    await connection_1.prisma.moodBoard.delete({ where: { id } });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'mood_board.deleted',
        entityType: 'MoodBoard',
        entityId: id,
        metadata: { clientBrief: existing.clientBrief, style: existing.style, room: existing.room },
        req,
    });
}
async function approveMoodBoard(id, selectedIndex, actorId, req) {
    const existing = await connection_1.prisma.moodBoard.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Mood board not found');
    const combinations = existing.combinations;
    if (selectedIndex >= combinations.length) {
        throw AppError_1.AppError.badRequest(`selectedIndex ${selectedIndex} is out of range — this board has ${combinations.length} combination(s)`);
    }
    const updated = await connection_1.prisma.moodBoard.update({
        where: { id },
        data: { status: 'APPROVED', selectedIndex },
        include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'mood_board.approved',
        entityType: 'MoodBoard',
        entityId: id,
        metadata: { selectedIndex, boardName: combinations[selectedIndex]?.board_name },
        req,
    });
    return updated;
}
//# sourceMappingURL=moodBoard.service.js.map