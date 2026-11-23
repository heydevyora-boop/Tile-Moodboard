import { prisma } from '../../db/client.mjs';
import { nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { computeLine, computeTotals, salesGstTreatmentFor, toMilli, fromMilli } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   SALES INVOICES — THE CLAIM AGAINST THE CUSTOMER
   ============================================================

   CREATING AN INVOICE MOVES NO STOCK. This file never imports
   postStockMovement. The brief is explicit that the two must be
   decoupled, and the chosen stock-moving event is the delivery
   challan (dispatch.service.mjs) -- documented there, and kept
   true here by omission: there is nothing in this file capable
   of touching a stock balance.

   AN INVOICE IS ITS OWN PRICE AND TAX SNAPSHOT, taken from the
   SALES ORDER LINE at the moment the invoice is raised -- not
   re-read from today's Product Master. If a price changes in the
   Product Master next month, every invoice already raised still
   reads exactly as it did the day it was posted. The sales order
   line itself froze the price when the order was placed (or, for
   an order converted from a quotation, when the quotation froze
   it); this file inherits that freeze rather than repeating it.

   PARTIAL AND MULTIPLE INVOICES PER ORDER are supported because
   nothing here demands a line be invoiced all at once. What
   remains invoiceable on a line is ordered quantity less what
   every earlier, non-cancelled invoice against this same order
   already claimed for that product -- computed fresh each time,
   the same shape as a purchase return's eligibility check,
   because no running "invoicedQuantity" column was added to
   SalesOrderLine: it did not need one to stay correct, and adding
   one would have been a second source of truth for a number this
   query already answers exactntly.

   GST IS DECIDED FRESH ON THIS DOCUMENT, the same way a purchase
   order decides its own GST rather than borrowing another
   document's: sellerStateCode is the invoicing warehouse, place
   of supply is the customer's shipping state, through the same
   salesGstTreatmentFor() used everywhere else on the sales side.
   In the ordinary case this agrees with the sales order's own
   gstTreatment; it is not assumed to, because a customer's
   address can be corrected between order and invoice and the
   invoice must reflect the truth on the day it is raised.
   ============================================================ */

const TRANSITIONS = { DRAFT: ['POSTED', 'CANCELLED'], POSTED: ['CANCELLED'], CANCELLED: [] };
export function canTransition(from, to) { return (TRANSITIONS[from] ?? []).includes(to); }

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtInvoice: true, nameAtInvoice: true, hsnAtInvoice: true,
  quantity: true, uom: true, unitPrice: true, discountPercent: true, discountAmount: true,
  grossAmount: true, taxableValue: true, taxRate: true,
  cgstAmount: true, sgstAmount: true, igstAmount: true, taxAmount: true, lineTotal: true,
};

const HEAD_SELECT = {
  id: true, invoiceNo: true, status: true, invoiceDate: true, dueDate: true,
  billingAddress: true, shippingAddress: true, paymentTerms: true, notes: true,
  gstTreatment: true, sellerStateCode: true, placeOfSupplyCode: true,
  subTotal: true, discountTotal: true, taxableTotal: true,
  cgstTotal: true, sgstTotal: true, igstTotal: true, taxTotal: true,
  otherCharges: true, grandTotal: true, currency: true,
  postedAt: true, cancelledAt: true, cancelReason: true, createdAt: true, updatedAt: true,
  customer: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, creditPeriodDays: true } },
  salesOrder: { select: { id: true, orderNo: true, status: true } },
  warehouse: { select: { id: true, code: true, name: true, stateCode: true } },
  createdBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
};

/* ============================================================
   READING
   ============================================================ */

export async function list(query = {}) {
  const { search, status, customerId, salesOrderId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(salesOrderId ? { salesOrderId } : {}),
    ...(from || to
      ? { invoiceDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { invoiceNo: { contains: search, mode: 'insensitive' } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
          { salesOrder: { orderNo: { contains: search, mode: 'insensitive' } } },
        ],
      }
      : {}),
  };

  const [rows, total, outstanding] = await Promise.all([
    prisma.salesInvoice.findMany({ where, orderBy: [{ invoiceDate: 'desc' }], skip, take, select: HEAD_SELECT }),
    prisma.salesInvoice.count({ where }),
    prisma.salesInvoice.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { grandTotal: true }, _count: { _all: true } }),
  ]);

  const paid = await paidAmountByInvoice(rows.map((r) => r.id));

  return {
    rows: rows.map((r) => shape(r, paid.get(r.id) ?? 0)),
    summary: { postedInvoices: outstanding._count._all, postedValue: Number(outstanding._sum.grandTotal ?? 0) },
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const invoice = await prisma.salesInvoice.findUnique({
    where: { id },
    select: { ...HEAD_SELECT, lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT } },
  });
  if (!invoice) throw new NotFoundError('Sales invoice');
  const paid = await paidAmountByInvoice([id]);
  return { ...shape(invoice, paid.get(id) ?? 0), lines: invoice.lines.map(shapeLine) };
}

