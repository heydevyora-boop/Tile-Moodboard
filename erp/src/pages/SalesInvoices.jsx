import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { SI_STATUS, SALES_GST_TREATMENT, PAYMENT_STATUS } from '../data/salesStatus.js';

/* ============================================================
   SALES INVOICES — A CLAIM FOR PAYMENT, NOT A DELIVERY
   ============================================================
   RECORDING ONE MOVES NO STOCK. Not one movement. The price and
   tax on each line are the sales order line's own frozen figures,
   not today's Product Master price -- an invoice is a snapshot
   of what was agreed, and stays that way even if prices change
   later.
   ============================================================ */

export default function SalesInvoices() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const soParam = params.get('so');

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [invoicing, setInvoicing] = useState(null);   // sales order id
  const [entry, setEntry] = useState({});
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [otherCharges, setOtherCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined, customerId, from: from || undefined, to: to || undefined, page, pageSize,
  }), [search, customerId, from, to, page, pageSize]);

  const list = useApi(() => api.salesInvoices.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.salesInvoices.get(openId), [openId], { skip: !openId });
  const customers = useApi(() => api.customers.options(), []);
  const invoiceable = useApi(() => api.salesOrders.invoiceable(invoicing), [invoicing], { skip: !invoicing });
  const openOrders = useApi(
    () => api.salesOrders.list({ status: 'CONFIRMED,PARTIALLY_RESERVED,RESERVED,PARTIALLY_DISPATCHED,FULLY_DISPATCHED', pageSize: 100 }),
    [list.data],
  );

  useEffect(() => { if (soParam) setInvoicing(soParam); }, [soParam]);

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const closeForm = () => {
    setInvoicing(null); setEntry({}); setDueDate(''); setOtherCharges(''); setNotes(''); setError(null);
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
      const created = await api.salesInvoices.create({
        salesOrderId: invoicing, invoiceDate, dueDate: dueDate || null,
        otherCharges: otherCharges === '' ? 0 : otherCharges, notes: notes || null, lines,
      });
      closeForm(); list.reload(); open(created.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const doCancel = async () => {
    setBusy(true); setError(null);
    try {
      await api.salesInvoices.cancel(cancelling.id, reason);
      setCancelling(null); setReason(''); list.reload(); if (openId) detail.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'invoiceNo', label: 'Invoice', width: 140, sortable: false, render: (i) => <span className="sku">{i.invoiceNo}</span> },
    { key: 'customer', label: 'Customer', sortable: false, render: (i) => (<><strong>{i.customer?.name}</strong>{i.salesOrder && <div className="tiny muted">against {i.salesOrder.orderNo}</div>}</>) },
    { key: 'invoiceDate', label: 'Dated', width: 112, sortable: false, render: (i) => day(i.invoiceDate) },
    { key: 'dueDate', label: 'Due', width: 112, sortable: false, render: (i) => i.dueDate ? day(i.dueDate) : <span className="muted">—</span> },
    { key: 'grandTotal', label: 'Value', align: 'right', width: 120, sortable: false, render: (i) => <strong className="num">{money(i.grandTotal)}</strong> },
    {
      key: 'paymentStatus', label: 'Payment', width: 120, sortable: false,
      render: (i) => (i.paymentStatus ? (() => { const s = PAYMENT_STATUS[i.paymentStatus] ?? { label: i.paymentStatus, tone: 'info' }; return <StatusPill tone={s.tone}>{s.label}</StatusPill>; })() : <span className="muted">—</span>),
    },
    { key: 'status', label: 'State', width: 110, sortable: false, render: (i) => { const s = SI_STATUS[i.status] ?? { label: i.status, tone: 'info' }; return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>; } },
    { key: 'actions', label: '', width: 92, sortable: false, render: (i) => <button className="btn btn-sm" onClick={() => open(i.id)}>Open</button> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;
  const d = detail.data;
  const r = invoiceable.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            A claim for payment, not a delivery. <strong>Creating an invoice moves
            no stock</strong> &mdash; the sales order can be invoiced before, during
            or after dispatch, and each invoice freezes the price and tax it was
            raised with.
          </p>
        </div>
        <div className="page-actions">
          <select className="select" value="" onChange={(e) => e.target.value && setInvoicing(e.target.value)} aria-label="Invoice against an order">
            <option value="">Invoice against an order…</option>
            {(openOrders.data?.rows ?? []).map((o) => <option key={o.id} value={o.id}>{o.orderNo} — {o.customer?.name}</option>)}
          </select>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(i) => i.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search} onSearch={reset(setSearch)} searchPlaceholder="Search invoice, order, customer…"
        emptyTitle="No invoices" emptyNote="When a sales order is invoiced, it appears here."
        filters={(
          <>
            <select className="select" value={customerId} onChange={(e) => reset(setCustomerId)(e.target.value)} aria-label="Customer">
              <option value="all">All customers</option>
              {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="input" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} aria-label="From" style={{ width: 146 }} />
            <input className="input" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} aria-label="To" style={{ width: 146 }} />
          </>
        )}
      />

      {/* ── create ── */}
      <Modal
        open={Boolean(invoicing)} wide onClose={closeForm}
        title={r ? 'Invoice against ' + r.salesOrder.orderNo : 'Sales invoice'}
        subtitle="Posted immediately. No stock is moved by this document."
        footer={(
          <>
            <button className="btn" onClick={closeForm} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="si-form" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post invoice'}</button>
          </>
        )}
      >
        {invoiceable.loading && <p className="muted">Reading the order…</p>}
        <FieldErrors error={error} />
        {r && !r.salesOrder.invoiceable && (
          <div className="notice notice-danger"><span aria-hidden="true">●</span>
            <div>This order is {r.salesOrder.status.toLowerCase().replace(/_/g, ' ')}, which is too early to invoice. It must be confirmed first.</div></div>
        )}
        {r && r.salesOrder.invoiceable && (
          <form id="si-form" onSubmit={post} className="stack">
            <div className="grid-3">
              <div className="field"><label htmlFor="si-date">Invoice date</label>
                <input id="si-date" className="input" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></div>
              <div className="field"><label htmlFor="si-due">Due date</label>
                <input id="si-due" className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                <span className="tiny muted">Blank follows the customer&rsquo;s credit period.</span></div>
              <div className="field"><label htmlFor="si-other">Other charges</label>
                <input id="si-other" className="input" type="number" min="0" step="0.01" value={otherCharges} onChange={(e) => setOtherCharges(e.target.value)} /></div>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Code</th><th>Product</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th style={{ textAlign: 'right' }}>Invoiced</th>
                  <th style={{ textAlign: 'right' }}>Outstanding</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Invoice now</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.salesOrderLineId}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.orderedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.invoicedQuantity)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{qty(l.outstandingQuantity)}</strong></td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(l.unitPrice)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <input className="input" type="number" min="0" step="0.001" style={{ width: 100 }}
                        value={lineOf(l.salesOrderLineId)} onChange={(e) => setLine(l.salesOrderLineId, e.target.value)}
                        aria-label={'Invoice for ' + l.sku} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="field"><label htmlFor="si-notes">Notes</label>
              <input id="si-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </form>
        )}
      </Modal>

      {/* ── detail ── */}
      <Modal
        open={Boolean(openId)} wide onClose={closeDetail}
        title={d ? d.invoiceNo : 'Sales invoice'}
        subtitle={d ? d.customer.name : ''}
        footer={(
          <>
            <button className="btn" onClick={closeDetail}>Close</button>
            {d?.status === 'POSTED' && (
              <button className="btn" onClick={() => { setCancelling(d); setError(null); }}>Cancel invoice</button>
            )}
          </>
        )}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="notice notice-info">
              <span aria-hidden="true">●</span>
              <div><strong>{SI_STATUS[d.status]?.label}.</strong> {SI_STATUS[d.status]?.note}</div>
            </div>
            <div className="summary-strip">
              <div><span className="kpi-label">Dated</span><strong>{day(d.invoiceDate)}</strong></div>
              <div><span className="kpi-label">Due</span><strong>{d.dueDate ? day(d.dueDate) : '—'}</strong></div>
              <div><span className="kpi-label">Order</span><strong>{d.salesOrder?.orderNo ?? '—'}</strong></div>
              <div><span className="kpi-label">Paid</span><strong>{money(d.paidAmount)}</strong></div>
              <div><span className="kpi-label">Outstanding</span><strong>{money(d.outstandingAmount)}</strong></div>
            </div>
            <p className="tiny muted" style={{ marginTop: 10 }}>
              <strong>{SALES_GST_TREATMENT[d.gstTreatment]?.label}.</strong> {SALES_GST_TREATMENT[d.gstTreatment]?.note}
            </p>
            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>#</th><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td><td><span className="sku">{l.sku}</span></td><td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(l.unitPrice)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{money(l.lineTotal)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="summary-strip" style={{ marginTop: 12 }}>
              <div><span className="kpi-label">Taxable</span><strong className="num">{money(d.taxableTotal)}</strong></div>
              {d.gstTreatment === 'INTER_STATE'
                ? <div><span className="kpi-label">IGST</span><strong className="num">{money(d.igstTotal)}</strong></div>
                : (<><div><span className="kpi-label">CGST</span><strong className="num">{money(d.cgstTotal)}</strong></div><div><span className="kpi-label">SGST</span><strong className="num">{money(d.sgstTotal)}</strong></div></>)}
              <div><span className="kpi-label">Grand total</span><strong className="num">{money(d.grandTotal)}</strong></div>
            </div>
            {d.cancelReason && <p className="tiny muted" style={{ marginTop: 12 }}>Cancelled: {d.cancelReason}</p>}
            <p className="tiny muted" style={{ marginTop: 12 }}>
              <Link to={'/customer-payments?invoice=' + d.id}>Record a payment against this invoice</Link>.
            </p>
          </>
        )}
      </Modal>

      {/* ── cancel ── */}
      <Modal
        open={Boolean(cancelling)} onClose={() => { setCancelling(null); setError(null); }}
        title={cancelling ? 'Cancel ' + cancelling.invoiceNo : ''}
        footer={(<><button className="btn" onClick={() => setCancelling(null)} disabled={busy}>Back</button><button className="btn btn-primary" onClick={doCancel} disabled={busy}>{busy ? 'Working…' : 'Cancel invoice'}</button></>)}
      >
        <FieldErrors error={error} />
        <p className="tiny muted">Refused while any payment is recorded against it &mdash; that must be resolved first.</p>
        <div className="field"><label htmlFor="si-cancel-reason">Reason</label>
          <input id="si-cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raised against the wrong order." /></div>
      </Modal>
    </>
  );
}
