import crypto from 'node:crypto';
import { prisma } from '../../db/client.mjs';
import { postStockMovement } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toMilli, fromMilli } from './money.mjs';
import { refreshStatusFromLines, RESERVABLE } from './salesOrder.service.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   STOCK RESERVATION
   ============================================================

   RESERVING MOVES NO PHYSICAL STOCK. It calls postStockMovement()
   with movementType RESERVATION -- the same primitive step 5
   built and the Inventory module's own Reservation screen already
   uses -- and nothing in this file writes a balance or a ledger
   row any other way.

   WHY THIS FILE CALLS postStockMovement() DIRECTLY rather than
   through inventory.service.mjs's reserve()/releaseReservation():
   those wrappers always open their OWN prisma.$transaction, so
   they cannot be composed into a larger one. Reserving several
   lines against one order, and updating each order line's running
   total alongside the ledger write, has to be one transaction or
   none of it -- exactly the reasoning grn.service.mjs and
   purchaseReturn.service.mjs already follow for the same reason,
   which is why they import postStockMovement from db/stock.mjs
   directly too. This is the established pattern, not a new one.

   AVAILABLE, NOT PHYSICAL, IS WHAT IS CHECKED. Step 5's rule:
   available = onHand - reserved - damaged. A product can be fully
   in stock and have none of it available, because it is already
   promised to somebody else's order or sitting damaged. Shown to
   the caller before anything is attempted, and enforced again by
   the database's own CHECK -- two layers, same as every other
   movement in this system.
   ============================================================ */

/**
 * What is available to reserve, per line of an order -- what a
 * reservation screen opens on. Computed fresh from
 * inventory_balances, never cached.
 */
