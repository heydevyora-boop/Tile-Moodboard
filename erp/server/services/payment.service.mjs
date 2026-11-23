import { prisma } from '../../db/client.mjs';
import { record as writeAudit } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { toPaise, fromPaise } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   CUSTOMER PAYMENTS — BASIC TRACKING, NOT AN ACCOUNTING SYSTEM
   ============================================================

   The brief is explicit about the boundary: "implement basic
   payment tracking only if supported by existing schema", and
   "do not implement a complete accounting system or bank
   reconciliation in this phase." This file is exactly as small
   as that boundary allows.

   A PAYMENT IS RECORDED AGAINST ONE POSTED INVOICE. There is no
   bank account, no ledger posting, no allocation across several
   invoices in one payment -- a customer who pays for two invoices
   at once is recorded as two CustomerPayment rows, one per
   invoice, exactly as the schema was built (customer_payments has
   a single required salesInvoiceId, not a many-to-many).

   THE BALANCE IS NEVER STORED. Received, outstanding and status
   are all derived fresh from SUM(CustomerPayment.amount) against
   the invoice's own grandTotal, every time they are asked for --
   the same decision this schema makes everywhere else that a
   number can be derived instead of cached (compare how
   SalesOrderLine never stores "remaining", only reservedQuantity/
   dispatchedQuantity/returnedQuantity, with remaining always
   computed from those). A cached balance is a second place the
   same fact can go stale; this file gives it nowhere to do that.

   OVERPAYMENT IS REFUSED, not clipped and not allowed through as
   a credit balance -- this phase has no concept of customer
   credit to carry it. If a customer genuinely overpaid, that is a
   conversation for a person, and the figure in the refusal is
   exactly what is actually owed.
   ============================================================ */

const SELECT = {
  id: true, amount: true, paymentDate: true, method: true, reference: true, notes: true, createdAt: true,
  customer: { select: { id: true, code: true, name: true } },
  salesInvoice: { select: { id: true, invoiceNo: true, grandTotal: true, status: true, invoiceDate: true } },
  recordedBy: { select: { id: true, name: true } },
};

