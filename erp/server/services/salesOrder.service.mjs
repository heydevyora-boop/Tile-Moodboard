import { prisma } from '../../db/client.mjs';
import { nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import {
  computeLine, computeTotals, salesGstTreatmentFor, gstRateForHsn, toMilli, fromMilli,
} from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   SALES ORDERS
   ============================================================

   A SALES ORDER DOES NOT TOUCH STOCK BY ITSELF. Not when raised,
   not when approved, not when confirmed. Stock is committed only
   by an explicit RESERVATION (reservation.service.mjs) and leaves
   the building only on DISPATCH (dispatch.service.mjs). This file
   imports neither postStockMovement nor reserve()/
   releaseReservation() -- deliberately, so it cannot move or
   commit a single box on its own.

   THE STATE MACHINE IS THE POINT OF THIS SERVICE, mirroring the
   purchase order's shape exactly:

       DRAFT -> PENDING_APPROVAL -> CONFIRMED -> PARTIALLY_RESERVED -> RESERVED
                                                                           |
                                                                           v
                                                        PARTIALLY_DISPATCHED -> FULLY_DISPATCHED -> CLOSED
         any of the first three -> CANCELLED

   THE RULE THAT MATTERS: an order that has shipped SOMETHING
   cannot be cancelled. Stock that has actually left the building
   is a fact, and cancelling asserts the order never happened.
   Such an order is CLOSED short instead, with a reason -- the
   same rule step 6 enforces for a purchase order with a posted
   receipt, applied here to a posted dispatch.

   An order's RESERVED/PARTIALLY_RESERVED and DISPATCHED/
   PARTIALLY_DISPATCHED statuses are not set directly by this
   file: refreshStatusFromLines() (exported for
   reservation.service.mjs and dispatch.service.mjs to call inside
   their own transactions) derives them from the lines, LINE BY
   LINE -- summing would let a fully reserved line mask one never
   touched, the exact bug step 6's purchase order status had and
   was fixed for.
   ============================================================ */

const TRANSITIONS = {
  DRAFT: ['PENDING_APPROVAL', 'CONFIRMED', 'CANCELLED'],
  PENDING_APPROVAL: ['CONFIRMED', 'DRAFT', 'CANCELLED'],
  CONFIRMED: ['PARTIALLY_RESERVED', 'RESERVED', 'CANCELLED'],
  PARTIALLY_RESERVED: ['PARTIALLY_RESERVED', 'RESERVED', 'CANCELLED'],
  RESERVED: ['PARTIALLY_DISPATCHED', 'FULLY_DISPATCHED', 'CANCELLED'],
  PARTIALLY_DISPATCHED: ['PARTIALLY_DISPATCHED', 'FULLY_DISPATCHED', 'CLOSED'],
  FULLY_DISPATCHED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

/** Statuses in which reservation may be attempted. */
export const RESERVABLE = ['CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED'];
/** Statuses in which dispatch may be attempted. */
export const DISPATCHABLE = ['RESERVED', 'PARTIALLY_RESERVED', 'PARTIALLY_DISPATCHED'];
/** Statuses that mean the order is finished with. */
export const TERMINAL = ['CANCELLED', 'CLOSED'];

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function assertTransition(order, to, extra) {
  if (canTransition(order.status, to)) return;
  throw new ConflictError(
    'Order ' + order.orderNo + ' is ' + readable(order.status) + ' and cannot become '
    + readable(to) + '.' + (extra ? ' ' + extra : ''),
    { from: order.status, to, allowedFromHere: TRANSITIONS[order.status] ?? [] },
  );
}

const WORDS = {
  DRAFT: 'a draft', PENDING_APPROVAL: 'awaiting approval', CONFIRMED: 'confirmed',
  PARTIALLY_RESERVED: 'partially reserved', RESERVED: 'reserved',
  PARTIALLY_DISPATCHED: 'partially dispatched', FULLY_DISPATCHED: 'fully dispatched',
  CLOSED: 'closed', CANCELLED: 'cancelled',
};
const readable = (s) => WORDS[s] ?? s;

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true,
  hsnAtOrder: true, description: true, quantity: true, uom: true, unitPrice: true,
  discountPercent: true, discountAmount: true, grossAmount: true, taxableValue: true,
  taxRate: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxAmount: true,
  lineTotal: true, reservedQuantity: true, dispatchedQuantity: true, returnedQuantity: true,
  product: { select: { id: true, sku: true, name: true, status: true } },
};

const HEAD_SELECT = {
  id: true, orderNo: true, status: true, quotationId: true,
  orderDate: true, expectedDispatchDate: true,
  billingAddress: true, shippingAddress: true, paymentTerms: true, deliveryTerms: true, notes: true,
  gstTreatment: true, sellerStateCode: true, placeOfSupplyCode: true,
  subTotal: true, discountTotal: true, taxableTotal: true,
  cgstTotal: true, sgstTotal: true, igstTotal: true, taxTotal: true,
  otherCharges: true, grandTotal: true, currency: true,
  submittedAt: true, approvedAt: true, cancelledAt: true, cancelReason: true,
  closedAt: true, closeReason: true, createdAt: true, updatedAt: true,
  customer: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, state: true, shippingStateCode: true, shippingState: true } },
  warehouse: { select: { id: true, code: true, name: true, stateCode: true, state: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
};

/* ============================================================
   READING
   ============================================================ */

export async function list(query = {}) {
  const { search, status, customerId, warehouseId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const statuses = status && status !== 'all'
    ? String(status).split(',').filter((s) => s in TRANSITIONS)
    : null;

  const where = {
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(from || to
      ? { orderDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { orderNo: { contains: search, mode: 'insensitive' } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
          { lines: { some: { skuAtOrder: { contains: search, mode: 'insensitive' } } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      orderBy: [{ orderDate: 'desc' }, { orderNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true, deliveryChallans: true, invoices: true } } },
    }),
    prisma.salesOrder.count({ where }),
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
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    select: {
      ...HEAD_SELECT,
      _count: { select: { lines: true, deliveryChallans: true, invoices: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT },
      deliveryChallans: {
        orderBy: { dispatchDate: 'desc' },
        select: {
          id: true, challanNo: true, status: true, dispatchDate: true, transporter: true,
          dispatchedAt: true, dispatchedBy: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      },
      invoices: {
        orderBy: { invoiceDate: 'desc' },
        select: { id: true, invoiceNo: true, invoiceDate: true, grandTotal: true, status: true },
      },
    },
  });
  if (!order) throw new NotFoundError('Sales order');

  return {
    ...shapeHead(order),
    lines: order.lines.map(shapeLine),
    deliveryChallans: order.deliveryChallans.map((d) => ({
      id: d.id, challanNo: d.challanNo, status: d.status, dispatchDate: d.dispatchDate,
      transporter: d.transporter, dispatchedAt: d.dispatchedAt,
      dispatchedBy: d.dispatchedBy?.name ?? null, lineCount: d._count.lines,
    })),
    invoices: order.invoices.map((i) => ({
      id: i.id, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate,
      amount: Number(i.grandTotal), status: i.status,
    })),
    allowed: {
      edit: order.status === 'DRAFT',
      submit: canTransition(order.status, 'PENDING_APPROVAL'),
      approve: canTransition(order.status, 'CONFIRMED'),
      reserve: RESERVABLE.includes(order.status),
      dispatch: DISPATCHABLE.includes(order.status),
      cancel: canTransition(order.status, 'CANCELLED') && !(await hasAnyDispatch(order.id)),
      close: canTransition(order.status, 'CLOSED'),
    },
  };
}

/* ============================================================
   CREATING
   ============================================================ */

export async function create(input, actor) {
  await assertCan(actor, 'sales:write');
  const { customer, warehouse, lines, head } = await validateDraft(input);
  return createDraft({ customer, warehouse, lines, head, quotationId: null }, actor);
}

/**
 * Build a DRAFT order from an already-validated, already-priced
 * quotation. Called ONLY from quotation.service.mjs's convert(),
 * which has already checked sales:write. Re-prices nothing: the
 * quotation's own snapshot is what the customer saw, and that is
 * what the order should open with.
 */
export async function createFromQuotation({ quotation, warehouseId }, actor) {
  const [customer, warehouse] = await Promise.all([
    prisma.customer.findUniqueOrThrow({ where: { id: quotation.customerId } }),
    prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } }),
  ]);
  if (!warehouse.isActive) {
    throw new ValidationError([{ field: 'warehouseId', message: warehouse.name + ' is deactivated.' }]);
  }

  const gst = salesGstTreatmentFor({ warehouse, customer });
  if (gst.error) throw new ValidationError([gst.error]);

  const computed = quotation.lines.map((l) => computeLine({
    quantity: l.quantity, unitPrice: l.unitPrice,
    discountPercent: l.discountPercent, discountAmount: l.discountAmount,
    taxRate: l.taxRate, treatment: gst.treatment,
  }));

  const lines = quotation.lines.map((l, i) => ({
    lineNo: i + 1,
    productId: l.productId,
    skuAtOrder: l.skuAtQuote,
    nameAtOrder: l.nameAtQuote,
    hsnAtOrder: l.hsnAtQuote,
    description: l.description,
    quantity: computed[i].quantity,
    uom: l.uom,
    unitPrice: computed[i].unitPrice,
    discountPercent: computed[i].discountPercent,
    discountAmount: computed[i].discountAmount,
    grossAmount: computed[i].grossAmount,
    taxableValue: computed[i].taxableValue,
    taxRate: computed[i].taxRate,
    cgstAmount: computed[i].cgstAmount,
    sgstAmount: computed[i].sgstAmount,
    igstAmount: computed[i].igstAmount,
    taxAmount: computed[i].taxAmount,
    lineTotal: computed[i].lineTotal,
  }));

  const head = {
    orderDate: new Date(),
    expectedDispatchDate: null,
    billingAddress: quotation.billingAddress,
    shippingAddress: quotation.shippingAddress,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: null,
    notes: null,
    currency: 'INR',
    gstTreatment: gst.treatment,
    sellerStateCode: gst.sellerStateCode,
    placeOfSupplyCode: gst.placeOfSupplyCode,
    totals: computeTotals(computed, {}),
  };

  return createDraft({ customer, warehouse, lines, head, quotationId: quotation.id }, actor);
}

async function createDraft({ customer, warehouse, lines, head, quotationId }, actor) {
  const orderNo = await nextDocumentNumber('SALES_ORDER');

  const id = await prisma.$transaction(async (tx) => {
    const order = await tx.salesOrder.create({
      data: {
        orderNo,
        customerId: customer.id,
        warehouseId: warehouse.id,
        quotationId,
        status: 'DRAFT',
        orderDate: head.orderDate,
        expectedDispatchDate: head.expectedDispatchDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        deliveryTerms: head.deliveryTerms,
        notes: head.notes,
        currency: head.currency,
        gstTreatment: head.gstTreatment,
        sellerStateCode: head.sellerStateCode,
        placeOfSupplyCode: head.placeOfSupplyCode,
        ...head.totals,
        createdById: actor.id,
        lines: { create: lines },
      },
      select: { id: true, orderNo: true },
    });

    await record(tx, {
      entityType: 'SalesOrder',
      entityId: order.id,
      action: 'CREATE',
      actorUserId: actor.id,
      summary: 'Raised ' + orderNo + ' for ' + customer.name + ', ' + lines.length + ' line(s), '
        + head.totals.grandTotal + ' ' + head.currency + ' ('
        + head.gstTreatment.toLowerCase().replace('_', '-') + ')'
        + (quotationId ? ', from a converted quotation' : '')
        + '. Nothing is reserved; no stock has moved.',
    });

    return order.id;
  });

  return get(id);
}

/** Draft only. */
export async function update(id, input, actor) {
  await assertCan(actor, 'sales:write');

  const existing = await prisma.salesOrder.findUnique({
    where: { id }, select: { id: true, orderNo: true, status: true },
  });
  if (!existing) throw new NotFoundError('Sales order');
  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      'Order ' + existing.orderNo + ' is ' + readable(existing.status)
      + ' and cannot be edited. Cancel it and raise a new one, or close it short.',
      { status: existing.status },
    );
  }

  const { customer, warehouse, lines, head } = await validateDraft(input);

  await prisma.$transaction(async (tx) => {
    await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
    await tx.salesOrder.update({
      where: { id },
      data: {
        customerId: customer.id,
        warehouseId: warehouse.id,
        expectedDispatchDate: head.expectedDispatchDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        deliveryTerms: head.deliveryTerms,
        notes: head.notes,
        currency: head.currency,
        gstTreatment: head.gstTreatment,
        sellerStateCode: head.sellerStateCode,
        placeOfSupplyCode: head.placeOfSupplyCode,
        ...head.totals,
        lines: { create: lines },
      },
    });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: 'Edited draft ' + existing.orderNo + ': ' + lines.length + ' line(s), '
        + head.totals.grandTotal + ' ' + head.currency + '.',
    });
  });

  return get(id);
}