export async function availability(orderId) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNo: true, status: true, warehouseId: true,
      warehouse: { select: { id: true, code: true, name: true, isActive: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true,
          quantity: true, uom: true, reservedQuantity: true, dispatchedQuantity: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('Sales order');

  const balances = await prisma.inventoryBalance.findMany({
    where: { warehouseId: order.warehouseId, productId: { in: order.lines.map((l) => l.productId) } },
    select: { productId: true, quantityOnHand: true, quantityReserved: true, quantityDamaged: true },
  });
  const byProduct = new Map(balances.map((b) => [b.productId, b]));

  return {
    salesOrder: {
      id: order.id, orderNo: order.orderNo, status: order.status,
      warehouse: order.warehouse, reservable: RESERVABLE.includes(order.status),
    },
    lines: order.lines.map((l) => {
      const b = byProduct.get(l.productId);
      const onHand = toMilli(b?.quantityOnHand ?? 0);
      const alreadyReserved = toMilli(b?.quantityReserved ?? 0);
      const damaged = toMilli(b?.quantityDamaged ?? 0);
      const available = Math.max(0, onHand - alreadyReserved - damaged);
      const ordered = toMilli(l.quantity);
      const reservedHere = toMilli(l.reservedQuantity);
      const dispatchedHere = toMilli(l.dispatchedQuantity);
      return {
        salesOrderLineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        sku: l.skuAtOrder,
        name: l.nameAtOrder,
        uom: l.uom,
        orderedQuantity: Number(l.quantity),
        reservedQuantity: Number(l.reservedQuantity),
        dispatchedQuantity: Number(l.dispatchedQuantity),
        unreservedQuantity: Number(fromMilli(Math.max(0, ordered - reservedHere - dispatchedHere))),
        warehouseOnHand: Number(fromMilli(onHand)),
        warehouseAvailable: Number(fromMilli(available)),
        warehouseDamaged: Number(fromMilli(damaged)),
      };
    }),
  };
}

/**
 * Reserve stock for a confirmed order, line by line.
 *
 * @param {object} input
 * @param {string} input.salesOrderId
 * @param {Array}  input.lines  { salesOrderLineId, quantity, idempotencyKey? }
 */
export async function reserveForOrder(input, actor) {
  await assertCan(actor, 'stock:reserve');

  const prepared = await prepareReserve(input);

  const id = await prisma.$transaction(async (tx) => {
    let posted = 0;

    for (const line of prepared.lines) {
      const result = await postStockMovement({
        productId: line.productId,
        warehouseId: prepared.order.warehouseId,
        movementType: 'RESERVATION',
        reason: 'RESERVATION',
        quantity: line.quantity,
        referenceType: 'SALES_ORDER',
        referenceId: prepared.order.id,
        referenceNo: prepared.order.orderNo,
        remarks: 'Reserved for ' + prepared.order.orderNo,
        // Client-supplied, same convention every write endpoint in
        // this system already uses (inventory adjustments, GRN
        // over-receipt, …): present, a retry is refused by the
        // ledger's own unique index; absent, the request is safe
        // but not idempotent, and that is the caller's choice to
        // make knowingly -- documented in inventory.service.mjs
        // since step 5 and unchanged here.
        idempotencyKey: line.idempotencyKey
          ? 'so-reserve:' + line.salesOrderLineId + ':' + line.idempotencyKey
          // No client key: safe (the database's own unique index
          // still refuses a true duplicate row) but not idempotent
          // against a retried request -- the same documented
          // trade-off inventory.service.mjs has made since step 5.
          : 'so-reserve:' + crypto.randomUUID(),
        createdById: actor.id,
      }, tx);

      await tx.salesOrderLine.update({
        where: { id: line.salesOrderLineId },
        data: { reservedQuantity: { increment: line.quantity } },
      });

      posted += 1;
      line._entryNo = String(result.entry.entryNo);
    }

    const status = await refreshStatusFromLines(tx, prepared.order.id);

    await record(tx, {
      entityType: 'SalesOrder',
      entityId: prepared.order.id,
      action: 'RESERVE',
      actorUserId: actor.id,
      summary: 'Reserved ' + prepared.summary + ' against ' + prepared.order.orderNo
        + '. Physical stock is unchanged; the order is now ' + status.toLowerCase().replace(/_/g, ' ') + '.',
    });

    return prepared.order.id;
  });

  return availability(id);
}

/**
 * Release some or all of a line's reservation.
 *
 * Exposed both for a direct "release" action (over-reservation
 * corrected by hand) and for salesOrder.service.mjs's cancel() and
 * close(), which call releaseForLine() directly inside their own
 * transaction -- the exported function below wraps it with its
 * own transaction and audit entry for the standalone case.
 */
export async function releaseFromOrder(input, actor) {
  await assertCan(actor, 'stock:reserve');
  const prepared = await prepareRelease(input);

  const id = await prisma.$transaction(async (tx) => {
    for (const line of prepared.lines) {
      await releaseForLine({
        salesOrderLine: line.row, salesOrder: prepared.order, quantity: line.quantity,
        reason: 'Released by request' + (input.reason ? ': ' + input.reason : ''),
        idempotencyKey: line.idempotencyKey,
      }, actor, tx);
    }
    const status = await refreshStatusFromLines(tx, prepared.order.id);
    await record(tx, {
      entityType: 'SalesOrder', entityId: prepared.order.id, action: 'RESERVE', actorUserId: actor.id,
      summary: 'Released ' + prepared.summary + ' against ' + prepared.order.orderNo
        + '. The order is now ' + status.toLowerCase().replace(/_/g, ' ') + '.',
    });
    return prepared.order.id;
  });

  return availability(id);
}

/**
 * The primitive releaseFromOrder(), cancel() and close() all
 * share: post RESERVATION_RELEASE, decrement the line's
 * reservedQuantity. MUST be called inside an open transaction;
 * the caller owns refreshStatusFromLines() and its own audit
 * entry, because cancel/close want their OWN summary, not one
 * about a release in isolation.
 */
export async function releaseForLine({ salesOrderLine, salesOrder, quantity, reason, idempotencyKey }, actor, tx) {
  if (!salesOrder?.warehouseId) {
    // A sales order ALWAYS has a warehouse (NOT NULL in the
    // schema); a caller reaching this without it loaded is a bug
    // in that caller, not a legitimate state to paper over with a
    // guess.
    throw new Error('releaseForLine: salesOrder.warehouseId is required and was not provided.');
  }
  await postStockMovement({
    productId: salesOrderLine.productId,
    warehouseId: salesOrder.warehouseId,
    movementType: 'RESERVATION_RELEASE',
    reason: 'RESERVATION_RELEASE',
    quantity,
    referenceType: 'SALES_ORDER',
    referenceId: salesOrder.id,
    referenceNo: salesOrder.orderNo,
    remarks: reason,
    idempotencyKey: idempotencyKey
      ? 'so-release:' + salesOrderLine.id + ':' + idempotencyKey
      : 'so-release:' + crypto.randomUUID(),
    createdById: actor.id,
  }, tx);

  await tx.salesOrderLine.update({
    where: { id: salesOrderLine.id },
    data: { reservedQuantity: { decrement: quantity } },
  });
}

/* ============================================================
   VALIDATION
   ============================================================ */

async function prepareReserve(input) {
  const fields = [];
  if (!input.salesOrderId) fields.push({ field: 'salesOrderId', message: 'Which order is this for?' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'Choose at least one line to reserve.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const order = await prisma.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true, orderNo: true, status: true, warehouseId: true,
      warehouse: { select: { isActive: true, name: true } },
      lines: { select: { id: true, productId: true, skuAtOrder: true, quantity: true, reservedQuantity: true, dispatchedQuantity: true } },
    },
  });
  if (!order) throw new ValidationError([{ field: 'salesOrderId', message: 'No such sales order.' }]);

  if (!RESERVABLE.includes(order.status)) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' is ' + order.status.toLowerCase().replace(/_/g, ' ')
      + ', so stock cannot be reserved against it. Only a confirmed order — or one '
      + 'already partially reserved — can take a reservation.',
      { status: order.status, reservableStatuses: RESERVABLE },
    );
  }
  if (!order.warehouse.isActive) {
    throw new ValidationError([{ field: 'salesOrderId', message: order.warehouse.name + ' is deactivated.' }]);
  }

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  const balances = await prisma.inventoryBalance.findMany({
    where: { warehouseId: order.warehouseId, productId: { in: order.lines.map((l) => l.productId) } },
    select: { productId: true, quantityOnHand: true, quantityReserved: true, quantityDamaged: true },
  });
  const balanceByProduct = new Map(balances.map((b) => [b.productId, b]));

  const lines = [];
  const parts = [];
  const seen = new Set();

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    const orderLine = byLineId.get(raw?.salesOrderLineId);
    if (!orderLine) { fields.push({ field: at('salesOrderLineId'), message: 'Not a line on this order.' }); return; }
    if (seen.has(orderLine.id)) {
      fields.push({ field: at('salesOrderLineId'), message: 'Line appears twice on this request.' });
      return;
    }
    seen.add(orderLine.id);

    let quantityMilli;
    try { quantityMilli = toMilli(raw.quantity); } catch { fields.push({ field: at('quantity'), message: 'Not a usable quantity.' }); return; }
    if (quantityMilli <= 0) { fields.push({ field: at('quantity'), message: 'A reservation quantity must be above zero.' }); return; }

    const orderedMilli = toMilli(orderLine.quantity);
    const committedMilli = toMilli(orderLine.reservedQuantity) + toMilli(orderLine.dispatchedQuantity);
    const unreservedMilli = orderedMilli - committedMilli;
    if (quantityMilli > unreservedMilli) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(Math.max(0, unreservedMilli))
          + ' of this line is not already reserved or dispatched.',
      });
      return;
    }

    const b = balanceByProduct.get(orderLine.productId);
    const onHand = toMilli(b?.quantityOnHand ?? 0);
    const alreadyReserved = toMilli(b?.quantityReserved ?? 0);
    const damaged = toMilli(b?.quantityDamaged ?? 0);
    const available = onHand - alreadyReserved - damaged;

    // DO NOT SILENTLY CONFIRM UNAVAILABLE QUANTITIES. Checked
    // here, with the figures, so the message is useful; the
    // database's own CHECK on inventory_balances refuses it
    // again regardless, in case of a race between this read and
    // the write.
    if (quantityMilli > available) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': ' + fromMilli(Math.max(0, available)) + ' available at this '
          + 'warehouse (on hand less what is already reserved or damaged), but '
          + fromMilli(quantityMilli) + ' was requested.',
      });
      return;
    }

    lines.push({
      salesOrderLineId: orderLine.id,
      productId: orderLine.productId,
      quantity: fromMilli(quantityMilli),
      idempotencyKey: raw.idempotencyKey ? String(raw.idempotencyKey) : undefined,
    });
    parts.push(fromMilli(quantityMilli) + ' ' + orderLine.skuAtOrder);
  });

  if (fields.length) throw new ValidationError(fields);

  return { order, lines, summary: parts.join('; ') };
}

