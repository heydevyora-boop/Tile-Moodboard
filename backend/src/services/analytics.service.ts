import { prisma } from '@db/connection';

export interface AnalyticsOverview {
  printExports: {
    byFormat: { format: string; count: number }[];
    byFileFormat: { fileFormat: string; count: number }[];
    byDpi: { dpi: number; count: number }[];
    total: number;
  };
  moodBoards: {
    generated: number;
    approved: number;
    approvalRate: number;
    byStyle: { style: string; count: number }[];
    byRoom: { room: string; count: number }[];
  };
  topFavoritedTiles: { tileId: string; tileName: string; favoriteCount: number }[];
  catalogUploads: { total: number; completed: number; failed: number; successRate: number };
  staffActivity: { userId: string; userName: string; actionCount: number }[];
}

function countBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function getAnalyticsOverview(days = 30): Promise<AnalyticsOverview> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [printBoards, moodBoardCounts, favoriteCounts, catalogCounts, recentActivity, styleCounts, roomCounts] = await Promise.all([
    prisma.printBoard.findMany({ select: { format: true, fileFormat: true, dpi: true } }),
    prisma.moodBoard.groupBy({ by: ['status'], _count: { status: true } }),
    prisma.customerFavorite.groupBy({ by: ['tileId'], _count: { tileId: true }, orderBy: { _count: { tileId: 'desc' } }, take: 5 }),
    prisma.catalog.groupBy({ by: ['status'], _count: { status: true } }),
    prisma.activityLog.findMany({ where: { createdAt: { gte: since }, userId: { not: null } }, select: { userId: true, user: { select: { name: true } } } }),
    prisma.moodBoard.groupBy({ by: ['style'], _count: { style: true }, orderBy: { _count: { style: 'desc' } } }),
    prisma.moodBoard.groupBy({ by: ['room'], _count: { room: true }, orderBy: { _count: { room: 'desc' } } }),
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
  const tiles = tileIds.length ? await prisma.tile.findMany({ where: { id: { in: tileIds } }, select: { id: true, name: true } }) : [];
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

  const activityByUser = new Map<string, { userName: string; count: number }>();
  for (const entry of recentActivity) {
    if (!entry.userId) continue;
    const existing = activityByUser.get(entry.userId);
    if (existing) {
      existing.count += 1;
    } else {
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
