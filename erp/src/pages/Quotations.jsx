import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { QUOTATION_STATUS } from '../data/salesStatus.js';

/* ============================================================
   QUOTATIONS
   ============================================================
   A QUOTATION MOVES NO STOCK, AND CANNOT CREATE AN ORDER ON ITS
   OWN. The server enforces both -- this screen's "Convert" button
   is the one path from a quote to an order, and it is a deliberate
   action, never automatic on acceptance.
   ============================================================ */

const EMPTY_LINE = { productId: '', sku: '', name: '', uom: '', quantity: '', unitPrice: '', discountPercent: '' };

export default function Quotations() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const openId = params.get('open');
  const statusParam = params.get('status') || 'all';

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [revising, setRevising] = useState(null);
  const [acting, setActing] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // ── create / revise form state ──
  const [customerIdForm, setCustomerIdForm] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const [sku, setSku] = useState('');
  const [lookup, setLookup] = useState('');
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [discount, setDiscount] = useState('');

  const query = useMemo(() => ({
    search: search || undefined, status: statusParam, customerId,
    from: from || undefined, to: to || undefined, page, pageSize,
  }), [search, statusParam, customerId, from, to, page, pageSize]);

  const list = useApi(() => api.quotations.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.quotations.get(openId), [openId], { skip: !openId });
  const customers = useApi(() => api.customers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  useEffect(() => {
    const t = setTimeout(() => setLookup(sku.trim()), 250);
    return () => clearTimeout(t);
  }, [sku]);
  const matches = useApi(() => api.products.list({ search: lookup, pageSize: 12 }), [lookup], { skip: lookup.length < 2 });
  const chosen = (matches.data?.rows ?? []).find((p) => p.sku.toUpperCase() === sku.trim().toUpperCase());

  const setStatus = (value) => {
    const n = new URLSearchParams(params);
    if (value === 'all') n.delete('status'); else n.set('status', value);
    setParams(n, { replace: true });
    setPage(1);
  };
  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const resetForm = () => {
    setCustomerIdForm(''); setWarehouseId(''); setQuotationDate(new Date().toISOString().slice(0, 10));
    setExpiryDate(''); setNotes(''); setLines([]); setSku(''); setQuantity(''); setRate(''); setDiscount('');
  };

  const startCreate = () => { resetForm(); setError(null); setCreating(true); };
  const startRevise = (q) => {
    resetForm();
    setCustomerIdForm(q.customer.id);
    setWarehouseId(q.warehouse?.id ?? '');
    setLines(q.lines.map((l) => ({
      productId: l.productId, sku: l.sku, name: l.name, uom: l.uom,
      quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent,
    })));
    setError(null);
    setRevising(q);
  };

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

  const bodyOf = () => ({
    customerId: customerIdForm, warehouseId: warehouseId || null,
    quotationDate, expiryDate: expiryDate || null, notes: notes || null,
    lines: lines.map((l) => ({
      productId: l.productId, quantity: l.quantity, uom: l.uom,
      unitPrice: l.unitPrice === '' ? null : l.unitPrice, discountPercent: l.discountPercent,
    })),
  });

  const submitCreate = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const created = await api.quotations.create(bodyOf());
      setCreating(false); list.reload(); open(created.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const submitRevision = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      // Reachable only via the "Revise" button, which the detail
      // view shows only once a quotation has left DRAFT -- update()
      // is draft-only, so revise() is always the right call here.
      const created = await api.quotations.revise(revising.id, bodyOf());
      setRevising(null); list.reload(); open(created.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const act = async () => {
    setBusy(true); setError(null);
    try {
      const { kind, q } = acting;
      if (kind === 'send') await api.quotations.send(q.id);
      if (kind === 'accept') await api.quotations.respond(q.id, 'ACCEPTED');
      if (kind === 'reject') await api.quotations.respond(q.id, 'REJECTED');
      if (kind === 'expire') await api.quotations.respond(q.id, 'EXPIRED');
      if (kind === 'cancel') await api.quotations.cancel(q.id, reason);
      if (kind === 'convert') { const r = await api.quotations.convert(q.id); navigate('/sales-orders?open=' + r.newOrder.id); return; }
      setActing(null); setReason(''); list.reload(); if (openId) detail.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'quotationNo', label: 'Quotation', width: 140, sortable: false, render: (q) => <span className="sku">{q.quotationNo}</span> },
    {
      key: 'customer', label: 'Customer', sortable: false,
      render: (q) => (<><strong>{q.customer?.name}</strong>{q.revisionNo > 1 && <div className="tiny muted">revision {q.revisionNo}</div>}</>),
    },
    { key: 'quotationDate', label: 'Dated', width: 112, sortable: false, render: (q) => day(q.quotationDate) },
    { key: 'expiryDate', label: 'Expires', width: 112, sortable: false, render: (q) => q.expiryDate ? day(q.expiryDate) : <span className="muted">—</span> },
    { key: 'grandTotal', label: 'Value', align: 'right', width: 120, sortable: false, render: (q) => <strong className="num">{money(q.totals.grandTotal)}</strong> },
    {
      key: 'status', label: 'State', width: 140, sortable: false,
      render: (q) => { const s = QUOTATION_STATUS[q.status] ?? { label: q.status, tone: 'info' }; return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>; },
    },
    { key: 'actions', label: '', width: 90, sortable: false, render: (q) => <button className="btn btn-sm" onClick={() => open(q.id)}>Open</button> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;
  const d = detail.data;
  const ready = customerIdForm && lines.length > 0 && lines.every((l) => l.unitPrice !== '' && l.unitPrice !== null);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What has been offered to a customer. <strong>A quotation moves no
            stock</strong>, and an accepted quotation never turns itself into an
            order &mdash; converting it is a deliberate action, below.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={startCreate}>New quotation</button>
        </div>
      </div>

      <div className="viewbar">
        {[['all', 'Everything'], ...Object.entries(QUOTATION_STATUS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
          <button key={k} className={'viewtab' + (statusParam === k ? ' is-on' : '')} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(q) => q.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search} onSearch={reset(setSearch)} searchPlaceholder="Search quotation number, customer…"
        emptyTitle="No quotations" emptyNote="Nothing matches these filters."
        filters={(
          <select className="select" value={customerId} onChange={(e) => reset(setCustomerId)(e.target.value)} aria-label="Customer">
            <option value="all">All customers</option>
            {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      />

      {/* ── create / revise form ── */}
      {(creating || revising) && (
        <Modal
          open wide
          onClose={() => { setCreating(false); setRevising(null); }}
          title={revising ? 'Revise ' + revising.quotationNo : 'New quotation'}
          subtitle={revising
            ? 'Creates a new revision. The one being revised is marked cancelled; both stay visible.'
            : 'Saved as a draft. Nothing is committed and no stock moves until this is converted to an order.'}
          footer={(
            <>
              <button className="btn" onClick={() => { setCreating(false); setRevising(null); }} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" form="quote-form" type="submit" disabled={busy || !ready}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        >
          <FieldErrors error={error} />
          <form id="quote-form" onSubmit={revising ? submitRevision : submitCreate} className="stack">
            <div className="grid-2">
              <div className="field">
                <label htmlFor="q-customer">Customer</label>
                <select id="q-customer" className="select" value={customerIdForm} onChange={(e) => setCustomerIdForm(e.target.value)} required disabled={Boolean(revising)}>
                  <option value="">Choose…</option>
                  {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-warehouse">Preferred warehouse</label>
                <select id="q-warehouse" className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Not decided yet</option>
                  {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <span className="tiny muted">Required before this can be converted to an order.</span>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="q-date">Quotation date</label>
                <input id="q-date" className="input" type="date" value={quotationDate} onChange={(e) => setQuotationDate(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="q-expiry">Valid until</label>
                <input id="q-expiry" className="input" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
              </div>
            </div>

            <div className="field">
              <label>Lines</label>
              {lines.length === 0
                ? <p className="tiny muted">Nothing added yet.</p>
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
                <label htmlFor="q-sku">Product code</label>
                <input id="q-sku" className="input" list="q-product-list" value={sku} onChange={(e) => setSku(e.target.value)} autoComplete="off" placeholder="DV-1001" />
                <datalist id="q-product-list">{(matches.data?.rows ?? []).map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}</datalist>
                <span className="tiny muted">{chosen ? chosen.name : 'Type two characters to search.'}</span>
              </div>
              <div className="field">
                <label htmlFor="q-qty">Quantity</label>
                <input id="q-qty" className="input" type="number" min="0.001" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="q-rate">Rate</label>
                <input id="q-rate" className="input" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
                  placeholder={chosen?.sellingPrice ? String(chosen.sellingPrice) : ''} />
                <span className="tiny muted">Blank uses the product&rsquo;s selling price.</span>
              </div>
              <div className="field">
                <label htmlFor="q-disc">Discount %</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="q-disc" className="input" type="number" min="0" max="100" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                  <button type="button" className="btn" onClick={addLine} disabled={!chosen || !(Number(quantity) > 0)}>Add</button>
                </div>
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-notes">Notes</label>
              <input id="q-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}

      {/* ── detail ── */}
      <Modal
        open={Boolean(openId)} wide onClose={closeDetail}
        title={d ? d.quotationNo : 'Quotation'}
        subtitle={d ? d.customer.name : ''}
        footer={(
          <>
            <button className="btn" onClick={closeDetail}>Close</button>
            {d?.allowed.send && <button className="btn" onClick={() => { setActing({ kind: 'send', q: d }); setError(null); }}>Send to customer</button>}
            {d?.allowed.respond && (
              <>
                <button className="btn" onClick={() => { setActing({ kind: 'reject', q: d }); setError(null); }}>Rejected</button>
                <button className="btn" onClick={() => { setActing({ kind: 'expire', q: d }); setError(null); }}>Expired</button>
                <button className="btn" onClick={() => { setActing({ kind: 'accept', q: d }); setError(null); }}>Accepted</button>
              </>
            )}
            {d?.allowed.revise && <button className="btn" onClick={() => { closeDetail(); startRevise(d); }}>Revise</button>}
            {d?.allowed.cancel && <button className="btn" onClick={() => { setActing({ kind: 'cancel', q: d }); setError(null); }}>Cancel</button>}
            {d?.allowed.convert && (
              <button className="btn btn-primary" onClick={() => { setActing({ kind: 'convert', q: d }); setError(null); }}>
                Convert to sales order
              </button>
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
              <div><strong>{QUOTATION_STATUS[d.status]?.label}.</strong> {QUOTATION_STATUS[d.status]?.note}</div>
            </div>
            <div className="summary-strip">
              <div><span className="kpi-label">Dated</span><strong>{day(d.quotationDate)}</strong></div>
              <div><span className="kpi-label">Valid until</span><strong>{d.expiryDate ? day(d.expiryDate) : '—'}</strong></div>
              <div><span className="kpi-label">Warehouse</span><strong>{d.warehouse?.name ?? 'Not decided'}</strong></div>
              <div><span className="kpi-label">Revision</span><strong>{d.revisionNo}</strong></div>
            </div>
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
              <div><span className="kpi-label">Taxable</span><strong className="num">{money(d.totals.taxableTotal)}</strong></div>
              <div><span className="kpi-label">Tax</span><strong className="num">{money(d.totals.taxTotal)}</strong></div>
              <div><span className="kpi-label">Grand total</span><strong className="num">{money(d.totals.grandTotal)}</strong></div>
            </div>
            {d.convertedToOrders?.length > 0 && (
              <p className="tiny muted" style={{ marginTop: 12 }}>
                Converted to <Link to={'/sales-orders?open=' + d.convertedToOrders[0].id}>{d.convertedToOrders[0].orderNo}</Link>.
              </p>
            )}
          </>
        )}
      </Modal>

      {/* ── confirm a transition ── */}
      <Modal
        open={Boolean(acting)} onClose={() => { setActing(null); setError(null); }}
        title={acting ? ({ send: 'Send to customer', accept: 'Mark accepted', reject: 'Mark rejected', expire: 'Mark expired', cancel: 'Cancel quotation', convert: 'Convert to sales order' }[acting.kind] + ' — ' + acting.q.quotationNo) : ''}
        footer={(
          <>
            <button className="btn" onClick={() => setActing(null)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={act} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</button>
          </>
        )}
      >
        <FieldErrors error={error} />
        {acting?.kind === 'convert' && (
          <>
            <p>This raises a draft sales order from this quotation, at the price and tax already frozen on it, and marks the quotation converted.</p>
            <p className="tiny muted"><strong>No stock moves.</strong> The order still has to be submitted, approved and reserved before anything can be dispatched.</p>
          </>
        )}
        {acting?.kind === 'cancel' && (
          <div className="field">
            <label htmlFor="q-cancel-reason">Reason</label>
            <input id="q-cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer withdrew interest." />
          </div>
        )}
        {['send', 'accept', 'reject', 'expire'].includes(acting?.kind) && <p>This updates the quotation&rsquo;s status. No stock is affected.</p>}
      </Modal>
    </>
  );
}
