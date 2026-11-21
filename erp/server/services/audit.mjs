/* ============================================================
   THE AUDIT TRAIL
   ============================================================
   Written in the SAME TRANSACTION as the change it records. An
   audit row committed separately can be missing for a change that
   happened, or present for one that rolled back; either makes the
   log something you have to double-check, which is the one thing
   a log must not be.

   The table is append-only, guarded by a trigger from step 2, so
   nothing here can edit or remove a past entry.
   ============================================================ */

/** Fields that must never be written into an audit diff. */
const NEVER_LOG = new Set(['passwordHash', 'password', 'token', 'secret']);

/**
 * What actually changed, old and new, for the fields that moved.
 *
 * A diff rather than two full snapshots: a snapshot pair per edit
 * duplicates every price the studio has ever set and is unreadable
 * at review time.
 */
export function diff(before, after) {
  const changes = {};
  for (const key of Object.keys(after ?? {})) {
    if (NEVER_LOG.has(key)) continue;
    const from = before ? before[key] : undefined;
    const to = after[key];
    // Through String() because a Prisma Decimal and the number 84
    // are the same price and should not read as a change.
    if (String(from ?? '') === String(to ?? '')) continue;
    changes[key] = { from: from === undefined ? null : String(from ?? ''), to: to === null || to === undefined ? null : String(to) };
  }
  return changes;
}

/**
 * Record an action.
 *
 * @param {object} db     an OPEN TRANSACTION, normally. Passing the
 *                        bare client works but gives up the
 *                        guarantee above.
 */
export async function record(db, {
  entityType, entityId, action, actorUserId,
  before, after, summary, requestId, ipAddress,
}) {
  const changes = (before || after) ? diff(before, after) : null;
  return db.auditLog.create({
    data: {
      entityType,
      entityId,
      action,
      actorUserId: actorUserId ?? null,
      changes: changes && Object.keys(changes).length > 0 ? changes : null,
      summary: summary ?? null,
      requestId: requestId ?? null,
      ipAddress: ipAddress ?? null,
    },
  });
}
