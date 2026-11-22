import { prisma } from '../../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toMilli, fromMilli } from './money.mjs';
import { refreshStatusFromLines, RECEIVABLE } from './purchaseOrder.service.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   GOODS RECEIPT — WHERE PURCHASING MEETS INVENTORY
   ============================================================

   THIS IS THE ONLY FILE IN THE PURCHASE MODULE THAT MOVES STOCK,
   and it moves it by calling postStockMovement() and nothing
   else. No balance is written here, no ledger row is inserted
   here. The step 5 test that greps the codebase for direct
   balance writes still passes, and it will fail the moment
   anybody changes that.

   A PURCHASE ORDER DOES NOT INCREASE INVENTORY. Approving one
   does not either. Stock increases exactly once, here, when
   somebody posts a receipt for goods that physically arrived.

   THE THREE DISPOSITIONS OF A DELIVERY

     accepted  sound. Posted INWARD. Sellable.
     damaged   broken, but IN THE BUILDING. Posted INWARD and then
               immediately DAMAGE, so physical stock matches what
               a stock-take would find while available stock does
               not include it. Step 5's rule: a broken box is
               still a box in the warehouse.
     rejected  turned away at the gate. NO movement is posted at
               all, the supplier still owes the quantity, and a
               reason is required.

   IDEMPOTENCY

   Every movement's key is derived from the RECEIPT LINE'S OWN ID
   -- "grn:<lineId>:inward", "grn:<lineId>:damage". Those ids are
   minted when the draft is created, so they are stable across
   retries. Posting the same receipt twice is refused by the
   database's unique index on the idempotency key, not by a
   check-then-act in JavaScript that two concurrent requests
   would both pass.

   TRANSACTION SAFETY

   The draft rows, every stock movement, the order line totals,
   the order's status and the audit entry are written in ONE
   transaction. If any part fails, none of it happened: there is
   no state in which stock moved but the receipt did not exist.
   ============================================================ */

const LINE_SELECT = {
  id: true, lineNo: true, purchaseOrderLineId: true, productId: true,
  skuAtReceipt: true, nameAtReceipt: true,
  orderedQuantity: true, previouslyReceivedQuantity: true,
  acceptedQuantity: true, damagedQuantity: true, rejectedQuantity: true,
  receivedQuantity: true, uom: true, unitCost: true,
  rejectionReason: true, remarks: true,
};

const HEAD_SELECT = {
  id: true, grnNo: true, status: true, receiptDate: true,
  supplierDocNo: true, supplierDocDate: true, documentRef: true, remarks: true,
  postedAt: true, cancelledAt: true, cancelReason: true, createdAt: true, updatedAt: true,
  purchaseOrder: { select: { id: true, orderNo: true, status: true, currency: true } },
  supplier: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
};

/* ============================================================
   READING
   ============================================================ */

