import { Request } from 'express';
import { prisma } from '@db/connection';
import { logger } from '@utils/logger';

interface LogActivityInput {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  req?: Request;
}

/**
 * Writes one row to ActivityLog. Never throws — a logging failure should
 * never break the request that triggered it, so errors are swallowed and
 * reported to winston instead.
 */
export async function logActivity({ userId, action, entityType, entityId, metadata, req }: LogActivityInput): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        userId: userId ?? undefined,
        action,
        entityType,
        entityId,
        // See the identical cast + comment in errorLog.service.ts —
        // Prisma's Json input type is stricter than Record<string, unknown>.
        metadata: metadata as unknown as object | undefined,
        ipAddress: req?.ip,
        userAgent: req?.headers['user-agent'],
      },
    });
  } catch (err) {
    logger.error('Failed to write activity log', { action, error: (err as Error).message });
  }
}