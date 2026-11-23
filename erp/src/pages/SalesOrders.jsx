import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day, stamp } from '../lib/format.js';
import { SO_STATUS, SALES_GST_TREATMENT } from '../data/salesStatus.js';

/* ============================================================
   SALES ORDERS
   ============================================================
   RAISING ONE MOVES NO STOCK. Approving one moves no stock.
   Reserving moves the RESERVED dimension only, not a physical
   unit. The only document that moves physical stock is a
   delivery challan, raised from the "Dispatch" screen once an
   order is reserved.
   ============================================================ */

export default function SalesOrders() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const statusParam = params.get('status') || 'all';

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('all');
  const [warehouseId, setWarehouseId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [acting, setActing] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined, status: statusParam, customerId, warehouseId,
    from: from || undefined, to: to || undefined, page, pageSize,
  }), [search, statusParam, customerId, warehouseId, from, to, page, pageSize]);

  const list = useApi(() => api.salesOrders.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.salesOrders.get(openId), [openId], { skip: !openId });
  const customers = useApi(() => api.customers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  const setStatus = (value) => {
    const n = new URLSearchParams(params);
    if (value === 'all') n.delete('status'); else n.set('status', value);
    setParams(n, { replace: true });
    setPage(1);
  };
  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const act = async () => {
    setBusy(true); setError(null);
    try {
      const { kind, order } = acting;
      if (kind === 'submit') await api.salesOrders.submit(order.id);
      if (kind === 'approve') await api.salesOrders.approve(order.id);
      if (kind === 'cancel') await api.salesOrders.cancel(order.id, reason);
      if (kind === 'close') await api.salesOrders.close(order.id, reason);
      setActing(null); setReason(''); list.reload(); if (openId) detail.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'orderNo', label: 'Order', width: 130, sortable: false, render: (o) => <span className="sku">{o.orderNo}</span> },
    {
      key: 'customer', label: 'Customer', sortable: false,
      render: (o) => (<><strong>{o.customer?.name}</strong><div className="tiny muted">{o.warehouse?.name} · {SALES_GST_TREATMENT[o.gst?.treatment]?.label ?? o.gst?.treatment}</div></>),
    },
    { key: 'orderDate', label: 'Raised', width: 110, sortable: false, render: (o) => day(o.orderDate) },
    { key: 'lineCount', label: 'Lines', align: 'right', width: 70, sortable: false, render: (o) => <span className="num">{qty(o.lineCount ?? 0)}</span> },
    { key: 'dispatchCount', label: 'Dispatches', align: 'right', width: 90, sortable: false, render: (o) => (o.dispatchCount ? <span className="num">{qty(o.dispatchCount)}</span> : <span className="muted">—</span>) },
    {
      key: 'grandTotal', label: 'Value', align: 'right', width: 126, sortable: false,
      render: (o) => (<><strong className="num">{money(o.totals.grandTotal)}</strong><div className="tiny muted num">{money(o.totals.taxTotal)} tax</div></>),
    },
    {
      key: 'status', label: 'State', width: 150, sortable: false,
      render: (o) => { const s = SO_STATUS[o.status] ?? { label: o.status, tone: 'info' }; return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>; },
    },
    { key: 'actions', label: '', width: 90, sortable: false, render: (o) => <button className="btn btn-sm" onClick={() => open(o.id)}>Open</button> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;
  const d = detail.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What customers have committed to buy. <strong>None of this is stock.</strong>{' '}
            An order &mdash; even an approved one &mdash; is a commitment, not a
            delivery; stock moves only when a{' '}
            <Link to="/delivery-challans">delivery challan</Link> is dispatched.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>New sales order</button>
        </div>
      </div>

      <div className="viewbar">
        {[['all', 'Everything'], ...Object.entries(SO_STATUS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
          <button key={k} className={'viewtab' + (statusParam === k ? ' is-on' : '')} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(o) => o.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search} onSearch={reset(setSearch)} searchPlaceholder="Search order number, customer, product…"
        emptyTitle="No sales orders" emptyNote="Nothing matches these filters."
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

      {creating && (
        <SalesOrderForm
          onClose={() => setCreating(false)}
          onSaved={(created) => { setCreating(false); list.reload(); open(created.id); }}
        />
      )}

      {/* ── one order ── */}
      <Modal
        open={Boolean(openId)} wide onClose={closeDetail}
        title={d ? d.orderNo : 'Sales order'}
        subtitle={d ? d.customer.name + ' → ' + d.warehouse.name : ''}
        footer={(
          <>
            <button className="btn" onClick={closeDetail}>Close</button>
            {d?.allowed.submit && <button className="btn" onClick={() => { setActing({ kind: 'submit', order: d }); setError(null); }}>Submit for approval</button>}
            {d?.allowed.cancel && <button className="btn" onClick={() => { setActing({ kind: 'cancel', order: d }); setError(null); }}>Cancel order</button>}
            {d?.allowed.close && <button className="btn" onClick={() => { setActing({ kind: 'close', order: d }); setError(null); }}>Close short</button>}
            {d?.allowed.reserve && <button className="btn" onClick={() => setReserving(true)}>Reserve stock</button>}
            {d?.allowed.dispatch && <Link className="btn" to={'/delivery-challans?so=' + d.id}>Dispatch</Link>}
            {d?.allowed.approve && <button className="btn btn-primary" onClick={() => { setActing({ kind: 'approve', order: d }); setError(null); }}>Approve</button>}
          </>
        )}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="notice notice-info">
              <span aria-hidden="true">●</span>
              <div>
                <strong>{SO_STATUS[d.status]?.label}.</strong> {SO_STATUS[d.status]?.note}
                {d.dispatchCount > 0 && <> {d.dispatchCount} delivery challan(s) against it.</>}
              </div>
            </div>

            <div className="summary-strip">
              <div><span className="kpi-label">Raised</span><strong>{day(d.orderDate)}</strong></div>
              <div><span className="kpi-label">Expected dispatch</span><strong>{d.expectedDispatchDate ? day(d.expectedDispatchDate) : '—'}</strong></div>
              <div><span className="kpi-label">Terms</span><strong>{d.paymentTerms ?? '—'}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.createdBy ?? '—'}</strong></div>
              <div><span className="kpi-label">Approved by</span><strong>{d.approvedBy ?? '—'}</strong></div>
            </div>

            <p className="tiny muted" style={{ marginTop: 10 }}>
              <strong>{SALES_GST_TREATMENT[d.gst.treatment]?.label}.</strong> {SALES_GST_TREATMENT[d.gst.treatment]?.note}{' '}
              Seller state {d.gst.sellerStateCode ?? '—'}, place of supply {d.gst.placeOfSupplyCode ?? '—'}.
            </p>

            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>#</th><th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Reserved</th><th style={{ textAlign: 'right' }}>Dispatched</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td><td><span className="sku">{l.sku}</span></td><td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(l.unitPrice)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{money(l.lineTotal)}</strong></td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.reservedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {qty(l.dispatchedQuantity)}
                      {l.outstandingQuantity > 0 && <div className="tiny" style={{ color: 'var(--warn)' }}>{qty(l.outstandingQuantity)} due</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="summary-strip" style={{ marginTop: 12 }}>
              <div><span className="kpi-label">Taxable</span><strong className="num">{money(d.totals.taxableTotal)}</strong></div>
              {d.gst.treatment === 'INTER_STATE'
                ? <div><span className="kpi-label">IGST</span><strong className="num">{money(d.totals.igstTotal)}</strong></div>
                : (<><div><span className="kpi-label">CGST</span><strong className="num">{money(d.totals.cgstTotal)}</strong></div><div><span className="kpi-label">SGST</span><strong className="num">{money(d.totals.sgstTotal)}</strong></div></>)}
              <div><span className="kpi-label">Grand total</span><strong className="num">{money(d.totals.grandTotal)}</strong></div>
            </div>

            {d.deliveryChallans.length > 0 && (
              <>
                <h4 style={{ margin: '18px 0 6px' }}>Delivery challans</h4>
                <table className="table">
                  <thead><tr><th>Challan</th><th>Date</th><th>By</th><th>State</th></tr></thead>
                  <tbody>
                    {d.deliveryChallans.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="sku" to={'/delivery-challans?open=' + c.id}>{c.challanNo}</Link></td>
                        <td className="tiny">{day(c.dispatchDate)}</td>
                        <td className="tiny">{c.dispatchedBy ?? '—'}</td>
                        <td className="tiny">{c.status.toLowerCase()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {d.invoices.length > 0 && (
              <>
                <h4 style={{ margin: '18px 0 6px' }}>Invoices</h4>
                <table className="table">
                  <thead><tr><th>Invoice</th><th>Date</th><th>State</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                  <tbody>
                    {d.invoices.map((i) => (
                      <tr key={i.id}>
                        <td><Link className="sku" to={'/sales-invoices?open=' + i.id}>{i.invoiceNo}</Link></td>
                        <td className="tiny">{day(i.invoiceDate)}</td>
                        <td className="tiny">{i.status.toLowerCase()}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{money(i.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {d.cancelReason && <p className="tiny muted" style={{ marginTop: 12 }}>Cancelled by {d.cancelledBy} on {stamp(d.cancelledAt)}: {d.cancelReason}</p>}
            {d.closeReason && <p className="tiny muted" style={{ marginTop: 12 }}>Closed by {d.closedBy} on {stamp(d.closedAt)}: {d.closeReason}</p>}
          </>
        )}
      </Modal>

      {/* ── reserve stock ── */}
      {reserving && d && (
        <ReservationPanel
          order={d}
          onClose={() => setReserving(false)}
          onDone={() => { setReserving(false); detail.reload(); list.reload(); }}
        />
      )}

      {/* ── confirm a transition ── */}
      <Modal
        open={Boolean(acting)} onClose={() => { setActing(null); setError(null); }}
        title={acting ? ({ submit: 'Submit for approval', approve: 'Approve', cancel: 'Cancel order', close: 'Close short' }[acting.kind] + ' — ' + acting.order.orderNo) : ''}
        footer={(
          <>
            <button className="btn" onClick={() => setActing(null)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={act} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</button>
          </>
        )}
      >
        <FieldErrors error={error} />
        {acting?.kind === 'approve' && (
          <>
            <p>This commits {acting.order.customer.name} to {money(acting.order.totals.grandTotal)}, and the order may then be reserved and dispatched.</p>
            <p className="tiny muted"><strong>No stock moves.</strong> Approving says what will be sold, not what has shipped.</p>
          </>
        )}
        {acting?.kind === 'submit' && <p>The order goes forward for approval and can no longer be edited freely.</p>}
        {acting?.kind === 'cancel' && (
          <>
            <p>Cancelling says this order never happened. Refused once anything has been dispatched against it &mdash; use Close short instead.</p>
            <div className="field"><label htmlFor="so-reason">Reason</label>
              <input id="so-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer cancelled the order." /></div>
          </>
        )}
        {acting?.kind === 'close' && (
          <>
            <p>Closing finishes the order off at whatever has shipped. Any remaining reservation is released back to available stock.</p>
            <div className="field"><label htmlFor="so-close">Reason</label>
              <input id="so-close" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer only wants the partial delivery." /></div>
          </>
        )}
      </Modal>
    </>
  );
}

/* ============================================================
   STOCK AVAILABILITY & RESERVATION
   ============================================================
   RESERVING MOVES THE RESERVED DIMENSION, NOT PHYSICAL STOCK.
   Shown for every line, read fresh from inventory_balances, so a
   quantity that cannot actually be promised is visible before
   the attempt rather than after a refusal.
   ============================================================ */

function ReservationPanel({ order, onClose, onDone }) {
  const avail = useApi(() => api.salesOrders.availability(order.id), [order.id]);
  const [qtys, setQtys] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const lines = avail.data?.lines ?? [];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const reqLines = lines
        .filter((l) => Number(qtys[l.salesOrderLineId]) > 0)
        .map((l) => ({ salesOrderLineId: l.salesOrderLineId, quantity: qtys[l.salesOrderLineId] }));
      if (reqLines.length === 0) { setBusy(false); return; }
      await api.salesOrders.reserve(order.id, reqLines, 'ui:' + Date.now());
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal
      open wide onClose={onClose}
      title={'Reserve stock — ' + order.orderNo}
      subtitle="Promises the quantity to this order without moving a single physical unit."
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" form="reserve-form" type="submit" disabled={busy}>{busy ? 'Reserving…' : 'Reserve'}</button>
        </>
      )}
    >
      {avail.loading && <p className="muted">Reading live stock…</p>}
      <FieldErrors error={error} />
      {avail.data && (
        <form id="reserve-form" onSubmit={submit} className="stack">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th><th>Product</th>
                <th style={{ textAlign: 'right' }}>Ordered</th>
                <th style={{ textAlign: 'right' }}>Unreserved</th>
                <th style={{ textAlign: 'right' }}>Available at warehouse</th>
                <th style={{ textAlign: 'right' }}>Reserve now</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.salesOrderLineId}>
                  <td><span className="sku">{l.sku}</span></td>
                  <td>{l.name}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{qty(l.orderedQuantity)}</td>
                  <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.unreservedQuantity)}</strong></td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {qty(l.warehouseAvailable)}
                    {l.warehouseDamaged > 0 && <div className="tiny muted">{qty(l.warehouseDamaged)} damaged, excluded</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input className="input" type="number" min="0" step="0.001" style={{ width: 100 }}
                      value={qtys[l.salesOrderLineId] ?? ''}
                      onChange={(e) => setQtys({ ...qtys, [l.salesOrderLineId]: e.target.value })}
                      aria-label={'Reserve for ' + l.sku} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted">
            Available here is on-hand less what is already reserved or damaged elsewhere
            &mdash; physical stock is not the same as what can actually be promised.
          </p>
        </form>
      )}
    </Modal>
  );
}

/* ============================================================
   RAISING A SALES ORDER
   ============================================================ */

function SalesOrderForm({ onClose, onSaved }) {
  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedDispatchDate, setExpectedDispatchDate] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [otherCharges, setOtherCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);

  const [sku, setSku] = useState('');
  const [lookup, setLookup] = useState('');
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [discount, setDiscount] = useState('');

  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const customers = useApi(() => api.customers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  useEffect(() => { const t = setTimeout(() => setLookup(sku.trim()), 250); return () => clearTimeout(t); }, [sku]);
  const matches = useApi(() => api.products.list({ search: lookup, pageSize: 12 }), [lookup], { skip: lookup.length < 2 });

  const customer = (customers.data?.rows ?? []).find((c) => c.id === customerId);
  const warehouse = (warehouses.data?.rows ?? []).find((w) => w.id === warehouseId);

  useEffect(() => { if (customer && !paymentTerms) setPaymentTerms(customer.paymentTerms ?? ''); }, [customer, paymentTerms]);
  useEffect(() => {
    const all = warehouses.data?.rows ?? [];
    if (!warehouseId && all.length === 1) setWarehouseId(all[0].id);
  }, [warehouses.data, warehouseId]);

  // A PREVIEW: selling warehouse state against the customer's
  // SHIPPING state -- not billing -- the same asymmetric rule
  // money.mjs's salesGstTreatmentFor() enforces server-side.
  const treatment = useMemo(() => {
    const a = warehouse?.stateCode;
    const b = customer?.shippingStateCode ?? customer?.stateCode;
    if (!a || !b) return null;
    return a === b ? 'INTRA_STATE' : 'INTER_STATE';
  }, [customer, warehouse]);

  const chosen = (matches.data?.rows ?? []).find((p) => p.sku.toUpperCase() === sku.trim().toUpperCase());

  const addLine = () => {
    if (!chosen || !(Number(quantity) > 0)) return;
    setLines([...lines, {
      productId: chosen.id, sku: chosen.sku, name: chosen.name, uom: chosen.uom,
      quantity: Number(quantity),
      unitPrice: rate === '' ? (chosen.sellingPrice ?? '') : rate,
      discountPercent: discount === '' ? 0 : Number(discount),
    }]);
    setSku(''); setQuantity(''); setRate(''); setDiscount('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const created = await api.salesOrders.create({
        customerId, warehouseId, orderDate,
        expectedDispatchDate: expectedDispatchDate || null,
        paymentTerms: paymentTerms || null,
        otherCharges: otherCharges === '' ? 0 : otherCharges,
        notes: notes || null,
        lines: lines.map((l) => ({
          productId: l.productId, quantity: l.quantity, uom: l.uom,
          unitPrice: l.unitPrice === '' ? null : l.unitPrice, discountPercent: l.discountPercent,
        })),
      });
      onSaved(created);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const ready = customerId && warehouseId && lines.length > 0 && lines.every((l) => l.unitPrice !== '' && l.unitPrice !== null);

  return (
    <Modal
      open wide onClose={onClose}
      title="New sales order"
      subtitle="Saved as a draft. Nothing is committed and no stock moves until it is approved, reserved and dispatched."
      footer={(
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" form="so-form" type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : 'Save as draft'}</button>
        </>
      )}
    >
      <FieldErrors error={error} />
      <form id="so-form" onSubmit={submit} className="stack">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="so-customer">Customer</label>
            <select id="so-customer" className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Choose…</option>
              {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="tiny muted">{customer ? (customer.gstin ? customer.gstin : 'No GSTIN: still taxed as a plain B2C sale.') : 'Only active customers are listed.'}</span>
          </div>
          <div className="field">
            <label htmlFor="so-warehouse">Dispatch from</label>
            <select id="so-warehouse" className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="">Choose…</option>
              {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <span className="tiny muted">Compared against the customer&rsquo;s shipping state, not billing, to decide the tax.</span>
          </div>
        </div>

        {treatment && (
          <div className="notice notice-info">
            <span aria-hidden="true">●</span>
            <div><strong>{SALES_GST_TREATMENT[treatment].label}.</strong> {SALES_GST_TREATMENT[treatment].note}</div>
          </div>
        )}
        {customer && warehouse && !treatment && (
          <div className="notice notice-warn">
            <span aria-hidden="true">●</span>
            <div>A GST state code is missing on the warehouse or the customer&rsquo;s shipping address, so the tax cannot be worked out. Saving will be refused rather than guessed at.</div>
          </div>
        )}

        <div className="grid-3">
          <div className="field"><label htmlFor="so-date">Order date</label>
            <input id="so-date" className="input" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></div>
          <div className="field"><label htmlFor="so-expected">Expected dispatch</label>
            <input id="so-expected" className="input" type="date" value={expectedDispatchDate} onChange={(e) => setExpectedDispatchDate(e.target.value)} /></div>
          <div className="field"><label htmlFor="so-terms">Payment terms</label>
            <input id="so-terms" className="input" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="30 days" /></div>
        </div>

        <div className="field">
          <label>Lines</label>
          {lines.length === 0
            ? <p className="tiny muted">Nothing added yet. Each SKU is tracked as its own line.</p>
            : (
              <table className="table">
                <thead><tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Disc %</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.productId + ':' + i}>
                      <td><span className="sku">{l.sku}</span></td>
                      <td>{l.name}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {l.unitPrice === '' || l.unitPrice === null ? <span style={{ color: 'var(--danger)' }}>rate needed</span> : money(Number(l.unitPrice))}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>{l.discountPercent || '—'}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div className="grid-4">
          <div className="field">
            <label htmlFor="so-sku">Product code</label>
            <input id="so-sku" className="input" list="so-product-list" value={sku} onChange={(e) => setSku(e.target.value)} autoComplete="off" placeholder="DV-1001" />
            <datalist id="so-product-list">{(matches.data?.rows ?? []).map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}</datalist>
            <span className="tiny muted">{chosen ? chosen.name : 'Type two characters to search.'}</span>
          </div>
          <div className="field"><label htmlFor="so-qty">Quantity</label>
            <input id="so-qty" className="input" type="number" min="0.001" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="so-rate">Rate</label>
            <input id="so-rate" className="input" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder={chosen?.sellingPrice ? String(chosen.sellingPrice) : ''} />
            <span className="tiny muted">Blank uses the product&rsquo;s selling price.</span>
          </div>
          <div className="field">
            <label htmlFor="so-disc">Discount %</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="so-disc" className="input" type="number" min="0" max="100" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              <button type="button" className="btn" onClick={addLine} disabled={!chosen || !(Number(quantity) > 0)}>Add</button>
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="field"><label htmlFor="so-other">Other charges</label>
            <input id="so-other" className="input" type="number" min="0" step="0.01" value={otherCharges} onChange={(e) => setOtherCharges(e.target.value)} /></div>
          <div className="field"><label htmlFor="so-notes">Notes</label>
            <input id="so-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
      </form>
    </Modal>
  );
}