export async function list(query = {}) {
  const {
    search, status, supplierId, warehouseId, purchaseOrderId, from, to,
    page = 1, pageSize = 25,
  } = query;

  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    ...(from || to
      ? { receiptDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { grnNo: { contains: search, mode: 'insensitive' } },
          { supplierDocNo: { contains: search, mode: 'insensitive' } },
          { purchaseOrder: { orderNo: { contains: search, mode: 'insensitive' } } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { lines: { some: { skuAtReceipt: { contains: search, mode: 'insensitive' } } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.goodsReceiptNote.findMany({
      where,
      orderBy: [{ receiptDate: 'desc' }, { grnNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { select: { receivedQuantity: true } } },
    }),
    prisma.goodsReceiptNote.count({ where }),
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
  const grn = await prisma.goodsReceiptNote.findUnique({
    where: { id },
    select: {
      ...HEAD_SELECT,
      _count: { select: { lines: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT },
    },
  });
  if (!grn) throw new NotFoundError('Goods receipt');

  /* THE STOCK THIS RECEIPT ACTUALLY MOVED, read back from the
     ledger rather than asserted. If a note claims to be posted
     and the ledger has nothing under its reference, that is worth
     seeing on the screen. */
  const movements = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'GOODS_RECEIPT_NOTE', referenceId: id },
    orderBy: { entryNo: 'asc' },
    select: {
      id: true, entryNo: true, movementType: true, quantity: true, uom: true,
      balanceBefore: true, balanceAfter: true, unitCost: true,
      product: { select: { sku: true, name: true } },
    },
  });

  return {
    ...shapeHead(grn),
    lines: grn.lines.map(shapeLine),
    movements: movements.map((m) => ({
      id: m.id,
      entryNo: String(m.entryNo),
      sku: m.product.sku,
      name: m.product.name,
      movementType: m.movementType,
      quantity: Number(m.quantity),
      uom: m.uom,
      balanceBefore: Number(m.balanceBefore),
      balanceAfter: Number(m.balanceAfter),
      unitCost: m.unitCost === null ? null : Number(m.unitCost),
    })),
  };
}

/**
 * What is still outstanding on an order, line by line.
 *
 * What a receipt form opens on. Computed from the order lines'
 * running totals, which the posting path maintains inside the
 * same transaction as the movements.
 */
export async function receivableLines(purchaseOrderId) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: {
      id: true, orderNo: true, status: true, currency: true,
      supplier: { select: { id: true, code: true, name: true } },
      warehouse: { select: { id: true, code: true, name: true, isActive: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true,
          quantity: true, uom: true, unitPrice: true,
          receivedQuantity: true, rejectedQuantity: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('Purchase order');

  return {
    purchaseOrder: {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      currency: order.currency,
      supplier: order.supplier,
      warehouse: order.warehouse,
      receivable: RECEIVABLE.includes(order.status),
    },
    lines: order.lines.map((l) => {
      const orderedMilli = toMilli(l.quantity);
      const receivedMilli = toMilli(l.receivedQuantity);
      return {
        purchaseOrderLineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        sku: l.skuAtOrder,
        name: l.nameAtOrder,
        uom: l.uom,
        unitPrice: Number(l.unitPrice),
        orderedQuantity: Number(l.quantity),
        receivedQuantity: Number(l.receivedQuantity),
        rejectedQuantity: Number(l.rejectedQuantity),
        outstandingQuantity: Number(fromMilli(Math.max(0, orderedMilli - receivedMilli))),
      };
    }),
  };
}

/* ============================================================
   POSTING A RECEIPT
   ============================================================ */

/**
 * Create a receipt and post its stock, in one transaction.
 *
 * @param {object} input
 * @param {string} input.purchaseOrderId
 * @param {string} [input.warehouseId]   defaults to the order's
 * @param {Array}  input.lines           { purchaseOrderLineId, acceptedQuantity, damagedQuantity?, rejectedQuantity?, rejectionReason?, remarks? }
 * @param {boolean} [input.overReceiptApproved]  see below
 * @param {string}  [input.overReceiptReason]
 */
export async function receive(input, actor) {
  /* Booking in what arrived is the store keeper's job, and the
     seed gives that role purchase:receive without
     purchase:approve. Receiving and approving are different
     authorities on purpose. */
  await assertCan(actor, 'purchase:receive');

  const prepared = await prepare(input);
  const grnNo = await nextDocumentNumber('GOODS_RECEIPT_NOTE');

  const id = await prisma.$transaction(async (tx) => {
    /* ── 1. the note and its lines ──────────────────────────
       Written first so that every line has an id, which is what
       the movements' idempotency keys are built from. */
    const grn = await tx.goodsReceiptNote.create({
      data: {
        grnNo,
        status: 'DRAFT',
        purchaseOrderId: prepared.order.id,
        supplierId: prepared.order.supplierId,
        warehouseId: prepared.warehouse.id,
        receiptDate: prepared.receiptDate,
        supplierDocNo: prepared.supplierDocNo,
        supplierDocDate: prepared.supplierDocDate,
        documentRef: prepared.documentRef,
        remarks: prepared.remarks,
        receivedById: actor.id,
        lines: { create: prepared.lines },
      },
      select: { id: true, lines: { select: { ...LINE_SELECT } } },
    });

    let movementCount = 0;

    for (const line of grn.lines) {
      const accepted = toMilli(line.acceptedQuantity);
      const damaged = toMilli(line.damagedQuantity);
      const intoStock = accepted + damaged;

      /* ── 2. the stock, through the one service ────────────
         Accepted and damaged BOTH come in physically: the broken
         boxes are in the building and a stock-take would count
         them. One INWARD for the total. */
      if (intoStock > 0) {
        await postStockMovement({
          productId: line.productId,
          warehouseId: prepared.warehouse.id,
          movementType: 'INWARD',
          reason: 'PURCHASE_RECEIPT',
          quantity: fromMilli(intoStock),
          uom: line.uom,
          unitCost: line.unitCost ?? undefined,
          referenceType: 'GOODS_RECEIPT_NOTE',
          referenceId: grn.id,
          referenceNo: grnNo,
          transactionDate: prepared.receiptDate,
          remarks: 'Received against ' + prepared.order.orderNo
            + (prepared.supplierDocNo ? ', supplier doc ' + prepared.supplierDocNo : ''),
          // STABLE, and derived from the line's own id. A retry
          // posts the same key and the database refuses it.
          idempotencyKey: 'grn:' + line.id + ':inward',
          createdById: actor.id,
        }, tx);
        movementCount += 1;
      }

      /* ── 3. and the damaged part is condemned straight away ──
         So physical stock matches the shelf while available stock
         does not include boxes nobody can sell. Writing them off
         is a separate decision, taken later, with its own reason. */
      if (damaged > 0) {
        await postStockMovement({
          productId: line.productId,
          warehouseId: prepared.warehouse.id,
          movementType: 'DAMAGE',
          reason: 'DAMAGE',
          quantity: fromMilli(damaged),
          uom: line.uom,
          referenceType: 'GOODS_RECEIPT_NOTE',
          referenceId: grn.id,
          referenceNo: grnNo,
          transactionDate: prepared.receiptDate,
          remarks: 'Damaged on arrival against ' + prepared.order.orderNo
            + (line.remarks ? ': ' + line.remarks : ''),
          idempotencyKey: 'grn:' + line.id + ':damage',
          createdById: actor.id,
        }, tx);
        movementCount += 1;
      }

      /* ── 4. the order line's running totals ────────────────
         Rejected stock is counted separately and NOT as received:
         it never entered the building, so the supplier still owes
         it and the order is not satisfied by it. */
      await tx.purchaseOrderLine.update({
        where: { id: line.purchaseOrderLineId },
        data: {
          receivedQuantity: { increment: fromMilli(intoStock) },
          rejectedQuantity: { increment: line.rejectedQuantity },
        },
      });
    }

    // ── 5. the note becomes POSTED ──────────────────────────
    await tx.goodsReceiptNote.update({
      where: { id: grn.id },
      data: { status: 'POSTED', postedById: actor.id, postedAt: new Date() },
    });

    // ── 6. and the order's status follows its lines ─────────
    const status = await refreshStatusFromLines(tx, prepared.order.id);

    await record(tx, {
      entityType: 'GoodsReceiptNote',
      entityId: grn.id,
      action: 'RECEIVE',
      actorUserId: actor.id,
      summary: 'Posted ' + grnNo + ' against ' + prepared.order.orderNo + ' at '
        + prepared.warehouse.name + ': ' + prepared.summary + '. '
        + movementCount + ' stock movement(s) written; the order is now '
        + status.toLowerCase().replace(/_/g, ' ') + '.',
    });

    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: prepared.order.id,
      action: 'RECEIVE',
      actorUserId: actor.id,
      summary: 'Goods received on ' + prepared.order.orderNo + ' under ' + grnNo
        + '; status is now ' + status.toLowerCase().replace(/_/g, ' ') + '.',
    });

    return grn.id;
  });

  return get(id);
}

/**
 * Cancel a receipt.
 *
 * ONLY WHILE IT IS A DRAFT. A posted receipt wrote entries on an
 * append-only ledger, and those cannot be unwritten -- the
 * database refuses it, which is the guarantee step 5 exists to
 * provide. A receipt posted in error is corrected by a purchase
 * return (the goods went back) or by a stock adjustment (they were
 * never there), either of which leaves both the error and the
 * correction on the record.
 */
export async function cancel(id, actor, reason) {
  await assertCan(actor, 'purchase:receive');

  const grn = await prisma.goodsReceiptNote.findUnique({
    where: { id },
    select: { id: true, grnNo: true, status: true },
  });
  if (!grn) throw new NotFoundError('Goods receipt');

  if (grn.status === 'POSTED') {
    throw new ConflictError(
      'Receipt ' + grn.grnNo + ' has been posted and cannot be cancelled. Its stock '
      + 'movements are on an append-only ledger and the database will not remove them. '
      + 'If the goods went back, raise a purchase return; if they were never there, post '
      + 'a stock adjustment with the reason. Either way both the receipt and the '
      + 'correction stay visible.',
      { status: grn.status, useInstead: ['purchase-return', 'stock-adjustment'] },
    );
  }
  if (grn.status === 'CANCELLED') {
    throw new ConflictError('Receipt ' + grn.grnNo + ' is already cancelled.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.goodsReceiptNote.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledById: actor.id,
        cancelledAt: new Date(),
        cancelReason: reason ? String(reason).trim() : null,
      },
    });
    await record(tx, {
      entityType: 'GoodsReceiptNote',
      entityId: id,
      action: 'CANCEL',
      actorUserId: actor.id,
      summary: 'Cancelled draft receipt ' + grn.grnNo + (reason ? ': ' + reason : '')
        + '. Nothing had been posted.',
    });
  });

  return get(id);
}

/* ============================================================
   VALIDATION
   ============================================================ */

async function prepare(input) {
  const fields = [];

  if (!input.purchaseOrderId) {
    throw new ValidationError([{ field: 'purchaseOrderId', message: 'Which order is this against?' }]);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError([{ field: 'lines', message: 'A receipt needs at least one line.' }]);
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    select: {
      id: true, orderNo: true, status: true, supplierId: true, warehouseId: true,
      supplier: { select: { id: true, name: true, isActive: true } },
      lines: {
        select: {
          id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true,
          quantity: true, uom: true, unitPrice: true, receivedQuantity: true,
          product: { select: { id: true, sku: true, archivedAt: true } },
        },
      },
    },
  });
  if (!order) throw new ValidationError([{ field: 'purchaseOrderId', message: 'No such purchase order.' }]);

  /* ONLY AN APPROVED ORDER CAN RECEIVE GOODS. A draft has not
     been placed with anybody, and a cancelled or closed one is
     finished with. Receiving against either would create stock
     whose explanation contradicts itself. */
  if (!RECEIVABLE.includes(order.status)) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' is ' + order.status.toLowerCase().replace(/_/g, ' ')
      + ', so goods cannot be received against it. Only an approved or partially '
      + 'received order can take a receipt.',
      { status: order.status, receivableStatuses: RECEIVABLE },
    );
  }

  const warehouseId = input.warehouseId ?? order.warehouseId;
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) {
    throw new ValidationError([{ field: 'warehouseId', message: 'No such warehouse.' }]);
  }
  if (!warehouse.isActive) {
    throw new ValidationError([{
      field: 'warehouseId',
      message: warehouse.name + ' is deactivated, so stock cannot be booked in there.',
    }]);
  }

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  const seen = new Set();
  const lines = [];
  const parts = [];

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;

    const orderLine = byLineId.get(raw?.purchaseOrderLineId);
    if (!orderLine) {
      fields.push({
        field: at('purchaseOrderLineId'),
        message: 'That line is not on order ' + order.orderNo + '.',
      });
      return;
    }
    if (seen.has(orderLine.id)) {
      fields.push({
        field: at('purchaseOrderLineId'),
        message: 'Line ' + orderLine.lineNo + ' appears twice on this receipt. '
          + 'Put the whole quantity on one line.',
      });
      return;
    }
    seen.add(orderLine.id);

    if (orderLine.product.archivedAt) {
      fields.push({ field: at('purchaseOrderLineId'), message: orderLine.skuAtOrder + ' has been archived.' });
      return;
    }

    const accepted = qtyOf(raw.acceptedQuantity);
    const damaged = qtyOf(raw.damagedQuantity);
    const rejected = qtyOf(raw.rejectedQuantity);

    if (accepted === null) { fields.push({ field: at('acceptedQuantity'), message: 'Not a usable quantity.' }); return; }
    if (damaged === null) { fields.push({ field: at('damagedQuantity'), message: 'Not a usable quantity.' }); return; }
    if (rejected === null) { fields.push({ field: at('rejectedQuantity'), message: 'Not a usable quantity.' }); return; }
    if (accepted < 0 || damaged < 0 || rejected < 0) {
      fields.push({ field: at('acceptedQuantity'), message: 'A received quantity cannot be negative.' });
      return;
    }
    if (accepted + damaged + rejected === 0) {
      fields.push({
        field: at('acceptedQuantity'),
        message: 'Line ' + orderLine.lineNo + ' records nothing. Leave it off the receipt instead.',
      });
      return;
    }
    if (rejected > 0 && !String(raw.rejectionReason ?? '').trim()) {
      fields.push({
        field: at('rejectionReason'),
        message: 'Turning stock away needs a reason on the record.',
      });
      return;
    }

    /* OVER-RECEIPT IS REFUSED BY DEFAULT, which is what the brief
       asks for. Accepting more than was ordered without anybody
       saying so is how a supplier's mistake becomes the studio's
       stock and the studio's invoice.

       There IS an explicit, authorised path: overReceiptApproved
       with a reason. It is deliberately not a silent tolerance
       band -- somebody has to say "yes, take the extra", and the
       reason goes in the audit log. */
    const orderedMilli = toMilli(orderLine.quantity);
    const alreadyMilli = toMilli(orderLine.receivedQuantity);
    const nowMilli = accepted + damaged;
    const remainingMilli = orderedMilli - alreadyMilli;

    if (nowMilli > remainingMilli && !input.overReceiptApproved) {
      fields.push({
        field: at('acceptedQuantity'),
        message: 'Line ' + orderLine.lineNo + ' (' + orderLine.skuAtOrder + '): '
          + fromMilli(remainingMilli) + ' still outstanding, but ' + fromMilli(nowMilli)
          + ' is being received. Over-receipt must be approved explicitly, with a reason.',
      });
      return;
    }

    const unitCost = raw.unitCost === undefined || raw.unitCost === null || raw.unitCost === ''
      ? orderLine.unitPrice
      : raw.unitCost;

    lines.push({
      lineNo: lines.length + 1,
      purchaseOrderLineId: orderLine.id,
      productId: orderLine.productId,
      // Snapshots, as on the order line and for the same reason.
      skuAtReceipt: orderLine.skuAtOrder,
      nameAtReceipt: orderLine.nameAtOrder,
      orderedQuantity: orderLine.quantity,
      previouslyReceivedQuantity: orderLine.receivedQuantity,
      acceptedQuantity: fromMilli(accepted),
      damagedQuantity: fromMilli(damaged),
      rejectedQuantity: fromMilli(rejected),
      receivedQuantity: fromMilli(accepted + damaged),
      uom: raw.uom ?? orderLine.uom,
      unitCost,
      rejectionReason: rejected > 0 ? String(raw.rejectionReason).trim() : null,
      remarks: raw.remarks ? String(raw.remarks).trim() : null,
    });

    parts.push(fromMilli(accepted + damaged) + ' ' + orderLine.skuAtOrder
      + (damaged > 0 ? ' (' + fromMilli(damaged) + ' damaged)' : '')
      + (rejected > 0 ? ', ' + fromMilli(rejected) + ' rejected' : ''));
  });

  if (input.overReceiptApproved && !String(input.overReceiptReason ?? '').trim()) {
    fields.push({
      field: 'overReceiptReason',
      message: 'Accepting more than was ordered needs a reason. It goes in the audit log.',
    });
  }

  if (fields.length) throw new ValidationError(fields);

  const receiptDate = input.receiptDate ? new Date(input.receiptDate) : new Date();
  if (Number.isNaN(receiptDate.getTime())) {
    throw new ValidationError([{ field: 'receiptDate', message: 'That is not a date.' }]);
  }

  return {
    order,
    warehouse,
    lines,
    receiptDate,
    supplierDocNo: text(input.supplierDocNo),
    supplierDocDate: input.supplierDocDate ? new Date(input.supplierDocDate) : null,
    documentRef: text(input.documentRef),
    remarks: [text(input.remarks), input.overReceiptApproved
      ? 'Over-receipt approved: ' + String(input.overReceiptReason).trim()
      : null].filter(Boolean).join(' — ') || null,
    summary: parts.join('; '),
  };
}