async function paidAmountByInvoice(invoiceIds) {
  if (invoiceIds.length === 0) return new Map();
  const rows = await prisma.customerPayment.groupBy({
    by: ['salesInvoiceId'], where: { salesInvoiceId: { in: invoiceIds } }, _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.salesInvoiceId, Number(r._sum.amount ?? 0)]));
}

/** What remains invoiceable on an order, line by line -- what an invoice form opens on. */
export async function invoiceableLines(salesOrderId) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true, orderNo: true, status: true, currency: true,
      customer: { select: { id: true, code: true, name: true } },
      warehouse: { select: { id: true, code: true, name: true, isActive: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: LINE_FROM_ORDER },
    },
  });
  if (!order) throw new NotFoundError('Sales order');

  const already = await alreadyInvoiced(order.id, order.lines.map((l) => l.productId));

  return {
    salesOrder: {
      id: order.id, orderNo: order.orderNo, status: order.status, currency: order.currency,
      customer: order.customer, warehouse: order.warehouse, invoiceable: INVOICEABLE.includes(order.status),
    },
    lines: order.lines.map((l) => {
      const orderedMilli = toMilli(l.quantity);
      const invoicedMilli = already.get(l.productId) ?? 0;
      return {
        salesOrderLineId: l.id, lineNo: l.lineNo, productId: l.productId,
        sku: l.skuAtOrder, name: l.nameAtOrder, uom: l.uom,
        orderedQuantity: Number(l.quantity),
        invoicedQuantity: Number(fromMilli(invoicedMilli)),
        outstandingQuantity: Number(fromMilli(Math.max(0, orderedMilli - invoicedMilli))),
        unitPrice: Number(l.unitPrice), taxRate: Number(l.taxRate),
      };
    }),
  };
}

const LINE_FROM_ORDER = {
  id: true, lineNo: true, productId: true, skuAtOrder: true, nameAtOrder: true, hsnAtOrder: true,
  quantity: true, uom: true, unitPrice: true, discountPercent: true, discountAmount: true, taxRate: true,
};

/** Orders may be invoiced once committed; a draft or a cancelled order has nothing to bill. */
const INVOICEABLE = ['CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED', 'PARTIALLY_DISPATCHED', 'FULLY_DISPATCHED', 'CLOSED'];

async function alreadyInvoiced(salesOrderId, productIds) {
  if (productIds.length === 0) return new Map();
  const rows = await prisma.salesInvoiceLine.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, salesInvoice: { salesOrderId, status: { not: 'CANCELLED' } } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.productId, toMilli(r._sum.quantity ?? 0)]));
}

/* ============================================================
   CREATING AND POSTING
   ============================================================
   One atomic step, the same shape as a goods receipt: there is no
   separately editable DRAFT sitting in the database. If the lines
   are wrong, the fix is to cancel this invoice and raise another
   -- never to edit a posted claim for payment.
   ============================================================ */

export async function create(input, actor) {
  await assertCan(actor, 'sales:invoice');
  const prepared = await prepare(input);
  const invoiceNo = await nextDocumentNumber('SALES_INVOICE');

  const id = await prisma.$transaction(async (tx) => {
    const invoice = await tx.salesInvoice.create({
      data: {
        invoiceNo,
        status: 'POSTED',
        customerId: prepared.order.customerId,
        salesOrderId: prepared.order.id,
        warehouseId: prepared.warehouse.id,
        invoiceDate: prepared.invoiceDate,
        dueDate: prepared.dueDate,
        billingAddress: prepared.billingAddress,
        shippingAddress: prepared.shippingAddress,
        paymentTerms: prepared.paymentTerms,
        notes: prepared.notes,
        gstTreatment: prepared.gst.treatment,
        sellerStateCode: prepared.gst.sellerStateCode,
        placeOfSupplyCode: prepared.gst.placeOfSupplyCode,
        ...toTotals(prepared.totals),
        createdById: actor.id,
        postedById: actor.id,
        postedAt: new Date(),
        lines: { create: prepared.lines },
      },
      select: { id: true },
    });

    await record(tx, {
      entityType: 'SalesInvoice', entityId: invoice.id, action: 'POST', actorUserId: actor.id,
      summary: 'Posted ' + invoiceNo + ' to ' + prepared.order.customer.name + ' against '
        + prepared.order.orderNo + ' for ' + prepared.totals.grandTotal + ' INR ('
        + prepared.gst.treatment.toLowerCase().replace('_', '-') + '): ' + prepared.summary
        + '. No stock moved by this document.',
    });

    return invoice.id;
  });

  return get(id);
}

