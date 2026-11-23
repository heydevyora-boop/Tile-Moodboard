import { prisma } from '../../db/client.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toPaise, fromPaise } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   SUPPLIER INVOICES — A CLAIM FOR PAYMENT
   ============================================================

   RECORDING AN INVOICE CHANGES NO STOCK. Not one movement, not
   one balance. This file does not import postStockMovement and
   must never need to.

   That is the whole reason supplier invoices are a separate
   document here rather than a field on the receipt. The three
   things routinely disagree:

     the ORDER      what was agreed
     the RECEIPT    what actually arrived   <- the only one that
                                               moves stock
     the INVOICE    what we are being billed for

   An ERP that treats any two of them as one cannot show you the
   disagreement, and the disagreement is the entire point of
   three-way matching. A supplier who invoices for forty boxes
   and delivers thirty-eight has to be visible.

   DUPLICATE PROTECTION is a unique index on (supplier, invoice
   number) in the database, not a lookup in JavaScript. Two
   clerks entering the same invoice at the same moment both pass
   a check-then-act; only one passes a unique index. Paying an
   invoice twice is how money leaves a business quietly.
   ============================================================ */

const SELECT = {
  id: true, invoiceNo: true, status: true, invoiceDate: true, dueDate: true,
  taxableAmount: true, taxAmount: true, invoiceAmount: true, currency: true,
  documentRef: true, notes: true, createdAt: true, updatedAt: true,
  supplier: { select: { id: true, code: true, name: true, creditPeriodDays: true } },
  purchaseOrder: { select: { id: true, orderNo: true, status: true, grandTotal: true } },
  goodsReceiptNote: { select: { id: true, grnNo: true, receiptDate: true, status: true } },
  createdBy: { select: { id: true, name: true } },
};

