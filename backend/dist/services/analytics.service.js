"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnalyticsOverview = getAnalyticsOverview;
const connection_1 = require("@db/connection");
function countBy(items, keyFn) {
    const counts = new Map();
    for (const item of items) {
        const key = keyFn(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}
async function getAnalyticsOverview(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [printBoards, moodBoardCounts, favoriteCounts, catalogCounts, recentActivity, styleCounts, roomCounts] = await Promise.all([
        connection_1.prisma.printBoard.findMany({ select: { format: true, fileFormat: true, dpi: true } }),
        connection_1.prisma.moodBoard.groupBy({ by: ['status'], _count: { status: true } }),
        connection_1.prisma.customerFavorite.groupBy({ by: ['tileId'], _count: { tileId: true }, orderBy: { _count: { tileId: 'desc' } }, take: 5 }),
        connection_1.prisma.catalog.groupBy({ by: ['status'], _count: { status: true } }),
        connection_1.prisma.activityLog.findMany({ where: { createdAt: { gte: since }, userId: { not: null } }, select: { userId: true, user: { select: { name: true } } } }),
        connection_1.prisma.moodBoard.groupBy({ by: ['style'], _count: { style: true }, orderBy: { _count: { style: 'desc' } } }),
        connection_1.prisma.moodBoard.groupBy({ by: ['room'], _count: { room: true }, orderBy: { _count: { room: 'desc' } } }),
    ]);
    const byStyle = styleCounts.map((s) => ({ style: s.style, count: s._count.style }));
    const byRoom = roomCounts.map((r) => ({ room: r.room, count: r._count.room }));
    const byFormat = [...countBy(printBoards, (p) => p.format)].map(([format, count]) => ({ format, count }));
    const byFileFormat = [...countBy(printBoards, (p) => p.fileFormat)].map(([fileFormat, count]) => ({ fileFormat, count }));
    const byDpi = [...countBy(printBoards, (p) => p.dpi)].map(([dpi, count]) => ({ dpi, count })).sort((a, b) => a.dpi - b.dpi);
    const statusCounts = new Map(moodBoardCounts.map((c) => [c.status, c._count.status]));
    const generated = [...statusCounts.values()].reduce((sum, n) => sum + n, 0);
    const approved = statusCounts.get('APPROVED') ?? 0;
    const approvalRate = generated > 0 ? Math.round((approved / generated) * 1000) / 10 : 0;
    const tileIds = favoriteCounts.map((f) => f.tileId);
    const tiles = tileIds.length ? await connection_1.prisma.tile.findMany({ where: { id: { in: tileIds } }, select: { id: true, name: true } }) : [];
    const tileNameById = new Map(tiles.map((t) => [t.id, t.name]));
    const topFavoritedTiles = favoriteCounts.map((f) => ({
        tileId: f.tileId,
        tileName: tileNameById.get(f.tileId) ?? '(deleted tile)',
        favoriteCount: f._count.tileId,
    }));
    const catalogStatusCounts = new Map(catalogCounts.map((c) => [c.status, c._count.status]));
    const catalogTotal = [...catalogStatusCounts.values()].reduce((sum, n) => sum + n, 0);
    const catalogCompleted = catalogStatusCounts.get('COMPLETED') ?? 0;
    const catalogFailed = catalogStatusCounts.get('FAILED') ?? 0;
    const catalogSuccessRate = catalogTotal > 0 ? Math.round((catalogCompleted / catalogTotal) * 1000) / 10 : 0;
    const activityByUser = new Map();
    for (const entry of recentActivity) {
        if (!entry.userId)
            continue;
        const existing = activityByUser.get(entry.userId);
        if (existing) {
            existing.count += 1;
        }
        else {
            activityByUser.set(entry.userId, { userName: entry.user?.name ?? '(deleted user)', count: 1 });
        }
    }
    const staffActivity = [...activityByUser.entries()]
        .map(([userId, v]) => ({ userId, userName: v.userName, actionCount: v.count }))
        .sort((a, b) => b.actionCount - a.actionCount)
        .slice(0, 10);
    return {
        printExports: { byFormat, byFileFormat, byDpi, total: printBoards.length },
        moodBoards: { generated, approved, approvalRate, byStyle, byRoom },
        topFavoritedTiles,
        catalogUploads: { total: catalogTotal, completed: catalogCompleted, failed: catalogFailed, successRate: catalogSuccessRate },
        staffActivity,
    };
}
//# sourceMappingURL=analytics.service.js.map