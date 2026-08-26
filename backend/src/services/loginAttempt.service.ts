import { Request } from 'express';
import { prisma } from '@db/connection';
import { logger } from '@utils/logger';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { LoginHistoryQuery } from '@validators/loggingSystem.validators';

export type FailureReason = 'user_not_found' | 'invalid_password' | 'account_deactivated';

interface RecordLoginAttemptInput {
  email: string;
  userId?: string | null;
  success: boolean;
  failureReason?: FailureReason;
  req?: Request;
}

/**
 * Records every login attempt, successful or not — including attempts
 * against emails with no matching account. That last case matters: it's
 * exactly the signal you'd want to catch a credential-stuffing attempt
 * against your staff list, and the pre-Module-22 login flow threw before
 * ever logging anything for it.
 */
export async function recordLoginAttempt(input: RecordLoginAttemptInput): Promise<void> {
  try {
    await prisma.loginAttempt.create({
      data: {
        email: input.email.toLowerCase().trim(),
        userId: input.userId ?? undefined,
        success: input.success,
        failureReason: input.failureReason,
        ipAddress: input.req?.ip,
        userAgent: input.req?.headers['user-agent'],
      },
    });
  } catch (err) {
    logger.error('Failed to record login attempt', { email: input.email, error: (err as Error).message });
  }
}

export async function listLoginHistory(query: LoginHistoryQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.email ? { email: { contains: query.email.toLowerCase(), mode: 'insensitive' as const } } : {}),
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
    prisma.loginAttempt.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.loginAttempt.count({ where }),
  ]);

  return { attempts, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}
