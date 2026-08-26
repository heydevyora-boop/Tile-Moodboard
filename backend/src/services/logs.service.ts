import { prisma } from '@db/connection';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { LogsQuery } from '@validators/logs.validators';
import { CatalogLogsQuery } from '@validators/loggingSystem.validators';

/**
 * "User Activity Logs" — the ActivityLog audit trail this app has been
 * writing to since Module 4: every create/update/delete/generate/publish
 * action across the whole build logs here. Login history and error logs
 * are separate, dedicated tables (Module 22) with their own richer,
 * structured fields — see loginAttempt.service.ts and errorLog.service.ts.
 */
export async function listLogs(query: LogsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.action ? { action: { contains: query.action, mode: 'insensitive' as const } } : {}),
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
    prisma.activityLog.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.activityLog.count({ where }),
  ]);

  return { logs, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function listDistinctActions(): Promise<string[]> {
  const rows = await prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
  return rows.map((r) => r.action);
}

/** Mood Board Logs — the generic activity trail, pre-scoped to MoodBoard entities. */
export async function listMoodBoardLogs(query: Omit<LogsQuery, 'entityType'>) {
  return listLogs({ ...query, entityType: 'MoodBoard' });
}

/** Print Board Logs — the generic activity trail, pre-scoped to PrintBoard entities. */
export async function listPrintBoardLogs(query: Omit<LogsQuery, 'entityType'>) {
  return listLogs({ ...query, entityType: 'PrintBoard' });
}

/**
 * Catalog Logs — unlike Mood/Print Board logs, this isn't just a scoped
 * ActivityLog view. The richest per-run detail (the actual extraction
 * progress log, page-by-page) lives on Catalog.processingLog, not in
 * ActivityLog, which only has generic "catalog.uploaded"-style entries.
 * This surfaces real run history across all catalogs for the admin logs
 * screen; the existing GET /catalog-extractor/catalogs/:id already exposes
 * one run's full log for the per-catalog "View Log" button.
 */
export async function listCatalogLogs(query: CatalogLogsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.brandId ? { brandId: query.brandId } : {}),
  };

  const [catalogs, total] = await Promise.all([
    prisma.catalog.findMany({
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
    prisma.catalog.count({ where }),
  ]);

  return { catalogs, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}
