import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { Failed } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { PO_STATUS, INVOICE_STATUS } from '../data/purchaseStatus.js';

/* ============================================================
   PURCHASE HISTORY — EVERY DOCUMENT ON ONE TIMELINE
   ============================================================
   Orders, receipts, returns and invoices interleaved by date,
   because that is how the question is actually asked: what
   happened with this supplier, in order. Each row links back to
   the document it came from.
   ============================================================ */

const KIND = {
  ORDER: { label: 'Order', tone: 'info', to: (r) => '/purchase-orders?open=' + r.id },
  RECEIPT: { label: 'Received', tone: 'ok', to: (r) => '/goods-receipts?open=' + r.id },
  RETURN: { label: 'Returned', tone: 'warn', to: (r) => '/purchase-returns?open=' + r.id },
  INVOICE: { label: 'Invoice', tone: 'inert', to: (r) => '/supplier-invoices?open=' + r.id },
};

export default function PurchaseHistory() {
  const [kind, setKind] = useState('all');
  const [supplierId, setSupplierId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const query = useMemo(() => ({
    kind, supplierId, warehouseId,
    from: from || undefined, to: to || undefined,
    page, pageSize,
  }), [kind, supplierId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.purchase.history(query), [JSON.stringify(query)]);
  const suppliers = useApi(() => api.suppliers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const columns = [
    { key: 'at', label: 'When', width: 118, sortable: false, render: (r) => day(r.at) },
    {
      key: 'kind',
      label: 'What',
      width: 128,
      sortable: false,
      render: (r) => {
        const k = KIND[r.kind] ?? { label: r.kind, tone: 'info' };
        return <StatusPill tone={k.tone}>{k.label}</StatusPill>;
      },
    },
    {
      key: 'reference',
      label: 'Document',
      width: 160,
      sortable: false,
      render: (r) => (
        <Link className="sku" to={KIND[r.kind]?.to(r) ?? '#'}>{r.reference}</Link>
      ),
    },
    {
      key: 'supplier',
      label: 'Supplier',
      sortable: false,
      render: (r) => (
        <>
          <strong>{r.supplier}</strong>
          {r.warehouse && <div className="tiny muted">{r.warehouse}</div>}
        </>
      ),
    },
    { key: 'detail', label: 'Detail', sortable: false, render: (r) => <span className="tiny">{r.detail}</span> },
    {
      key: 'quantity',
      label: 'Quantity',
      align: 'right',
      width: 104,
      sortable: false,
      render: (r) => {
        if (r.quantity === null) return <span className="muted">—</span>;
        /* Negative means it went back out. Shown with its sign so
           a return never reads as another delivery. */
        const out = r.quantity < 0;
        return (
          <span className="num" style={out ? { color: 'var(--warn)' } : undefined}>
            {out ? '−' : '+'}{qty(Math.abs(r.quantity))}
          </span>
        );
      },
    },
    {
      key: 'amount',
      label: 'Value',
      align: 'right',
      width: 124,
      sortable: false,
      render: (r) => (r.amount === null ? <span className="muted">—</span> : <span className="num">{money(r.amount)}</span>),
    },
    {
      key: 'status',
      label: 'State',
      width: 132,
      sortable: false,
      render: (r) => {
        const label = PO_STATUS[r.status]?.label ?? INVOICE_STATUS[r.status]?.label
          ?? r.status.toLowerCase();
        return <span className="tiny">{label}</span>;
      },
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Every purchase document in the order it happened: what was ordered, what
            arrived, what went back and what the studio was billed for. The three
            kinds routinely disagree, and seeing them on one timeline is how the
            disagreement becomes obvious.
          </p>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(r) => r.kind + ':' + r.id}
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
        emptyTitle="Nothing yet"
        emptyNote="Raise a purchase order and it will appear here."
        filters={(
          <>
            <select className="select" value={kind} onChange={(e) => reset(setKind)(e.target.value)} aria-label="Kind">
              <option value="all">Everything</option>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="select" value={supplierId}
              onChange={(e) => reset(setSupplierId)(e.target.value)} aria-label="Supplier">
              <option value="all">All suppliers</option>
              {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="select" value={warehouseId}
              onChange={(e) => reset(setWarehouseId)(e.target.value)} aria-label="Warehouse">
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <input className="input" type="date" value={from}
              onChange={(e) => reset(setFrom)(e.target.value)} aria-label="From" style={{ width: 146 }} />
            <input className="input" type="date" value={to}
              onChange={(e) => reset(setTo)(e.target.value)} aria-label="To" style={{ width: 146 }} />
          </>
        )}
      />

      {list.data?.truncated && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          This timeline is assembled from four separate queries, each taking a bounded
          slice, so a very long history is truncated rather than loaded whole. Narrow
          the supplier or the date range to be sure of seeing everything.
        </p>
      )}
    </>
  );
}
