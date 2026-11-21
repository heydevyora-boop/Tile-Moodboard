import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from './DataTable.jsx';
import StockMovementForm from './StockMovementForm.jsx';
import { Failed } from './ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   INWARD AND OUTWARD, FROM ONE LEDGER
   ============================================================
   Stock Inward and Stock Outward are not two sets of records.
   They are one append-only ledger read in two directions, which
   is why they share this component and why the direction is
   resolved in the DATABASE rather than here: a receipt that
   appeared on the Inward screen but not in the ledger would be a
   bug waiting to happen, and like this it cannot exist.

   Recording a movement goes through the one stock transaction
   service, with an idempotency key, so pressing Save twice posts
   it once.
   ============================================================ */

const REASON_LABEL = {
  OPENING_STOCK: 'Opening stock',
  PURCHASE_RECEIPT: 'Purchase receipt',
  PURCHASE_RETURN: 'Returned to supplier',
  SALES_DISPATCH: 'Sales dispatch',
  SALES_RETURN: 'Customer return',
  SAMPLE_ISSUE: 'Sample issued',
  DAMAGE: 'Damage',
  DAMAGE_RECOVERY: 'Damage recovered',
  STOCK_COUNT_CORRECTION: 'Stock count correction',
  WAREHOUSE_TRANSFER: 'Warehouse transfer',
  RESERVATION: 'Reserved',
  RESERVATION_RELEASE: 'Reservation released',
  OTHER: 'Other',
};

const REASONS_BY_DIR = {
  in: ['PURCHASE_RECEIPT', 'SALES_RETURN', 'STOCK_COUNT_CORRECTION', 'WAREHOUSE_TRANSFER', 'OPENING_STOCK', 'OTHER'],
  out: ['SALES_DISPATCH', 'SAMPLE_ISSUE', 'PURCHASE_RETURN', 'STOCK_COUNT_CORRECTION', 'WAREHOUSE_TRANSFER', 'OTHER'],
};

export default function MovementList({ dir, title, intro, recordLabel }) {
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [recording, setRecording] = useState(false);

  const query = useMemo(() => ({
    direction: dir === 'in' ? 'IN' : 'OUT',
    search: search || undefined,
    reason,
    warehouseId,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize,
  }), [dir, search, reason, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.inventory.ledger(query), [JSON.stringify(query)]);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const reset = (fn) => (value) => { fn(value); setPage(1); };

  const columns = [
    {
      key: 'entryNo',
      label: 'Entry',
      width: 78,
      sortable: false,
      render: (m) => <span className="sku">{m.entryNo}</span>,
    },
    {
      key: 'at',
      label: 'When',
      width: 150,
      sortable: false,
      render: (m) => (
        <>
          {stamp(m.at)}
          {/* The business date and the moment it was typed in are
              different facts, and only one of them can be
              back-dated. Where they differ, both are shown. */}
          {m.recordedAt && m.recordedAt.slice(0, 10) !== m.at.slice(0, 10) && (
            <div className="tiny muted">entered {stamp(m.recordedAt)}</div>
          )}
        </>
      ),
    },
    {
      key: 'productName',
      label: 'Product',
      sortable: false,
      render: (m) => (
        <>
          <strong>{m.productName}</strong>
          <div className="sku">{m.sku}</div>
        </>
      ),
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      width: 140,
      sortable: false,
      render: (m) => m.warehouse,
    },
    {
      key: 'reason',
      label: 'Reason',
      width: 160,
      sortable: false,
      render: (m) => REASON_LABEL[m.reason] ?? m.reason,
    },
    {
      key: 'referenceNo',
      label: 'Document',
      width: 130,
      sortable: false,
      render: (m) => (m.referenceNo
        ? <span className="sku">{m.referenceNo}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'quantity',
      label: dir === 'in' ? 'Received' : 'Issued',
      align: 'right',
      width: 96,
      sortable: false,
      render: (m) => <span className="num">{qty(m.quantity)} {m.uom?.toLowerCase()}</span>,
    },
    /* THE WHOLE POINT OF A LEDGER: what the balance was, and what
       it became. Reading these two down the page re-derives the
       stock figure by hand, which is how a discrepancy is found. */
    {
      key: 'balanceBefore',
      label: 'Was',
      align: 'right',
      width: 84,
      sortable: false,
      render: (m) => <span className="num muted">{qty(m.balanceBefore)}</span>,
    },
    {
      key: 'balanceAfter',
      label: 'Became',
      align: 'right',
      width: 92,
      sortable: false,
      render: (m) => <strong className="num">{qty(m.balanceAfter)}</strong>,
    },
    {
      key: 'performedBy',
      label: 'Recorded by',
      width: 130,
      sortable: false,
      render: (m) => m.performedBy ?? <span className="muted">—</span>,
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const rows = list.data?.rows ?? [];
  const pageQty = rows.reduce((s, m) => s + m.quantity, 0);

  return (
    <>
      <div className="page-intro">
        <div><p>{intro}</p></div>
        <div className="page-actions">
          <Link className="btn" to="/ledger">Full ledger</Link>
          <button className="btn btn-primary" onClick={() => setRecording(true)}>{recordLabel}</button>
        </div>
      </div>

      <div className="summary-strip">
        <div>
          <span className="kpi-label">Movements</span>
          <strong className="num">{qty(list.data?.total ?? 0)}</strong>
        </div>
        <div>
          <span className="kpi-label">On this page</span>
          <strong className="num">{qty(pageQty)}</strong>
        </div>
        <p className="tiny muted">
          Every row is an entry on the append-only ledger. Nothing here can be
          edited or deleted — a mistake is corrected by posting its reversal,
          and both stay on the record.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        server={{
          total: list.data?.total ?? 0,
          page,
          pageSize,
          pageCount: list.data?.pageCount ?? 1,
          loading: list.loading,
          sort: null,
          onPage: setPage,
          onPageSize: (n) => { setPageSize(n); setPage(1); },
          onSort: () => {},
        }}
        search={search}
        onSearch={reset(setSearch)}
        searchPlaceholder="Search product code, name, document…"
        emptyTitle={'No ' + title.toLowerCase() + ' movements'}
        emptyNote="Nothing matches this reason, warehouse or date range."
        filters={(
          <>
            <select
              className="select"
              value={reason}
              onChange={(e) => reset(setReason)(e.target.value)}
              aria-label="Reason"
            >
              <option value="all">All reasons</option>
              {REASONS_BY_DIR[dir].map((r) => (
                <option key={r} value={r}>{REASON_LABEL[r]}</option>
              ))}
            </select>
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
        mode={dir}
        open={recording}
        onClose={() => setRecording(false)}
        onPosted={() => list.reload()}
      />
    </>
  );
}
