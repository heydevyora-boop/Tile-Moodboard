import { prisma } from '../../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toMilli, fromMilli } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   PURCHASE RETURNS — STOCK GOING BACK TO THE SUPPLIER
   ============================================================

   SUPPORTED, and the inspection found the schema able to carry it
   safely: StockMovementReason already had PURCHASE_RETURN, and
   step 5's service already handles both the physical and the
   damaged dimension. So this is a genuine implementation rather
   than the deferred capability the brief allows for.

   IT REDUCES STOCK THROUGH postStockMovement() AND NOTHING ELSE.
   No ledger entry is edited: the receipt that brought the stock
   in stays exactly as it was written, and the return sits beside
   it. A stock card then reads as what actually happened -- it
   came in on the 3rd, it went back on the 11th -- rather than as
   a history that has been tidied up.

   ELIGIBILITY

   You may not return more than the supplier actually delivered,
   net of what has already gone back. That is computed from the
   POSTED receipts for this supplier and product, minus the POSTED
   returns. Subsequent movements are accounted for by the stock
   service itself, which refuses to take a balance below zero --
   so stock that was received and then sold cannot be returned
   either, and the refusal says which figure is short.

   RETURNING DAMAGED STOCK takes two movements, not one. The boxes
   are in the damaged dimension, so they are first recovered out
   of it and then issued; doing only the second would leave the
   damaged figure claiming boxes that are no longer in the
   building.
   ============================================================ */

const HEAD_SELECT = {
  id: true, returnNo: true, status: true, returnDate: true,
  reason: true, remarks: true, documentRef: true,
  postedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
  supplier: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  purchaseOrder: { select: { id: true, orderNo: true } },
  createdBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
};

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtReturn: true, nameAtReturn: true,
  quantity: true, uom: true, unitCost: true, fromDamaged: true, remarks: true,
};

