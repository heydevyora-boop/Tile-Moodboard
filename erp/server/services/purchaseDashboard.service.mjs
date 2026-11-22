import { prisma } from '../../db/client.mjs';
import { toMilli, fromMilli } from './money.mjs';

/* ============================================================
   THE PURCHASE DASHBOARD
   ============================================================
   Every figure here is a COUNT OR SUM FROM THE DATABASE. There is
   no demo data behind this file and no fallback figure: if the
   database is empty the dashboard reads zero, which is the
   truthful answer and reads very differently from a plausible
   invented one.
   ============================================================ */

export async function dashboard({ from, to, supplierId, warehouseId } = {}) {
  const dateRange = from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) }
    : undefined;

  const scope = {
    ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
    ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
    ...(dateRange ? { orderDate: dateRange } : {}),
  };

  const [
    suppliersTotal, suppliersActive,
    byStatus, ordersTotal,
    valueCommitted,
    receiptsPosted, recentReceipts,
    openInvoices, disputedInvoices,
    returnsPosted,
    outstandingLines,
    receivedLines,
    topSuppliers,
  ] = await Promise.all([
    prisma.supplier.count(),
    prisma.supplier.count({ where: { isActive: true } }),

    prisma.purchaseOrder.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.purchaseOrder.count({ where: scope }),

    /* Value the studio has actually committed to. Drafts are not
       commitments and cancelled orders are not trade, so neither
       is counted -- a figure that includes them flatters itself. */
    prisma.purchaseOrder.aggregate({
      where: { ...scope, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grandTotal: true },
    }),

    prisma.goodsReceiptNote.count({
      where: {
        status: 'POSTED',
        ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
        ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
        ...(dateRange ? { receiptDate: dateRange } : {}),
      },
    }),
    prisma.goodsReceiptNote.findMany({
      where: { status: 'POSTED' },
      orderBy: { postedAt: 'desc' },
      take: 8,
      select: {
        id: true, grnNo: true, receiptDate: true, postedAt: true,
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        purchaseOrder: { select: { id: true, orderNo: true } },
        receivedBy: { select: { name: true } },
        lines: { select: { receivedQuantity: true, damagedQuantity: true, rejectedQuantity: true } },
      },
    }),

    prisma.supplierInvoice.aggregate({
      where: { status: { in: ['RECEIVED', 'MATCHED'] } },
      _count: { _all: true },
      _sum: { invoiceAmount: true },
    }),
    prisma.supplierInvoice.count({ where: { status: 'DISPUTED' } }),

    prisma.purchaseReturn.count({ where: { status: 'POSTED' } }),

    /* PENDING DELIVERIES, line by line, so the figure is what is
       actually still owed rather than a count of orders. */
    prisma.purchaseOrderLine.findMany({
      where: { purchaseOrder: { ...scope, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } } },
      select: {
        quantity: true, receivedQuantity: true,
        purchaseOrder: { select: { id: true, orderNo: true, expectedDate: true } },
      },
    }),

    prisma.goodsReceiptNoteLine.findMany({
      where: {
        goodsReceiptNote: {
          status: 'POSTED',
          ...(supplierId && supplierId !== 'all' ? { supplierId } : {}),
          ...(warehouseId && warehouseId !== 'all' ? { warehouseId } : {}),
          ...(dateRange ? { receiptDate: dateRange } : {}),
        },
      },
      select: { receivedQuantity: true, damagedQuantity: true, rejectedQuantity: true },
    }),

    prisma.purchaseOrder.groupBy({
      by: ['supplierId'],
      where: { ...scope, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grandTotal: true },
      _count: { _all: true },
      orderBy: { _sum: { grandTotal: 'desc' } },
      take: 5,
    }),
  ]);

  const count = (status) => byStatus.find((r) => r.status === status)?._count._all ?? 0;

  const outstandingMilli = outstandingLines.reduce(
    (t, l) => t + Math.max(0, toMilli(l.quantity) - toMilli(l.receivedQuantity)), 0,
  );
  const ordersAwaitingDelivery = new Set(
    outstandingLines
      .filter((l) => toMilli(l.quantity) > toMilli(l.receivedQuantity))
      .map((l) => l.purchaseOrder.id),
  ).size;

  const today = startOfDay(new Date());
  const overdue = new Set(
    outstandingLines
      .filter((l) => toMilli(l.quantity) > toMilli(l.receivedQuantity)
        && l.purchaseOrder.expectedDate && l.purchaseOrder.expectedDate < today)
      .map((l) => l.purchaseOrder.id),
  ).size;

  const receivedMilli = receivedLines.reduce((t, l) => t + toMilli(l.receivedQuantity), 0);
  const damagedMilli = receivedLines.reduce((t, l) => t + toMilli(l.damagedQuantity), 0);
  const rejectedMilli = receivedLines.reduce((t, l) => t + toMilli(l.rejectedQuantity), 0);

  const supplierNames = topSuppliers.length
    ? await prisma.supplier.findMany({
      where: { id: { in: topSuppliers.map((s) => s.supplierId) } },
      select: { id: true, name: true, code: true },
    })
    : [];
  const nameOf = new Map(supplierNames.map((s) => [s.id, s]));

  return {
    suppliers: {
      total: suppliersTotal,
      active: suppliersActive,
      inactive: suppliersTotal - suppliersActive,
    },
    orders: {
      total: ordersTotal,
      draft: count('DRAFT'),
      pendingApproval: count('PENDING_APPROVAL'),
      approved: count('APPROVED'),
      partiallyReceived: count('PARTIALLY_RECEIVED'),
      fullyReceived: count('FULLY_RECEIVED'),
      cancelled: count('CANCELLED'),
      closed: count('CLOSED'),
      valueCommitted: Number(valueCommitted._sum.grandTotal ?? 0),
    },
    deliveries: {
      ordersAwaiting: ordersAwaitingDelivery,
      overdue,
      outstandingQuantity: Number(fromMilli(outstandingMilli)),
    },
    receipts: {
      posted: receiptsPosted,
      totalReceivedQuantity: Number(fromMilli(receivedMilli)),
      damagedQuantity: Number(fromMilli(damagedMilli)),
      rejectedQuantity: Number(fromMilli(rejectedMilli)),
    },
    invoices: {
      open: openInvoices._count._all,
      openValue: Number(openInvoices._sum.invoiceAmount ?? 0),
      disputed: disputedInvoices,
    },
    returns: { posted: returnsPosted },
    topSuppliers: topSuppliers.map((s) => ({
      id: s.supplierId,
      name: nameOf.get(s.supplierId)?.name ?? '—',
      code: nameOf.get(s.supplierId)?.code ?? null,
      orders: s._count._all,
      value: Number(s._sum.grandTotal ?? 0),
    })),
    recentReceipts: recentReceipts.map((r) => ({
      id: r.id,
      grnNo: r.grnNo,
      receiptDate: r.receiptDate,
      postedAt: r.postedAt,
      supplier: r.supplier.name,
      warehouse: r.warehouse.name,
      orderId: r.purchaseOrder?.id ?? null,
      orderNo: r.purchaseOrder?.orderNo ?? null,
      receivedBy: r.receivedBy?.name ?? null,
      lineCount: r.lines.length,
      quantity: r.lines.reduce((t, l) => t + Number(l.receivedQuantity), 0),
      damaged: r.lines.reduce((t, l) => t + Number(l.damagedQuantity), 0),
      rejected: r.lines.reduce((t, l) => t + Number(l.rejectedQuantity), 0),
    })),
  };
}

