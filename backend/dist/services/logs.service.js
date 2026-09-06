"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLogs = listLogs;
exports.listDistinctActions = listDistinctActions;
exports.listMoodBoardLogs = listMoodBoardLogs;
exports.listPrintBoardLogs = listPrintBoardLogs;
exports.listCatalogLogs = listCatalogLogs;
const connection_1 = require("@db/connection");
const pagination_1 = require("@utils/pagination");
async function listLogs(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.from || query.to
            ? {
                createdAt: {
                    ...(query.from ? { gte: query.from } : {}),
                    ...(query.to ? { lte: query.to } : {}),
                },
            }
            : {}),
    };
    const [logs, total] = await Promise.all([
        connection_1.prisma.activityLog.findMany({
            where,
            include: { user: { select: { id: true, name: true, email: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.activityLog.count({ where }),
    ]);
    return { logs, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function listDistinctActions() {
    const rows = await connection_1.prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
    return rows.map((r) => r.action);
}
async function listMoodBoardLogs(query) {
    return listLogs({ ...query, entityType: 'MoodBoard' });
}
async function listPrintBoardLogs(query) {
    return listLogs({ ...query, entityType: 'PrintBoard' });
}
async function listCatalogLogs(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
    };
    const [catalogs, total] = await Promise.all([
        connection_1.prisma.catalog.findMany({
            where,
            select: {
                id: true,
                fileName: true,
                status: true,
                errorMessage: true,
                processingLog: true,
                totalPages: true,
                currentPage: true,
                startedAt: true,
                completedAt: true,
                createdAt: true,
                brand: { select: { id: true, name: true } },
                uploadedBy: { select: { id: true, name: true } },
            },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.catalog.count({ where }),
    ]);
    return { catalogs, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
//# sourceMappingURL=logs.service.js.map