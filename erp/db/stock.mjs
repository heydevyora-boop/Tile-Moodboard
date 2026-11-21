import { prisma } from './client.mjs';

/* ============================================================
   THE ONLY WAY STOCK MOVES
   ============================================================

   Every receipt, dispatch, sample, breakage, adjustment and
   transfer goes through postStockMovement(). Nothing else writes
   to stock_ledger_entries, and nothing at all writes
   inventory_balances.quantityOnHand directly.

   THE FOUR THINGS IT GUARANTEES

   1. ONE TRANSACTION. The ledger entry and the balance are written
      together or not at all. There is no window in which stock has
      moved but the balance has not caught up, and no path that
      updates the balance without leaving a record of why.

   2. THE ROW IS LOCKED FIRST. SELECT ... FOR UPDATE on the one
      balance row for this product-and-warehouse, before it is
      read. Two dispatches of the same product at the same instant
      QUEUE instead of racing. Without the lock both read 10, both
      write 5, and five boxes vanish with both ledger entries
      looking perfectly correct -- the classic lost update, and the
      hardest kind of stock error to find afterwards, because
      nothing in the history looks wrong.

   3. IT CANNOT POST TWICE. idempotencyKey is unique in the
      database. A retried API call, a double-clicked button or a
      replayed queue message hits the constraint and is reported as
      a duplicate rather than moving the stock again.

   4. IT CANNOT GO NEGATIVE. Checked here for a clear error, and
      again by a CHECK constraint in the database for when
      something bypasses this function.

   WHAT IT DELIBERATELY WILL NOT DO: edit or delete an existing
   entry. The ledger is append-only, enforced by a trigger. A
   mistake is corrected with reverseStockMovement(), which posts
   the opposite entry linked back to the original.
   ============================================================ */

const INWARD_TYPES = new Set(['INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN']);

/** Thrown when the same movement is posted twice. */
export class DuplicateMovementError extends Error {
  constructor(key) {
    super('This movement has already been posted (idempotency key: ' + key + ')');
    this.name = 'DuplicateMovementError';
    this.idempotencyKey = key;
  }
}

/** Thrown when a dispatch would take the balance below zero. */
export class InsufficientStockError extends Error {
  constructor({ sku, available, requested }) {
    super(
      'Not enough stock for ' + sku + ': ' + available + ' on hand, '
      + requested + ' requested.',
    );
    this.name = 'InsufficientStockError';
    this.available = available;
    this.requested = requested;
  }
}

/**
 * Post one stock movement.
 *
 * @param {object} m
 * @param {string} m.productId
 * @param {string} m.warehouseId
 * @param {string} m.movementType    StockMovementType
 * @param {string} m.reason          StockMovementReason
 * @param {number|string} m.quantity Always positive; direction comes from movementType
 * @param {string} m.uom
 * @param {string} m.referenceType
 * @param {string} m.idempotencyKey  Built from what the movement IS
 * @param {string} m.createdById
 * @param {Date}   [m.transactionDate]
 * @param {string} [m.referenceId]
 * @param {string} [m.referenceNo]
 * @param {string} [m.remarks]
 * @param {number|string} [m.unitCost]
 * @param {string} [m.reversalOfEntryId]
 * @param {object} [tx] An open transaction to join, when the caller
 *                      is already in one — a sales dispatch posts
 *                      several lines and either all of them move or
 *                      none do.
 */