/**
 * PURCHASE HISTORY — every purchase document on one timeline.
 *
 * Orders, receipts, returns and invoices interleaved by date,
 * which is how somebody actually asks the question: "what
 * happened with this supplier, in order".
 */
export async function history(query = {}) {
  const { supplierId, warehouseId, from, to, kind, page = 1, pageSize = 50 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);

  const dateRange = from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) }
    : undefined;
  const supplierWhere = supplierId && supplierId !== 'all' ? { supplierId } : {};
  const warehouseWhere = warehouseId && warehouseId !== 'all' ? { warehouseId } : {};
  const wants = (k) => !kind || kind === 'all' || kind === k;

  const [orders, receipts, returns, invoices] = await Promise.all([
    wants('ORDER')
      ? prisma.purchaseOrder.findMany({
        where: { ...supplierWhere, ...warehouseWhere, ...(dateRange ? { orderDate: dateRange } : {}) },
        orderBy: { orderDate: 'desc' },
        take: take * 2,
        select: {
          id: true, orderNo: true, status: true, orderDate: true, grandTotal: true, currency: true,
          supplier: { select: { name: true } }, warehouse: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      })
      : [],
    wants('RECEIPT')
      ? prisma.goodsReceiptNote.findMany({
        where: { ...supplierWhere, ...warehouseWhere, status: 'POSTED', ...(dateRange ? { receiptDate: dateRange } : {}) },
        orderBy: { receiptDate: 'desc' },
        take: take * 2,
        select: {
          id: true, grnNo: true, receiptDate: true,
          supplier: { select: { name: true } }, warehouse: { select: { name: true } },
          purchaseOrder: { select: { orderNo: true } },
          lines: { select: { receivedQuantity: true } },
        },
      })
      : [],
    wants('RETURN')
      ? prisma.purchaseReturn.findMany({
        where: { ...supplierWhere, ...warehouseWhere, status: 'POSTED', ...(dateRange ? { returnDate: dateRange } : {}) },
        orderBy: { returnDate: 'desc' },
        take: take * 2,
        select: {
          id: true, returnNo: true, returnDate: true, reason: true,
          supplier: { select: { name: true } }, warehouse: { select: { name: true } },
          lines: { select: { quantity: true } },
        },
      })
      : [],
    wants('INVOICE')
      ? prisma.supplierInvoice.findMany({
        where: { ...supplierWhere, ...(dateRange ? { invoiceDate: dateRange } : {}) },
        orderBy: { invoiceDate: 'desc' },
        take: take * 2,
        select: {
          id: true, invoiceNo: true, invoiceDate: true, invoiceAmount: true,
          currency: true, status: true, supplier: { select: { name: true } },
        },
      })
      : [],
  ]);

  const events = [
    ...orders.map((o) => ({
      kind: 'ORDER',
      id: o.id,
      at: o.orderDate,
      reference: o.orderNo,
      supplier: o.supplier.name,
      warehouse: o.warehouse.name,
      status: o.status,
      detail: o._count.lines + ' line(s)',
      amount: Number(o.grandTotal),
      currency: o.currency,
      quantity: null,
    })),
    ...receipts.map((r) => ({
      kind: 'RECEIPT',
      id: r.id,
      at: r.receiptDate,
      reference: r.grnNo,
      supplier: r.supplier.name,
      warehouse: r.warehouse.name,
      status: 'POSTED',
      detail: 'against ' + (r.purchaseOrder?.orderNo ?? '—'),
      amount: null,
      currency: null,
      quantity: r.lines.reduce((t, l) => t + Number(l.receivedQuantity), 0),
    })),
    ...returns.map((r) => ({
      kind: 'RETURN',
      id: r.id,
      at: r.returnDate,
      reference: r.returnNo,
      supplier: r.supplier.name,
      warehouse: r.warehouse.name,
      status: 'POSTED',
      detail: r.reason,
      amount: null,
      currency: null,
      quantity: -r.lines.reduce((t, l) => t + Number(l.quantity), 0),
    })),
    ...invoices.map((i) => ({
      kind: 'INVOICE',
      id: i.id,
      at: i.invoiceDate,
      reference: i.invoiceNo,
      supplier: i.supplier.name,
      warehouse: null,
      status: i.status,
      detail: 'supplier invoice',
      amount: Number(i.invoiceAmount),
      currency: i.currency,
      quantity: null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const start = (Math.max(Number(page) || 1, 1) - 1) * take;

  return {
    rows: events.slice(start, start + take),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total: events.length,
    pageCount: Math.max(1, Math.ceil(events.length / take)),
    /* The four queries each take a bounded slice, so a very long
       history is truncated rather than loaded whole. Said out
       loud instead of quietly producing a page that looks
       complete. */
    truncated: [orders, receipts, returns, invoices].some((set) => set.length >= take * 2),
  };
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