export async function list(query = {}) {
  const { search, status, supplierId, warehouseId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(from || to
      ? { returnDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { returnNo: { contains: search, mode: 'insensitive' } },
          { reason: { contains: search, mode: 'insensitive' } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { lines: { some: { skuAtReturn: { contains: search, mode: 'insensitive' } } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.purchaseReturn.findMany({
      where,
      orderBy: [{ returnDate: 'desc' }, { returnNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { select: { quantity: true } } },
    }),
    prisma.purchaseReturn.count({ where }),
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
  const ret = await prisma.purchaseReturn.findUnique({
    where: { id },
    select: { ...HEAD_SELECT, _count: { select: { lines: true } }, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
  });
  if (!ret) throw new NotFoundError('Purchase return');

  const movements = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'PURCHASE_RETURN', referenceId: id },
    orderBy: { entryNo: 'asc' },
    select: {
      id: true, entryNo: true, movementType: true, quantity: true, uom: true,
      balanceBefore: true, balanceAfter: true,
      product: { select: { sku: true, name: true } },
    },
  });

  return {
    ...shapeHead(ret),
    lines: ret.lines.map(shapeLine),
    movements: movements.map((m) => ({
      id: m.id,
      entryNo: String(m.entryNo),
      sku: m.product.sku,
      movementType: m.movementType,
      quantity: Number(m.quantity),
      balanceBefore: Number(m.balanceBefore),
      balanceAfter: Number(m.balanceAfter),
    })),
  };
}

/**
 * How much of a product this supplier may still have back.
 *
 * Received on posted receipts, less what has already gone back.
 * Exposed so the form can show the figure BEFORE somebody types a
 * quantity that will be refused.
 */
export async function eligibility({ supplierId, productId, warehouseId }) {
  const [receipts, returned, balance] = await Promise.all([
    prisma.goodsReceiptNoteLine.aggregate({
      where: {
        productId,
        goodsReceiptNote: {
          supplierId,
          status: 'POSTED',
          ...(warehouseId ? { warehouseId } : {}),
        },
      },
      _sum: { receivedQuantity: true },
    }),
    prisma.purchaseReturnLine.aggregate({
      where: {
        productId,
        purchaseReturn: {
          supplierId,
          status: 'POSTED',
          ...(warehouseId ? { warehouseId } : {}),
        },
      },
      _sum: { quantity: true },
    }),
    warehouseId
      ? prisma.inventoryBalance.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
        select: { quantityOnHand: true, quantityReserved: true, quantityDamaged: true },
      })
      : null,
  ]);

  const receivedMilli = toMilli(receipts._sum.receivedQuantity ?? 0);
  const returnedMilli = toMilli(returned._sum.quantity ?? 0);
  const eligibleMilli = Math.max(0, receivedMilli - returnedMilli);

  const onHand = toMilli(balance?.quantityOnHand ?? 0);
  const reserved = toMilli(balance?.quantityReserved ?? 0);
  const damaged = toMilli(balance?.quantityDamaged ?? 0);

  return {
    receivedFromSupplier: Number(fromMilli(receivedMilli)),
    alreadyReturned: Number(fromMilli(returnedMilli)),
    eligible: Number(fromMilli(eligibleMilli)),
    inStock: {
      onHand: Number(fromMilli(onHand)),
      sellable: Number(fromMilli(Math.max(0, onHand - reserved - damaged))),
      damaged: Number(fromMilli(damaged)),
    },
    _milli: { eligible: eligibleMilli, damaged },
  };
}

/* ============================================================
   POSTING A RETURN
   ============================================================ */

export async function post(input, actor) {
  await assertCan(actor, 'purchase:write');

  const prepared = await prepare(input);
  const returnNo = await nextDocumentNumber('PURCHASE_RETURN');

  const id = await prisma.$transaction(async (tx) => {
    const ret = await tx.purchaseReturn.create({
      data: {
        returnNo,
        status: 'DRAFT',
        supplierId: prepared.supplier.id,
        warehouseId: prepared.warehouse.id,
        purchaseOrderId: prepared.purchaseOrderId,
        returnDate: prepared.returnDate,
        reason: prepared.reason,
        remarks: prepared.remarks,
        documentRef: prepared.documentRef,
        createdById: actor.id,
        lines: { create: prepared.lines },
      },
      select: { id: true, lines: { select: LINE_SELECT } },
    });

    for (const line of ret.lines) {
      /* DAMAGED STOCK COMES OUT OF TWO PLACES. It sits in the
         damaged dimension as well as in physical stock, so
         recover it first; otherwise the damaged figure would go
         on claiming boxes that have left the building, and the
         available-stock CHECK would refuse the issue anyway. */
      if (line.fromDamaged) {
        await postStockMovement({
          productId: line.productId,
          warehouseId: prepared.warehouse.id,
          movementType: 'DAMAGE_RECOVERY',
          reason: 'DAMAGE_RECOVERY',
          quantity: line.quantity,
          uom: line.uom,
          referenceType: 'PURCHASE_RETURN',
          referenceId: ret.id,
          referenceNo: returnNo,
          transactionDate: prepared.returnDate,
          remarks: 'Released from damaged stock to go back to ' + prepared.supplier.name,
          idempotencyKey: 'pr:' + line.id + ':undamage',
          createdById: actor.id,
        }, tx);
      }

      await postStockMovement({
        productId: line.productId,
        warehouseId: prepared.warehouse.id,
        movementType: 'OUTWARD',
        reason: 'PURCHASE_RETURN',
        quantity: line.quantity,
        uom: line.uom,
        unitCost: line.unitCost ?? undefined,
        referenceType: 'PURCHASE_RETURN',
        referenceId: ret.id,
        referenceNo: returnNo,
        transactionDate: prepared.returnDate,
        remarks: 'Returned to ' + prepared.supplier.name + ': ' + prepared.reason,
        idempotencyKey: 'pr:' + line.id + ':outward',
        createdById: actor.id,
      }, tx);
    }

    await tx.purchaseReturn.update({
      where: { id: ret.id },
      data: { status: 'POSTED', postedById: actor.id, postedAt: new Date() },
    });

    await record(tx, {
      entityType: 'PurchaseReturn',
      entityId: ret.id,
      action: 'POST',
      actorUserId: actor.id,
      summary: 'Posted ' + returnNo + ' to ' + prepared.supplier.name + ' from '
        + prepared.warehouse.name + ': ' + prepared.summary + '. Reason: ' + prepared.reason
        + '. The receipts that brought this stock in are unchanged.',
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

  if (!input.supplierId) fields.push({ field: 'supplierId', message: 'Which supplier is this going back to?' });
  if (!input.warehouseId) fields.push({ field: 'warehouseId', message: 'Which warehouse is it leaving?' });
  if (!String(input.reason ?? '').trim()) {
    fields.push({ field: 'reason', message: 'A return needs a reason. Somebody will ask why the goods went back.' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'A return needs at least one line.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const [supplier, warehouse] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: input.supplierId } }),
    prisma.warehouse.findUnique({ where: { id: input.warehouseId } }),
  ]);
  if (!supplier) fields.push({ field: 'supplierId', message: 'No such supplier.' });
  if (!warehouse) fields.push({ field: 'warehouseId', message: 'No such warehouse.' });
  else if (!warehouse.isActive) {
    fields.push({ field: 'warehouseId', message: warehouse.name + ' is deactivated.' });
  }
  if (fields.length) throw new ValidationError(fields);

  if (input.purchaseOrderId) {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: input.purchaseOrderId },
      select: { id: true, supplierId: true, orderNo: true },
    });
    if (!order) fields.push({ field: 'purchaseOrderId', message: 'No such purchase order.' });
    else if (order.supplierId !== supplier.id) {
      fields.push({
        field: 'purchaseOrderId',
        message: 'Order ' + order.orderNo + ' belongs to a different supplier.',
      });
    }
  }

  const productIds = [...new Set(input.lines.map((l) => l?.productId).filter(Boolean))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true, name: true, uom: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  const parts = [];
  const seen = new Set();

  for (let i = 0; i < input.lines.length; i += 1) {
    const raw = input.lines[i];
    const at = (f) => 'lines[' + i + '].' + f;

    const product = byId.get(raw?.productId);
    if (!product) { fields.push({ field: at('productId'), message: 'No such product.' }); continue; }

    const key = product.id + ':' + Boolean(raw.fromDamaged);
    if (seen.has(key)) {
      fields.push({ field: at('productId'), message: product.sku + ' appears twice. Put the whole quantity on one line.' });
      continue;
    }
    seen.add(key);

    let quantityMilli;
    try {
      quantityMilli = toMilli(raw.quantity);
    } catch {
      fields.push({ field: at('quantity'), message: 'Not a usable quantity.' });
      continue;
    }
    if (quantityMilli <= 0) {
      fields.push({ field: at('quantity'), message: 'A return quantity must be above zero.' });
      continue;
    }

    /* NOT MORE THAN THIS SUPPLIER ACTUALLY DELIVERED. Checked
       here, with the figures, so the message is useful; the stock
       service separately refuses to take a balance below zero, so
       stock that was received and then sold is caught there too. */
    const able = await eligibility({
      supplierId: supplier.id,
      productId: product.id,
      warehouseId: warehouse.id,
    });

    if (quantityMilli > able._milli.eligible) {
      fields.push({
        field: at('quantity'),
        message: product.sku + ': this supplier delivered ' + able.receivedFromSupplier
          + ' and ' + able.alreadyReturned + ' has already gone back, so at most '
          + able.eligible + ' can be returned.',
      });
      continue;
    }

    if (raw.fromDamaged && quantityMilli > able._milli.damaged) {
      fields.push({
        field: at('quantity'),
        message: product.sku + ': only ' + able.inStock.damaged
          + ' is marked damaged at this warehouse.',
      });
      continue;
    }

    lines.push({
      lineNo: lines.length + 1,
      productId: product.id,
      skuAtReturn: product.sku,
      nameAtReturn: product.name,
      quantity: fromMilli(quantityMilli),
      uom: raw.uom ?? product.uom,
      unitCost: raw.unitCost === undefined || raw.unitCost === null || raw.unitCost === ''
        ? null : raw.unitCost,
      fromDamaged: Boolean(raw.fromDamaged),
      remarks: raw.remarks ? String(raw.remarks).trim() : null,
    });

    parts.push(fromMilli(quantityMilli) + ' ' + product.sku + (raw.fromDamaged ? ' (damaged)' : ''));
  }

  if (fields.length) throw new ValidationError(fields);

  const returnDate = input.returnDate ? new Date(input.returnDate) : new Date();
  if (Number.isNaN(returnDate.getTime())) {
    throw new ValidationError([{ field: 'returnDate', message: 'That is not a date.' }]);
  }

  return {
    supplier,
    warehouse,
    purchaseOrderId: input.purchaseOrderId ?? null,
    returnDate,
    reason: String(input.reason).trim(),
    remarks: text(input.remarks),
    documentRef: text(input.documentRef),
    lines,
    summary: parts.join('; '),
  };
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

function shapeHead(r) {
  return {
    id: r.id,
    returnNo: r.returnNo,
    status: r.status,
    returnDate: r.returnDate,
    reason: r.reason,
    remarks: r.remarks,
    documentRef: r.documentRef,
    supplier: r.supplier,
    warehouse: r.warehouse,
    purchaseOrder: r.purchaseOrder,
    createdBy: r.createdBy?.name ?? null,
    postedBy: r.postedBy?.name ?? null,
    postedAt: r.postedAt,
    cancelledAt: r.cancelledAt,
    lineCount: r._count?.lines ?? null,
    totalQuantity: r.lines ? r.lines.reduce((t, l) => t + Number(l.quantity), 0) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id,
    lineNo: l.lineNo,
    productId: l.productId,
    sku: l.skuAtReturn,
    name: l.nameAtReturn,
    quantity: Number(l.quantity),
    uom: l.uom,
    unitCost: l.unitCost === null ? null : Number(l.unitCost),
    fromDamaged: l.fromDamaged,
    remarks: l.remarks,
  };
}