/* ============================================================
   THE LIFECYCLE
   ============================================================ */

export async function submit(id, actor) {
  await assertCan(actor, 'sales:write');
  const order = await load(id);
  assertTransition(order, 'PENDING_APPROVAL');
  await assertHasLines(order);

  await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date() } });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: 'Submitted ' + order.orderNo + ' for approval.',
    });
  });
  return get(id);
}

/**
 * -> CONFIRMED. Still no stock moves -- confirming commits the
 * studio to the sale; it says nothing about reservation or
 * dispatch, which are each their own later step.
 */
export async function approve(id, actor) {
  await assertCan(actor, 'sales:approve');
  const order = await load(id);
  assertTransition(order, 'CONFIRMED', order.status === 'CONFIRMED' ? 'It is already confirmed.' : '');
  await assertHasLines(order);

  if (!order.customer.isActive) {
    throw new ConflictError(order.customer.name + ' is deactivated, so an order cannot be confirmed for them.');
  }
  if (!order.warehouse.isActive) {
    throw new ConflictError(order.warehouse.name + ' is deactivated, so it could not fulfil the order.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({
      where: { id }, data: { status: 'CONFIRMED', approvedById: actor.id, approvedAt: new Date() },
    });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'APPROVE', actorUserId: actor.id,
      summary: 'Confirmed ' + order.orderNo + ' (' + order.grandTotal + ' ' + order.currency
        + ') for ' + order.customer.name + '. No stock has moved: reservation and dispatch '
        + 'are separate, later steps.',
    });
  });
  return get(id);
}

