import { prisma } from '../../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toMilli, fromMilli } from './money.mjs';
import { refreshStatusFromLines, DISPATCHABLE } from './salesOrder.service.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   DISPATCH / DELIVERY CHALLAN — THE OTHER DOCUMENT THAT MOVES STOCK
   ============================================================

   A DELIVERY CHALLAN IS WHAT ACTUALLY MOVES STOCK ON THE SALES
   SIDE. Not the sales order, not its confirmation, not the
   invoice: posting a challan is the one event this module treats
   as "goods left the building", and it is the only place that
   calls postStockMovement() for OUTWARD.

   THE ORDER OF OPERATIONS MATTERS, and it is the integration risk
   step 7's inspection flagged before any of this was written:
   availability is available = onHand - reserved - damaged, so a
   dispatch must RELEASE THE RESERVATION FIRST and only then post
   OUTWARD. Doing it the other way round -- OUTWARD first -- would
   for one instant have the same boxes counted as both reserved
   and gone, and the available-stock CHECK could refuse a dispatch
   that is in fact entirely valid. Releasing first is also what
   purchase returns already do for damaged stock (recover from
   damaged, then issue), so this is the established shape, not an
   invention.

   IDEMPOTENCY mirrors the goods receipt exactly: each dispatch
   line is its own database row, created inside the SAME
   transaction as its two movements, so the keys
   "dc:<lineId>:release" and "dc:<lineId>:outward" are stable and
   a retried request is refused by the ledger's own unique index
   rather than trusted to a check-then-act.

   NO DRAFT STATE IS EVER PERSISTED on its own: the challan is
   created DRAFT and flipped to DISPATCHED inside the one
   transaction that also posts the stock, exactly as
   grn.service.mjs does for a goods receipt. If anything in that
   transaction fails, nothing commits -- not the challan, not a
   line, not a movement.
   ============================================================ */

const LINE_SELECT = {
  id: true, lineNo: true, salesOrderLineId: true, productId: true,
  skuAtDispatch: true, nameAtDispatch: true, quantity: true, uom: true,
};

const HEAD_SELECT = {
  id: true, challanNo: true, status: true, dispatchDate: true,
  transporter: true, vehicleNumber: true, trackingRef: true,
  receiverName: true, receiverPhone: true, remarks: true,
  dispatchedAt: true, cancelledAt: true, cancelReason: true, createdAt: true, updatedAt: true,
  salesOrder: { select: { id: true, orderNo: true, status: true } },
  salesInvoice: { select: { id: true, invoiceNo: true } },
  customer: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  dispatchedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
};

/* ============================================================
   READING
   ============================================================ */

export async function list(query = {}) {
  const { search, status, customerId, warehouseId, salesOrderId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(salesOrderId ? { salesOrderId } : {}),
    ...(from || to
      ? { dispatchDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { challanNo: { contains: search, mode: 'insensitive' } },
          { trackingRef: { contains: search, mode: 'insensitive' } },
          { salesOrder: { orderNo: { contains: search, mode: 'insensitive' } } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.deliveryChallan.findMany({
      where,
      orderBy: [{ dispatchDate: 'desc' }, { challanNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { select: { quantity: true } } },
    }),
    prisma.deliveryChallan.count({ where }),
  ]);

  return {
    rows: rows.map(shapeHead),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const dc = await prisma.deliveryChallan.findUnique({
    where: { id },
    select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
  });
  if (!dc) throw new NotFoundError('Delivery challan');

  const movements = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'DELIVERY_CHALLAN', referenceId: id },
    orderBy: { entryNo: 'asc' },
    select: {
      id: true, entryNo: true, movementType: true, quantity: true, uom: true,
      balanceBefore: true, balanceAfter: true, product: { select: { sku: true, name: true } },
    },
  });

  return {
    ...shapeHead(dc),
    lines: dc.lines.map(shapeLine),
    movements: movements.map((m) => ({
      id: m.id, entryNo: String(m.entryNo), sku: m.product.sku, movementType: m.movementType,
      quantity: Number(m.quantity), balanceBefore: Number(m.balanceBefore), balanceAfter: Number(m.balanceAfter),
    })),
  };
}

/** What is still owed on an order, line by line -- what a dispatch form opens on. */
export async function dispatchableLines(salesOrderId) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true, orderNo: true, status: true, currency: true,
      customer: { select: { id: true, code: true, name: true } },
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

  return {
    salesOrder: {
      id: order.id, orderNo: order.orderNo, status: order.status, currency: order.currency,
      customer: order.customer, warehouse: order.warehouse, dispatchable: DISPATCHABLE.includes(order.status),
    },
    lines: order.lines.map((l) => {
      const ordered = toMilli(l.quantity);
      const dispatched = toMilli(l.dispatchedQuantity);
      const reserved = toMilli(l.reservedQuantity);
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
        outstandingQuantity: Number(fromMilli(Math.max(0, ordered - dispatched))),
        dispatchableNow: Number(fromMilli(Math.max(0, Math.min(reserved, ordered - dispatched)))),
      };
    }),
  };
}

