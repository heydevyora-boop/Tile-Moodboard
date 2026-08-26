import { prisma } from '@db/connection';
import { logger } from '@utils/logger';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { ErrorLogsQuery } from '@validators/loggingSystem.validators';

interface RecordErrorLogInput {
  message: string;
  stack?: string;
  statusCode: number;
  path: string;
  method: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persists a server error (statusCode >= 500) so it can be browsed and
 * filtered from the Admin > Logs UI instead of requiring shell access to
 * grep winston's rotated file logs. Fire-and-forget, same pattern as
 * activity/login logging — a logging failure must never mask or replace
 * the original error response already being sent to the client.
 */
export async function recordErrorLog(input: RecordErrorLogInput): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        message: input.message,
        stack: input.stack,
        statusCode: input.statusCode,
        path: input.path,
        method: input.method,
        userId: input.userId,
        // Prisma's generated type for a Json column (InputJsonValue) is
        // stricter than Record<string, unknown> — TS can't prove an
        // arbitrary Record is JSON-serializable on its own. This is a
        // deliberate, narrow cast at the Prisma boundary, not a sign the
        // value itself is unsafe: everything passed in here is always a
        // plain object built from primitives (see call sites).
        metadata: input.metadata as unknown as object | undefined,
      },
    });
  } catch (err) {
    logger.error('Failed to record error log', { message: input.message, error: (err as Error).message });
  }
}

export async function listErrorLogs(query: ErrorLogsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.statusCode ? { statusCode: query.statusCode } : {}),
    ...(query.path ? { path: { contains: query.path, mode: 'insensitive' as const } } : {}),
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
    prisma.errorLog.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.errorLog.count({ where }),
  ]);

  return { errors, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}