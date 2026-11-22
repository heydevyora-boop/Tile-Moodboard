import { prisma } from '../../db/client.mjs';
import { nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import {
  computeLine, computeTotals, gstTreatmentFor, gstRateForHsn, toMilli, fromMilli,
} from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   PURCHASE ORDERS
   ============================================================

   A PURCHASE ORDER DOES NOT TOUCH STOCK. Not when it is raised,
   not when it is approved, not ever. It is an agreement to buy.
   Stock moves when goods arrive and a goods receipt is posted,
   which is grn.service.mjs, and nothing in this file imports
   postStockMovement -- deliberately, so that it cannot.

   THE STATE MACHINE IS THE POINT OF THIS SERVICE.

       DRAFT ─▶ PENDING_APPROVAL ─▶ APPROVED ─▶ PARTIALLY_RECEIVED
                                                      │
                                                      ▼
                                               FULLY_RECEIVED
                                                      │
       any of the first three ─▶ CANCELLED            ▼
       received ones ─────────────────────────────▶ CLOSED

   Two rules carry most of the weight:

   AN ORDER THAT HAS RECEIVED GOODS CANNOT BE CANCELLED. Cancelling
   says "this never happened", and it did: there is stock on a
   shelf that came in against it. Such an order is CLOSED instead,
   short of its full quantity, with a reason recorded. The brief
   asks for exactly this and it is the single most important
   transition rule here.

   AN APPROVED ORDER CANNOT BE EDITED. Lines, prices, quantities
   and the supplier are all frozen once somebody has committed the
   studio to them. Editing is a DRAFT-only operation; after that
   the honest options are to cancel and re-raise, or to close
   short.
   ============================================================ */

/** Which status may become which. Everything absent is refused. */
const TRANSITIONS = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED', 'CLOSED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED'],
  FULLY_RECEIVED: ['CLOSED'],
  CANCELLED: [],
  CLOSED: [],
};

/** Statuses in which goods may be booked in against the order. */
export const RECEIVABLE = ['APPROVED', 'PARTIALLY_RECEIVED'];

/** Statuses that mean the order is finished with. */
export const TERMINAL = ['CANCELLED', 'CLOSED'];

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function assertTransition(order, to, extra) {
  if (canTransition(order.status, to)) return;
  throw new ConflictError(
    'Order ' + order.orderNo + ' is ' + readable(order.status)
    + ' and cannot become ' + readable(to) + '.'
    + (extra ? ' ' + extra : ''),
    { from: order.status, to, allowedFromHere: TRANSITIONS[order.status] ?? [] },
  );
}

const WORDS = {
  DRAFT: 'a draft',
  PENDING_APPROVAL: 'awaiting approval',
  APPROVED: 'approved',
  PARTIALLY_RECEIVED: 'partially received',
  FULLY_RECEIVED: 'fully received',
  CANCELLED: 'cancelled',
  CLOSED: 'closed',
};
const readable = (s) => WORDS[s] ?? s;

/* ============================================================
   READING
   ============================================================ */

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true,
  hsnAtOrder: true, description: true, quantity: true, uom: true, unitPrice: true,
  discountPercent: true, discountAmount: true, grossAmount: true, taxableValue: true,
  taxRate: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxAmount: true,
  lineTotal: true, receivedQuantity: true, rejectedQuantity: true, expectedDate: true,
  product: { select: { id: true, sku: true, name: true, status: true } },
};