/* ============================================================
   POSTING A DISPATCH
   ============================================================ */

/**
 * @param {object} input
 * @param {string} input.salesOrderId
 * @param {string} [input.warehouseId]   defaults to the order's
 * @param {Array}  input.lines  { salesOrderLineId, quantity, allowUnreserved? }
 * @param {boolean} [input.allowUnreservedApproved]  authorised exception, see below
 */
export async function dispatch(input, actor) {
  await assertCan(actor, 'sales:dispatch');
  const prepared = await prepare(input);
  const challanNo = await nextDocumentNumber('DELIVERY_CHALLAN');

  const id = await prisma.$transaction(async (tx) => {
    const dc = await tx.deliveryChallan.create({
      data: {
        challanNo,
        status: 'DRAFT',
        salesOrderId: prepared.order.id,
        salesInvoiceId: prepared.salesInvoiceId,
        customerId: prepared.order.customerId,
        warehouseId: prepared.warehouse.id,
        dispatchDate: prepared.dispatchDate,
        transporter: prepared.transporter,
        vehicleNumber: prepared.vehicleNumber,
        trackingRef: prepared.trackingRef,
        receiverName: prepared.receiverName,
        receiverPhone: prepared.receiverPhone,
        remarks: prepared.remarks,
        createdById: actor.id,
        lines: { create: prepared.lines.map(({ releaseQuantity, ...rest }) => rest) },
      },
      select: { id: true, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
    });

    for (const [i, line] of dc.lines.entries()) {
      const releaseQuantity = prepared.lines[i].releaseQuantity;

      // ── 1. RELEASE THE RESERVATION FIRST -- only as much of it
      // as this line actually holds. An approved over-dispatch's
      // excess was never reserved, so there is nothing to release
      // for it, and no movement is posted for that part. ────────
      if (releaseQuantity > 0) {
        await postStockMovement({
          productId: line.productId,
          warehouseId: prepared.warehouse.id,
          movementType: 'RESERVATION_RELEASE',
          reason: 'RESERVATION_RELEASE',
          quantity: releaseQuantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: dc.id,
          referenceNo: challanNo,
          remarks: 'Released for dispatch under ' + challanNo,
          idempotencyKey: 'dc:' + line.id + ':release',
          createdById: actor.id,
        }, tx);
      }

      // ── 2. THEN THE STOCK ACTUALLY LEAVES ────────────────────
      await postStockMovement({
        productId: line.productId,
        warehouseId: prepared.warehouse.id,
        movementType: 'OUTWARD',
        reason: 'SALES_DISPATCH',
        quantity: line.quantity,
        uom: line.uom,
        referenceType: 'DELIVERY_CHALLAN',
        referenceId: dc.id,
        referenceNo: challanNo,
        transactionDate: prepared.dispatchDate,
        remarks: 'Dispatched against ' + prepared.order.orderNo
          + (prepared.trackingRef ? ', tracking ' + prepared.trackingRef : ''),
        idempotencyKey: 'dc:' + line.id + ':outward',
        createdById: actor.id,
      }, tx);

      // ── 3. the order line's running totals ──────────────────
      await tx.salesOrderLine.update({
        where: { id: line.salesOrderLineId },
        data: {
          reservedQuantity: { decrement: releaseQuantity },
          dispatchedQuantity: { increment: line.quantity },
        },
      });
    }

    await tx.deliveryChallan.update({
      where: { id: dc.id },
      data: { status: 'DISPATCHED', dispatchedById: actor.id, dispatchedAt: new Date() },
    });

    const status = await refreshStatusFromLines(tx, prepared.order.id);

    await record(tx, {
      entityType: 'DeliveryChallan', entityId: dc.id, action: 'DISPATCH', actorUserId: actor.id,
      summary: 'Dispatched ' + challanNo + ' against ' + prepared.order.orderNo + ' from '
        + prepared.warehouse.name + ': ' + prepared.summary + '. The reservation was released '
        + 'and the stock then left through the same movement service; the order is now '
        + status.toLowerCase().replace(/_/g, ' ') + '.',
    });
    await record(tx, {
      entityType: 'SalesOrder', entityId: prepared.order.id, action: 'DISPATCH', actorUserId: actor.id,
      summary: 'Goods dispatched on ' + prepared.order.orderNo + ' under ' + challanNo + '.',
    });

    return dc.id;
  });

  return get(id);
}

/* ============================================================
   VALIDATION
   ============================================================
   A DISPATCHED CHALLAN CANNOT BE CANCELLED: it has written
   outward entries on the append-only ledger, and the database
   refuses to remove them. A wrongly dispatched delivery is
   corrected by a sales return instead, which is a movement in its
   own right and leaves both documents visible.
   ============================================================ */

async function prepare(input) {
  const fields = [];
  if (!input.salesOrderId) {
    throw new ValidationError([{ field: 'salesOrderId', message: 'Which order is this against?' }]);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError([{ field: 'lines', message: 'A dispatch needs at least one line.' }]);
  }

  const order = await prisma.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true, orderNo: true, status: true, customerId: true, warehouseId: true,
      lines: {
        select: {
          id: true, lineNo: true, productId: true, skuAtOrder: true, uom: true,
          quantity: true, reservedQuantity: true, dispatchedQuantity: true,
        },
      },
    },
  });
  if (!order) throw new ValidationError([{ field: 'salesOrderId', message: 'No such sales order.' }]);

  if (!DISPATCHABLE.includes(order.status)) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' is ' + order.status.toLowerCase().replace(/_/g, ' ')
      + ', so goods cannot be dispatched against it. Only a reserved — or already partly '
      + 'dispatched — order can take a dispatch.',
      { status: order.status, dispatchableStatuses: DISPATCHABLE },
    );
  }

  const warehouseId = input.warehouseId ?? order.warehouseId;
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new ValidationError([{ field: 'warehouseId', message: 'No such warehouse.' }]);
  if (!warehouse.isActive) {
    throw new ValidationError([{ field: 'warehouseId', message: warehouse.name + ' is deactivated.' }]);
  }

  // AN INVOICE REFERENCE IS OPTIONAL -- the architecture allows
  // dispatch to happen with or without one already raised -- but
  // if given it must actually be this order's own invoice.
  let salesInvoiceId = null;
  if (input.salesInvoiceId) {
    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: input.salesInvoiceId },
      select: { id: true, invoiceNo: true, salesOrderId: true, status: true },
    });
    if (!invoice) fields.push({ field: 'salesInvoiceId', message: 'No such invoice.' });
    else if (invoice.salesOrderId !== order.id) {
      fields.push({ field: 'salesInvoiceId', message: 'Invoice ' + invoice.invoiceNo + ' is against a different order.' });
    } else if (invoice.status !== 'POSTED') {
      fields.push({ field: 'salesInvoiceId', message: 'Invoice ' + invoice.invoiceNo + ' is ' + invoice.status.toLowerCase() + ', not posted.' });
    } else {
      salesInvoiceId = invoice.id;
    }
  }

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  const seen = new Set();
  const lines = [];
  const parts = [];

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    const orderLine = byLineId.get(raw?.salesOrderLineId);
    if (!orderLine) { fields.push({ field: at('salesOrderLineId'), message: 'Not a line on this order.' }); return; }
    if (seen.has(orderLine.id)) {
      fields.push({ field: at('salesOrderLineId'), message: 'Line appears twice on this dispatch.' });
      return;
    }
    seen.add(orderLine.id);

    let quantityMilli;
    try { quantityMilli = toMilli(raw.quantity); } catch { fields.push({ field: at('quantity'), message: 'Not a usable quantity.' }); return; }
    if (quantityMilli <= 0) { fields.push({ field: at('quantity'), message: 'A dispatch quantity must be above zero.' }); return; }

    const orderedMilli = toMilli(orderLine.quantity);
    const dispatchedMilli = toMilli(orderLine.dispatchedQuantity);
    const reservedMilli = toMilli(orderLine.reservedQuantity);
    const outstandingMilli = orderedMilli - dispatchedMilli;

    // PREVENT DISPATCH ABOVE THE REMAINING ORDER QUANTITY,
    // outright -- there is no authorised exception for this one,
    // unlike over-receipt on the purchase side, because shipping
    // more than a customer ordered is never something a studio
    // would want to do by accident OR on purpose through this
    // screen.
    if (quantityMilli > outstandingMilli) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(Math.max(0, outstandingMilli))
          + ' remains on this order line.',
      });
      return;
    }

    // PREVENT DISPATCH ABOVE THE RESERVED QUANTITY unless an
    // authorised exception is given -- the mirror of the
    // purchase side's over-receipt approval.
    if (quantityMilli > reservedMilli && !raw.allowUnreserved && !input.allowUnreservedApproved) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(Math.max(0, reservedMilli))
          + ' is reserved on this line, but ' + fromMilli(quantityMilli) + ' is being dispatched. '
          + 'Dispatching unreserved stock must be approved explicitly, with a reason.',
      });
      return;
    }

    lines.push({
      lineNo: lines.length + 1,
      salesOrderLineId: orderLine.id,
      productId: orderLine.productId,
      skuAtDispatch: orderLine.skuAtOrder,
      // Snapshot of the name as it reads today; the line carries
      // its own quantity and uom, matching GRN's shape.
      nameAtDispatch: orderLine.nameAtOrder ?? orderLine.skuAtOrder,
      quantity: fromMilli(quantityMilli),
      uom: raw.uom ?? orderLine.uom,
      // HOW MUCH OF THIS DISPATCH IS ACTUALLY RELEASING A
      // RESERVATION, versus the unreserved-and-approved excess.
      // Capped at what this line itself holds reserved: an
      // approved over-dispatch must not release (or decrement)
      // reservation that was never there to begin with, whether
      // that reservation belongs to this line or -- worse --
      // reads as available at the warehouse only because some
      // OTHER order's reservation happens to cover it.
      releaseQuantity: fromMilli(Math.min(quantityMilli, reservedMilli)),
    });
    parts.push(fromMilli(quantityMilli) + ' ' + orderLine.skuAtOrder);
  });

  if (input.allowUnreservedApproved && !String(input.allowUnreservedReason ?? '').trim()) {
    fields.push({
      field: 'allowUnreservedReason',
      message: 'Dispatching unreserved stock needs a reason. It goes in the audit log.',
    });
  }

  if (fields.length) throw new ValidationError(fields);

  const dispatchDate = input.dispatchDate ? new Date(input.dispatchDate) : new Date();
  if (Number.isNaN(dispatchDate.getTime())) {
    throw new ValidationError([{ field: 'dispatchDate', message: 'That is not a date.' }]);
  }

  return {
    order, warehouse, salesInvoiceId, lines,
    dispatchDate,
    transporter: text(input.transporter),
    vehicleNumber: text(input.vehicleNumber),
    trackingRef: text(input.trackingRef),
    receiverName: text(input.receiverName),
    receiverPhone: text(input.receiverPhone),
    remarks: [text(input.remarks), input.allowUnreservedApproved
      ? 'Unreserved dispatch approved: ' + String(input.allowUnreservedReason).trim()
      : null].filter(Boolean).join(' — ') || null,
    summary: parts.join('; '),
  };
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shapeHead(d) {
  return {
    id: d.id, challanNo: d.challanNo, status: d.status, dispatchDate: d.dispatchDate,
    transporter: d.transporter, vehicleNumber: d.vehicleNumber, trackingRef: d.trackingRef,
    receiverName: d.receiverName, receiverPhone: d.receiverPhone, remarks: d.remarks,
    salesOrder: d.salesOrder, salesInvoice: d.salesInvoice, customer: d.customer, warehouse: d.warehouse,
    createdBy: d.createdBy?.name ?? null, dispatchedBy: d.dispatchedBy?.name ?? null,
    cancelledBy: d.cancelledBy?.name ?? null,
    dispatchedAt: d.dispatchedAt, cancelledAt: d.cancelledAt, cancelReason: d.cancelReason,
    lineCount: d._count?.lines ?? null,
    totalQuantity: d.lines ? d.lines.reduce((t, l) => t + Number(l.quantity), 0) : null,
    createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id, lineNo: l.lineNo, salesOrderLineId: l.salesOrderLineId, productId: l.productId,
    sku: l.skuAtDispatch, name: l.nameAtDispatch, quantity: Number(l.quantity), uom: l.uom,
  };
}
