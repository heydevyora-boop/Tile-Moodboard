import { prisma, isDatabaseConnected } from '@db/connection';
import { config } from '@config/index';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface StatusBreakdown {
  status: string;
  count: number;
}

export interface DashboardStats {
  users: { total: number; active: number };
  brands: { total: number };
  tiles: { total: number };
  catalogs: { total: number; newThisWeek: number; byStatus: StatusBreakdown[] };
  moodBoards: { total: number; newThisWeek: number; byStatus: StatusBreakdown[] };
  printBoards: { total: number; newThisWeek: number };
  customers: { total: number };
  designRules: { total: number };
  referenceImages: { total: number };
}

/**
 * Turns Prisma's groupBy shape ([{ status: 'X', _count: { status: N } }, ...])
 * into a flat, frontend-friendly array. Also fills in zero-count entries for
 * any status the DB happens to have no rows for yet, so chart/legend code
 * on the frontend doesn't have to special-case missing keys.
 */
function normalizeStatusBreakdown(
  raw: { status: string; _count: { status: number } }[],
  allStatuses: readonly string[],
): StatusBreakdown[] {
  const counts = new Map(raw.map((r) => [r.status, r._count.status]));
  return allStatuses.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

export async function getStats(): Promise<DashboardStats> {
  const weekAgo = new Date(Date.now() - ONE_WEEK_MS);

  const [
    totalUsers,
    activeUsers,
    totalBrands,
    totalTiles,
    totalCatalogs,
    catalogsThisWeek,
    catalogsByStatusRaw,
    totalMoodBoards,
    moodBoardsThisWeek,
    moodBoardsByStatusRaw,
    totalPrintBoards,
    printBoardsThisWeek,
    totalCustomers,
    totalDesignRules,
    totalReferenceImages,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.brand.count(),
    prisma.tile.count(),
    prisma.catalog.count(),
    prisma.catalog.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.catalog.groupBy({ by: ['status'], _count: { status: true } }),
    prisma.moodBoard.count(),
    prisma.moodBoard.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.moodBoard.groupBy({ by: ['status'], _count: { status: true } }),
    prisma.printBoard.count(),
    prisma.printBoard.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.customer.count(),
    prisma.designRule.count({ where: { isActive: true } }),
    prisma.referenceImage.count(),
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

export interface RecentActivityItem {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  user: { id: string; name: string; email: string } | null;
}

export async function getRecentActivity(limit: number): Promise<RecentActivityItem[]> {
  const rows = await prisma.activityLog.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  return rows as unknown as RecentActivityItem[];
}

export interface SystemStatus {
  env: string;
  uptimeSeconds: number;
  db: 'up' | 'down';
  timestamp: string;
}

export function getSystemStatus(): SystemStatus {
  return {
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    db: isDatabaseConnected() ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  };
}

export interface DashboardOverview {
  stats: DashboardStats;
  recentActivity: RecentActivityItem[];
  system: SystemStatus;
}

/** Single call to hydrate the whole Admin Dashboard page in one round trip. */
export async function getOverview(activityLimit = 10): Promise<DashboardOverview> {
  const [stats, recentActivity] = await Promise.all([getStats(), getRecentActivity(activityLimit)]);

  return {
    stats,
    recentActivity,
    system: getSystemStatus(),
  };
}
