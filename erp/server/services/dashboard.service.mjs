import * as inventory from './inventory.service.mjs';
import * as purchaseDashboard from './purchaseDashboard.service.mjs';
import * as salesDashboard from './salesDashboard.service.mjs';

/* ============================================================
   THE COMBINED ERP DASHBOARD
   ============================================================
   Step 8's own module, because nothing before it needed one:
   inventory.service.dashboard(), purchaseDashboard.service.
   dashboard() and salesDashboard.service.dashboard() each already
   answer their own module's question in full, and each already
   has its own screen. This file does not reimplement a single
   figure from any of the three -- it calls all three and puts the
   results beside each other, because "how is the business doing
   today" is a question that spans modules and none of the three
   existing dashboards was built to answer it alone.

   Every figure here is therefore exactly the figure its owning
   module's own dashboard would show. There is no second query
   written against inventory_balances, purchase_orders or
   sales_orders in this file -- if that ever drifted from what the
   module's own screen reports, this would be the bug, not a
   second source of truth to reconcile.
   ============================================================ */

export async function summary({ from, to } = {}) {
  const [inv, purchase, sales] = await Promise.all([
    inventory.dashboard(),
    purchaseDashboard.dashboard({ from, to }),
    salesDashboard.dashboard({ from, to }),
  ]);

  // ONE RECENT-ACTIVITY FEED, not three. Interleaved by time, the
  // same shape purchase and sales history already use for their
  // own module -- a figure nobody has to click through three
  // screens to piece together.
  const recentTransactions = [
    ...inv.recentMovements.slice(0, 8).map((m) => ({
      kind: 'STOCK_MOVEMENT',
      id: m.id,
      at: m.recordedAt,
      reference: m.entryNo,
      detail: m.movementType.toLowerCase().replace(/_/g, ' ') + ' — ' + m.sku,
      quantity: m.quantity,
      direction: m.direction,
    })),
    ...purchase.recentReceipts.slice(0, 5).map((r) => ({
      kind: 'GOODS_RECEIPT',
      id: r.id,
      at: r.postedAt ?? r.receiptDate,
      reference: r.grnNo,
      detail: 'received from ' + r.supplier,
      quantity: r.quantity,
      direction: 'IN',
    })),
    ...sales.recentDispatches.slice(0, 5).map((d) => ({
      kind: 'DISPATCH',
      id: d.id,
      at: d.dispatchedAt ?? d.dispatchDate,
      reference: d.challanNo,
      detail: 'dispatched to ' + d.customer,
      quantity: d.quantity,
      direction: 'OUT',
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 15);

  return {
    products: {
      total: inv.totals.totalSkus,
      lowStock: inv.totals.lowStock,
      outOfStock: inv.totals.outOfStock,
    },
    inventory: {
      totalWarehouses: inv.totals.totalWarehouses,
      totalOnHand: inv.totals.physicalOnHand,
      totalInTransit: inv.totals.inTransit,
      totalReserved: inv.totals.reserved,
      totalDamaged: inv.totals.damaged,
      totalAvailable: inv.totals.available,
      reconciliation: inv.reconciliation,
    },
    lowStockItems: inv.lowStock,
    purchase: {
      suppliers: purchase.suppliers,
      orders: purchase.orders,
      deliveries: purchase.deliveries,
      receiptsPosted: purchase.receipts.posted,
      openInvoices: purchase.invoices.open,
      openInvoiceValue: purchase.invoices.openValue,
    },
    sales: {
      customers: sales.customers,
      orders: sales.orders,
      dispatchesPosted: sales.dispatch.posted,
      invoicedValue: sales.invoices.invoicedValue,
      outstandingPayments: sales.payments.outstanding,
    },
    recentTransactions,
  };
}
