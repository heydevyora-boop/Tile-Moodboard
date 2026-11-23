import { prisma } from '../../db/client.mjs';
import { toMilli, fromMilli } from './money.mjs';

/* ============================================================
   THE SALES DASHBOARD
   ============================================================
   Every figure is a count or sum read from the database at
   request time. There is no demo data and no fallback figure
   behind this file: an empty database reads as zero everywhere,
   which is the truthful answer, not a plausible invented one.
   ============================================================ */

export async function dashboard({ from, to, customerId, warehouseId } = {}) {
  const dateRange = from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) }
    : undefined;

  const scope = {
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(dateRange ? { orderDate: dateRange } : {}),
  };

  const [
    customersTotal, customersActive,
    byStatus, ordersTotal,
    valueConfirmed,
    reservedLines,
    dispatchedCount, recentDispatches,
    postedInvoices,
    returnsPosted,
    outstandingLines,
    paidTotal,
    topCustomers,
  ] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { isActive: true } }),

    prisma.salesOrder.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.salesOrder.count({ where: scope }),

    prisma.salesOrder.aggregate({
      where: { ...scope, status: { notIn: ['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'] } },
      _sum: { grandTotal: true },
    }),

    prisma.salesOrderLine.findMany({
      where: { salesOrder: { ...scope, status: { in: ['CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED', 'PARTIALLY_DISPATCHED'] } } },
      select: { quantity: true, reservedQuantity: true, dispatchedQuantity: true },
    }),

    prisma.deliveryChallan.count({
      where: {
        status: 'DISPATCHED',
        ...(customerId && customerId !== 'all' ? { customerId } : {}),
        ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
        ...(dateRange ? { dispatchDate: dateRange } : {}),
      },
    }),
    prisma.deliveryChallan.findMany({
      where: { status: 'DISPATCHED' },
      orderBy: { dispatchedAt: 'desc' },
      take: 8,
      select: {
        id: true, challanNo: true, dispatchDate: true, dispatchedAt: true,
        customer: { select: { name: true } }, warehouse: { select: { name: true } },
        salesOrder: { select: { id: true, orderNo: true } },
        dispatchedBy: { select: { name: true } },
        lines: { select: { quantity: true } },
      },
    }),

    prisma.salesInvoice.aggregate({
      where: { status: 'POSTED', ...(customerId && customerId !== 'all' ? { customerId } : {}), ...(dateRange ? { invoiceDate: dateRange } : {}) },
      _count: { _all: true },
      _sum: { grandTotal: true },
    }),

    prisma.salesReturn.count({ where: { status: 'POSTED' } }),

    /* PENDING DISPATCH, line by line -- what is actually still
       owed to the customer, not a count of orders. */
    prisma.salesOrderLine.findMany({
      where: { salesOrder: { ...scope, status: { in: ['RESERVED', 'PARTIALLY_RESERVED', 'PARTIALLY_DISPATCHED'] } } },
      select: { quantity: true, dispatchedQuantity: true, salesOrder: { select: { id: true, orderNo: true } } },
    }),

    prisma.customerPayment.aggregate({
      where: { ...(customerId && customerId !== 'all' ? { customerId } : {}), ...(dateRange ? { paymentDate: dateRange } : {}) },
      _sum: { amount: true },
    }),

    prisma.salesOrder.groupBy({
      by: ['customerId'],
      where: { ...scope, status: { notIn: ['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'] } },
      _sum: { taxableTotal: true },
      _count: { _all: true },
      orderBy: { _sum: { taxableTotal: 'desc' } },
      take: 5,
    }),
  ]);

  const count = (status) => byStatus.find((r) => r.status === status)?._count._all ?? 0;

  const reservedMilli = reservedLines.reduce((t, l) => t + toMilli(l.reservedQuantity), 0);
  const pendingDispatchMilli = outstandingLines.reduce(
    (t, l) => t + Math.max(0, toMilli(l.quantity) - toMilli(l.dispatchedQuantity)), 0,
  );
  const ordersAwaitingDispatch = new Set(
    outstandingLines
      .filter((l) => toMilli(l.quantity) > toMilli(l.dispatchedQuantity))
      .map((l) => l.salesOrder.id),
  ).size;

  const invoicedValue = Number(postedInvoices._sum.grandTotal ?? 0);
  const paid = Number(paidTotal._sum.amount ?? 0);

  const customerNames = topCustomers.length
    ? await prisma.customer.findMany({
      where: { id: { in: topCustomers.map((c) => c.customerId) } },
      select: { id: true, name: true, code: true },
    })
    : [];
  const nameOf = new Map(customerNames.map((c) => [c.id, c]));

  return {
    customers: {
      total: customersTotal,
      active: customersActive,
      inactive: customersTotal - customersActive,
    },
    orders: {
      total: ordersTotal,
      draft: count('DRAFT'),
      pendingApproval: count('PENDING_APPROVAL'),
      confirmed: count('CONFIRMED'),
      partiallyReserved: count('PARTIALLY_RESERVED'),
      reserved: count('RESERVED'),
      partiallyDispatched: count('PARTIALLY_DISPATCHED'),
      fullyDispatched: count('FULLY_DISPATCHED'),
      cancelled: count('CANCELLED'),
      closed: count('CLOSED'),
      valueConfirmed: Number(valueConfirmed._sum.grandTotal ?? 0),
    },
    stock: {
      reservedQuantity: Number(fromMilli(reservedMilli)),
      ordersAwaitingDispatch,
      pendingDispatchQuantity: Number(fromMilli(pendingDispatchMilli)),
    },
    dispatch: { posted: dispatchedCount },
    invoices: { posted: postedInvoices._count._all, invoicedValue },
    payments: { received: paid, outstanding: Math.max(0, invoicedValue - paid) },
    returns: { posted: returnsPosted },
    topCustomers: topCustomers.map((c) => ({
      id: c.customerId,
      name: nameOf.get(c.customerId)?.name ?? '—',
      code: nameOf.get(c.customerId)?.code ?? null,
      orders: c._count._all,
      value: Number(c._sum.taxableTotal ?? 0),
    })),
    recentDispatches: recentDispatches.map((d) => ({
      id: d.id,
      challanNo: d.challanNo,
      dispatchDate: d.dispatchDate,
      dispatchedAt: d.dispatchedAt,
      customer: d.customer.name,
      warehouse: d.warehouse.name,
      orderId: d.salesOrder?.id ?? null,
      orderNo: d.salesOrder?.orderNo ?? null,
      dispatchedBy: d.dispatchedBy?.name ?? null,
      lineCount: d.lines.length,
      quantity: d.lines.reduce((t, l) => t + Number(l.quantity), 0),
    })),
  };
}

