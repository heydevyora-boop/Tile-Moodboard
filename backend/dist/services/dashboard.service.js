"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStats = getStats;
exports.getRecentActivity = getRecentActivity;
exports.getSystemStatus = getSystemStatus;
exports.getOverview = getOverview;
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function normalizeStatusBreakdown(raw, allStatuses) {
    const counts = new Map(raw.map((r) => [r.status, r._count.status]));
    return allStatuses.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}
async function getStats() {
    const weekAgo = new Date(Date.now() - ONE_WEEK_MS);
    const [totalUsers, activeUsers, totalBrands, totalTiles, totalCatalogs, catalogsThisWeek, catalogsByStatusRaw, totalMoodBoards, moodBoardsThisWeek, moodBoardsByStatusRaw, totalPrintBoards, printBoardsThisWeek, totalCustomers, totalDesignRules, totalReferenceImages,] = await Promise.all([
        connection_1.prisma.user.count(),
        connection_1.prisma.user.count({ where: { isActive: true } }),
        connection_1.prisma.brand.count(),
        connection_1.prisma.tile.count(),
        connection_1.prisma.catalog.count(),
        connection_1.prisma.catalog.count({ where: { createdAt: { gte: weekAgo } } }),
        connection_1.prisma.catalog.groupBy({ by: ['status'], _count: { status: true } }),
        connection_1.prisma.moodBoard.count(),
        connection_1.prisma.moodBoard.count({ where: { createdAt: { gte: weekAgo } } }),
        connection_1.prisma.moodBoard.groupBy({ by: ['status'], _count: { status: true } }),
        connection_1.prisma.printBoard.count(),
        connection_1.prisma.printBoard.count({ where: { createdAt: { gte: weekAgo } } }),
        connection_1.prisma.customer.count(),
        connection_1.prisma.designRule.count({ where: { isActive: true } }),
        connection_1.prisma.referenceImage.count(),
    ]);
    return {
        users: { total: totalUsers, active: activeUsers },
        brands: { total: totalBrands },
        tiles: { total: totalTiles },
        catalogs: {
            total: totalCatalogs,
            newThisWeek: catalogsThisWeek,
            byStatus: normalizeStatusBreakdown(catalogsByStatusRaw, ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']),
        },
        moodBoards: {
            total: totalMoodBoards,
            newThisWeek: moodBoardsThisWeek,
            byStatus: normalizeStatusBreakdown(moodBoardsByStatusRaw, [
                'DRAFT',
                'GENERATED',
                'REFINED',
                'APPROVED',
                'REJECTED',
                'ARCHIVED',
            ]),
        },
        printBoards: { total: totalPrintBoards, newThisWeek: printBoardsThisWeek },
        customers: { total: totalCustomers },
        designRules: { total: totalDesignRules },
        referenceImages: { total: totalReferenceImages },
    };
}
async function getRecentActivity(limit) {
    const rows = await connection_1.prisma.activityLog.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true } } },
    });
    return rows;
}
function getSystemStatus() {
    return {
        env: index_1.config.env,
        uptimeSeconds: Math.round(process.uptime()),
        db: (0, connection_1.isDatabaseConnected)() ? 'up' : 'down',
        timestamp: new Date().toISOString(),
    };
}
async function getOverview(activityLimit = 10) {
    const [stats, recentActivity] = await Promise.all([getStats(), getRecentActivity(activityLimit)]);
    return {
        stats,
        recentActivity,
        system: getSystemStatus(),
    };
}
//# sourceMappingURL=dashboard.service.js.map