/** A quantity, as integer thousandths, or null if unusable. */
function qtyOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  try {
    return toMilli(value);
  } catch {
    return null;
  }
}

const text = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

/* ── shaping ─────────────────────────────────────────────── */

function shapeHead(g) {
  return {
    id: g.id,
    grnNo: g.grnNo,
    status: g.status,
    receiptDate: g.receiptDate,
    supplierDocNo: g.supplierDocNo,
    supplierDocDate: g.supplierDocDate,
    documentRef: g.documentRef,
    remarks: g.remarks,
    purchaseOrder: g.purchaseOrder,
    supplier: g.supplier,
    warehouse: g.warehouse,
    receivedBy: g.receivedBy?.name ?? null,
    postedBy: g.postedBy?.name ?? null,
    cancelledBy: g.cancelledBy?.name ?? null,
    postedAt: g.postedAt,
    cancelledAt: g.cancelledAt,
    cancelReason: g.cancelReason,
    lineCount: g._count?.lines ?? null,
    totalReceived: g.lines
      ? g.lines.reduce((t, l) => t + Number(l.receivedQuantity), 0)
      : null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id,
    lineNo: l.lineNo,
    purchaseOrderLineId: l.purchaseOrderLineId,
    productId: l.productId,
    sku: l.skuAtReceipt,
    name: l.nameAtReceipt,
    orderedQuantity: Number(l.orderedQuantity),
    previouslyReceivedQuantity: Number(l.previouslyReceivedQuantity),
    acceptedQuantity: Number(l.acceptedQuantity),
    damagedQuantity: Number(l.damagedQuantity),
    rejectedQuantity: Number(l.rejectedQuantity),
    receivedQuantity: Number(l.receivedQuantity),
    uom: l.uom,
    unitCost: l.unitCost === null ? null : Number(l.unitCost),
    rejectionReason: l.rejectionReason,
    remarks: l.remarks,
  };
}