/**
 * SALES HISTORY — every sales document on one timeline.
 *
 * Quotations, orders, invoices, dispatches and returns
 * interleaved by date, the same shape as purchase history.
 */
export async function history(query = {}) {
  const { customerId, warehouseId, from, to, kind, page = 1, pageSize = 50 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);

  const dateRange = from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) }
    : undefined;
  const customerWhere = customerId && customerId !== 'all' ? { customerId } : {};
  const warehouseWhere = warehouseId && warehouseId !== 'all' ? { warehouseId } : {};
  const wants = (k) => !kind || kind === 'all' || kind === k;

  const [quotations, orders, invoices, dispatches, returns] = await Promise.all([
    wants('QUOTATION')
      ? prisma.quotation.findMany({
        where: { ...customerWhere, ...(dateRange ? { quotationDate: dateRange } : {}) },
        orderBy: { quotationDate: 'desc' }, take: take * 2,
        select: {
          id: true, quotationNo: true, status: true, quotationDate: true, grandTotal: true, currency: true,
          customer: { select: { name: true } }, _count: { select: { lines: true } },
        },
      })
      : [],
    wants('ORDER')
      ? prisma.salesOrder.findMany({
        where: { ...customerWhere, ...warehouseWhere, ...(dateRange ? { orderDate: dateRange } : {}) },
        orderBy: { orderDate: 'desc' }, take: take * 2,
        select: {
          id: true, orderNo: true, status: true, orderDate: true, currency: true, grandTotal: true,
          customer: { select: { name: true } }, warehouse: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      })
      : [],
    wants('INVOICE')
      ? prisma.salesInvoice.findMany({
        where: { ...customerWhere, status: { not: 'CANCELLED' }, ...(dateRange ? { invoiceDate: dateRange } : {}) },
        orderBy: { invoiceDate: 'desc' }, take: take * 2,
        select: {
          id: true, invoiceNo: true, invoiceDate: true, grandTotal: true, currency: true, status: true,
          customer: { select: { name: true } },
        },
      })
      : [],
    wants('DISPATCH')
      ? prisma.deliveryChallan.findMany({
        where: { ...customerWhere, ...warehouseWhere, status: 'DISPATCHED', ...(dateRange ? { dispatchDate: dateRange } : {}) },
        orderBy: { dispatchDate: 'desc' }, take: take * 2,
        select: {
          id: true, challanNo: true, dispatchDate: true,
          customer: { select: { name: true } }, warehouse: { select: { name: true } },
          salesOrder: { select: { orderNo: true } },
          lines: { select: { quantity: true } },
        },
      })
      : [],
    wants('RETURN')
      ? prisma.salesReturn.findMany({
        where: { ...customerWhere, ...warehouseWhere, status: 'POSTED', ...(dateRange ? { returnDate: dateRange } : {}) },
        orderBy: { returnDate: 'desc' }, take: take * 2,
        select: {
          id: true, returnNo: true, returnDate: true, reason: true,
          customer: { select: { name: true } }, warehouse: { select: { name: true } },
          lines: { select: { quantity: true } },
        },
      })
      : [],
  ]);

  const events = [
    ...quotations.map((q) => ({
      kind: 'QUOTATION', id: q.id, at: q.quotationDate, reference: q.quotationNo,
      customer: q.customer.name, warehouse: null, status: q.status,
      detail: q._count.lines + ' line(s)', amount: Number(q.grandTotal), currency: q.currency, quantity: null,
    })),
    ...orders.map((o) => ({
      kind: 'ORDER', id: o.id, at: o.orderDate, reference: o.orderNo,
      customer: o.customer.name, warehouse: o.warehouse.name, status: o.status,
      detail: o._count.lines + ' line(s)',
      amount: Number(o.grandTotal),
      currency: o.currency, quantity: null,
    })),
    ...invoices.map((i) => ({
      kind: 'INVOICE', id: i.id, at: i.invoiceDate, reference: i.invoiceNo,
      customer: i.customer.name, warehouse: null, status: i.status,
      detail: 'sales invoice', amount: Number(i.grandTotal), currency: i.currency, quantity: null,
    })),
    ...dispatches.map((d) => ({
      kind: 'DISPATCH', id: d.id, at: d.dispatchDate, reference: d.challanNo,
      customer: d.customer.name, warehouse: d.warehouse.name, status: 'DISPATCHED',
      detail: 'against ' + (d.salesOrder?.orderNo ?? '—'), amount: null, currency: null,
      quantity: d.lines.reduce((t, l) => t + Number(l.quantity), 0),
    })),
    ...returns.map((r) => ({
      kind: 'RETURN', id: r.id, at: r.returnDate, reference: r.returnNo,
      customer: r.customer.name, warehouse: r.warehouse.name, status: 'POSTED',
      detail: r.reason, amount: null, currency: null,
      quantity: -r.lines.reduce((t, l) => t + Number(l.quantity), 0),
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const start = (Math.max(Number(page) || 1, 1) - 1) * take;

  return {
    rows: events.slice(start, start + take),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total: events.length,
    pageCount: Math.max(1, Math.ceil(events.length / take)),
    truncated: [quotations, orders, invoices, dispatches, returns].some((set) => set.length >= take * 2),
  };
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}
