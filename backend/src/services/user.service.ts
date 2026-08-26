import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { hashPassword, comparePassword } from '@utils/password';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { revokeAllUserTokens } from './token.service';
import { logActivity } from './activityLog.service';
import {
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
  UpdateProfileInput,
  ChangePasswordInput,
} from '@validators/user.validators';

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  role: { id: string; name: string; permissions: string[] };
}

interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roleId: string;
  role: { id: string; name: string; permissions: string[] };
}

function toSafeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    role: user.role,
  };
}

/**
 * Guards against removing the last active user holding the OWNER role —
 * without this, an admin could accidentally lock the whole team out of
 * the highest-privilege role.
 */
async function assertNotLastOwner(user: UserRecord, excludingUserId?: string): Promise<void> {
  if (user.role.name !== 'OWNER') return;

  const otherActiveOwners = await prisma.user.count({
    where: {
      role: { name: 'OWNER' },
      isActive: true,
      NOT: { id: excludingUserId ?? user.id },
    },
  });

  if (otherActiveOwners === 0) {
    throw AppError.badRequest('Cannot remove the last active Owner account. Promote another user to Owner first.');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Admin: list / create / update / delete / assign role
// ─────────────────────────────────────────────────────────────────────────

export async function listUsers(query: ListUsersQuery): Promise<{ users: SafeUser[]; meta: PaginationMeta }> {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.roleId ? { roleId: query.roleId } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [records, total] = await Promise.all([
    prisma.user.findMany({ where, include: { role: true }, skip, take, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);

  return {
    users: (records as UserRecord[]).map(toSafeUser),
    meta: buildPaginationMeta(total, page, limit),
  };
}

export async function getUserById(id: string): Promise<SafeUser> {
  const user = (await prisma.user.findUnique({ where: { id }, include: { role: true } })) as UserRecord | null;
  if (!user) throw AppError.notFound('User not found');
  return toSafeUser(user);
}

export async function createUser(input: CreateUserInput, actorId: string, req?: Request): Promise<SafeUser> {
  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role) throw AppError.badRequest('Selected role does not exist');

  const passwordHash = await hashPassword(input.password);

  const user = (await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      roleId: input.roleId,
      isActive: input.isActive,
    },
    include: { role: true },
  })) as UserRecord;

  await logActivity({
    userId: actorId,
    action: 'user.created',
    entityType: 'User',
    entityId: user.id,
    metadata: { name: user.name, email: user.email, role: user.role.name },
    req,
  });

  return toSafeUser(user);
}

export async function updateUser(id: string, input: UpdateUserInput, actorId: string, req?: Request): Promise<SafeUser> {
  const existing = (await prisma.user.findUnique({ where: { id }, include: { role: true } })) as UserRecord | null;
  if (!existing) throw AppError.notFound('User not found');

  const isDeactivating = input.isActive === false && existing.isActive === true;
  if (isDeactivating) {
    await assertNotLastOwner(existing);
  }

  const updated = (await prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: { role: true },
  })) as UserRecord;

  // Deactivating a user should end their sessions immediately, not wait
  // out the access token's remaining lifetime.
  if (isDeactivating) {
    await revokeAllUserTokens(id);
  }

  await logActivity({
    userId: actorId,
    action: 'user.updated',
    entityType: 'User',
    entityId: id,
    metadata: { changes: input },
    req,
  });

  return toSafeUser(updated);
}

export async function deleteUser(id: string, actorId: string, req?: Request): Promise<void> {
  if (id === actorId) {
    throw AppError.badRequest('You cannot delete your own account');
  }

  const existing = (await prisma.user.findUnique({ where: { id }, include: { role: true } })) as UserRecord | null;
  if (!existing) throw AppError.notFound('User not found');

  await assertNotLastOwner(existing);

  // Log before deleting — the row (and any FK-restored context) won't exist after.
  await logActivity({
    userId: actorId,
    action: 'user.deleted',
    entityType: 'User',
    entityId: id,
    metadata: { name: existing.name, email: existing.email, role: existing.role.name },
    req,
  });

  // refresh_tokens / password_reset_tokens cascade-delete automatically;
  // everything else (catalogs uploaded, mood boards created, etc.) has its
  // FK set to SET NULL, so historical records survive the user's deletion.
  await prisma.user.delete({ where: { id } });
}

export async function assignRole(id: string, roleId: string, actorId: string, req?: Request): Promise<SafeUser> {
  const [existing, newRole] = await Promise.all([
    prisma.user.findUnique({ where: { id }, include: { role: true } }) as Promise<UserRecord | null>,
    prisma.role.findUnique({ where: { id: roleId } }),
  ]);

  if (!existing) throw AppError.notFound('User not found');
  if (!newRole) throw AppError.badRequest('Selected role does not exist');

  if (existing.roleId === roleId) {
    return toSafeUser(existing); // no-op, nothing to guard or revoke
  }

  if (existing.role.name === 'OWNER' && newRole.name !== 'OWNER') {
    await assertNotLastOwner(existing);
  }

  const updated = (await prisma.user.update({ where: { id }, data: { roleId }, include: { role: true } })) as UserRecord;

  // Force fresh permissions immediately rather than waiting for the old
  // access token to expire — a role downgrade should take effect right away.
  await revokeAllUserTokens(id);

  await logActivity({
    userId: actorId,
    action: 'user.role_assigned',
    entityType: 'User',
    entityId: id,
    metadata: { fromRole: existing.role.name, toRole: newRole.name },
    req,
  });

  return toSafeUser(updated);
}

// ─────────────────────────────────────────────────────────────────────────
// Self-service: profile & password
// ─────────────────────────────────────────────────────────────────────────

export async function getProfile(userId: string): Promise<SafeUser> {
  return getUserById(userId);
}

export async function updateProfile(userId: string, input: UpdateProfileInput, req?: Request): Promise<SafeUser> {
  const updated = (await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
    },
    include: { role: true },
  })) as UserRecord;

  await logActivity({ userId, action: 'user.profile_updated', entityType: 'User', entityId: userId, metadata: { changes: input }, req });

  return toSafeUser(updated);
}

export async function changeOwnPassword(userId: string, input: ChangePasswordInput, req?: Request): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  const currentPasswordOk = await comparePassword(input.currentPassword, user.passwordHash);
  if (!currentPasswordOk) {
    throw AppError.badRequest('Current password is incorrect');
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Force re-login on every other device — the current session's refresh
  // token was already revoked as part of this, so the caller must also
  // treat this response as "you're about to be logged out here too."
  await revokeAllUserTokens(userId);

  await logActivity({ userId, action: 'user.password_changed', entityType: 'User', entityId: userId, req });
}
