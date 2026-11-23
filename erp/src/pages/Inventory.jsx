import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   INVENTORY — CONNECTED TO THE ERP DATABASE
   ============================================================
   The same screen that was reviewed and approved. What changed is
   underneath: every figure is now the projection of the real
   append-only stock ledger, reconciled against it on each read of
   the reconciliation report, and the search, filters, sort and
   paging happen in the database rather than in the browser.

   THERE IS NO VALUE COLUMN ANY MORE, and that is deliberate. The
   prototype showed "value at cost" using the product's purchase
   price, which is a guess: the studio has not chosen a valuation
   method (FIFO, weighted average or standard cost), and the three
   give different answers for the same stock. A figure labelled
   "value" that nobody can reproduce is worse than no figure, so
   the ledger records unit cost per movement -- everything any of
   the three methods needs -- and the column returns when the
   method is decided. docs/INVENTORY_MANAGEMENT.md states the
   options.
   ============================================================ */

/* Five ways to look at the same rows. "Needs ordering" is the
   default because it is the only one that is a to-do list. */
const VIEWS = {
  all: { label: 'Everything', params: {} },
  order: { label: 'Needs ordering', params: { lowOnly: true } },
  out: { label: 'Nothing on hand', params: { outOnly: true } },
  damaged: { label: 'Holding damaged', params: { damagedOnly: true } },
};