const HEAD_SELECT = {
  id: true, orderNo: true, status: true, orderDate: true, expectedDate: true,
  billingAddress: true, shippingAddress: true, paymentTerms: true, notes: true,
  gstTreatment: true, supplierStateCode: true, placeOfSupplyCode: true,
  subTotal: true, discountTotal: true, taxableTotal: true,
  cgstTotal: true, sgstTotal: true, igstTotal: true, taxTotal: true,
  otherCharges: true, grandTotal: true, currency: true,
  submittedAt: true, approvedAt: true, cancelledAt: true, cancelReason: true,
  closedAt: true, closeReason: true, createdAt: true, updatedAt: true,
  supplier: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, state: true } },
  warehouse: { select: { id: true, code: true, name: true, stateCode: true, state: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
};

export async function list(query = {}) {
  const {
    search, status, supplierId, warehouseId, from, to,
    page = 1, pageSize = 25,
  } = query;

  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const statuses = status && status !== 'all'
    ? String(status).split(',').filter((s) => s in TRANSITIONS)
    : null;

  const where = {
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(from || to
      ? { orderDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { orderNo: { contains: search, mode: 'insensitive' } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { lines: { some: { skuAtOrder: { contains: search, mode: 'insensitive' } } } },
          { lines: { some: { nameAtOrder: { contains: search, mode: 'insensitive' } } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: [{ orderDate: 'desc' }, { orderNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true, receipts: true, invoices: true } } },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return {
    rows: rows.map((o) => shapeHead(o)),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      ...HEAD_SELECT,
      _count: { select: { lines: true, receipts: true, invoices: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT },
      receipts: {
        orderBy: { receiptDate: 'desc' },
        select: {
          id: true, grnNo: true, status: true, receiptDate: true, supplierDocNo: true,
          postedAt: true, receivedBy: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      },
      invoices: {
        orderBy: { invoiceDate: 'desc' },
        select: { id: true, invoiceNo: true, invoiceDate: true, invoiceAmount: true, status: true },
      },
    },
  });
  if (!order) throw new NotFoundError('Purchase order');

  return {
    ...shapeHead(order),
    lines: order.lines.map(shapeLine),
    receipts: order.receipts.map((r) => ({
      id: r.id,
      grnNo: r.grnNo,
      status: r.status,
      receiptDate: r.receiptDate,
      supplierDocNo: r.supplierDocNo,
      postedAt: r.postedAt,
      receivedBy: r.receivedBy?.name ?? null,
      lineCount: r._count.lines,
    })),
    invoices: order.invoices.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate,
      amount: Number(i.invoiceAmount),
      status: i.status,
    })),
    allowed: {
      edit: order.status === 'DRAFT',
      submit: canTransition(order.status, 'PENDING_APPROVAL'),
      approve: canTransition(order.status, 'APPROVED'),
      receive: RECEIVABLE.includes(order.status),
      cancel: canTransition(order.status, 'CANCELLED') && !(await hasReceipts(order.id)),
      close: canTransition(order.status, 'CLOSED'),
    },
  };
}

/* ============================================================
   CREATING
   ============================================================ */

export async function create(input, actor) {
  await assertCan(actor, 'purchase:write');

  const { supplier, warehouse, lines, head } = await validateDraft(input);

  const orderNo = await nextDocumentNumber('PURCHASE_ORDER');

  const id = await prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.create({
      data: {
        orderNo,
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        status: 'DRAFT',
        orderDate: head.orderDate,
        expectedDate: head.expectedDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        notes: head.notes,
        currency: head.currency,
        gstTreatment: head.gstTreatment,
        supplierStateCode: head.supplierStateCode,
        placeOfSupplyCode: head.placeOfSupplyCode,
        ...head.totals,
        createdById: actor.id,
        lines: { create: lines },
      },
      select: { id: true, orderNo: true },
    });

    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: order.id,
      action: 'CREATE',
      actorUserId: actor.id,
      summary: 'Raised ' + orderNo + ' on ' + supplier.name + ' for '
        + lines.length + ' line(s), ' + head.totals.grandTotal + ' '
        + head.currency + ' (' + head.gstTreatment.toLowerCase().replace('_', '-')
        + '). Nothing has been received; no stock has moved.',
    });

    return order.id;
  });

  return get(id);
}

/**
 * Replace a DRAFT order's contents.
 *
 * Draft only, and the service says so rather than silently
 * ignoring the attempt. Once an order is approved it has been
 * sent to a supplier, and quietly changing what it says is the
 * behaviour the brief explicitly forbids.
 */
export async function update(id, input, actor) {
  await assertCan(actor, 'purchase:write');

  const existing = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { id: true, orderNo: true, status: true, supplierId: true, warehouseId: true },
  });
  if (!existing) throw new NotFoundError('Purchase order');

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      'Order ' + existing.orderNo + ' is ' + readable(existing.status)
      + ' and cannot be edited. An order a supplier has already been given must not '
      + 'change underneath them: cancel it and raise a new one, or close it short.',
      { status: existing.status },
    );
  }

  const { supplier, warehouse, lines, head } = await validateDraft(input);

  await prisma.$transaction(async (tx) => {
    // The lines are replaced wholesale. A draft has no history
    // worth preserving line by line, and diffing them would be
    // machinery for no benefit.
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        orderDate: head.orderDate,
        expectedDate: head.expectedDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        notes: head.notes,
        currency: head.currency,
        gstTreatment: head.gstTreatment,
        supplierStateCode: head.supplierStateCode,
        placeOfSupplyCode: head.placeOfSupplyCode,
        ...head.totals,
        lines: { create: lines },
      },
    });

    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor.id,
      summary: 'Edited draft ' + existing.orderNo + ': ' + lines.length + ' line(s), '
        + head.totals.grandTotal + ' ' + head.currency + '.',
    });
  });

  return get(id);
}