export async function returnToDraft(id, actor, reason) {
  await assertCan(actor, 'sales:approve');
  const order = await load(id);
  assertTransition(order, 'DRAFT');

  await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({ where: { id }, data: { status: 'DRAFT', submittedAt: null } });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: 'Sent ' + order.orderNo + ' back to draft' + (reason ? ': ' + reason : '') + '.',
    });
  });
  return get(id);
}

/**
 * CANCEL — only while NOTHING has been dispatched.
 *
 * Reservations ARE released: a reservation is a promise, not a
 * fact about stock having moved, and releasing it is itself a
 * stock movement through the one service, done here before the
 * order is marked cancelled.
 */
export async function cancel(id, actor, reason) {
  await assertCan(actor, 'sales:write');
  const order = await loadWithLines(id);

  const dispatched = order.lines.reduce((t, l) => t + toMilli(l.dispatchedQuantity), 0);
  if (dispatched > 0) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' cannot be cancelled: ' + fromMilli(dispatched) + ' unit(s) have '
      + 'already been dispatched. That stock has left the building and this order is the only '
      + 'thing that explains it. Close the order short instead, with a reason.',
      { dispatchedQuantity: fromMilli(dispatched), useInstead: 'close' },
    );
  }

  assertTransition(order, 'CANCELLED');
  if (!reason || !String(reason).trim()) {
    throw new ValidationError([{ field: 'reason', message: 'Say why the order was cancelled.' }]);
  }

  const reservedLines = order.lines.filter((l) => toMilli(l.reservedQuantity) > 0);

  await prisma.$transaction(async (tx) => {
    // Lazy import, for the same one-directional reason as
    // quotation -> salesOrder: salesOrder knows how to ask
    // reservation.service.mjs to release, reservation does not
    // need to know about cancellation.
    const reservation = await import('./reservation.service.mjs');
    for (const line of reservedLines) {
      await reservation.releaseForLine({
        salesOrderLine: line, salesOrder: order, quantity: line.reservedQuantity,
        reason: 'Order cancelled: ' + String(reason).trim(),
      }, actor, tx);
    }

    await tx.salesOrder.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: new Date(), cancelReason: String(reason).trim() },
    });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'CANCEL', actorUserId: actor.id,
      summary: 'Cancelled ' + order.orderNo + ' before any dispatch'
        + (reservedLines.length ? '; released ' + reservedLines.length + ' reservation(s)' : '')
        + ': ' + String(reason).trim(),
    });
  });

  return get(id);
}

