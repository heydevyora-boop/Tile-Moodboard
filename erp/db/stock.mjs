import { prisma } from './client.mjs';

/* ============================================================
   THE ONLY WAY STOCK MOVES
   ============================================================

   Every receipt, dispatch, sample, breakage, reservation,
   adjustment and transfer goes through postStockMovement().
   Nothing else writes stock_ledger_entries, and nothing at all
   writes a quantity on inventory_balances.

   ── THE THREE DIMENSIONS ─────────────────────────────────────

       PHYSICAL   quantityOnHand       what is in the building
       RESERVED   quantityReserved     on the shelf, promised
       DAMAGED    quantityDamaged      on the shelf, unsellable
       IN TRANSIT quantityInTransit    left another warehouse,
                                       not yet arrived here

       AVAILABLE = PHYSICAL − RESERVED − DAMAGED

   Reserved and damaged are SUBSETS of physical, not additions to
   it. A reserved box is still on the shelf; a broken box is still
   a box. Treating either as "gone" makes the stock-take disagree
   with the system, which is how a warehouse stops trusting it.

   In transit belongs to neither warehouse's physical stock: a
   lorry is not a shelf and nobody can pick from it. Company-wide
   physical stock is on-hand + in-transit, which stays constant
   from dispatch to receipt.

   ── THE SIX GUARANTEES ───────────────────────────────────────

   1. ONE TRANSACTION. The ledger entry and the projection are
      written together or not at all.

   2. THE ROW IS LOCKED FIRST. SELECT ... FOR UPDATE on the one
      balance row, before it is read. Two dispatches of the same
      product at the same instant QUEUE instead of racing.
      Without it both read 10, both write 5, and five boxes
      vanish with two perfectly correct-looking ledger entries --
      the lost update, and the hardest stock error to find
      afterwards because nothing in the history looks wrong.

   3. IT CANNOT POST TWICE. idempotencyKey is unique in the
      database. A retried call, a double-clicked button or a
      replayed message hits the constraint and is reported as a
      duplicate rather than moving the stock again.

   4. IT CANNOT GO NEGATIVE. Checked here for a clear message and
      again by CHECK constraints for anything that bypasses this
      function. Available stock cannot go below zero either: a
      reservation can never promise boxes that are already
      broken.

   5. AN INACTIVE WAREHOUSE TAKES NOTHING. A warehouse somebody
      has closed must not quietly keep accepting stock.

   6. IT NEVER EDITS. The ledger is append-only, enforced by a
      trigger. A mistake is corrected by posting the opposite
      entry, linked back to the original.
   ============================================================ */

/** Which dimension each movement type moves, and in which direction. */
const MOVEMENT_EFFECT = {
  INWARD:              { dimension: 'physical', sign: +1 },
  ADJUSTMENT_INCREASE: { dimension: 'physical', sign: +1 },
  TRANSFER_IN:         { dimension: 'physical', sign: +1 },
  OUTWARD:             { dimension: 'physical', sign: -1 },
  ADJUSTMENT_DECREASE: { dimension: 'physical', sign: -1 },
  TRANSFER_OUT:        { dimension: 'physical', sign: -1 },

  RESERVATION:         { dimension: 'reserved', sign: +1 },
  RESERVATION_RELEASE: { dimension: 'reserved', sign: -1 },

  DAMAGE:              { dimension: 'damaged', sign: +1 },
  DAMAGE_RECOVERY:     { dimension: 'damaged', sign: -1 },
};

export const MOVEMENT_TYPES = Object.keys(MOVEMENT_EFFECT);

/** Thrown when the same movement is posted twice. */
export class DuplicateMovementError extends Error {
  constructor(key) {
    super('This movement has already been posted (idempotency key: ' + key + ')');
    this.name = 'DuplicateMovementError';
    this.code = 'DUPLICATE_MOVEMENT';
    this.status = 409;
    this.idempotencyKey = key;
  }
}

/** Thrown when a movement would take a balance below zero. */
export class InsufficientStockError extends Error {
  constructor({ sku, dimension, available, requested }) {
    super(
      'Not enough ' + dimension + ' stock for ' + sku + ': '
      + available + ' available, ' + requested + ' requested.',
    );
    this.name = 'InsufficientStockError';
    this.code = 'INSUFFICIENT_STOCK';
    this.status = 409;
    this.dimension = dimension;
    this.available = available;
    this.requested = requested;
  }
}

/** Thrown when the movement cannot be accepted at all. */
export class StockValidationError extends Error {
  constructor(message, fields) {
    super(message);
    this.name = 'StockValidationError';
    this.code = 'VALIDATION_FAILED';
    this.status = 422;
    this.fields = fields ?? [];
  }
}