export async function list(query = {}) {
  const { customerId, salesInvoiceId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(salesInvoiceId ? { salesInvoiceId } : {}),
    ...(from || to
      ? { paymentDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
  };

  const [rows, total, totalAmount] = await Promise.all([
    prisma.customerPayment.findMany({ where, orderBy: [{ paymentDate: 'desc' }], skip, take, select: SELECT }),
    prisma.customerPayment.count({ where }),
    prisma.customerPayment.aggregate({ where, _sum: { amount: true } }),
  ]);

  return {
    rows: rows.map(shape),
    summary: { totalReceived: Number(totalAmount._sum.amount ?? 0) },
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

/** The live balance on one invoice -- what the invoice screen and this file's own refusal both read. */
export async function balanceOf(salesInvoiceId) {
  const invoice = await prisma.salesInvoice.findUnique({
    where: { id: salesInvoiceId },
    select: { id: true, invoiceNo: true, status: true, grandTotal: true, dueDate: true },
  });
  if (!invoice) throw new NotFoundError('Sales invoice');

  const paid = await prisma.customerPayment.aggregate({ where: { salesInvoiceId }, _sum: { amount: true } });
  const grandTotalPaise = toPaise(invoice.grandTotal);
  const paidPaise = toPaise(paid._sum.amount ?? 0);
  const outstandingPaise = Math.max(0, grandTotalPaise - paidPaise);
  const overdue = invoice.status === 'POSTED' && outstandingPaise > 0
    && invoice.dueDate !== null && invoice.dueDate < new Date();

  return {
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    grandTotal: Number(fromPaise(grandTotalPaise)),
    paid: Number(fromPaise(paidPaise)),
    outstanding: Number(fromPaise(outstandingPaise)),
    status: invoice.status !== 'POSTED' ? null
      : outstandingPaise <= 0 ? 'PAID'
        : overdue ? 'OVERDUE'
          : paidPaise > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
    _paise: { grandTotal: grandTotalPaise, paid: paidPaise, outstanding: outstandingPaise },
  };
}

export async function record(input, actor) {
  await assertCan(actor, 'sales:payment');

  const fields = [];
  if (!input.salesInvoiceId) fields.push({ field: 'salesInvoiceId', message: 'Which invoice is this against?' });
  if (!input.paymentDate) fields.push({ field: 'paymentDate', message: 'When was it received?' });
  if (input.amount === undefined || input.amount === null || input.amount === '') {
    fields.push({ field: 'amount', message: 'How much was received?' });
  }
  const method = String(input.method ?? '').toUpperCase();
  if (!['CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER'].includes(method)) {
    fields.push({ field: 'method', message: 'Choose a payment method.' });
  }
  if (fields.length) throw new ValidationError(fields);

  // A PAYMENT WITHOUT A VALID INVOICE REFERENCE IS REFUSED HERE,
  // before any arithmetic: balanceOf() itself throws NotFoundError
  // for a missing invoice, which is exactly the enforcement the
  // brief asks for.
  const balance = await balanceOf(input.salesInvoiceId);
  if (balance.status === null) {
    throw new ConflictError(
      'Invoice ' + balance.invoiceNo + ' is not posted, so there is nothing yet to receive payment against.',
    );
  }

  let amountPaise;
  try { amountPaise = toPaise(input.amount); } catch (err) {
    throw new ValidationError([{ field: 'amount', message: err.message }]);
  }
  if (amountPaise <= 0) throw new ValidationError([{ field: 'amount', message: 'A payment amount must be above zero.' }]);

  if (amountPaise > balance._paise.outstanding) {
    throw new ConflictError(
      'Invoice ' + balance.invoiceNo + ' has ' + balance.outstanding + ' outstanding; '
      + fromPaise(amountPaise) + ' would overpay it. This phase has no concept of customer '
      + 'credit to hold the difference, so an overpayment is refused rather than recorded against the wrong figure.',
      { outstanding: balance.outstanding },
    );
  }

  const paymentDate = new Date(input.paymentDate);
  if (Number.isNaN(paymentDate.getTime())) throw new ValidationError([{ field: 'paymentDate', message: 'That is not a date.' }]);

  const invoice = await prisma.salesInvoice.findUnique({ where: { id: input.salesInvoiceId }, select: { customerId: true, invoiceNo: true, customer: { select: { name: true } } } });

  const created = await prisma.$transaction(async (tx) => {
    const payment = await tx.customerPayment.create({
      data: {
        customerId: invoice.customerId,
        salesInvoiceId: input.salesInvoiceId,
        amount: fromPaise(amountPaise),
        paymentDate,
        method,
        reference: text(input.reference),
        notes: text(input.notes),
        recordedById: actor.id,
      },
      select: SELECT,
    });

    const after = await balanceOf(input.salesInvoiceId);
    await writeAudit(tx, {
      entityType: 'CustomerPayment', entityId: payment.id, action: 'CREATE', actorUserId: actor.id,
      summary: 'Recorded ' + fromPaise(amountPaise) + ' INR from ' + invoice.customer.name + ' against '
        + invoice.invoiceNo + ' via ' + method.toLowerCase().replace('_', ' ')
        + '. Outstanding is now ' + after.outstanding + '.',
    });

    return payment;
  });

  return shape(created);
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shape(p) {
  return {
    id: p.id, amount: Number(p.amount), paymentDate: p.paymentDate, method: p.method,
    reference: p.reference, notes: p.notes,
    customer: p.customer, salesInvoice: p.salesInvoice ? { ...p.salesInvoice, grandTotal: Number(p.salesInvoice.grandTotal) } : null,
    recordedBy: p.recordedBy?.name ?? null, createdAt: p.createdAt,
  };
}