/* ============================================================
   THE LIFECYCLE
   ============================================================ */

/** DRAFT → PENDING_APPROVAL. */
export async function submit(id, actor) {
  await assertCan(actor, 'purchase:write');
  const order = await load(id);
  assertTransition(order, 'PENDING_APPROVAL');
  await assertHasLines(order);

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
    });
    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor.id,
      summary: 'Submitted ' + order.orderNo + ' for approval.',
    });
  });

  return get(id);
}

/**
 * → APPROVED. The order may now be sent to the supplier.
 *
 * STILL NO STOCK MOVES. Approval commits the studio to buying;
 * it says nothing about anything having arrived.
 */
export async function approve(id, actor) {
  /* The one permission the brief names explicitly. It is separate
     from purchase:write because raising an order and committing
     the studio to it are different acts: the seed gives the store
     keeper the first and not the second. */
  await assertCan(actor, 'purchase:approve');

  const order = await load(id);
  assertTransition(order, 'APPROVED',
    order.status === 'APPROVED' ? 'It has already been approved.' : '');
  await assertHasLines(order);

  if (!order.supplier.isActive) {
    throw new ConflictError(
      order.supplier.name + ' is deactivated, so an order cannot be placed with them.',
    );
  }
  if (!order.warehouse.isActive) {
    throw new ConflictError(
      order.warehouse.name + ' is deactivated, so goods could not be booked in there.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
    });
    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'APPROVE',
      actorUserId: actor.id,
      summary: 'Approved ' + order.orderNo + ' (' + order.grandTotal + ' ' + order.currency
        + ') on ' + order.supplier.name + '. No stock has moved: goods are received '
        + 'against this order, not by it.',
    });
  });

  return get(id);
}

/** PENDING_APPROVAL → DRAFT, so it can be corrected. */
export async function returnToDraft(id, actor, reason) {
  await assertCan(actor, 'purchase:approve');
  const order = await load(id);
  assertTransition(order, 'DRAFT');

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'DRAFT', submittedAt: null } });
    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor.id,
      summary: 'Sent ' + order.orderNo + ' back to draft'
        + (reason ? ': ' + reason : '') + '.',
    });
  });

  return get(id);
}

/**
 * CANCEL — only while nothing has been received.
 *
 * THE RULE THAT MATTERS. Cancelling asserts the order never
 * happened. Once goods have come in against it that assertion is
 * false: there is stock on a shelf whose only explanation is this
 * order, and a cancelled order would leave it unexplained. Such an
 * order is CLOSED short instead, and the refusal says so.
 */
export async function cancel(id, actor, reason) {
  await assertCan(actor, 'purchase:write');
  const order = await load(id);

  const received = await receivedSoFar(id);
  if (received.anyReceipt) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' cannot be cancelled: '
      + received.postedReceipts + ' goods receipt(s) have already been posted against it, '
      + 'bringing in ' + fromMilli(received.totalMilli) + ' unit(s). That stock is on a shelf '
      + 'and this order is the only thing that explains it. Close the order short instead, '
      + 'with a reason.',
      {
        postedReceipts: received.postedReceipts,
        receivedQuantity: fromMilli(received.totalMilli),
        useInstead: 'close',
      },
    );
  }

  assertTransition(order, 'CANCELLED');

  if (!reason || !String(reason).trim()) {
    throw new ValidationError([{
      field: 'reason',
      message: 'Say why the order was cancelled. Somebody will ask.',
    }]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledById: actor.id,
        cancelledAt: new Date(),
        cancelReason: String(reason).trim(),
      },
    });
    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'CANCEL',
      actorUserId: actor.id,
      summary: 'Cancelled ' + order.orderNo + ' before any receipt: ' + String(reason).trim(),
    });
  });

  return get(id);
}

/**
 * CLOSE — the order is finished with, whatever arrived.
 *
 * The honest end for an order that was partly delivered and never
 * will be completed. Unlike cancelling it does not claim the order
 * never happened; it records that the studio has stopped waiting,
 * and why.
 */