/**
 * Post one stock movement.
 *
 * @param {object} m
 * @param {string} m.productId
 * @param {string} m.warehouseId
 * @param {string} m.movementType    one of MOVEMENT_TYPES
 * @param {string} m.reason          StockMovementReason
 * @param {number|string} m.quantity ALWAYS POSITIVE; direction comes from movementType
 * @param {string} m.referenceType
 * @param {string} m.idempotencyKey  built from what the movement IS
 * @param {string} m.createdById
 * @param {string} [m.uom]           defaults to the product's own
 * @param {Date}   [m.transactionDate]
 * @param {string} [m.referenceId]
 * @param {string} [m.referenceNo]
 * @param {string} [m.remarks]
 * @param {number|string} [m.unitCost]
 * @param {string} [m.reversalOfEntryId]
 * @param {boolean} [m.allowInactiveWarehouse]  only a transfer
 *        RECEIPT may use this; see dispatchTransfer.
 * @param {object} [tx] an open transaction to join, when the caller
 *        is already in one — a dispatch posts several lines and
 *        either all of them move or none do.
 */
export async function postStockMovement(m, tx) {
  const run = async (db) => {
    // ── 1-4. validate before touching anything ──────────────
    const effect = MOVEMENT_EFFECT[m.movementType];
    if (!effect) {
      throw new StockValidationError(
        'Unknown movement type "' + m.movementType + '".',
        [{ field: 'movementType', message: 'Must be one of: ' + MOVEMENT_TYPES.join(', ') }],
      );
    }

    const qty = Number(m.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new StockValidationError(
        'Quantity must be a positive number; direction is carried by the movement type.',
        [{ field: 'quantity', message: 'Must be greater than zero.' }],
      );
    }

    const product = await db.product.findUnique({
      where: { id: m.productId },
      select: { id: true, sku: true, uom: true, archivedAt: true },
    });
    if (!product) {
      throw new StockValidationError('No such product.',
        [{ field: 'productId', message: 'No product with that id.' }]);
    }

    const warehouse = await db.warehouse.findUnique({
      where: { id: m.warehouseId },
      select: { id: true, name: true, isActive: true },
    });
    if (!warehouse) {
      throw new StockValidationError('No such warehouse.',
        [{ field: 'warehouseId', message: 'No warehouse with that id.' }]);
    }
    if (!warehouse.isActive && !m.allowInactiveWarehouse) {
      /* A closed warehouse must not quietly keep taking stock.
         The one exception is receiving a transfer that was already
         on its way when it closed -- refusing that would strand
         the stock on a lorry, counted nowhere. */
      throw new StockValidationError(
        warehouse.name + ' is deactivated and cannot take stock movements.',
        [{ field: 'warehouseId', message: 'This warehouse is not active.' }],
      );
    }

    // ── 5-7. make the row exist, then LOCK it ───────────────
    //
    // A product that has never moved in this warehouse has no row
    // yet, and locking nothing locks nothing: two concurrent first
    // movements would both proceed. ON CONFLICT DO NOTHING makes
    // the creation itself the serialisation point.
    await db.$executeRaw`
      INSERT INTO "inventory_balances"
        ("id", "productId", "warehouseId", "quantityOnHand", "quantityReserved",
         "quantityDamaged", "quantityInTransit", "updatedAt")
      VALUES (gen_random_uuid(), ${m.productId}::uuid, ${m.warehouseId}::uuid, 0, 0, 0, 0, now())
      ON CONFLICT ("productId", "warehouseId") DO NOTHING
    `;

    const locked = await db.$queryRaw`
      SELECT "quantityOnHand"::text    AS on_hand,
             "quantityReserved"::text  AS reserved,
             "quantityDamaged"::text   AS damaged,
             "quantityInTransit"::text AS in_transit
      FROM "inventory_balances"
      WHERE "productId" = ${m.productId}::uuid AND "warehouseId" = ${m.warehouseId}::uuid
      FOR UPDATE
    `;

    const before = {
      onHand: Number(locked[0].on_hand),
      reserved: Number(locked[0].reserved),
      damaged: Number(locked[0].damaged),
      inTransit: Number(locked[0].in_transit),
    };

    // ── 8. what the movement does to each dimension ─────────
    const after = { ...before };
    const delta = effect.sign * qty;
    if (effect.dimension === 'physical') after.onHand += delta;
    if (effect.dimension === 'reserved') after.reserved += delta;
    if (effect.dimension === 'damaged') after.damaged += delta;

    const availableBefore = before.onHand - before.reserved - before.damaged;
    const availableAfter = after.onHand - after.reserved - after.damaged;

    if (after.onHand < 0) {
      throw new InsufficientStockError({
        sku: product.sku, dimension: 'physical', available: before.onHand, requested: qty,
      });
    }
    if (after.reserved < 0) {
      throw new InsufficientStockError({
        sku: product.sku, dimension: 'reserved', available: before.reserved, requested: qty,
      });
    }
    if (after.damaged < 0) {
      throw new InsufficientStockError({
        sku: product.sku, dimension: 'damaged', available: before.damaged, requested: qty,
      });
    }
    if (availableAfter < 0) {
      /* The default policy, and the one that matters most. A
         reservation or a damage report must not promise or
         condemn boxes that are already spoken for. Overriding it
         is a business decision nobody has made, so there is no
         flag for it here. */
      throw new InsufficientStockError({
        sku: product.sku, dimension: 'available', available: availableBefore, requested: qty,
      });
    }

    // ── 9. the immutable entry ──────────────────────────────
    const unitCost = m.unitCost === undefined || m.unitCost === null ? null : Number(m.unitCost);

    let entry;
    try {
      entry = await db.stockLedgerEntry.create({
        data: {
          productId: m.productId,
          warehouseId: m.warehouseId,
          movementType: m.movementType,
          reason: m.reason,
          quantity: qty,
          uom: m.uom ?? product.uom,
          unitCost,
          valueAmount: unitCost === null ? null : Number((unitCost * qty).toFixed(2)),
          balanceBefore: before.onHand,
          balanceAfter: after.onHand,
          reservedAfter: after.reserved,
          damagedAfter: after.damaged,
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
      // P2002 on idempotencyKey is this function doing its job,
      // not the caller's logic failing. Its own error type, so a
      // caller can treat a retry as success.
      if (err.code === 'P2002') throw new DuplicateMovementError(m.idempotencyKey);
      throw err;
    }

    // ── 10. the projection, same transaction, same lock ─────
    await db.$executeRaw`
      UPDATE "inventory_balances"
      SET "quantityOnHand"   = ${after.onHand},
          "quantityReserved" = ${after.reserved},
          "quantityDamaged"  = ${after.damaged},
          "lastMovementAt"   = now(),
          "version"          = "version" + 1,
          "updatedAt"        = now()
      WHERE "productId" = ${m.productId}::uuid AND "warehouseId" = ${m.warehouseId}::uuid
    `;

    // ── 11. verify what actually landed ─────────────────────
    //
    // Reading the row back inside the same transaction. It costs
    // one query and it catches the case nothing else would: a
    // trigger, a rule or a future hand-written statement quietly
    // writing something other than what was computed.
    const [check] = await db.$queryRaw`
      SELECT "quantityOnHand"::text AS on_hand, "quantityReserved"::text AS reserved,
             "quantityDamaged"::text AS damaged
      FROM "inventory_balances"
      WHERE "productId" = ${m.productId}::uuid AND "warehouseId" = ${m.warehouseId}::uuid
    `;
    if (Number(check.on_hand) !== after.onHand
      || Number(check.reserved) !== after.reserved
      || Number(check.damaged) !== after.damaged) {
      throw new Error(
        'Stock verification failed for ' + product.sku + ': expected on-hand '
        + after.onHand + ', found ' + check.on_hand + '. The transaction has been rolled back.',
      );
    }

    // ── 12. the result ──────────────────────────────────────
    return {
      entry,
      sku: product.sku,
      before: { ...before, available: availableBefore },
      after: { ...after, available: availableAfter },
    };
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

/**
 * Correct a mistake by posting its opposite.
 *
 * The original is NOT touched — it cannot be; the database
 * refuses. Both rows stay on the stock card, which is what makes
 * the correction auditable rather than invisible.
 */
export async function reverseStockMovement({ entryId, createdById, remarks }, tx) {
  const run = async (db) => {
    const original = await db.stockLedgerEntry.findUnique({ where: { id: entryId } });
    if (!original) throw new StockValidationError('No such ledger entry.');

    const OPPOSITE = {
      INWARD: 'OUTWARD',
      OUTWARD: 'INWARD',
      ADJUSTMENT_INCREASE: 'ADJUSTMENT_DECREASE',
      ADJUSTMENT_DECREASE: 'ADJUSTMENT_INCREASE',
      TRANSFER_IN: 'TRANSFER_OUT',
      TRANSFER_OUT: 'TRANSFER_IN',
      RESERVATION: 'RESERVATION_RELEASE',
      RESERVATION_RELEASE: 'RESERVATION',
      DAMAGE: 'DAMAGE_RECOVERY',
      DAMAGE_RECOVERY: 'DAMAGE',
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
      // same entry twice by accident hits the same unique
      // constraint that stops a double post.
      idempotencyKey: 'reversal:' + original.id,
      reversalOfEntryId: original.id,
      createdById,
      // A reversal of a movement into a warehouse that has since
      // been closed must still be possible: refusing it would
      // leave the mistake standing.
      allowInactiveWarehouse: true,
    }, db);
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

/** The next document number, without two clerks getting the same one. */
export async function nextDocumentNumber(documentType, tx) {
  const run = async (db) => {
    // The UPDATE itself takes the row lock, so two callers queue
    // rather than both reading the same last number. A "SELECT max
    // + 1" races the moment two people save at once, and a
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
