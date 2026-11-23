import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, day } from '../lib/format.js';
import { DISPOSITION } from '../data/salesStatus.js';

/* ============================================================
   SALES RETURNS — STOCK COMING BACK FROM A CUSTOMER
   ============================================================
   THREE DISPOSITIONS, three different effects on stock: accepted
   good stock goes back to sellable (one movement), damaged stock
   is physically back but held out of the sellable count (two
   movements), and a rejected claim moves NOTHING -- the goods are
   not treated as having come back at all. One order line may
   split across all three in a single return.
   ============================================================ */

export default function SalesReturns() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const soParam = params.get('so');

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [returning, setReturning] = useState(null);   // sales order id
  const [entry, setEntry] = useState({});   // { [lineId]: { ACCEPTED_GOOD, DAMAGED, REJECTED } }
  const [returnDate, setReturnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ search: search || undefined, customerId, page, pageSize }), [search, customerId, page, pageSize]);

  const list = useApi(() => api.salesReturns.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.salesReturns.get(openId), [openId], { skip: !openId });
  const customers = useApi(() => api.customers.options(), []);
  const returnable = useApi(() => api.salesOrders.returnable(returning), [returning], { skip: !returning });
  const dispatchedOrders = useApi(
    () => api.salesOrders.list({ status: 'PARTIALLY_DISPATCHED,FULLY_DISPATCHED,CLOSED', pageSize: 100 }),
    [list.data],
  );

  useEffect(() => { if (soParam) setReturning(soParam); }, [soParam]);

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const closeForm = () => {
    setReturning(null); setEntry({}); setReason(''); setError(null);
    const n = new URLSearchParams(params); n.delete('so'); setParams(n, { replace: true });
  };

  const reset = (fn) => (v) => { fn(v); setPage(1); };
  const cellOf = (lineId, disp) => entry[lineId]?.[disp] ?? '';
  const setCell = (lineId, disp, v) => setEntry({ ...entry, [lineId]: { ...entry[lineId], [disp]: v } });

  const post = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const lines = [];
      for (const [lineId, dispositions] of Object.entries(entry)) {
        for (const [disposition, v] of Object.entries(dispositions)) {
          if (Number(v) > 0) lines.push({ salesOrderLineId: lineId, disposition, quantity: v });
        }
      }
      const created = await api.salesReturns.post({ salesOrderId: returning, returnDate, reason, lines });
      closeForm(); list.reload(); open(created.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'returnNo', label: 'Return', width: 140, sortable: false, render: (r) => <span className="sku">{r.returnNo}</span> },
    { key: 'customer', label: 'Customer', sortable: false, render: (r) => (<><strong>{r.customer?.name}</strong><div className="tiny muted">into {r.warehouse?.name}</div></>) },
    { key: 'returnDate', label: 'Received', width: 112, sortable: false, render: (r) => day(r.returnDate) },
    { key: 'reason', label: 'Why', sortable: false, render: (r) => <span className="tiny">{r.reason}</span> },
    { key: 'totalQuantity', label: 'Quantity', align: 'right', width: 100, sortable: false, render: (r) => <strong className="num">{qty(r.totalQuantity ?? 0)}</strong> },
    { key: 'status', label: 'State', width: 110, sortable: false, render: (r) => <StatusPill tone={r.status === 'POSTED' ? 'ok' : 'inert'}>{r.status.toLowerCase()}</StatusPill> },
    { key: 'actions', label: '', width: 92, sortable: false, render: (r) => <button className="btn btn-sm" onClick={() => open(r.id)}>Open</button> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;
  const d = detail.data;
  const r = returnable.data;
  const hasAnyQuantity = Object.values(entry).some((ds) => Object.values(ds ?? {}).some((v) => Number(v) > 0));

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Stock coming back from a customer. Only <strong>accepted good</strong> and{' '}
            <strong>damaged</strong> goods move any stock &mdash; a <strong>rejected</strong>{' '}
            claim moves nothing at all. The original dispatch is never edited; the
            return sits beside it.
          </p>
        </div>
        <div className="page-actions">
          <select className="select" value="" onChange={(e) => e.target.value && setReturning(e.target.value)} aria-label="Return against an order">
            <option value="">Return against an order…</option>
            {(dispatchedOrders.data?.rows ?? []).map((o) => <option key={o.id} value={o.id}>{o.orderNo} — {o.customer?.name}</option>)}
          </select>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(r) => r.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search} onSearch={reset(setSearch)} searchPlaceholder="Search return number, customer, reason…"
        emptyTitle="No sales returns" emptyNote="Nothing has come back from a customer."
        filters={(
          <select className="select" value={customerId} onChange={(e) => reset(setCustomerId)(e.target.value)} aria-label="Customer">
            <option value="all">All customers</option>
            {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      />

      {/* ── raise one ── */}
      <Modal
        open={Boolean(returning)} wide onClose={closeForm}
        title={r ? 'Return against ' + r.salesOrder.orderNo : 'Sales return'}
        subtitle="Posting this may move stock immediately, through the append-only ledger."
        footer={(
          <>
            <button className="btn" onClick={closeForm} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="sr-form" type="submit" disabled={busy || !hasAnyQuantity || !String(reason).trim()}>
              {busy ? 'Posting…' : 'Post return'}
            </button>
          </>
        )}
      >
        {returnable.loading && <p className="muted">Reading the order…</p>}
        <FieldErrors error={error} />
        {r && (
          <form id="sr-form" onSubmit={post} className="stack">
            <div className="grid-2">
              <div className="field"><label htmlFor="sr-date">Return date</label>
                <input id="sr-date" className="input" type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></div>
              <div className="field"><label htmlFor="sr-reason">Reason</label>
                <input id="sr-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer found a shade mismatch on part of the order." required /></div>
            </div>

            {r.lines.length === 0 ? (
              <p className="tiny muted">Nothing on this order is eligible to come back — it is either not dispatched yet or already fully returned.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th><th>Product</th>
                    <th style={{ textAlign: 'right' }}>Dispatched</th>
                    <th style={{ textAlign: 'right' }}>Eligible</th>
                    <th style={{ textAlign: 'right' }}>Accepted good</th>
                    <th style={{ textAlign: 'right' }}>Damaged</th>
                    <th style={{ textAlign: 'right' }}>Rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.salesOrderLineId}>
                      <td><span className="sku">{l.sku}</span></td>
                      <td>{l.name}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{qty(l.dispatchedQuantity)}</td>
                      <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.eligibleQuantity)}</strong></td>
                      {['ACCEPTED_GOOD', 'DAMAGED', 'REJECTED'].map((disp) => (
                        <td key={disp} style={{ textAlign: 'right' }}>
                          <input className="input" type="number" min="0" step="0.001" style={{ width: 92 }}
                            value={cellOf(l.salesOrderLineId, disp)} onChange={(e) => setCell(l.salesOrderLineId, disp, e.target.value)}
                            aria-label={DISPOSITION[disp].label + ' for ' + l.sku} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="tiny muted">
              <strong>Accepted good</strong> goes back to sellable stock.{' '}
              <strong>Damaged</strong> is physically back but held out of the sellable
              count.{' '}
              <strong>Rejected</strong> moves nothing &mdash; the claim is refused and
              the goods stay with the customer.
            </p>
          </form>
        )}
      </Modal>

      {/* ── one return ── */}
      <Modal
        open={Boolean(openId)} wide onClose={closeDetail}
        title={d ? d.returnNo : 'Sales return'}
        subtitle={d ? d.customer.name + ' → ' + d.warehouse.name : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="summary-strip">
              <div><span className="kpi-label">Received</span><strong>{day(d.returnDate)}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.postedBy ?? d.receivedBy ?? '—'}</strong></div>
              <div><span className="kpi-label">Against</span><strong>{d.salesOrder?.orderNo ?? '—'}</strong></div>
            </div>
            <p className="tiny muted" style={{ marginTop: 10 }}><strong>Reason:</strong> {d.reason}</p>

            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Quantity</th><th>Disposition</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                    <td>{(() => { const s = DISPOSITION[l.disposition]; return <StatusPill tone={s.tone}>{s.label}</StatusPill>; })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4 style={{ margin: '18px 0 6px' }}>What it did to stock</h4>
            {d.movements.length === 0 ? (
              <p className="tiny muted">No stock movements are recorded under this return — expected when every line was rejected.</p>
            ) : (
              <table className="table">
                <thead><tr><th>Entry</th><th>Code</th><th>Movement</th><th style={{ textAlign: 'right' }}>Quantity</th><th style={{ textAlign: 'right' }}>Was</th><th style={{ textAlign: 'right' }}>Became</th></tr></thead>
                <tbody>
                  {d.movements.map((m) => (
                    <tr key={m.id}>
                      <td><span className="sku">{m.entryNo}</span></td>
                      <td><span className="sku">{m.sku}</span></td>
                      <td className="tiny">{m.movementType.toLowerCase().replace(/_/g, ' ')}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{qty(m.quantity)}</td>
                      <td className="num muted" style={{ textAlign: 'right' }}>{qty(m.balanceBefore)}</td>
                      <td className="num" style={{ textAlign: 'right' }}><strong>{qty(m.balanceAfter)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="tiny muted" style={{ marginTop: 8 }}>
              <Link to={'/ledger?referenceNo=' + encodeURIComponent(d.returnNo)}>See it in the ledger</Link>.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