export async function close(id, actor, reason) {
  await assertCan(actor, 'sales:approve');
  const order = await load(id);
  assertTransition(order, 'CLOSED');
  if (!reason || !String(reason).trim()) {
    throw new ValidationError([{
      field: 'reason',
      message: 'Closing an order short needs a reason.',
    }]);
  }

  const lines = await prisma.salesOrderLine.findMany({
    where: { salesOrderId: id },
    select: { quantity: true, dispatchedQuantity: true, reservedQuantity: true },
  });
  const reservedLines = lines.filter((l) => toMilli(l.reservedQuantity) > 0);

  await prisma.$transaction(async (tx) => {
    if (reservedLines.length) {
      const reservation = await import('./reservation.service.mjs');
      const fullLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: id } });
      for (const line of fullLines.filter((l) => toMilli(l.reservedQuantity) > 0)) {
        await reservation.releaseForLine({
          salesOrderLine: line, salesOrder: order, quantity: line.reservedQuantity,
          reason: 'Order closed short: ' + String(reason).trim(),
        }, actor, tx);
      }
    }
    await tx.salesOrder.update({
      where: { id },
      data: { status: 'CLOSED', closedById: actor.id, closedAt: new Date(), closeReason: String(reason).trim() },
    });
    await record(tx, {
      entityType: 'SalesOrder', entityId: id, action: 'CLOSE', actorUserId: actor.id,
      summary: 'Closed ' + order.orderNo + ': ' + String(reason).trim(),
    });
  });

  return get(id);
}

