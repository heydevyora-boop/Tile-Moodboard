import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { generateOpaqueToken, hashToken } from '@utils/crypto';
import { addDuration } from '@utils/duration';
import { AppError } from '@utils/AppError';

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

function metaFromRequest(req?: Request): RequestMeta {
  return { ipAddress: req?.ip, userAgent: req?.headers['user-agent'] };
}

/**
 * Issues a brand new refresh token for a user and stores its hash.
 * Returns the RAW token — this is the only time it exists in plaintext;
 * only its hash is persisted.
 */
export async function issueRefreshToken(userId: string, req?: Request): Promise<string> {
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken, config.auth.jwtRefreshSecret);
  const { ipAddress, userAgent } = metaFromRequest(req);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: addDuration(new Date(), config.auth.jwtRefreshExpiresIn),
      ipAddress,
      userAgent,
    },
  });

  return rawToken;
}

/**
 * Validates a raw refresh token, rotates it (revokes the old one, issues
 * a new one), and returns the new raw token plus the associated userId.
 * Rotation means a stolen-and-reused old token is immediately detectable
 * (its replacedByTokenHash will be set, and any known reuse can be
 * treated as a signal to revoke the whole session chain).
 */
export async function rotateRefreshToken(rawToken: string, req?: Request): Promise<{ userId: string; newRawToken: string }> {
  const tokenHash = hashToken(rawToken, config.auth.jwtRefreshSecret);

  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw AppError.unauthorized('Invalid refresh token');
  }
  if (existing.revokedAt) {
    // Reuse of an already-rotated/revoked token — likely token theft.
    // Defensively revoke every active token for this user.
    await revokeAllUserTokens(existing.userId);
    throw AppError.unauthorized('Refresh token has already been used. All sessions have been revoked for safety — please log in again.');
  }
  if (existing.expiresAt < new Date()) {
    throw AppError.unauthorized('Refresh token has expired');
  }

  const newRawToken = generateOpaqueToken();
  const newTokenHash = hashToken(newRawToken, config.auth.jwtRefreshSecret);
  const { ipAddress, userAgent } = metaFromRequest(req);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: newTokenHash,
        expiresAt: addDuration(new Date(), config.auth.jwtRefreshExpiresIn),
        ipAddress,
        userAgent,
      },
    }),
  ]);

  return { userId: existing.userId, newRawToken };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken, config.auth.jwtRefreshSecret);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Used on password reset and on detected token-reuse — kills every active session for a user. */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