export async function cancel(id, actor, reason) {
  await assertCan(actor, 'sales:invoice');
  const invoice = await prisma.salesInvoice.findUnique({ where: { id }, select: HEAD_SELECT });
  if (!invoice) throw new NotFoundError('Sales invoice');
  if (!canTransition(invoice.status, 'CANCELLED')) {
    throw new ConflictError(invoice.invoiceNo + ' is already cancelled.');
  }
  if (!String(reason ?? '').trim()) {
    throw new ValidationError([{ field: 'reason', message: 'Cancelling an invoice needs a reason on record.' }]);
  }

  const paid = await paidAmountByInvoice([id]);
  if ((paid.get(id) ?? 0) > 0) {
    throw new ConflictError(
      invoice.invoiceNo + ' has ' + paid.get(id) + ' recorded against it. '
      + 'A payment must be resolved before the invoice it was paid against can be cancelled.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.salesInvoice.update({
      where: { id }, data: { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: new Date(), cancelReason: String(reason).trim() },
    });
    await record(tx, {
      entityType: 'SalesInvoice', entityId: id, action: 'CANCEL', actorUserId: actor.id,
      before: { status: invoice.status }, after: { status: 'CANCELLED' },
      summary: 'Cancelled ' + invoice.invoiceNo + ': ' + String(reason).trim()
        + '. The invoiced quantity it held is released back to what the order may still be billed for.',
    });
  });

  return get(id);
}

/* ============================================================
   VALIDATION
   ============================================================ */

async function prepare(input) {
  if (!input.salesOrderId) throw new ValidationError([{ field: 'salesOrderId', message: 'Which order is this for?' }]);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError([{ field: 'lines', message: 'An invoice needs at least one line.' }]);
  }

  const order = await prisma.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true, orderNo: true, status: true, warehouseId: true, customerId: true,
      billingAddress: true, shippingAddress: true, paymentTerms: true,
      customer: { select: { id: true, name: true, creditPeriodDays: true, paymentTerms: true, stateCode: true, shippingStateCode: true } },
      lines: { select: LINE_FROM_ORDER },
    },
  });
  if (!order) throw new ValidationError([{ field: 'salesOrderId', message: 'No such sales order.' }]);
  if (!INVOICEABLE.includes(order.status)) {
    throw new ConflictError(
      'Order ' + order.orderNo + ' is ' + order.status.toLowerCase().replace(/_/g, ' ')
      + ', which is too early to invoice. It must be confirmed first.',
      { status: order.status, invoiceableStatuses: INVOICEABLE },
    );
  }

  const warehouseId = input.warehouseId ?? order.warehouseId;
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new ValidationError([{ field: 'warehouseId', message: 'No such warehouse.' }]);

  const gst = salesGstTreatmentFor({ warehouse, customer: order.customer });
  if (gst.error) throw new ValidationError([gst.error]);

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));
  const already = await alreadyInvoiced(order.id, order.lines.map((l) => l.productId));

  const fields = [];
  const lines = [];
  const computed = [];
  const parts = [];
  const seen = new Set();

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    const orderLine = byLineId.get(raw?.salesOrderLineId);
    if (!orderLine) { fields.push({ field: at('salesOrderLineId'), message: 'Not a line on this order.' }); return; }
    if (seen.has(orderLine.id)) {
      fields.push({ field: at('salesOrderLineId'), message: 'Line appears twice on this invoice.' });
      return;
    }
    seen.add(orderLine.id);

    let quantityMilli;
    try { quantityMilli = toMilli(raw.quantity); } catch { fields.push({ field: at('quantity'), message: 'Not a usable quantity.' }); return; }
    if (quantityMilli <= 0) { fields.push({ field: at('quantity'), message: 'An invoice quantity must be above zero.' }); return; }

    const orderedMilli = toMilli(orderLine.quantity);
    const invoicedMilli = already.get(orderLine.productId) ?? 0;
    const outstandingMilli = orderedMilli - invoicedMilli;
    if (quantityMilli > outstandingMilli) {
      fields.push({
        field: at('quantity'),
        message: orderLine.skuAtOrder + ': only ' + fromMilli(Math.max(0, outstandingMilli))
          + ' remains unbilled on this order line.',
      });
      return;
    }

    let math;
    try {
      math = computeLine({
        quantity: fromMilli(quantityMilli),
        unitPrice: orderLine.unitPrice,
        discountPercent: orderLine.discountPercent,
        taxRate: orderLine.taxRate,
        treatment: gst.treatment,
      });
    } catch (err) { fields.push({ field: at('quantity'), message: err.message }); return; }

    computed.push(math);
    lines.push({
      lineNo: lines.length + 1,
      productId: orderLine.productId,
      skuAtInvoice: orderLine.skuAtOrder,
      nameAtInvoice: orderLine.nameAtOrder,
      hsnAtInvoice: orderLine.hsnAtOrder,
      quantity: math.quantity, uom: orderLine.uom, unitPrice: math.unitPrice,
      discountPercent: math.discountPercent, discountAmount: math.discountAmount,
      grossAmount: math.grossAmount, taxableValue: math.taxableValue, taxRate: math.taxRate,
      cgstAmount: math.cgstAmount, sgstAmount: math.sgstAmount, igstAmount: math.igstAmount,
      taxAmount: math.taxAmount, lineTotal: math.lineTotal,
    });
    parts.push(fromMilli(quantityMilli) + ' ' + orderLine.skuAtOrder);
  });

  if (fields.length) throw new ValidationError(fields);

  const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : new Date();
  if (Number.isNaN(invoiceDate.getTime())) throw new ValidationError([{ field: 'invoiceDate', message: 'That is not a date.' }]);
  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : order.customer.creditPeriodDays
      ? new Date(invoiceDate.getTime() + order.customer.creditPeriodDays * 86400000)
      : null;

  return {
    order, warehouse, gst, lines,
    invoiceDate, dueDate,
    billingAddress: text(input.billingAddress) ?? order.billingAddress,
    shippingAddress: text(input.shippingAddress) ?? order.shippingAddress,
    paymentTerms: text(input.paymentTerms) ?? order.paymentTerms ?? order.customer.paymentTerms ?? null,
    notes: text(input.notes),
    totals: computeTotals(computed, { otherCharges: input.otherCharges ?? 0 }),
    summary: parts.join('; '),
  };
}