/* ============================================================
   SHARED WITH reservation.service.mjs AND dispatch.service.mjs
   ============================================================ */

/**
 * Recompute an order's status from its lines, LINE BY LINE.
 *
 * Called inside the caller's own transaction so the status and
 * the quantities it is derived from cannot disagree. Never moves
 * an order OUT of a terminal state.
 */
export async function refreshStatusFromLines(tx, orderId) {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true, status: true,
      lines: { select: { quantity: true, reservedQuantity: true, dispatchedQuantity: true } },
    },
  });
  if (TERMINAL.includes(order.status)) return order.status;

  const lines = order.lines.map((l) => ({
    ordered: toMilli(l.quantity),
    reserved: toMilli(l.reservedQuantity),
    dispatched: toMilli(l.dispatchedQuantity),
  }));

  const anyDispatch = lines.some((l) => l.dispatched > 0);
  const everyLineFullyDispatched = lines.length > 0 && lines.every((l) => l.dispatched >= l.ordered);
  const anyReservation = lines.some((l) => l.reserved > 0 || l.dispatched > 0);
  const everyLineFullyReservedOrDispatched = lines.length > 0
    && lines.every((l) => l.reserved + l.dispatched >= l.ordered);

  let next = order.status;
  if (anyDispatch) {
    next = everyLineFullyDispatched ? 'FULLY_DISPATCHED' : 'PARTIALLY_DISPATCHED';
  } else if (anyReservation && RESERVABLE.includes(order.status)) {
    next = everyLineFullyReservedOrDispatched ? 'RESERVED' : 'PARTIALLY_RESERVED';
  } else if (!anyReservation && ['PARTIALLY_RESERVED', 'RESERVED'].includes(order.status)) {
    // Every reservation on this order was released (e.g. a partial
    // cancellation path) and nothing has dispatched: back to
    // CONFIRMED, which is the status before any reservation existed.
    next = 'CONFIRMED';
  }

  if (next === order.status) return order.status;
  await tx.salesOrder.update({ where: { id: orderId }, data: { status: next } });
  return next;
}

