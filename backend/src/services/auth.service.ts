import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { comparePassword, hashPassword } from '@utils/password';
import { signAccessToken } from '@utils/jwt';
import { generateOpaqueToken, hashToken } from '@utils/crypto';
import { addDuration } from '@utils/duration';
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens } from './token.service';
import { emailService } from './email.service';
import { logActivity } from './activityLog.service';
import { recordLoginAttempt } from './loginAttempt.service';

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  lastLoginAt: Date | null;
}

interface UserWithRole {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  role: { name: string; permissions: string[] };
}

function toSafeUser(user: UserWithRole): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
  };
}

async function issueTokenPair(user: UserWithRole, req?: Request) {
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions,
  });
  const refreshToken = await issueRefreshToken(user.id, req);
  return { accessToken, refreshToken };
}

export async function login(email: string, password: string, req?: Request) {
  const user = (await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { role: true },
  })) as UserWithRole | null;

  const invalidCredentials = () => AppError.unauthorized('Invalid email or password');

  if (!user) {
    await recordLoginAttempt({ email, success: false, failureReason: 'user_not_found', req });
    throw invalidCredentials();
  }
  if (!user.isActive) {
    await recordLoginAttempt({ email, userId: user.id, success: false, failureReason: 'account_deactivated', req });
    throw AppError.forbidden('This account has been deactivated. Contact an admin.');
  }

  const passwordOk = await comparePassword(password, user.passwordHash);
  if (!passwordOk) {
    await recordLoginAttempt({ email, userId: user.id, success: false, failureReason: 'invalid_password', req });
    await logActivity({ userId: user.id, action: 'user.login_failed', entityType: 'User', entityId: user.id, req });
    throw invalidCredentials();
  }

  const { accessToken, refreshToken } = await issueTokenPair(user, req);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordLoginAttempt({ email, userId: user.id, success: true, req });
  await logActivity({ userId: user.id, action: 'user.login', entityType: 'User', entityId: user.id, req });

  return { user: toSafeUser(user), accessToken, refreshToken };
}

export async function logout(rawRefreshToken: string | undefined, userId?: string, req?: Request): Promise<void> {
  if (rawRefreshToken) {
    await revokeRefreshToken(rawRefreshToken);
  }
  if (userId) {
    await logActivity({ userId, action: 'user.logout', entityType: 'User', entityId: userId, req });
  }
}

export async function refresh(rawRefreshToken: string | undefined, req?: Request) {
  if (!rawRefreshToken) throw AppError.unauthorized('No refresh token provided');

  const { userId, newRawToken } = await rotateRefreshToken(rawRefreshToken, req);

  const user = (await prisma.user.findUnique({ where: { id: userId }, include: { role: true } })) as UserWithRole | null;
  if (!user || !user.isActive) throw AppError.unauthorized('Account no longer active');

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions,
  });

  await logActivity({ userId: user.id, action: 'user.token_refreshed', entityType: 'User', entityId: user.id, req });

  return { user: toSafeUser(user), accessToken, refreshToken: newRawToken };
}

/**
 * Always resolves successfully regardless of whether the email exists —
 * this prevents an attacker from using "forgot password" to enumerate
 * registered accounts. If the user does exist, a reset email is sent.
 */
export async function forgotPassword(email: string, req?: Request): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (!user || !user.isActive) {
    return; // silently succeed — caller always sees a generic success message
  }

  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken, config.auth.jwtRefreshSecret);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: addDuration(new Date(), config.auth.passwordResetExpiresIn),
    },
  });

  await emailService.sendPasswordResetEmail(user.email, rawToken);
  await logActivity({ userId: user.id, action: 'user.password_reset_requested', entityType: 'User', entityId: user.id, req });
}

export async function resetPassword(rawToken: string, newPassword: string, req?: Request): Promise<void> {
  const tokenHash = hashToken(rawToken, config.auth.jwtRefreshSecret);

  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken) throw AppError.badRequest('Invalid or expired reset link');
  if (resetToken.usedAt) throw AppError.badRequest('This reset link has already been used');
  if (resetToken.expiresAt < new Date()) throw AppError.badRequest('This reset link has expired. Request a new one.');

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
  ]);

  // Force re-login everywhere — a password reset should invalidate every
  // existing session, in case the reset was prompted by a compromised account.
  await revokeAllUserTokens(resetToken.userId);

  await logActivity({ userId: resetToken.userId, action: 'user.password_reset_completed', entityType: 'User', entityId: resetToken.userId, req });
}
