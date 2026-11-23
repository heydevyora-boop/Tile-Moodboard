import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { Failed } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { QUOTATION_STATUS, SO_STATUS, SI_STATUS } from '../data/salesStatus.js';

/* ============================================================
   SALES HISTORY — EVERY DOCUMENT ON ONE TIMELINE
   ============================================================
   Quotations, orders, invoices, dispatches and returns
   interleaved by date, mirroring purchase history.
   ============================================================ */

const KIND = {
  QUOTATION: { label: 'Quotation', tone: 'inert', to: (r) => '/quotations?open=' + r.id },
  ORDER: { label: 'Order', tone: 'info', to: (r) => '/sales-orders?open=' + r.id },
  INVOICE: { label: 'Invoice', tone: 'inert', to: (r) => '/sales-invoices?open=' + r.id },
  DISPATCH: { label: 'Dispatched', tone: 'ok', to: (r) => '/delivery-challans?open=' + r.id },
  RETURN: { label: 'Returned', tone: 'warn', to: (r) => '/sales-returns?open=' + r.id },
};

export default function SalesHistory() {
  const [kind, setKind] = useState('all');
  const [customerId, setCustomerId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const query = useMemo(() => ({
    kind, customerId, warehouseId, from: from || undefined, to: to || undefined, page, pageSize,
  }), [kind, customerId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.sales.history(query), [JSON.stringify(query)]);
  const customers = useApi(() => api.customers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const columns = [
    { key: 'at', label: 'When', width: 118, sortable: false, render: (r) => day(r.at) },
    {
      key: 'kind', label: 'What', width: 120, sortable: false,
      render: (r) => { const k = KIND[r.kind] ?? { label: r.kind, tone: 'info' }; return <StatusPill tone={k.tone}>{k.label}</StatusPill>; },
    },
    {
      key: 'reference', label: 'Document', width: 150, sortable: false,
      render: (r) => <Link className="sku" to={KIND[r.kind]?.to(r) ?? '#'}>{r.reference}</Link>,
    },
    {
      key: 'customer', label: 'Customer', sortable: false,
      render: (r) => (<><strong>{r.customer}</strong>{r.warehouse && <div className="tiny muted">{r.warehouse}</div>}</>),
    },
    { key: 'detail', label: 'Detail', sortable: false, render: (r) => <span className="tiny">{r.detail}</span> },
    {
      key: 'quantity', label: 'Quantity', align: 'right', width: 104, sortable: false,
      render: (r) => {
        if (r.quantity === null) return <span className="muted">—</span>;
        const out = r.quantity < 0;
        return <span className="num" style={out ? { color: 'var(--warn)' } : undefined}>{out ? '−' : '+'}{qty(Math.abs(r.quantity))}</span>;
      },
    },
    {
      key: 'amount', label: 'Value', align: 'right', width: 124, sortable: false,
      render: (r) => (r.amount === null ? <span className="muted">—</span> : <span className="num">{money(r.amount)}</span>),
    },
    {
      key: 'status', label: 'State', width: 132, sortable: false,
      render: (r) => {
        const label = QUOTATION_STATUS[r.status]?.label ?? SO_STATUS[r.status]?.label
          ?? SI_STATUS[r.status]?.label ?? r.status.toLowerCase();
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
            Every sales document in the order it happened: what was quoted, what was
            ordered, what shipped, what was billed and what came back. One timeline,
            so the chain from quote to cash is visible without opening five screens.
          </p>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(r) => r.kind + ':' + r.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        emptyTitle="Nothing yet"
        emptyNote="Raise a quotation or a sales order and it will appear here."
        filters={(
          <>
            <select className="select" value={kind} onChange={(e) => reset(setKind)(e.target.value)} aria-label="Kind">
              <option value="all">Everything</option>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="select" value={customerId} onChange={(e) => reset(setCustomerId)(e.target.value)} aria-label="Customer">
              <option value="all">All customers</option>
              {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="select" value={warehouseId} onChange={(e) => reset(setWarehouseId)(e.target.value)} aria-label="Warehouse">
              <option value="all">All warehouses</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <input className="input" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} aria-label="From" style={{ width: 146 }} />
            <input className="input" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} aria-label="To" style={{ width: 146 }} />
          </>
        )}
      />

      {list.data?.truncated && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          This timeline is assembled from five separate queries, each taking a
          bounded slice, so a very long history is truncated rather than loaded
          whole. Narrow the customer or the date range to be sure of seeing everything.
        </p>
      )}
    </>
  );
}