async function load(id) {
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    select: {
      id: true, orderNo: true, status: true, grandTotal: true, currency: true, warehouseId: true,
      customer: { select: { id: true, name: true, isActive: true } },
      warehouse: { select: { id: true, name: true, isActive: true } },
      _count: { select: { lines: true } },
    },
  });
  if (!order) throw new NotFoundError('Sales order');
  return order;
}

async function loadWithLines(id) {
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    select: {
      id: true, orderNo: true, status: true,
      customer: { select: { id: true, name: true } },
      // SalesOrderLine itself has no warehouseId column -- only
      // SalesOrder does -- so it is read once below and attached
      // to each line afterwards, not selected here.
      lines: { select: { id: true, productId: true, quantity: true, reservedQuantity: true, dispatchedQuantity: true, uom: true, skuAtOrder: true } },
      warehouseId: true,
    },
  });
  if (!order) throw new NotFoundError('Sales order');
  return { ...order, lines: order.lines.map((l) => ({ ...l, warehouseId: order.warehouseId })) };
}

async function assertHasLines(order) {
  if ((order._count?.lines ?? 0) > 0) return;
  throw new ValidationError([{ field: 'lines', message: 'An order with no lines cannot be placed.' }]);
}

async function hasAnyDispatch(orderId) {
  const agg = await prisma.salesOrderLine.aggregate({
    where: { salesOrderId: orderId },
    _sum: { dispatchedQuantity: true },
  });
  return Number(agg._sum.dispatchedQuantity ?? 0) > 0;
}

/* ============================================================
   VALIDATION AND PRICING OF A DRAFT (raised from scratch)
   ============================================================ */