async function prepareRelease(input) {
  const fields = [];
  if (!input.salesOrderId) fields.push({ field: 'salesOrderId', message: 'Which order is this for?' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'Choose at least one line to release.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const order = await prisma.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true, orderNo: true, status: true, warehouseId: true,
      lines: { select: { id: true, productId: true, skuAtOrder: true, reservedQuantity: true } },
    },
  });
  if (!order) throw new ValidationError([{ field: 'salesOrderId', message: 'No such sales order.' }]);

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  const lines = [];
  const parts = [];

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    const orderLine = byLineId.get(raw?.salesOrderLineId);
    if (!orderLine) { fields.push({ field: at('salesOrderLineId'), message: 'Not a line on this order.' }); return; }

    let quantityMilli;
    try { quantityMilli = toMilli(raw.quantity); } catch { fields.push({ field: at('quantity'), message: 'Not a usable quantity.' }); return; }
    if (quantityMilli <= 0) { fields.push({ field: at('quantity'), message: 'A release quantity must be above zero.' }); return; }

    const reservedMilli = toMilli(orderLine.reservedQuantity);
    if (quantityMilli > reservedMilli) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(reservedMilli) + ' is reserved on this line.',
      });
      return;
    }

    lines.push({
      row: { id: orderLine.id, productId: orderLine.productId },
      quantity: fromMilli(quantityMilli),
      idempotencyKey: raw.idempotencyKey ? String(raw.idempotencyKey) : undefined,
    });
    parts.push(fromMilli(quantityMilli) + ' ' + orderLine.skuAtOrder);
  });

  if (fields.length) throw new ValidationError(fields);
  return { order, lines, summary: parts.join('; ') };
}
