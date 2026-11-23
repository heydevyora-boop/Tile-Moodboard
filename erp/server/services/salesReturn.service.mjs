import { prisma } from '../../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toMilli, fromMilli } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   SALES RETURNS — STOCK COMING BACK FROM THE CUSTOMER
   ============================================================

   THREE DISPOSITIONS, three different effects on stock, and
   exactly one of them moves nothing:

     ACCEPTED_GOOD  the boxes are fine; they go back to sellable
                    stock. One movement: INWARD.

     DAMAGED        the boxes are physically back in the building
                    but not sellable. TWO movements, both posted:
                    INWARD (they did arrive) and then DAMAGE (so
                    they are immediately pulled out of the
                    sellable count and into the damaged
                    dimension). A single movement would either
                    understate what came back or overstate what
                    can be sold -- the brief's own wording,
                    "damaged goods must be classified as damaged
                    stock", is why this is two postings rather
                    than one labelled INWARD-damaged.

     REJECTED       the claim is refused. NOTHING is posted. The
                    goods are not treated as having come back:
                    "rejected goods must not increase stock" is
                    enforced by this file simply never calling
                    postStockMovement for that line, not by a
                    movement that is later reversed.

   RETURNEDQUANTITY ON THE ORDER LINE increments for every
   disposition, including REJECTED -- see the field's own comment
   in schema.prisma ("what has come back, of any disposition").
   A claim made and refused still used up the dispatched quantity
   it was made against: the goods are with the customer and the
   matter is closed, so that dispatched quantity is not available
   for a second return claim. Only ACCEPTED_GOOD and DAMAGED move
   stock; REJECTED still advances the counter that prevents the
   same dispatched boxes being claimed back again and again.

   ELIGIBILITY is read straight off the order line's own running
   totals -- dispatchedQuantity less returnedQuantity -- because
   that is exactly what those two columns were put there to answer
   without re-summing every return. A return must therefore be
   raised against a sales order, so there is a line to check.
   ============================================================ */

const HEAD_SELECT = {
  id: true, returnNo: true, status: true, returnDate: true, reason: true, remarks: true,
  postedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
  customer: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  salesOrder: { select: { id: true, orderNo: true } },
  receivedBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
};

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtReturn: true, nameAtReturn: true,
  quantity: true, uom: true, disposition: true, remarks: true,
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
      ? { returnDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { returnNo: { contains: search, mode: 'insensitive' } },
          { reason: { contains: search, mode: 'insensitive' } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
          { lines: { some: { skuAtReturn: { contains: search, mode: 'insensitive' } } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.salesReturn.findMany({
      where, orderBy: [{ returnDate: 'desc' }, { returnNo: 'desc' }], skip, take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { select: { quantity: true, disposition: true } } },
    }),
    prisma.salesReturn.count({ where }),
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
  const ret = await prisma.salesReturn.findUnique({
    where: { id },
    select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
  });
  if (!ret) throw new NotFoundError('Sales return');

  const movements = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'SALES_RETURN', referenceId: id },
    orderBy: { entryNo: 'asc' },
    select: {
      id: true, entryNo: true, movementType: true, quantity: true, uom: true,
      balanceBefore: true, balanceAfter: true, product: { select: { sku: true, name: true } },
    },
  });

  return {
    ...shapeHead(ret),
    lines: ret.lines.map(shapeLine),
    movements: movements.map((m) => ({
      id: m.id, entryNo: String(m.entryNo), sku: m.product.sku, movementType: m.movementType,
      quantity: Number(m.quantity), balanceBefore: Number(m.balanceBefore), balanceAfter: Number(m.balanceAfter),
    })),
  };
}

/** What may still come back, line by line, against a sales order. */
export async function returnableLines(salesOrderId) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true, orderNo: true, status: true,
      customer: { select: { id: true, code: true, name: true } },
      warehouse: { select: { id: true, code: true, name: true, isActive: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true, uom: true, dispatchedQuantity: true, returnedQuantity: true },
      },
    },
  });
  if (!order) throw new NotFoundError('Sales order');

  return {
    salesOrder: { id: order.id, orderNo: order.orderNo, status: order.status, customer: order.customer, warehouse: order.warehouse },
    lines: order.lines
      .filter((l) => toMilli(l.dispatchedQuantity) > toMilli(l.returnedQuantity))
      .map((l) => {
        const eligibleMilli = Math.max(0, toMilli(l.dispatchedQuantity) - toMilli(l.returnedQuantity));
        return {
          salesOrderLineId: l.id, lineNo: l.lineNo, productId: l.productId, sku: l.skuAtOrder, name: l.nameAtOrder, uom: l.uom,
          dispatchedQuantity: Number(l.dispatchedQuantity), returnedQuantity: Number(l.returnedQuantity),
          eligibleQuantity: Number(fromMilli(eligibleMilli)),
        };
      }),
  };
}

/* ============================================================
   POSTING A RETURN
   ============================================================ */