export async function postStockMovement(m, tx) {
  const run = async (db) => {
    const qty = Number(m.quantity);
    if (!(qty > 0)) {
      throw new Error('Quantity must be positive; direction is carried by movementType.');
    }

    // Make sure the balance row exists before locking it. A product
    // that has never moved in this warehouse has no row yet, and
    // locking nothing locks nothing: two concurrent first movements
    // would both proceed. ON CONFLICT DO NOTHING makes the creation
    // itself the serialisation point.
    await db.$executeRaw`
      INSERT INTO "inventory_balances" ("id", "productId", "warehouseId", "quantityOnHand", "quantityReserved", "updatedAt")
      VALUES (gen_random_uuid(), ${m.productId}::uuid, ${m.warehouseId}::uuid, 0, 0, now())
      ON CONFLICT ("productId", "warehouseId") DO NOTHING
    `;

    // THE LOCK. Everything after this line is serialised against
    // any other movement of this product in this warehouse.
    const locked = await db.$queryRaw`
      SELECT "quantityOnHand"::text AS on_hand, "version"
      FROM "inventory_balances"
      WHERE "productId" = ${m.productId}::uuid AND "warehouseId" = ${m.warehouseId}::uuid
      FOR UPDATE
    `;

    const onHand = Number(locked[0].on_hand);
    const isInward = INWARD_TYPES.has(m.movementType);
    const balanceAfter = isInward ? onHand + qty : onHand - qty;

    if (balanceAfter < 0) {
      const product = await db.product.findUnique({
        where: { id: m.productId },
        select: { sku: true },
      });
      throw new InsufficientStockError({
        sku: product ? product.sku : m.productId,
        available: onHand,
        requested: qty,
      });
    }

    const unitCost = m.unitCost === undefined ? null : Number(m.unitCost);

    let entry;
    try {
      entry = await db.stockLedgerEntry.create({
        data: {
          productId: m.productId,
          warehouseId: m.warehouseId,
          movementType: m.movementType,
          reason: m.reason,
          quantity: qty,
          uom: m.uom,
          unitCost,
          valueAmount: unitCost === null ? null : Number((unitCost * qty).toFixed(2)),
          balanceAfter,
          referenceType: m.referenceType,
          referenceId: m.referenceId ?? null,
          referenceNo: m.referenceNo ?? null,
          transactionDate: m.transactionDate ?? new Date(),
          remarks: m.remarks ?? null,
          idempotencyKey: m.idempotencyKey,
          reversalOfEntryId: m.reversalOfEntryId ?? null,
          createdById: m.createdById,
        },
      });
    } catch (err) {
      // P2002 on idempotencyKey is not a failure of the caller's
      // logic; it is this function doing its job. Reported as its
      // own error type so a caller can treat a retry as success.
      if (err.code === 'P2002') throw new DuplicateMovementError(m.idempotencyKey);
      throw err;
    }

    await db.$executeRaw`
      UPDATE "inventory_balances"
      SET "quantityOnHand" = ${balanceAfter},
          "lastMovementAt" = now(),
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE "productId" = ${m.productId}::uuid AND "warehouseId" = ${m.warehouseId}::uuid
    `;

    return entry;
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

/**
 * Correct a mistake by posting its opposite.
 *
 * The original entry is NOT touched -- it cannot be; the database
 * refuses. Both rows stay on the stock card, which is what makes
 * the correction auditable rather than invisible.
 */
export async function reverseStockMovement({ entryId, createdById, remarks }, tx) {
  const run = async (db) => {
    const original = await db.stockLedgerEntry.findUnique({ where: { id: entryId } });
    if (!original) throw new Error('No such ledger entry: ' + entryId);

    const OPPOSITE = {
      INWARD: 'OUTWARD',
      OUTWARD: 'INWARD',
      ADJUSTMENT_INCREASE: 'ADJUSTMENT_DECREASE',
      ADJUSTMENT_DECREASE: 'ADJUSTMENT_INCREASE',
      TRANSFER_IN: 'TRANSFER_OUT',
      TRANSFER_OUT: 'TRANSFER_IN',
    };

    return postStockMovement({
      productId: original.productId,
      warehouseId: original.warehouseId,
      movementType: OPPOSITE[original.movementType],
      reason: original.reason,
      quantity: original.quantity,
      uom: original.uom,
      unitCost: original.unitCost,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      referenceNo: original.referenceNo,
      transactionDate: new Date(),
      remarks: remarks ?? ('Reversal of entry ' + original.entryNo),
      // Derived from the entry being reversed, so reversing the
      // same entry twice by accident is refused by the same unique
      // constraint that stops a double post.
      idempotencyKey: 'reversal:' + original.id,
      reversalOfEntryId: original.id,
      createdById,
    }, db);
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

/** The next document number, without two clerks getting the same one. */
export async function nextDocumentNumber(documentType, tx) {
  const run = async (db) => {
    // The UPDATE itself takes the row lock, so two callers queue
    // rather than both reading the same last number. A "SELECT max
    // + 1" would race the moment two people save at once, and a
    // duplicate order number is the kind of error an accountant
    // finds a month later.
    const rows = await db.$queryRaw`
      UPDATE "document_sequences"
      SET "lastNumber" = "lastNumber" + 1, "updatedAt" = now()
      WHERE "documentType" = ${documentType}
      RETURNING "prefix", "periodKey", "lastNumber", "padding"
    `;
    if (rows.length === 0) throw new Error('No document sequence for ' + documentType);

    const s = rows[0];
    return s.prefix + '-' + s.periodKey + '-'
      + String(s.lastNumber).padStart(s.padding, '0');
  };

  return tx ? run(tx) : prisma.$transaction(run);
}