export async function close(id, actor, reason) {
  await assertCan(actor, 'purchase:approve');
  const order = await load(id);
  assertTransition(order, 'CLOSED');

  if (!reason || !String(reason).trim()) {
    throw new ValidationError([{
      field: 'reason',
      message: 'Closing an order short needs a reason: "the supplier cannot supply" and '
        + '"we stopped waiting" are different facts about the same number.',
    }]);
  }

  const received = await receivedSoFar(id);

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedById: actor.id,
        closedAt: new Date(),
        closeReason: String(reason).trim(),
      },
    });
    await record(tx, {
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'CLOSE',
      actorUserId: actor.id,
      summary: 'Closed ' + order.orderNo + ' with ' + fromMilli(received.totalMilli)
        + ' of ' + fromMilli(received.orderedMilli) + ' received: ' + String(reason).trim(),
    });
  });

  return get(id);
}

/* ============================================================
   HELPERS SHARED WITH THE RECEIPT SERVICE
   ============================================================ */

/**
 * Recompute an order's status from its lines.
 *
 * Called by the receipt service inside its own transaction, so
 * the status and the quantities it is derived from are written
 * together and cannot disagree.
 *
 * Deliberately never moves an order OUT of a terminal state: a
 * receipt posted against a closed order must not quietly reopen
 * it.
 */
export async function refreshStatusFromLines(tx, orderId) {
  const order = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true, status: true,
      lines: { select: { quantity: true, receivedQuantity: true } },
    },
  });

  if (TERMINAL.includes(order.status)) return order.status;

  /* PER LINE, NOT ON THE TOTAL.
     Comparing summed quantities lets an over-receipt on one line
     cover a line that never arrived: order 100 of A and 40 of B,
     take 140 of A and nothing of B, and the totals match while B
     is still outstanding. An order is fully received only when
     every one of its lines is. Found by the smoke test doing
     exactly that. */
  const anyReceived = order.lines.some((l) => toMilli(l.receivedQuantity) > 0);
  const everyLineComplete = order.lines.length > 0 && order.lines.every(
    (l) => toMilli(l.receivedQuantity) >= toMilli(l.quantity),
  );

  const next = !anyReceived ? order.status
    : everyLineComplete ? 'FULLY_RECEIVED'
      : 'PARTIALLY_RECEIVED';

  if (next === order.status) return order.status;
  await tx.purchaseOrder.update({ where: { id: orderId }, data: { status: next } });
  return next;
}

async function load(id) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      id: true, orderNo: true, status: true, grandTotal: true, currency: true,
      supplier: { select: { id: true, name: true, isActive: true } },
      warehouse: { select: { id: true, name: true, isActive: true } },
      _count: { select: { lines: true } },
    },
  });
  if (!order) throw new NotFoundError('Purchase order');
  return order;
}

async function assertHasLines(order) {
  if ((order._count?.lines ?? 0) > 0) return;
  throw new ValidationError([{ field: 'lines', message: 'An order with no lines cannot be placed.' }]);
}

async function hasReceipts(orderId) {
  return (await prisma.goodsReceiptNote.count({
    where: { purchaseOrderId: orderId, status: 'POSTED' },
  })) > 0;
}

async function receivedSoFar(orderId) {
  const [lines, postedReceipts] = await Promise.all([
    prisma.purchaseOrderLine.findMany({
      where: { purchaseOrderId: orderId },
      select: { quantity: true, receivedQuantity: true },
    }),
    prisma.goodsReceiptNote.count({ where: { purchaseOrderId: orderId, status: 'POSTED' } }),
  ]);
  const totalMilli = lines.reduce((t, l) => t + toMilli(l.receivedQuantity), 0);
  const orderedMilli = lines.reduce((t, l) => t + toMilli(l.quantity), 0);
  return { totalMilli, orderedMilli, postedReceipts, anyReceipt: postedReceipts > 0 || totalMilli > 0 };
}

/* ============================================================
   VALIDATION AND PRICING OF A DRAFT
   ============================================================ */