export async function post(input, actor) {
  await assertCan(actor, 'sales:return');
  const prepared = await prepare(input);
  const returnNo = await nextDocumentNumber('SALES_RETURN');

  const id = await prisma.$transaction(async (tx) => {
    const ret = await tx.salesReturn.create({
      data: {
        returnNo, status: 'DRAFT',
        customerId: prepared.order.customerId,
        warehouseId: prepared.warehouse.id,
        salesOrderId: prepared.order.id,
        salesInvoiceId: prepared.salesInvoiceId,
        deliveryChallanId: prepared.deliveryChallanId,
        returnDate: prepared.returnDate,
        reason: prepared.reason,
        remarks: prepared.remarks,
        receivedById: actor.id,
        lines: { create: prepared.lines.map(({ salesOrderLineId, ...rest }) => rest) },
      },
      select: { id: true, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
    });

    for (const [i, line] of ret.lines.entries()) {
      const plan = prepared.lines[i];

      if (line.disposition === 'ACCEPTED_GOOD') {
        await postStockMovement({
          productId: line.productId, warehouseId: prepared.warehouse.id,
          movementType: 'INWARD', reason: 'SALES_RETURN', quantity: line.quantity, uom: line.uom,
          referenceType: 'SALES_RETURN', referenceId: ret.id, referenceNo: returnNo,
          transactionDate: prepared.returnDate,
          remarks: 'Accepted back from ' + prepared.order.customer.name + ' in good condition: ' + prepared.reason,
          idempotencyKey: 'sr:' + line.id + ':inward',
          createdById: actor.id,
        }, tx);
      } else if (line.disposition === 'DAMAGED') {
        // Physically back in the building first ...
        await postStockMovement({
          productId: line.productId, warehouseId: prepared.warehouse.id,
          movementType: 'INWARD', reason: 'SALES_RETURN', quantity: line.quantity, uom: line.uom,
          referenceType: 'SALES_RETURN', referenceId: ret.id, referenceNo: returnNo,
          transactionDate: prepared.returnDate,
          remarks: 'Returned by ' + prepared.order.customer.name + ', received damaged: ' + prepared.reason,
          idempotencyKey: 'sr:' + line.id + ':inward',
          createdById: actor.id,
        }, tx);
        // ... then immediately pulled out of sellable stock.
        await postStockMovement({
          productId: line.productId, warehouseId: prepared.warehouse.id,
          movementType: 'DAMAGE', reason: 'DAMAGE', quantity: line.quantity, uom: line.uom,
          referenceType: 'SALES_RETURN', referenceId: ret.id, referenceNo: returnNo,
          transactionDate: prepared.returnDate,
          remarks: 'Classified as damaged on return under ' + returnNo,
          idempotencyKey: 'sr:' + line.id + ':damage',
          createdById: actor.id,
        }, tx);
      }
      // REJECTED: no movement is posted. The claim is refused and
      // stock is untouched, exactly as the brief requires.

      // RETURNEDQUANTITY ADVANCES FOR EVERY DISPOSITION. A
      // rejected claim still resolves the dispatched quantity it
      // was made against -- see the file header.
      await tx.salesOrderLine.update({
        where: { id: plan.salesOrderLineId },
        data: { returnedQuantity: { increment: line.quantity } },
      });
    }

    await tx.salesReturn.update({
      where: { id: ret.id }, data: { status: 'POSTED', postedById: actor.id, postedAt: new Date() },
    });

    await record(tx, {
      entityType: 'SalesReturn', entityId: ret.id, action: 'POST', actorUserId: actor.id,
      summary: 'Posted ' + returnNo + ' from ' + prepared.order.customer.name + ' against '
        + prepared.order.orderNo + ' at ' + prepared.warehouse.name + ': ' + prepared.summary
        + '. Reason: ' + prepared.reason + '. The original dispatch is unchanged.',
    });

    return ret.id;
  });

  return get(id);
}

/* ============================================================
   VALIDATION
   ============================================================ */

async function prepare(input) {
  const fields = [];
  if (!input.salesOrderId) fields.push({ field: 'salesOrderId', message: 'Which order are these goods coming back against?' });
  if (!String(input.reason ?? '').trim()) {
    fields.push({ field: 'reason', message: 'A return needs a reason. Somebody will ask why the goods came back.' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'A return needs at least one line.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const order = await prisma.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true, orderNo: true, status: true, customerId: true, warehouseId: true,
      customer: { select: { id: true, name: true } },
      lines: { select: { id: true, productId: true, skuAtOrder: true, nameAtOrder: true, uom: true, dispatchedQuantity: true, returnedQuantity: true } },
    },
  });
  if (!order) fields.push({ field: 'salesOrderId', message: 'No such sales order.' });
  if (fields.length) throw new ValidationError(fields);

  const warehouseId = input.warehouseId ?? order.warehouseId;
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) fields.push({ field: 'warehouseId', message: 'No such warehouse.' });
  else if (!warehouse.isActive) fields.push({ field: 'warehouseId', message: warehouse.name + ' is deactivated.' });

  let salesInvoiceId = null;
  if (input.salesInvoiceId) {
    const inv = await prisma.salesInvoice.findUnique({ where: { id: input.salesInvoiceId }, select: { id: true, salesOrderId: true, invoiceNo: true } });
    if (!inv) fields.push({ field: 'salesInvoiceId', message: 'No such invoice.' });
    else if (inv.salesOrderId !== order.id) fields.push({ field: 'salesInvoiceId', message: 'Invoice ' + inv.invoiceNo + ' is against a different order.' });
    else salesInvoiceId = inv.id;
  }
  let deliveryChallanId = null;
  if (input.deliveryChallanId) {
    const dc = await prisma.deliveryChallan.findUnique({ where: { id: input.deliveryChallanId }, select: { id: true, salesOrderId: true, challanNo: true } });
    if (!dc) fields.push({ field: 'deliveryChallanId', message: 'No such delivery challan.' });
    else if (dc.salesOrderId !== order.id) fields.push({ field: 'deliveryChallanId', message: 'Challan ' + dc.challanNo + ' is against a different order.' });
    else deliveryChallanId = dc.id;
  }
  if (fields.length) throw new ValidationError(fields);

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  // ONE DISPATCHED LINE MAY SPLIT ACROSS DISPOSITIONS on a single
  // return -- six boxes back in good condition and four damaged,
  // say -- so the dedup key is (line, disposition), the same shape
  // as a purchase return keying on (product, fromDamaged). What
  // must still be bounded is the TOTAL claimed against one order
  // line within this one request, which a per-line check alone
  // cannot see: tracked here and subtracted from the eligible pool
  // before the next line against the same order line is checked.
  const seen = new Set();
  const claimedMilli = new Map();
  const lines = [];
  const parts = [];

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    const orderLine = byLineId.get(raw?.salesOrderLineId);
    if (!orderLine) { fields.push({ field: at('salesOrderLineId'), message: 'Not a line on this order.' }); return; }

    const disposition = String(raw?.disposition ?? '').toUpperCase();
    if (!['ACCEPTED_GOOD', 'DAMAGED', 'REJECTED'].includes(disposition)) {
      fields.push({ field: at('disposition'), message: 'Disposition must be ACCEPTED_GOOD, DAMAGED or REJECTED.' });
      return;
    }

    const dedupKey = orderLine.id + ':' + disposition;
    if (seen.has(dedupKey)) {
      fields.push({ field: at('salesOrderLineId'), message: 'This line and disposition appear twice on this return.' });
      return;
    }
    seen.add(dedupKey);

    let quantityMilli;
    try { quantityMilli = toMilli(raw.quantity); } catch { fields.push({ field: at('quantity'), message: 'Not a usable quantity.' }); return; }
    if (quantityMilli <= 0) { fields.push({ field: at('quantity'), message: 'A return quantity must be above zero.' }); return; }

    const alreadyClaimedMilli = claimedMilli.get(orderLine.id) ?? 0;
    const eligibleMilli = Math.max(
      0,
      toMilli(orderLine.dispatchedQuantity) - toMilli(orderLine.returnedQuantity) - alreadyClaimedMilli,
    );
    if (quantityMilli > eligibleMilli) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(eligibleMilli)
          + ' is eligible to come back (dispatched less what has already been returned, of any '
          + 'disposition, less what this same return already claims on this line).',
      });
      return;
    }
    claimedMilli.set(orderLine.id, alreadyClaimedMilli + quantityMilli);

    lines.push({
      lineNo: lines.length + 1,
      salesOrderLineId: orderLine.id,
      productId: orderLine.productId,
      skuAtReturn: orderLine.skuAtOrder,
      nameAtReturn: orderLine.nameAtOrder,
      quantity: fromMilli(quantityMilli),
      uom: raw.uom ?? orderLine.uom,
      disposition,
      remarks: raw.remarks ? String(raw.remarks).trim() : null,
    });
    parts.push(fromMilli(quantityMilli) + ' ' + orderLine.skuAtOrder + ' (' + disposition.toLowerCase().replace('_', ' ') + ')');
  });

  if (fields.length) throw new ValidationError(fields);

  const returnDate = input.returnDate ? new Date(input.returnDate) : new Date();
  if (Number.isNaN(returnDate.getTime())) throw new ValidationError([{ field: 'returnDate', message: 'That is not a date.' }]);

  return {
    order, warehouse, salesInvoiceId, deliveryChallanId,
    returnDate, reason: String(input.reason).trim(), remarks: text(input.remarks),
    lines, summary: parts.join('; '),
  };
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shapeHead(r) {
  return {
    id: r.id, returnNo: r.returnNo, status: r.status, returnDate: r.returnDate, reason: r.reason, remarks: r.remarks,
    customer: r.customer, warehouse: r.warehouse, salesOrder: r.salesOrder,
    receivedBy: r.receivedBy?.name ?? null, postedBy: r.postedBy?.name ?? null,
    postedAt: r.postedAt, cancelledAt: r.cancelledAt,
    lineCount: r._count?.lines ?? null,
    totalQuantity: r.lines ? r.lines.reduce((t, l) => t + Number(l.quantity), 0) : null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id, lineNo: l.lineNo, productId: l.productId, sku: l.skuAtReturn, name: l.nameAtReturn,
    quantity: Number(l.quantity), uom: l.uom, disposition: l.disposition, remarks: l.remarks,
  };
}