export async function list(query = {}) {
  const { search, status, supplierId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
    ...(from || to
      ? { invoiceDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { invoiceNo: { contains: search, mode: 'insensitive' } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { purchaseOrder: { orderNo: { contains: search, mode: 'insensitive' } } },
          { goodsReceiptNote: { grnNo: { contains: search, mode: 'insensitive' } } },
        ],
      }
      : {}),
  };

  const [rows, total, outstanding] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where, orderBy: [{ invoiceDate: 'desc' }], skip, take, select: SELECT,
    }),
    prisma.supplierInvoice.count({ where }),
    prisma.supplierInvoice.aggregate({
      where: { ...where, status: { in: ['RECEIVED', 'MATCHED'] } },
      _sum: { invoiceAmount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rows.map(shape),
    summary: {
      openInvoices: outstanding._count._all,
      openValue: Number(outstanding._sum.invoiceAmount ?? 0),
    },
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const invoice = await prisma.supplierInvoice.findUnique({ where: { id }, select: SELECT });
  if (!invoice) throw new NotFoundError('Supplier invoice');
  return { ...shape(invoice), match: await matchOf(invoice) };
}

/**
 * THE THREE-WAY MATCH, computed and never asserted.
 *
 * Compares what the invoice claims against what the receipt
 * actually took in and what the order agreed. It REPORTS the
 * difference; it does not adjust anything, and recording an
 * invoice that disagrees is allowed — disagreement is a fact
 * about the supplier, and hiding it would be the bug.
 */
async function matchOf(invoice) {
  if (!invoice.goodsReceiptNote && !invoice.purchaseOrder) {
    return {
      state: 'UNLINKED',
      note: 'This invoice is not linked to an order or a receipt, so there is nothing '
        + 'to match it against. It is a claim for payment on its own.',
    };
  }

  const invoiceAmount = toPaise(invoice.invoiceAmount);
  const orderAmount = invoice.purchaseOrder ? toPaise(invoice.purchaseOrder.grandTotal) : null;

  let receivedValue = null;
  if (invoice.goodsReceiptNote) {
    const lines = await prisma.goodsReceiptNoteLine.findMany({
      where: { goodsReceiptNoteId: invoice.goodsReceiptNote.id },
      select: { receivedQuantity: true, unitCost: true },
    });
    receivedValue = lines.reduce((total, l) => {
      if (l.unitCost === null) return total;
      // quantity is thousandths, cost is paise: the product is in
      // thousandths of a paisa, so scale back down once.
      return total + Math.round(Number(l.receivedQuantity) * 1000 * toPaise(l.unitCost) / 1000);
    }, 0);
  }

  const difference = receivedValue === null ? null : invoiceAmount - receivedValue;

  return {
    state: difference === null ? 'NO_RECEIPT_VALUE'
      : difference === 0 ? 'AGREES'
        : difference > 0 ? 'INVOICE_HIGHER' : 'INVOICE_LOWER',
    invoiceAmount: Number(fromPaise(invoiceAmount)),
    orderAmount: orderAmount === null ? null : Number(fromPaise(orderAmount)),
    receivedValue: receivedValue === null ? null : Number(fromPaise(receivedValue)),
    difference: difference === null ? null : Number(fromPaise(difference)),
    note: difference === null
      ? 'The receipt carries no unit costs, so there is no value to compare against.'
      : difference === 0
        ? 'The invoice matches the value of what was actually received.'
        : 'The invoice and the goods received do not agree. That is recorded, not corrected: '
          + 'which of the two is wrong is a question for a person.',
  };
}

export async function create(input, actor) {
  await assertCan(actor, 'purchase:write');

  const fields = [];
  if (!input.supplierId) fields.push({ field: 'supplierId', message: 'Which supplier sent this?' });
  if (!String(input.invoiceNo ?? '').trim()) {
    fields.push({ field: 'invoiceNo', message: "The supplier's own invoice number is required." });
  }
  if (!input.invoiceDate) fields.push({ field: 'invoiceDate', message: 'When is it dated?' });
  if (input.invoiceAmount === undefined || input.invoiceAmount === null || input.invoiceAmount === '') {
    fields.push({ field: 'invoiceAmount', message: 'What is it for?' });
  }
  if (fields.length) throw new ValidationError(fields);

  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new ValidationError([{ field: 'supplierId', message: 'No such supplier.' }]);

  const invoiceNo = String(input.invoiceNo).trim();

  let amounts;
  try {
    amounts = {
      invoiceAmount: fromPaise(toPaise(input.invoiceAmount)),
      taxableAmount: fromPaise(toPaise(input.taxableAmount ?? 0)),
      taxAmount: fromPaise(toPaise(input.taxAmount ?? 0)),
    };
  } catch (err) {
    throw new ValidationError([{ field: 'invoiceAmount', message: err.message }]);
  }
  if (toPaise(amounts.invoiceAmount) < 0) {
    throw new ValidationError([{ field: 'invoiceAmount', message: 'An invoice amount cannot be negative.' }]);
  }

  // Links are optional, but a link that points at another
  // supplier's paperwork is a mistake worth catching here.
  const [order, grn] = await Promise.all([
    input.purchaseOrderId
      ? prisma.purchaseOrder.findUnique({
        where: { id: input.purchaseOrderId },
        select: { id: true, orderNo: true, supplierId: true },
      })
      : null,
    input.goodsReceiptNoteId
      ? prisma.goodsReceiptNote.findUnique({
        where: { id: input.goodsReceiptNoteId },
        select: { id: true, grnNo: true, supplierId: true, purchaseOrderId: true, status: true },
      })
      : null,
  ]);

  if (input.purchaseOrderId && !order) {
    fields.push({ field: 'purchaseOrderId', message: 'No such purchase order.' });
  } else if (order && order.supplierId !== supplier.id) {
    fields.push({ field: 'purchaseOrderId', message: 'Order ' + order.orderNo + ' belongs to a different supplier.' });
  }

  if (input.goodsReceiptNoteId && !grn) {
    fields.push({ field: 'goodsReceiptNoteId', message: 'No such goods receipt.' });
  } else if (grn) {
    if (grn.supplierId !== supplier.id) {
      fields.push({ field: 'goodsReceiptNoteId', message: 'Receipt ' + grn.grnNo + ' belongs to a different supplier.' });
    }
    /* A DRAFT RECEIPT IS NOT EVIDENCE OF ANYTHING. Linking an
       invoice to one would suggest the goods arrived when no
       stock has moved. */
    if (grn.status !== 'POSTED') {
      fields.push({
        field: 'goodsReceiptNoteId',
        message: 'Receipt ' + grn.grnNo + ' is ' + grn.status.toLowerCase()
          + '. Only a posted receipt is evidence that goods arrived.',
      });
    }
    if (order && grn.purchaseOrderId !== order.id) {
      fields.push({
        field: 'goodsReceiptNoteId',
        message: 'Receipt ' + grn.grnNo + ' is against a different order from the one given.',
      });
    }
  }
  if (fields.length) throw new ValidationError(fields);

  const invoiceDate = new Date(input.invoiceDate);
  if (Number.isNaN(invoiceDate.getTime())) {
    throw new ValidationError([{ field: 'invoiceDate', message: 'That is not a date.' }]);
  }

  /* The due date follows the supplier's credit period where one
     is recorded and none is given. Derived rather than demanded,
     because it is arithmetic nobody should have to do. */
  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : supplier.creditPeriodDays !== null && supplier.creditPeriodDays !== undefined
      ? new Date(invoiceDate.getTime() + supplier.creditPeriodDays * 86400000)
      : null;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const invoice = await tx.supplierInvoice.create({
        data: {
          supplierId: supplier.id,
          invoiceNo,
          invoiceDate,
          dueDate,
          purchaseOrderId: order?.id ?? null,
          goodsReceiptNoteId: grn?.id ?? null,
          taxableAmount: amounts.taxableAmount,
          taxAmount: amounts.taxAmount,
          invoiceAmount: amounts.invoiceAmount,
          currency: String(input.currency ?? 'INR').trim() || 'INR',
          documentRef: text(input.documentRef),
          notes: text(input.notes),
          createdById: actor.id,
        },
        select: SELECT,
      });

      await record(tx, {
        entityType: 'SupplierInvoice',
        entityId: invoice.id,
        action: 'CREATE',
        actorUserId: actor.id,
        summary: 'Recorded invoice ' + invoiceNo + ' from ' + supplier.name + ' for '
          + amounts.invoiceAmount + ' ' + invoice.currency
          + (grn ? ', against receipt ' + grn.grnNo : '')
          + (order ? ', order ' + order.orderNo : '')
          + '. No stock moved: an invoice is a claim for payment, not a delivery.',
      });

      return invoice;
    });

    return { ...shape(created), match: await matchOf(created) };
  } catch (err) {
    // The unique index did its job. Translated into something a
    // person can act on.
    if (err?.code === 'P2002' || /supplier_invoices_supplierId_invoiceNo_key/.test(err?.message ?? '')) {
      const existing = await prisma.supplierInvoice.findFirst({
        where: { supplierId: supplier.id, invoiceNo },
        select: { id: true, invoiceDate: true, invoiceAmount: true },
      });
      throw new ConflictError(
        'Invoice ' + invoiceNo + ' from ' + supplier.name + ' is already recorded'
        + (existing ? ' (dated ' + existing.invoiceDate.toISOString().slice(0, 10)
          + ', ' + existing.invoiceAmount + ')' : '')
        + '. Entering it twice is how one gets paid twice.',
        { existingId: existing?.id, invoiceNo },
      );
    }
    throw err;
  }
}