async function validateDraft(input) {
  const fields = [];

  if (!input.supplierId) fields.push({ field: 'supplierId', message: 'Choose a supplier.' });
  if (!input.warehouseId) fields.push({ field: 'warehouseId', message: 'Choose the delivery warehouse.' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'An order needs at least one line.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const [supplier, warehouse] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: input.supplierId } }),
    prisma.warehouse.findUnique({ where: { id: input.warehouseId } }),
  ]);

  if (!supplier) fields.push({ field: 'supplierId', message: 'No such supplier.' });
  else if (!supplier.isActive) {
    fields.push({ field: 'supplierId', message: supplier.name + ' is deactivated.' });
  }
  if (!warehouse) fields.push({ field: 'warehouseId', message: 'No such warehouse.' });
  else if (!warehouse.isActive) {
    fields.push({ field: 'warehouseId', message: warehouse.name + ' is deactivated, so goods could not be received there.' });
  }
  if (fields.length) throw new ValidationError(fields);

  /* HOW GST APPLIES, decided once here and frozen on the order.
     If it cannot be decided the order is refused: there is no
     "assume intra-state" path, because that produces CGST and
     SGST on an inter-state purchase and nobody notices until an
     audit. */
  const gst = gstTreatmentFor({ supplier, warehouse });
  if (gst.error) throw new ValidationError([gst.error]);

  /* EVERY LINE MUST BE A REAL PRODUCT. The brief is explicit that
     a typed-in name must not create something unrelated, so lines
     are matched by productId against the Product Master and a
     name is never used to find or invent a product. */
  const productIds = [...new Set(input.lines.map((l) => l?.productId).filter(Boolean))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true, sku: true, name: true, uom: true, status: true, archivedAt: true,
      purchasePrice: true, hsnCode: true,
      category: { select: { hsnCode: true } },
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  const computed = [];

  input.lines.forEach((raw, i) => {
    const at = (field) => 'lines[' + i + '].' + field;

    if (!raw?.productId) {
      fields.push({ field: at('productId'), message: 'Line ' + (i + 1) + ' has no product. '
        + 'Pick one from the Product Master — a typed name cannot create a product here.' });
      return;
    }
    const product = byId.get(raw.productId);
    if (!product) {
      fields.push({ field: at('productId'), message: 'No such product.' });
      return;
    }
    if (product.archivedAt) {
      fields.push({ field: at('productId'), message: product.sku + ' is archived and cannot be ordered.' });
      return;
    }
    if (product.status === 'DISCONTINUED') {
      fields.push({
        field: at('productId'),
        message: product.sku + ' is discontinued. Reorder it only by bringing it back to '
          + 'active in the Product Master first.',
      });
      return;
    }

    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      fields.push({ field: at('quantity'), message: 'A quantity above zero is required.' });
      return;
    }

    const unitPrice = raw.unitPrice === undefined || raw.unitPrice === null || raw.unitPrice === ''
      ? product.purchasePrice
      : raw.unitPrice;
    if (unitPrice === null || unitPrice === undefined) {
      fields.push({
        field: at('unitPrice'),
        message: product.sku + ' has no purchase price on record, so the rate must be given.',
      });
      return;
    }
    if (Number(unitPrice) < 0) {
      fields.push({ field: at('unitPrice'), message: 'A rate cannot be negative.' });
      return;
    }

    /* THE TAX RATE IS SNAPSHOTTED. Taken from the line if given,
       otherwise from the product's HSN code, and then written onto
       the line so that changing the Product Master later cannot
       alter an order already placed. */
    const hsn = product.hsnCode ?? product.category?.hsnCode ?? null;
    const taxRate = raw.taxRate === undefined || raw.taxRate === null || raw.taxRate === ''
      ? gstRateForHsn(hsn)
      : Number(raw.taxRate);

    if (taxRate === null) {
      fields.push({
        field: at('taxRate'),
        message: product.sku + ' has no HSN code the system recognises, so its GST rate '
          + 'cannot be worked out. Enter the rate on the line.',
      });
      return;
    }
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      fields.push({ field: at('taxRate'), message: 'A GST rate is a percentage between 0 and 100.' });
      return;
    }

    let math;
    try {
      math = computeLine({
        quantity,
        unitPrice,
        discountPercent: raw.discountPercent ?? 0,
        discountAmount: raw.discountAmount,
        taxRate,
        treatment: gst.treatment,
      });
    } catch (err) {
      fields.push({ field: at('quantity'), message: err.message });
      return;
    }

    computed.push(math);
    lines.push({
      lineNo: lines.length + 1,
      productId: product.id,
      // Snapshots. What was ordered must still read the way it
      // read on the day, whatever the product is renamed to.
      skuAtOrder: product.sku,
      nameAtOrder: product.name,
      hsnAtOrder: hsn,
      description: raw.description ? String(raw.description).trim() : null,
      quantity: math.quantity,
      uom: raw.uom ?? product.uom,
      unitPrice: math.unitPrice,
      discountPercent: math.discountPercent,
      discountAmount: math.discountAmount,
      grossAmount: math.grossAmount,
      taxableValue: math.taxableValue,
      taxRate: math.taxRate,
      cgstAmount: math.cgstAmount,
      sgstAmount: math.sgstAmount,
      igstAmount: math.igstAmount,
      taxAmount: math.taxAmount,
      lineTotal: math.lineTotal,
      expectedDate: raw.expectedDate ? new Date(raw.expectedDate) : null,
    });
  });

  if (fields.length) throw new ValidationError(fields);

  const orderDate = input.orderDate ? new Date(input.orderDate) : new Date();
  const expectedDate = input.expectedDate ? new Date(input.expectedDate) : null;
  if (expectedDate && expectedDate < startOfDay(orderDate)) {
    throw new ValidationError([{
      field: 'expectedDate',
      message: 'The expected delivery date is before the order date.',
    }]);
  }

  return {
    supplier,
    warehouse,
    lines,
    head: {
      orderDate,
      expectedDate,
      billingAddress: text(input.billingAddress) ?? addressOf(warehouse),
      shippingAddress: text(input.shippingAddress) ?? addressOf(warehouse),
      paymentTerms: text(input.paymentTerms) ?? supplier.paymentTerms ?? null,
      notes: text(input.notes),
      currency: text(input.currency) ?? 'INR',
      gstTreatment: gst.treatment,
      supplierStateCode: gst.supplierStateCode ?? null,
      placeOfSupplyCode: gst.placeOfSupplyCode ?? null,
      totals: computeTotals(computed, { otherCharges: input.otherCharges ?? 0 }),
    },
  };
}

