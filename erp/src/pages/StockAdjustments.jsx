import { useMemo, useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import StockMovementForm from '../components/StockMovementForm.jsx';
import { Failed } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   ADJUSTMENTS — EVERY CORRECTION, AND WHY
   ============================================================
   This is the screen that makes the ledger trustworthy. A stock
   figure that disagrees with the shelf is corrected HERE, by
   posting a movement with a reason on it, and never by editing a
   balance — there is no code anywhere in this system that can
   edit one.

   Which means this list is the complete record of every time the
   system's number was wrong, who said so, and what they said
   about it. If it is long, that is information, not an
   embarrassment: it is the stock-count history.

   The remarks field is compulsory, enforced in the schema, the
   service and the database. An adjustment with no reason is a
   number somebody changed, and in six months nobody can say why.
   ============================================================ */

export default function StockAdjustments() {
  const [search, setSearch] = useState('');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [posting, setPosting] = useState(false);

  /* Both directions, in one list. An adjustment up and an
     adjustment down are the same decision made twice, and
     splitting them across two screens hides the pattern. */
  const upQuery = useMemo(() => ({
    movementType: 'ADJUSTMENT_INCREASE',
    search: search || undefined, warehouseId,
    from: from || undefined, to: to || undefined,
    page, pageSize,
  }), [search, warehouseId, from, to, page, pageSize]);

  const downQuery = useMemo(() => ({ ...upQuery, movementType: 'ADJUSTMENT_DECREASE' }), [upQuery]);

  const up = useApi(() => api.inventory.ledger(upQuery), [JSON.stringify(upQuery)]);
  const down = useApi(() => api.inventory.ledger(downQuery), [JSON.stringify(downQuery)]);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const reset = (fn) => (value) => { fn(value); setPage(1); };
  const reload = () => { up.reload(); down.reload(); };

  /* Merged in the browser, newest first. Two queries rather than
     one because the API filters on a single movement type, and
     adding an OR for this screen alone would complicate the
     ledger endpoint every other screen shares. The page sizes are
     equal, so the merge is stable. */
  const rows = useMemo(() => [...(up.data?.rows ?? []), ...(down.data?.rows ?? [])]
    .sort((a, b) => Number(b.entryNo) - Number(a.entryNo)), [up.data, down.data]);

  const total = (up.data?.total ?? 0) + (down.data?.total ?? 0);

  const columns = [
    { key: 'entryNo', label: 'Entry', width: 76, sortable: false, render: (m) => <span className="sku">{m.entryNo}</span> },
    { key: 'at', label: 'When', width: 148, sortable: false, render: (m) => stamp(m.at) },
    {
      key: 'productName',
      label: 'Product',
      sortable: false,
      render: (m) => (
        <>
          <strong>{m.productName}</strong>
          <div className="sku">{m.sku} · {m.warehouseCode}</div>
        </>
      ),
    },
    {
      key: 'direction',
      label: 'Direction',
      width: 130,
      sortable: false,
      render: (m) => (m.movementType === 'ADJUSTMENT_INCREASE'
        ? <StatusPill tone="ok" title="More was found than the system showed.">Increase</StatusPill>
        : <StatusPill tone="warn" title="Less was found than the system showed.">Decrease</StatusPill>),
    },
    {
      key: 'quantity',
      label: 'By',
      align: 'right',
      width: 92,
      sortable: false,
      render: (m) => (
        <span className="num">
          {m.movementType === 'ADJUSTMENT_INCREASE' ? '+' : '−'}{qty(m.quantity)}
        </span>
      ),
    },
    { key: 'balanceBefore', label: 'Was', align: 'right', width: 82, sortable: false, render: (m) => <span className="num muted">{qty(m.balanceBefore)}</span> },
    { key: 'balanceAfter', label: 'Became', align: 'right', width: 90, sortable: false, render: (m) => <strong className="num">{qty(m.balanceAfter)}</strong> },
    {
      key: 'remarks',
      label: 'Why',
      sortable: false,
      render: (m) => (m.remarks
        ? <span className="tiny">{m.remarks}</span>
        /* Should be unreachable: the field is compulsory at three
           levels. Shown rather than blank so that a row from
           before the rule would be visible rather than invisible. */
        : <span className="tiny" style={{ color: 'var(--danger)' }}>no reason recorded</span>),
    },
    {
      key: 'performedBy',
      label: 'By',
      width: 130,
      sortable: false,
      render: (m) => m.performedBy ?? <span className="muted">—</span>,
    },
  ];

  if (up.error && !up.data) return <Failed error={up.error} onRetry={reload} />;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Every time the system&rsquo;s stock figure disagreed with the shelf, and
            what was said about it. A balance is never edited — a correction is a
            movement like any other, posted through the same service, with a reason
            that cannot be left blank.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setPosting(true)}>Post an adjustment</button>
        </div>
      </div>

      <div className="summary-strip">
        <div>
          <span className="kpi-label">Adjustments up</span>
          <strong className="num">{qty(up.data?.total ?? 0)}</strong>
        </div>
        <div>
          <span className="kpi-label">Adjustments down</span>
          <strong className="num">{qty(down.data?.total ?? 0)}</strong>
        </div>
        <p className="tiny muted">
          A long list here is the stock-count history, not a problem. A short one
          with no reasons on it would be the problem.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        server={{
          total,
          page,
          pageSize,
          pageCount: Math.max(up.data?.pageCount ?? 1, down.data?.pageCount ?? 1),
          loading: up.loading || down.loading,
          sort: null,
          onPage: setPage,
          onPageSize: (n) => { setPageSize(n); setPage(1); },
          onSort: () => {},
        }}
        search={search}
        onSearch={reset(setSearch)}
        searchPlaceholder="Search product code or name…"
        emptyTitle="No adjustments"
        emptyNote="The system's figures have not needed correcting in this range."
        filters={(
          <>
            <select
              className="select"
              value={warehouseId}
              onChange={(e) => reset(setWarehouseId)(e.target.value)}
              aria-label="Warehouse"
            >
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <input
              className="input"
              type="date"
              value={from}
              onChange={(e) => reset(setFrom)(e.target.value)}
              aria-label="From"
              style={{ width: 142 }}
            />
            <input
              className="input"
              type="date"
              value={to}
              onChange={(e) => reset(setTo)(e.target.value)}
              aria-label="To"
              style={{ width: 142 }}
            />
          </>
        )}
      />

      <StockMovementForm
        mode="adjust"
        open={posting}
        onClose={() => setPosting(false)}
        onPosted={reload}
      />
    </>
  );
}
