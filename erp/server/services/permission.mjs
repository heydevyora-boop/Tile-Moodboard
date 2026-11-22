import { prisma } from '../../db/client.mjs';
import { AppError } from '../errors.mjs';

/* ============================================================
   WHAT THIS ACTOR IS ALLOWED TO DO
   ============================================================

   THE TABLES WERE ALREADY THERE AND NOTHING READ THEM.

   Step 2 created Role, RolePermission and UserRole, and the seed
   has filled them since step 2 with strings like "purchase:write"
   and "stock:post". A grep across server/ and db/ before step 6
   found no code that looked at any of it: every route had been
   open to every caller since step 3.

   This is the missing half, not a new authorization system. The
   brief asks that unauthorised approval and finalisation be
   prevented using the EXISTING infrastructure, so this reads the
   existing tables and nothing more.

   WHAT IT IS NOT.

   It is not authentication. Who the caller IS still arrives
   through the x-erp-user header placeholder from step 3, which
   anyone who can reach the port could set to anything. That is
   why the server binds to 127.0.0.1 and why the limitation is
   written down in docs/PURCHASE_MANAGEMENT.md rather than
   quietly papered over. A permission check on top of an
   unauthenticated actor stops MISTAKES -- a store keeper
   approving their own order -- and stops nothing else. It is
   worth having for that, and it is worth being honest that it is
   all it does.
   ============================================================ */

export class ForbiddenError extends AppError {
  constructor(permission, actor) {
    super(
      (actor?.name ? actor.name : 'This user')
      + ' does not have permission to do that (' + permission + ').',
      { status: 403, code: 'FORBIDDEN', details: { permission } },
    );
    this.name = 'ForbiddenError';
  }
}

/** Every permission this user holds, through all of their roles. */
export async function permissionsOf(userId) {
  if (!userId) return new Set();
  const rows = await prisma.userRole.findMany({
    where: { userId },
    select: { role: { select: { permissions: { select: { permission: true } } } } },
  });
  const out = new Set();
  for (const row of rows) {
    for (const { permission } of row.role.permissions) out.add(permission);
  }
  return out;
}

/**
 * Does this user hold a permission?
 *
 * "*" is the administrator's wildcard, which the seed gives to
 * ADMIN. "purchase:*" is honoured too, so a role can be given a
 * whole module without listing every verb.
 */
export async function can(userId, permission) {
  const held = await permissionsOf(userId);
  if (held.has('*')) return true;
  if (held.has(permission)) return true;
  const [resource] = permission.split(':');
  return held.has(resource + ':*');
}

/** Throw unless the actor holds it. */
export async function assertCan(actor, permission) {
  if (!(await can(actor?.id, permission))) throw new ForbiddenError(permission, actor);
}

/**
 * Express middleware form.
 *
 * Used on the routes where the brief names the risk: approving an
 * order and finalising a receipt. Reading is left open, because
 * the whole API is already behind localhost and a read-only
 * permission wall on top of a placeholder identity would be
 * ceremony rather than security.
 */
export function requirePermission(permission) {
  return async (req, _res, next) => {
    try {
      if (!req.actor) {
        throw new AppError('No user was identified for this request.', {
          status: 401, code: 'NO_ACTOR',
        });
      }
      await assertCan(req.actor, permission);
      next();
    } catch (err) {
      next(err);
    }
  };
}
