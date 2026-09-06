"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordErrorLog = recordErrorLog;
exports.listErrorLogs = listErrorLogs;
const connection_1 = require("@db/connection");
const logger_1 = require("@utils/logger");
const pagination_1 = require("@utils/pagination");
async function recordErrorLog(input) {
    try {
        await connection_1.prisma.errorLog.create({
            data: {
                message: input.message,
                stack: input.stack,
                statusCode: input.statusCode,
                path: input.path,
                method: input.method,
                userId: input.userId,
                metadata: input.metadata,
            },
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to record error log', { message: input.message, error: err.message });
    }
}
async function listErrorLogs(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.statusCode ? { statusCode: query.statusCode } : {}),
        ...(query.path ? { path: { contains: query.path, mode: 'insensitive' } } : {}),
        ...(query.from || query.to
            ? {
                createdAt: {
                    ...(query.from ? { gte: query.from } : {}),
                    ...(query.to ? { lte: query.to } : {}),
                },
            }
            : {}),
    };
    const [errors, total] = await Promise.all([
        connection_1.prisma.errorLog.findMany({
            where,
            include: { user: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.errorLog.count({ where }),
    ]);
    return { errors, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
//# sourceMappingURL=errorLog.service.js.map