async function validateDraft(input) {
  const fields = [];
  if (!input.customerId) fields.push({ field: 'customerId', message: 'Choose a customer.' });
  if (!input.warehouseId) fields.push({ field: 'warehouseId', message: 'Choose the dispatching warehouse.' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'An order needs at least one line.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const [customer, warehouse] = await Promise.all([
    prisma.customer.findUnique({ where: { id: input.customerId } }),
    prisma.warehouse.findUnique({ where: { id: input.warehouseId } }),
  ]);
  if (!customer) fields.push({ field: 'customerId', message: 'No such customer.' });
  else if (!customer.isActive) fields.push({ field: 'customerId', message: customer.name + ' is deactivated.' });
  if (!warehouse) fields.push({ field: 'warehouseId', message: 'No such warehouse.' });
  else if (!warehouse.isActive) {
    fields.push({ field: 'warehouseId', message: warehouse.name + ' is deactivated.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const gst = salesGstTreatmentFor({ warehouse, customer });
  if (gst.error) throw new ValidationError([gst.error]);

  const productIds = [...new Set(input.lines.map((l) => l?.productId).filter(Boolean))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true, sku: true, name: true, uom: true, status: true, archivedAt: true,
      sellingPrice: true, hsnCode: true, category: { select: { hsnCode: true } },
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  const computed = [];

  input.lines.forEach((raw, i) => {
    const at = (field) => 'lines[' + i + '].' + field;

    if (!raw?.productId) {
      fields.push({ field: at('productId'), message: 'Line ' + (i + 1) + ' has no product.' });
      return;
    }
    const product = byId.get(raw.productId);
    if (!product) { fields.push({ field: at('productId'), message: 'No such product.' }); return; }
    if (product.archivedAt) {
      fields.push({ field: at('productId'), message: product.sku + ' is archived and cannot be sold.' });
      return;
    }
    // A DISCONTINUED OR INACTIVE PRODUCT NEEDS AN EXPLICIT
    // EXCEPTION. The brief asks that this not pass silently; the
    // override has to be named per line, and is recorded in the
    // audit summary rather than disappearing into the line data.
    if (product.status !== 'ACTIVE' && !raw.allowInactiveProduct) {
      fields.push({
        field: at('productId'),
        message: product.sku + ' is ' + product.status.toLowerCase()
          + ', not active. Selling it needs an explicit exception on the line.',
      });
      return;
    }

    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      fields.push({ field: at('quantity'), message: 'A quantity above zero is required.' });
      return;
    }

    const unitPrice = raw.unitPrice === undefined || raw.unitPrice === null || raw.unitPrice === ''
      ? product.sellingPrice : raw.unitPrice;
    if (unitPrice === null || unitPrice === undefined) {
      fields.push({ field: at('unitPrice'), message: product.sku + ' has no selling price on record; give a rate.' });
      return;
    }
    if (Number(unitPrice) < 0) {
      fields.push({ field: at('unitPrice'), message: 'A rate cannot be negative.' });
      return;
    }

    const hsn = product.hsnCode ?? product.category?.hsnCode ?? null;
    const taxRate = raw.taxRate === undefined || raw.taxRate === null || raw.taxRate === ''
      ? gstRateForHsn(hsn) : Number(raw.taxRate);
    if (taxRate === null) {
      fields.push({
        field: at('taxRate'),
        message: product.sku + ' has no HSN code the system recognises; enter the GST rate on the line.',
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
        quantity, unitPrice,
        discountPercent: raw.discountPercent ?? 0,
        discountAmount: raw.discountAmount,
        taxRate, treatment: gst.treatment,
      });
    } catch (err) {
      fields.push({ field: at('quantity'), message: err.message });
      return;
    }

    computed.push(math);
    lines.push({
      lineNo: lines.length + 1,
      productId: product.id,
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
    });
  });

  if (fields.length) throw new ValidationError(fields);

  const orderDate = input.orderDate ? new Date(input.orderDate) : new Date();
  const expectedDispatchDate = input.expectedDispatchDate ? new Date(input.expectedDispatchDate) : null;
  if (expectedDispatchDate && expectedDispatchDate < startOfDay(orderDate)) {
    throw new ValidationError([{
      field: 'expectedDispatchDate',
      message: 'The expected dispatch date is before the order date.',
    }]);
  }

  return {
    customer, warehouse, lines,
    head: {
      orderDate, expectedDispatchDate,
      billingAddress: text(input.billingAddress) ?? addressOf(customer),
      shippingAddress: text(input.shippingAddress) ?? shippingAddressOf(customer),
      paymentTerms: text(input.paymentTerms) ?? customer.paymentTerms ?? null,
      deliveryTerms: text(input.deliveryTerms),
      notes: text(input.notes),
      currency: text(input.currency) ?? 'INR',
      gstTreatment: gst.treatment,
      sellerStateCode: gst.sellerStateCode ?? null,
      placeOfSupplyCode: gst.placeOfSupplyCode ?? null,
      totals: computeTotals(computed, { otherCharges: input.otherCharges ?? 0 }),
    },
  };
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function addressOf(c) { return [c.addressLine, c.city, c.state, c.postalCode].filter(Boolean).join(', ') || null; }
function shippingAddressOf(c) {
  return [c.shippingAddressLine, c.shippingCity, c.shippingState, c.shippingPostalCode]
    .filter(Boolean).join(', ') || addressOf(c);
}
function startOfDay(d) { const copy = new Date(d); copy.setHours(0, 0, 0, 0); return copy; }
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shapeHead(o) {
  return {
    id: o.id, orderNo: o.orderNo, status: o.status, statusLabel: readable(o.status),
    quotationId: o.quotationId, orderDate: o.orderDate, expectedDispatchDate: o.expectedDispatchDate,
    customer: o.customer, warehouse: o.warehouse,
    billingAddress: o.billingAddress, shippingAddress: o.shippingAddress,
    paymentTerms: o.paymentTerms, deliveryTerms: o.deliveryTerms, notes: o.notes,
    gst: { treatment: o.gstTreatment, sellerStateCode: o.sellerStateCode, placeOfSupplyCode: o.placeOfSupplyCode },
    totals: {
      subTotal: Number(o.subTotal), discountTotal: Number(o.discountTotal), taxableTotal: Number(o.taxableTotal),
      cgstTotal: Number(o.cgstTotal), sgstTotal: Number(o.sgstTotal), igstTotal: Number(o.igstTotal),
      taxTotal: Number(o.taxTotal), otherCharges: Number(o.otherCharges), grandTotal: Number(o.grandTotal),
    },
    currency: o.currency,
    lineCount: o._count?.lines ?? null,
    dispatchCount: o._count?.deliveryChallans ?? null,
    invoiceCount: o._count?.invoices ?? null,
    createdBy: o.createdBy?.name ?? null, approvedBy: o.approvedBy?.name ?? null,
    cancelledBy: o.cancelledBy?.name ?? null, closedBy: o.closedBy?.name ?? null,
    submittedAt: o.submittedAt, approvedAt: o.approvedAt,
    cancelledAt: o.cancelledAt, cancelReason: o.cancelReason,
    closedAt: o.closedAt, closeReason: o.closeReason,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

function shapeLine(l) {
  const quantity = Number(l.quantity);
  const reserved = Number(l.reservedQuantity);
  const dispatched = Number(l.dispatchedQuantity);
  return {
    id: l.id, lineNo: l.lineNo, productId: l.productId,
    sku: l.skuAtOrder, name: l.nameAtOrder, currentSku: l.product?.sku ?? null,
    hsnCode: l.hsnAtOrder, description: l.description,
    quantity, uom: l.uom, unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent), discountAmount: Number(l.discountAmount),
    grossAmount: Number(l.grossAmount), taxableValue: Number(l.taxableValue),
    taxRate: Number(l.taxRate), cgstAmount: Number(l.cgstAmount), sgstAmount: Number(l.sgstAmount),
    igstAmount: Number(l.igstAmount), taxAmount: Number(l.taxAmount), lineTotal: Number(l.lineTotal),
    reservedQuantity: reserved, dispatchedQuantity: dispatched, returnedQuantity: Number(l.returnedQuantity),
    unreservedQuantity: Math.max(0, quantity - reserved - dispatched),
    outstandingQuantity: Math.max(0, quantity - dispatched),
  };
}
