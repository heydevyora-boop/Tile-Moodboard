import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';
import { UpdateRoleInput } from '@validators/role.validators';
import { Request } from 'express';

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
}

export async function listRoles(): Promise<RoleSummary[]> {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  return roles as RoleSummary[];
}

/**
 * The OWNER role's `permissions: ['*']` is what makes requirePermission()
 * treat it as an unconditional superuser (see src/middlewares/auth.ts) —
 * editing that away through this endpoint would be a real way to lock
 * every Owner account out of the app, so it's blocked entirely rather
 * than just discouraged. ADMIN and STAFF are freely editable.
 */
export async function updateRole(id: string, input: UpdateRoleInput, actorId: string, req?: Request): Promise<RoleSummary> {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Role not found');
  if (existing.name === 'OWNER') {
    throw AppError.badRequest('The Owner role always has full access and cannot be edited.');
  }

  const role = await prisma.role.update({
    where: { id },
    data: {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    },
  });

  await logActivity({
    userId: actorId,
    action: 'role.updated',
    entityType: 'Role',
    entityId: id,
    metadata: { name: existing.name, permissions: input.permissions },
    req,
  });

  return role as RoleSummary;
}