const text = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

function addressOf(warehouse) {
  return [warehouse.name, warehouse.addressLine, warehouse.city, warehouse.state, warehouse.postalCode]
    .filter(Boolean).join(', ') || null;
}

function startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

/* ── shaping ─────────────────────────────────────────────── */

function shapeHead(o) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    status: o.status,
    statusLabel: readable(o.status),
    orderDate: o.orderDate,
    expectedDate: o.expectedDate,
    supplier: o.supplier,
    warehouse: o.warehouse,
    billingAddress: o.billingAddress,
    shippingAddress: o.shippingAddress,
    paymentTerms: o.paymentTerms,
    notes: o.notes,
    gst: {
      treatment: o.gstTreatment,
      supplierStateCode: o.supplierStateCode,
      placeOfSupplyCode: o.placeOfSupplyCode,
    },
    totals: {
      subTotal: Number(o.subTotal),
      discountTotal: Number(o.discountTotal),
      taxableTotal: Number(o.taxableTotal),
      cgstTotal: Number(o.cgstTotal),
      sgstTotal: Number(o.sgstTotal),
      igstTotal: Number(o.igstTotal),
      taxTotal: Number(o.taxTotal),
      otherCharges: Number(o.otherCharges),
      grandTotal: Number(o.grandTotal),
    },
    currency: o.currency,
    lineCount: o._count?.lines ?? null,
    receiptCount: o._count?.receipts ?? null,
    invoiceCount: o._count?.invoices ?? null,
    createdBy: o.createdBy?.name ?? null,
    approvedBy: o.approvedBy?.name ?? null,
    cancelledBy: o.cancelledBy?.name ?? null,
    closedBy: o.closedBy?.name ?? null,
    submittedAt: o.submittedAt,
    approvedAt: o.approvedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    closedAt: o.closedAt,
    closeReason: o.closeReason,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function shapeLine(l) {
  const quantity = Number(l.quantity);
  const received = Number(l.receivedQuantity);
  return {
    id: l.id,
    lineNo: l.lineNo,
    productId: l.productId,
    sku: l.skuAtOrder,
    name: l.nameAtOrder,
    currentSku: l.product?.sku ?? null,
    hsnCode: l.hsnAtOrder,
    description: l.description,
    quantity,
    uom: l.uom,
    unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent),
    discountAmount: Number(l.discountAmount),
    grossAmount: Number(l.grossAmount),
    taxableValue: Number(l.taxableValue),
    taxRate: Number(l.taxRate),
    cgstAmount: Number(l.cgstAmount),
    sgstAmount: Number(l.sgstAmount),
    igstAmount: Number(l.igstAmount),
    taxAmount: Number(l.taxAmount),
    lineTotal: Number(l.lineTotal),
    receivedQuantity: received,
    rejectedQuantity: Number(l.rejectedQuantity),
    outstandingQuantity: Math.max(0, quantity - received),
    expectedDate: l.expectedDate,
  };
}
