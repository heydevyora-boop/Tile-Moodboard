/* ============================================================
   THE FIFTEEN MODULES, IN ONE PLACE
   ============================================================

   The sidebar, the router and the page titles all read from this
   single list, so a module cannot appear in the nav without a route
   or carry two different names in two places.

   `status` is the honest state of each screen:
     'live'    -- reads and writes the real ERP database
     'ready'   -- built, but still running on generated demo data
     'planned' -- deliberately a placeholder. Warehouses is the one
                  the brief itself flagged: its workflow has not been
                  finalised, so the UI says so rather than inventing
                  a transfer flow the studio would then have to
                  unlearn.

   The distinction is shown in the sidebar rather than kept in a
   document, because a screen full of convincing demo data is
   indistinguishable from a working one until somebody tries to
   save. A reviewer must be able to see at a glance which is which.
   ============================================================ */

export const MODULES = [
  { to: '/',            label: 'Dashboard',              group: 'Overview',   status: 'ready' },

  { to: '/products',    label: 'Product Master',         group: 'Catalogue',  status: 'live' },
  { to: '/categories',  label: 'Catalogue Structure',    group: 'Catalogue',  status: 'live' },

  { to: '/inventory',   label: 'Inventory / Stock',      group: 'Inventory',  status: 'ready' },
  { to: '/inward',      label: 'Stock Inward',           group: 'Inventory',  status: 'ready' },
  { to: '/outward',     label: 'Stock Outward',          group: 'Inventory',  status: 'ready' },
  { to: '/ledger',      label: 'Stock Ledger',           group: 'Inventory',  status: 'ready' },
  { to: '/warehouses',  label: 'Warehouses',             group: 'Inventory',  status: 'planned' },

  { to: '/purchase',    label: 'Purchase Management',    group: 'Trade',      status: 'ready' },
  { to: '/sales',       label: 'Sales Management',       group: 'Trade',      status: 'ready' },

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
  'Overview', 'Catalogue', 'Inventory', 'Trade', 'Insight', 'Integration', 'Admin',
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