function toTotals(t) {
  return {
    subTotal: t.subTotal, discountTotal: t.discountTotal, taxableTotal: t.taxableTotal,
    cgstTotal: t.cgstTotal, sgstTotal: t.sgstTotal, igstTotal: t.igstTotal, taxTotal: t.taxTotal,
    otherCharges: t.otherCharges, grandTotal: t.grandTotal,
  };
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shape(i, paidAmount) {
  const grandTotal = Number(i.grandTotal);
  const outstanding = i.status === 'POSTED' ? Math.max(0, grandTotal - paidAmount) : 0;
  return {
    id: i.id, invoiceNo: i.invoiceNo, status: i.status, invoiceDate: i.invoiceDate, dueDate: i.dueDate,
    billingAddress: i.billingAddress, shippingAddress: i.shippingAddress, paymentTerms: i.paymentTerms, notes: i.notes,
    gstTreatment: i.gstTreatment, sellerStateCode: i.sellerStateCode, placeOfSupplyCode: i.placeOfSupplyCode,
    customer: i.customer, salesOrder: i.salesOrder, warehouse: i.warehouse,
    subTotal: Number(i.subTotal), discountTotal: Number(i.discountTotal), taxableTotal: Number(i.taxableTotal),
    cgstTotal: Number(i.cgstTotal), sgstTotal: Number(i.sgstTotal), igstTotal: Number(i.igstTotal),
    taxTotal: Number(i.taxTotal), otherCharges: Number(i.otherCharges), grandTotal,
    currency: i.currency,
    paidAmount, outstandingAmount: outstanding,
    paymentStatus: i.status !== 'POSTED' ? null : outstanding <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
    createdBy: i.createdBy?.name ?? null, postedBy: i.postedBy?.name ?? null, cancelledBy: i.cancelledBy?.name ?? null,
    postedAt: i.postedAt, cancelledAt: i.cancelledAt, cancelReason: i.cancelReason,
    createdAt: i.createdAt, updatedAt: i.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id, lineNo: l.lineNo, productId: l.productId, sku: l.skuAtInvoice, name: l.nameAtInvoice, hsn: l.hsnAtInvoice,
    quantity: Number(l.quantity), uom: l.uom, unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent), discountAmount: Number(l.discountAmount),
    grossAmount: Number(l.grossAmount), taxableValue: Number(l.taxableValue), taxRate: Number(l.taxRate),
    cgstAmount: Number(l.cgstAmount), sgstAmount: Number(l.sgstAmount), igstAmount: Number(l.igstAmount),
    taxAmount: Number(l.taxAmount), lineTotal: Number(l.lineTotal),
  };
}
