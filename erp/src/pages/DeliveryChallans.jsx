import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, day } from '../lib/format.js';
import { DC_STATUS } from '../data/salesStatus.js';

/* ============================================================
   DISPATCH / DELIVERY CHALLAN — THE ONLY SCREEN THAT ISSUES STOCK
   ============================================================
   Posting a challan releases the reservation and then posts
   OUTWARD, in that order, through the same stock service every
   movement in this ERP goes through. It cannot be undone
   afterwards: the ledger refuses it. A wrongly dispatched
   delivery is corrected by a sales return instead.
   ============================================================ */

export default function DeliveryChallans() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const soParam = params.get('so');

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [dispatching, setDispatching] = useState(null);   // sales order id
  const [entry, setEntry] = useState({});
  const [dispatchDate, setDispatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [transporter, setTransporter] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [trackingRef, setTrackingRef] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [allowUnreservedApproved, setAllowUnreservedApproved] = useState(false);
  const [allowUnreservedReason, setAllowUnreservedReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined, customerId, warehouseId,
    from: from || undefined, to: to || undefined, page, pageSize,
  }), [search, customerId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.deliveryChallans.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.deliveryChallans.get(openId), [openId], { skip: !openId });
  const customers = useApi(() => api.customers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);
  const dispatchable = useApi(() => api.salesOrders.dispatchable(dispatching), [dispatching], { skip: !dispatching });
  const openOrders = useApi(
    () => api.salesOrders.list({ status: 'RESERVED,PARTIALLY_RESERVED,PARTIALLY_DISPATCHED', pageSize: 100 }),
    [list.data],
  );

  useEffect(() => { if (soParam) setDispatching(soParam); }, [soParam]);

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const closeForm = () => {
    setDispatching(null); setEntry({}); setTransporter(''); setVehicleNumber(''); setTrackingRef('');
    setReceiverName(''); setAllowUnreservedApproved(false); setAllowUnreservedReason(''); setError(null);
    const n = new URLSearchParams(params); n.delete('so'); setParams(n, { replace: true });
  };

  const reset = (fn) => (v) => { fn(v); setPage(1); };
  const lineOf = (id) => entry[id] ?? '';
  const setLine = (id, v) => setEntry({ ...entry, [id]: v });

  const post = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const lines = Object.entries(entry)
        .filter(([, v]) => Number(v) > 0)
        .map(([salesOrderLineId, v]) => ({ salesOrderLineId, quantity: v }));
      const created = await api.deliveryChallans.dispatch({
        salesOrderId: dispatching, dispatchDate, transporter: transporter || null,
        vehicleNumber: vehicleNumber || null, trackingRef: trackingRef || null,
        receiverName: receiverName || null,
        allowUnreservedApproved: allowUnreservedApproved || undefined,
        allowUnreservedReason: allowUnreservedApproved ? allowUnreservedReason : undefined,
        lines,
      });
      closeForm(); list.reload(); openOrders.reload(); open(created.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'challanNo', label: 'Challan', width: 140, sortable: false, render: (c) => <span className="sku">{c.challanNo}</span> },
    { key: 'customer', label: 'Customer', sortable: false, render: (c) => (<><strong>{c.customer?.name}</strong><div className="tiny muted">from {c.warehouse?.name}</div></>) },
    { key: 'order', label: 'Against', width: 130, sortable: false, render: (c) => (c.salesOrder ? <span className="sku">{c.salesOrder.orderNo}</span> : <span className="muted">—</span>) },
    { key: 'dispatchDate', label: 'Dispatched', width: 112, sortable: false, render: (c) => day(c.dispatchDate) },
    { key: 'trackingRef', label: 'Tracking', width: 120, sortable: false, render: (c) => c.trackingRef ? <span className="sku">{c.trackingRef}</span> : <span className="muted">—</span> },
    { key: 'totalQuantity', label: 'Quantity', align: 'right', width: 100, sortable: false, render: (c) => <strong className="num">{qty(c.totalQuantity ?? 0)}</strong> },
    { key: 'dispatchedBy', label: 'By', width: 130, sortable: false, render: (c) => c.dispatchedBy ?? '—' },
    { key: 'status', label: 'State', width: 110, sortable: false, render: (c) => { const s = DC_STATUS[c.status] ?? { label: c.status, tone: 'info' }; return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>; } },
    { key: 'actions', label: '', width: 92, sortable: false, render: (c) => <button className="btn btn-sm" onClick={() => open(c.id)}>Open</button> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;
  const d = detail.data;
  const r = dispatchable.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Goods physically leaving the building. <strong>This is the only sales
            document that changes stock</strong> &mdash; not the order, not the
            approval, not the reservation, not the invoice. Each posted challan
            first releases its reservation and then posts the stock out, in that
            order, through the append-only ledger.
          </p>
        </div>
        <div className="page-actions">
          <select className="select" value="" onChange={(e) => e.target.value && setDispatching(e.target.value)} aria-label="Dispatch against an order">
            <option value="">Dispatch against an order…</option>
            {(openOrders.data?.rows ?? []).map((o) => <option key={o.id} value={o.id}>{o.orderNo} — {o.customer?.name}</option>)}
          </select>
        </div>
      </div>

      {(openOrders.data?.rows ?? []).length === 0 && (
        <div className="notice notice-info">
          <span aria-hidden="true">●</span>
          <div>No reserved order is waiting to ship. A challan can only be posted against a reserved — or already partly dispatched — order.</div>
        </div>
      )}

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(c) => c.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search} onSearch={reset(setSearch)} searchPlaceholder="Search challan, order, tracking, customer…"
        emptyTitle="Nothing dispatched yet" emptyNote="When goods leave against a reserved order, the challan appears here."
        filters={(
          <>
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

      {/* ── dispatching ── */}
      <Modal
        open={Boolean(dispatching)} wide onClose={closeForm}
        title={r ? 'Dispatch against ' + r.salesOrder.orderNo : 'Dispatch'}
        subtitle="Posting this moves stock. It is written to the append-only ledger and cannot be undone."
        footer={(
          <>
            <button className="btn" onClick={closeForm} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="dc-form" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post dispatch'}</button>
          </>
        )}
      >
        {dispatchable.loading && <p className="muted">Reading the order…</p>}
        <FieldErrors error={error} />
        {r && !r.salesOrder.dispatchable && (
          <div className="notice notice-danger">
            <span aria-hidden="true">●</span>
            <div>This order is {r.salesOrder.status.toLowerCase().replace(/_/g, ' ')}, so goods cannot be dispatched against it.</div>
          </div>
        )}
        {r && r.salesOrder.dispatchable && (
          <form id="dc-form" onSubmit={post} className="stack">
            <div className="grid-3">
              <div className="field"><label htmlFor="dc-date">Dispatch date</label>
                <input id="dc-date" className="input" type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} /></div>
              <div className="field"><label htmlFor="dc-transporter">Transporter</label>
                <input id="dc-transporter" className="input" value={transporter} onChange={(e) => setTransporter(e.target.value)} /></div>
              <div className="field"><label htmlFor="dc-vehicle">Vehicle number</label>
                <input id="dc-vehicle" className="input" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} /></div>
            </div>
            <div className="grid-3">
              <div className="field"><label htmlFor="dc-tracking">Tracking / LR number</label>
                <input id="dc-tracking" className="input" value={trackingRef} onChange={(e) => setTrackingRef(e.target.value)} /></div>
              <div className="field"><label htmlFor="dc-receiver">Receiver</label>
                <input id="dc-receiver" className="input" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} /></div>
              <div className="field"><label>From</label><input className="input" value={r.salesOrder.warehouse?.name ?? ''} disabled /></div>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th style={{ textAlign: 'right' }}>Reserved</th>
                  <th style={{ textAlign: 'right' }}>Outstanding</th>
                  <th style={{ textAlign: 'right' }}>Dispatch now</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.salesOrderLineId}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.orderedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.reservedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.outstandingQuantity)}</strong></td>
                    <td style={{ textAlign: 'right' }}>
                      <input className="input" type="number" min="0" step="0.001" style={{ width: 100 }}
                        value={lineOf(l.salesOrderLineId)} onChange={(e) => setLine(l.salesOrderLineId, e.target.value)}
                        aria-label={'Dispatch for ' + l.sku} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="field">
              <label htmlFor="dc-over" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <input id="dc-over" type="checkbox" checked={allowUnreservedApproved} onChange={(e) => setAllowUnreservedApproved(e.target.checked)} />
                {' '}Dispatch beyond what is reserved
              </label>
              <span className="tiny muted">Refused by default. Somebody has to say so, and the reason goes in the audit log.</span>
              {allowUnreservedApproved && (
                <input className="input" style={{ marginTop: 6 }} value={allowUnreservedReason} onChange={(e) => setAllowUnreservedReason(e.target.value)}
                  placeholder="Customer collecting in person; agreed to ship unreserved stock." />
              )}
            </div>
          </form>
        )}
      </Modal>

      {/* ── one challan, and the stock it moved ── */}
      <Modal
        open={Boolean(openId)} wide onClose={closeDetail}
        title={d ? d.challanNo : 'Delivery challan'}
        subtitle={d ? d.customer.name + ' ← ' + d.warehouse.name : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="summary-strip">
              <div><span className="kpi-label">Dispatched</span><strong>{day(d.dispatchDate)}</strong></div>
              <div><span className="kpi-label">Against</span><strong>{d.salesOrder?.orderNo ?? '—'}</strong></div>
              <div><span className="kpi-label">Invoice</span><strong>{d.salesInvoice?.invoiceNo ?? '—'}</strong></div>
              <div><span className="kpi-label">Tracking</span><strong>{d.trackingRef ?? '—'}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.dispatchedBy ?? '—'}</strong></div>
            </div>

            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Quantity</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}><td><span className="sku">{l.sku}</span></td><td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.quantity)} {l.uom?.toLowerCase()}</strong></td></tr>
                ))}
              </tbody>
            </table>

            <h4 style={{ margin: '18px 0 6px' }}>What it did to stock</h4>
            {d.movements.length === 0 ? (
              <p className="tiny muted">No stock movements are recorded under this challan. For a dispatched challan that would be a discrepancy worth investigating.</p>
            ) : (
              <table className="table">
                <thead><tr><th>Entry</th><th>Code</th><th>Movement</th><th style={{ textAlign: 'right' }}>Quantity</th><th style={{ textAlign: 'right' }}>Was</th><th style={{ textAlign: 'right' }}>Became</th></tr></thead>
                <tbody>
                  {d.movements.map((m) => (
                    <tr key={m.id}>
                      <td><span className="sku">{m.entryNo}</span></td>
                      <td><span className="sku">{m.sku}</span></td>
                      <td><StatusPill tone={m.movementType === 'OUTWARD' ? 'warn' : 'ok'}>{m.movementType === 'OUTWARD' ? 'Outward' : 'Reservation released'}</StatusPill></td>
                      <td className="num" style={{ textAlign: 'right' }}>{qty(m.quantity)}</td>
                      <td className="num muted" style={{ textAlign: 'right' }}>{qty(m.balanceBefore)}</td>
                      <td className="num" style={{ textAlign: 'right' }}><strong>{qty(m.balanceAfter)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Read back from the stock ledger under this challan&rsquo;s reference, not
              recomputed from the lines above.{' '}
              <Link to={'/ledger?referenceNo=' + encodeURIComponent(d.challanNo)}>See it in the ledger</Link>.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