export default function Inventory() {
  const [view, setView] = useState('all');
  const [search, setSearch] = useState('');
  const [warehouseId, setWarehouseId] = useState('all');
  const [categoryId, setCategoryId] = useState('all');
  const [sort, setSort] = useState({ key: 'sku', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const query = useMemo(() => ({
    search: search || undefined,
    warehouseId,
    categoryId,
    ...VIEWS[view].params,
    sortBy: sort.key,
    sortDir: sort.dir,
    page,
    pageSize,
  }), [search, warehouseId, categoryId, view, sort, page, pageSize]);

  const list = useApi(() => api.inventory.list(query), [JSON.stringify(query)]);
  const totals = useApi(() => api.inventory.totals(), []);
  const dash = useApi(() => api.inventory.dashboard(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);
  const categories = useApi(() => api.reference.categories(), []);

  const reset = (fn) => (value) => { fn(value); setPage(1); };

  const columns = [
    { key: 'sku', label: 'Code', width: 140, render: (r) => <span className="sku">{r.sku}</span> },
    {
      key: 'name',
      label: 'Product',
      render: (r) => (
        <>
          <strong>{r.name}</strong>
          <div className="tiny muted">
            {[r.brand?.name, r.productHead?.name, r.category?.name].filter(Boolean).join(' · ')}
          </div>
        </>
      ),
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      width: 150,
      sortable: false,
      render: (r) => (
        <>
          {r.warehouse?.name}
          {r.warehouse?.isActive === false && <div className="tiny muted">deactivated</div>}
        </>
      ),
    },
    {
      key: 'physical',
      label: 'On hand',
      align: 'right',
      width: 92,
      render: (r) => <span className="num">{qty(r.physical)}</span>,
    },
    /* RESERVED AND DAMAGED ARE PART OF ON HAND, not additional to
       it. The boxes are on the shelf; they are just somebody
       else's, or broken. Shown beside it so the difference between
       "we have it" and "we can sell it" is on the row rather than
       in somebody's head. */
    {
      key: 'reserved',
      label: 'Reserved',
      align: 'right',
      width: 92,
      sortable: false,
      render: (r) => (r.reserved > 0
        ? <span className="num">{qty(r.reserved)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'damaged',
      label: 'Damaged',
      align: 'right',
      width: 92,
      sortable: false,
      render: (r) => (r.damaged > 0
        ? <span className="num" style={{ color: 'var(--warn)' }}>{qty(r.damaged)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'inTransit',
      label: 'In transit',
      align: 'right',
      width: 92,
      sortable: false,
      render: (r) => (r.inTransit > 0
        ? <span className="num">{qty(r.inTransit)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'available',
      label: 'Can be sold',
      align: 'right',
      width: 104,
      sortable: false,
      render: (r) => <strong className="num">{qty(r.available)}</strong>,
    },
    {
      key: 'reorderLevel',
      label: 'Reorder at',
      align: 'right',
      width: 100,
      sortable: false,
      render: (r) => <span className="num">{qty(r.reorderLevel)}</span>,
    },
    {
      key: 'state',
      label: 'State',
      width: 136,
      sortable: false,
      render: (r) => {
        if (r.isOutOfStock) {
          return <StatusPill tone="danger" title="Nothing can be sold from this warehouse.">Nothing on hand</StatusPill>;
        }
        if (r.isLowStock) {
          return <StatusPill tone="warn" title="At or below the reorder level.">Running low</StatusPill>;
        }
        return <StatusPill tone="ok">In stock</StatusPill>;
      },
    },
    {
      key: 'lastMovementAt',
      label: 'Last moved',
      width: 150,
      sortable: false,
      render: (r) => (r.lastMovementAt
        ? <span className="tiny">{stamp(r.lastMovementAt)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'card',
      label: '',
      sortable: false,
      width: 94,
      render: (r) => (
        <Link className="btn btn-sm" to={'/ledger?sku=' + encodeURIComponent(r.sku)}>Stock card</Link>
      ),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const t = totals.data;
  const recon = dash.data?.reconciliation;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What is physically held, warehouse by warehouse. Every figure here is
            the closing balance of that product&rsquo;s stock card — it is not a
            number kept alongside the ledger, it is computed from it, and the
            reconciliation report re-derives all of it on demand.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/inward">Record inward</Link>
          <Link className="btn" to="/outward">Record outward</Link>
          <Link className="btn" to="/adjustments">Adjust</Link>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard
          label="On the shelves"
          value={t ? qty(t.physicalOnHand) : '—'}
          note={t && t.inTransit > 0
            ? qty(t.inTransit) + ' more in transit between warehouses'
            : 'across ' + (t ? t.skusHeld : 0) + ' product(s)'}
        />
        <KpiCard
          label="Can be sold"
          value={t ? qty(t.available) : '—'}
          note={t ? 'on hand less ' + qty(t.reserved) + ' reserved and ' + qty(t.damaged) + ' damaged' : ''}
        />
        <KpiCard
          label="Needs ordering"
          value={dash.data ? qty(dash.data.totals.lowStock) : '—'}
          tone={dash.data?.totals.lowStock ? 'warn' : undefined}
          note="at or below the reorder level"
        />
        <KpiCard
          label="Nothing on hand"
          value={dash.data ? qty(dash.data.totals.outOfStock) : '—'}
          tone={dash.data?.totals.outOfStock ? 'danger' : undefined}
          note="still on sale — reorder these"
        />
      </div>

      {/* The one claim this screen cannot make on its own. Every
          balance above is a projection; this says whether the
          ledger still agrees with it. Green is only green when it
          has been checked. */}
      {recon && (
        <div className={'notice ' + (recon.status === 'PASSED' ? 'notice-ok' : 'notice-danger')}>
          <span aria-hidden="true">●</span>
          <div>
            {recon.status === 'PASSED' ? (
              <>
                <strong>Every balance matches the ledger that produced it.</strong>
                {' '}Re-derived from {' '}
                <Link to="/reconciliation">the reconciliation report</Link>.
              </>
            ) : (
              <>
                <strong>
                  {recon.driftedBalances} balance(s) and {recon.unbalancedTransfers} transfer(s)
                  do not agree with the ledger.
                </strong>
                {' '}Until that is explained, treat the figures above as unverified.
                {' '}<Link to="/reconciliation">See what is wrong</Link>.
              </>
            )}
          </div>
        </div>
      )}

      <div className="viewbar">
        {Object.entries(VIEWS).map(([k, v]) => (
          <button
            key={k}
            className={'viewtab' + (view === k ? ' is-on' : '')}
            onClick={() => { setView(k); setPage(1); }}
          >
            {v.label}
          </button>
        ))}
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(r) => r.productId + ':' + r.warehouse?.id}
        server={{
          total: list.data?.total ?? 0,
          page,
          pageSize,
          pageCount: list.data?.pageCount ?? 1,
          loading: list.loading,
          sort,
          onPage: setPage,
          onPageSize: (n) => { setPageSize(n); setPage(1); },
          onSort: setSort,
        }}
        search={search}
        onSearch={reset(setSearch)}
        searchPlaceholder="Search code, name, brand, series…"
        emptyTitle="Nothing in this view"
        emptyNote="No product matches this combination right now."
        filters={(
          <>
            <select
              className="select"
              value={warehouseId}
              onChange={(e) => reset(setWarehouseId)(e.target.value)}
              aria-label="Warehouse"
            >
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <select
              className="select"
              value={categoryId}
              onChange={(e) => reset(setCategoryId)(e.target.value)}
              aria-label="Category"
            >
              <option value="all">All categories</option>
              {(categories.data?.rows ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </>
        )}
      />

      {list.data?.filteredAfterPaging && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          &ldquo;Needs ordering&rdquo; and &ldquo;Nothing on hand&rdquo; are
          derived from each product&rsquo;s own reorder level, so they are
          applied to the page after the database returns it. The count is the
          number of matching rows on this page, not across the whole catalogue.
        </p>
      )}
    </>
  );
}
