/* ============================================================
   THE TWENTY-FOUR MODULES, IN ONE PLACE
   ============================================================

   The sidebar, the router and the page titles all read from this
   single list, so a module cannot appear in the nav without a route
   or carry two different names in two places.

   `status` is the honest state of each screen:
     'live'    -- reads and writes the real ERP database
     'ready'   -- built, but still running on generated demo data
     'planned' -- deliberately a placeholder, for a module whose
                  workflow the studio has not settled.

   Warehouses was 'planned' through step 3, because the brief itself
   flagged that its workflow was unsettled and a transfer flow built
   before the studio agreed how stock moves between locations would
   have had to be unlearned. Step 5 settled it: the four questions
   that screen used to list are answered in
   docs/INVENTORY_MANAGEMENT.md and implemented, so it is 'live'
   along with the rest of Inventory.

   The distinction is shown in the sidebar rather than kept in a
   document, because a screen full of convincing demo data is
   indistinguishable from a working one until somebody tries to
   save. A reviewer must be able to see at a glance which is which.
   ============================================================ */

export const MODULES = [
  { to: '/',            label: 'Dashboard',              group: 'Overview',   status: 'ready' },

  { to: '/products',    label: 'Product Master',         group: 'Catalogue',  status: 'live' },
  { to: '/categories',  label: 'Catalogue Structure',    group: 'Catalogue',  status: 'live' },

  { to: '/inventory',   label: 'Inventory / Stock',      group: 'Inventory',  status: 'live' },
  { to: '/inward',      label: 'Stock Inward',           group: 'Inventory',  status: 'live' },
  { to: '/outward',     label: 'Stock Outward',          group: 'Inventory',  status: 'live' },
  { to: '/adjustments', label: 'Stock Adjustments',      group: 'Inventory',  status: 'live' },
  { to: '/ledger',      label: 'Stock Ledger',           group: 'Inventory',  status: 'live' },
  { to: '/warehouses',  label: 'Warehouses',             group: 'Inventory',  status: 'live' },
  { to: '/transfers',   label: 'Warehouse Transfers',    group: 'Inventory',  status: 'live' },
  { to: '/reconciliation', label: 'Stock Reconciliation', group: 'Inventory', status: 'live' },

  { to: '/purchase',          label: 'Purchase Dashboard',  group: 'Purchase', status: 'live' },
  { to: '/suppliers',         label: 'Suppliers',           group: 'Purchase', status: 'live' },
  { to: '/purchase-orders',   label: 'Purchase Orders',     group: 'Purchase', status: 'live' },
  { to: '/goods-receipts',    label: 'Goods Receipt',       group: 'Purchase', status: 'live' },
  { to: '/supplier-invoices', label: 'Supplier Invoices',   group: 'Purchase', status: 'live' },
  { to: '/purchase-returns',  label: 'Purchase Returns',    group: 'Purchase', status: 'live' },
  { to: '/purchase-history',  label: 'Purchase History',    group: 'Purchase', status: 'live' },

  { to: '/sales',               label: 'Sales Dashboard',     group: 'Sales', status: 'live' },
  { to: '/customers',           label: 'Customers',          group: 'Sales', status: 'live' },
  { to: '/quotations',          label: 'Quotations',         group: 'Sales', status: 'live' },
  { to: '/sales-orders',        label: 'Sales Orders',       group: 'Sales', status: 'live' },
  { to: '/sales-invoices',      label: 'Sales Invoices',     group: 'Sales', status: 'live' },
  { to: '/delivery-challans',   label: 'Dispatch / Delivery', group: 'Sales', status: 'live' },
  { to: '/sales-returns',       label: 'Sales Returns',      group: 'Sales', status: 'live' },
  { to: '/customer-payments',   label: 'Customer Payments',  group: 'Sales', status: 'live' },
  { to: '/sales-history',       label: 'Sales History',      group: 'Sales', status: 'live' },

  { to: '/reports',     label: 'Reports & Analytics',    group: 'Insight',    status: 'ready' },

  { to: '/sync',        label: 'Website Sync Status',    group: 'Integration', status: 'ready' },
  { to: '/transfer',    label: 'Import / Export',        group: 'Integration', status: 'live' },

  { to: '/users',       label: 'User Management',        group: 'Admin',      status: 'ready' },
  { to: '/settings',    label: 'Settings',               group: 'Admin',      status: 'ready' },
];

/* The sidebar renders groups in this order. Kept separate from
   MODULES so re-ordering a section does not mean re-sorting the
   route table. */
export const GROUP_ORDER = [
  'Overview', 'Catalogue', 'Inventory', 'Purchase', 'Sales', 'Insight', 'Integration', 'Admin',
];

/** The module a path belongs to, for the topbar heading. */
export function moduleFor(pathname) {
  // Longest match first, so /products/TL-0001 still resolves to
  // Product Master rather than to the dashboard's '/'.
  const hit = [...MODULES]
    .sort((a, b) => b.to.length - a.to.length)
    .find((m) => pathname === m.to || (m.to !== '/' && pathname.startsWith(m.to + '/')));
  if (hit) return hit;

  /* An address that matches nothing is not the dashboard. Returning
     the dashboard module put "Dashboard" in the topbar above a page
     that said "No such screen" -- a small lie, and the sort of one
     that makes a reader stop trusting the rest of the headings. The
     path still falls back to '/' so anything navigating onwards
     lands somewhere real. */
  return { to: '/', label: 'Not found', group: 'Overview', status: 'ready' };
}
