"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordLoginAttempt = recordLoginAttempt;
exports.listLoginHistory = listLoginHistory;
const connection_1 = require("@db/connection");
const logger_1 = require("@utils/logger");
const pagination_1 = require("@utils/pagination");
async function recordLoginAttempt(input) {
    try {
        await connection_1.prisma.loginAttempt.create({
            data: {
                email: input.email.toLowerCase().trim(),
                userId: input.userId ?? undefined,
                success: input.success,
                failureReason: input.failureReason,
                ipAddress: input.req?.ip,
                userAgent: input.req?.headers['user-agent'],
            },
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to record login attempt', { email: input.email, error: err.message });
    }
}
async function listLoginHistory(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.email ? { email: { contains: query.email.toLowerCase(), mode: 'insensitive' } } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.success !== undefined ? { success: query.success } : {}),
        ...(query.from || query.to
            ? {
                createdAt: {
                    ...(query.from ? { gte: query.from } : {}),
                    ...(query.to ? { lte: query.to } : {}),
                },
            }
            : {}),
    };
    const [attempts, total] = await Promise.all([
        connection_1.prisma.loginAttempt.findMany({
            where,
            include: { user: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.loginAttempt.count({ where }),
    ]);
    return { attempts, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
//# sourceMappingURL=loginAttempt.service.js.map