/** Move an invoice between RECEIVED, MATCHED, DISPUTED and CANCELLED. */
export async function setStatus(id, status, actor, note) {
  await assertCan(actor, 'purchase:write');

  const invoice = await prisma.supplierInvoice.findUnique({ where: { id }, select: SELECT });
  if (!invoice) throw new NotFoundError('Supplier invoice');

  if (!['RECEIVED', 'MATCHED', 'DISPUTED', 'CANCELLED'].includes(status)) {
    throw new ValidationError([{ field: 'status', message: 'Not a supplier invoice status.' }]);
  }
  if (invoice.status === 'CANCELLED') {
    throw new ConflictError('Invoice ' + invoice.invoiceNo + ' has been cancelled and cannot change again.');
  }
  if (status === 'DISPUTED' && !String(note ?? '').trim()) {
    throw new ValidationError([{
      field: 'note',
      message: 'Say what is being disputed. A dispute with no stated reason cannot be followed up.',
    }]);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const after = await tx.supplierInvoice.update({
      where: { id },
      data: {
        status,
        notes: note ? [invoice.notes, String(note).trim()].filter(Boolean).join('\n') : invoice.notes,
      },
      select: SELECT,
    });
    await record(tx, {
      entityType: 'SupplierInvoice',
      entityId: id,
      action: status === 'CANCELLED' ? 'CANCEL' : 'UPDATE',
      actorUserId: actor.id,
      before: { status: invoice.status },
      after: { status },
      summary: 'Invoice ' + invoice.invoiceNo + ' from ' + invoice.supplier.name
        + ' marked ' + status.toLowerCase() + (note ? ': ' + String(note).trim() : '') + '.',
    });
    return after;
  });

  return { ...shape(updated), match: await matchOf(updated) };
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

function shape(i) {
  return {
    id: i.id,
    invoiceNo: i.invoiceNo,
    status: i.status,
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    supplier: i.supplier,
    purchaseOrder: i.purchaseOrder
      ? { ...i.purchaseOrder, grandTotal: Number(i.purchaseOrder.grandTotal) }
      : null,
    goodsReceiptNote: i.goodsReceiptNote,
    taxableAmount: Number(i.taxableAmount),
    taxAmount: Number(i.taxAmount),
    invoiceAmount: Number(i.invoiceAmount),
    currency: i.currency,
    documentRef: i.documentRef,
    notes: i.notes,
    createdBy: i.createdBy?.name ?? null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}
