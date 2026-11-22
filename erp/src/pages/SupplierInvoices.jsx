import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { INVOICE_STATUS } from '../data/purchaseStatus.js';

/* ============================================================
   SUPPLIER INVOICES — A CLAIM FOR PAYMENT
   ============================================================
   RECORDING ONE CHANGES NO STOCK. An invoice is what the studio
   is being asked to pay for; a goods receipt is what actually
   arrived. They routinely disagree, and showing the disagreement
   is the entire point of keeping them apart.
   ============================================================ */

export default function SupplierInvoices() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [supplierId, setSupplierId] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({});
  const [acting, setActing] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined, status, supplierId, page, pageSize,
  }), [search, status, supplierId, page, pageSize]);

  const list = useApi(() => api.supplierInvoices.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.supplierInvoices.get(openId), [openId], { skip: !openId });
  const suppliers = useApi(() => api.suppliers.options(), []);
  const receipts = useApi(
    () => api.goodsReceipts.list({ status: 'POSTED', supplierId: form.supplierId ?? 'all', pageSize: 50 }),
    [form.supplierId],
    { skip: !form.supplierId },
  );

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.supplierInvoices.create({
        supplierId: form.supplierId,
        invoiceNo: form.invoiceNo,
        invoiceDate: form.invoiceDate,
        dueDate: form.dueDate || null,
        goodsReceiptNoteId: form.goodsReceiptNoteId || null,
        purchaseOrderId: form.purchaseOrderId || null,
        taxableAmount: form.taxableAmount || 0,
        taxAmount: form.taxAmount || 0,
        invoiceAmount: form.invoiceAmount,
        documentRef: form.documentRef || null,
        notes: form.notes || null,
      });
      setCreating(false);
      setForm({});
      list.reload();
      open(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.supplierInvoices.setStatus(acting.invoice.id, acting.status, note);
      setActing(null);
      setNote('');
      list.reload();
      if (openId) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'invoiceNo', label: 'Invoice', width: 160, sortable: false, render: (i) => <span className="sku">{i.invoiceNo}</span> },
    {
      key: 'supplier',
      label: 'Supplier',
      sortable: false,
      render: (i) => (
        <>
          <strong>{i.supplier?.name}</strong>
          <div className="tiny muted">
            {i.goodsReceiptNote ? 'receipt ' + i.goodsReceiptNote.grnNo : 'no receipt linked'}
            {i.purchaseOrder ? ' · order ' + i.purchaseOrder.orderNo : ''}
          </div>
        </>
      ),
    },
    { key: 'invoiceDate', label: 'Dated', width: 112, sortable: false, render: (i) => day(i.invoiceDate) },
    {
      key: 'dueDate',
      label: 'Due',
      width: 118,
      sortable: false,
      render: (i) => {
        if (!i.dueDate) return <span className="muted">—</span>;
        const overdue = new Date(i.dueDate) < new Date() && ['RECEIVED', 'MATCHED'].includes(i.status);
        return (
          <>
            {day(i.dueDate)}
            {overdue && <div className="tiny" style={{ color: 'var(--danger)' }}>overdue</div>}
          </>
        );
      },
    },
    {
      key: 'invoiceAmount',
      label: 'Amount',
      align: 'right',
      width: 130,
      sortable: false,
      render: (i) => <strong className="num">{money(i.invoiceAmount)}</strong>,
    },
    {
      key: 'status',
      label: 'State',
      width: 130,
      sortable: false,
      render: (i) => {
        const s = INVOICE_STATUS[i.status] ?? { label: i.status, tone: 'info' };
        return <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>;
      },
    },
    {
      key: 'actions',
      label: '',
      width: 92,
      sortable: false,
      render: (i) => <button className="btn btn-sm" onClick={() => open(i.id)}>Open</button>,
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const d = detail.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What suppliers are asking to be paid. <strong>Recording an invoice does
            not change stock</strong> &mdash; only a goods receipt does that. Keeping
            the two apart is what lets the system show you a supplier who invoiced
            for forty boxes and delivered thirty-eight.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => { setForm({}); setError(null); setCreating(true); }}>
            Record an invoice
          </button>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard label="Open invoices" value={qty(list.data?.summary.openInvoices ?? 0)}
          note="received or matched, not yet settled" />
        <KpiCard label="Open value" value={money(list.data?.summary.openValue ?? 0)} />
        <KpiCard label="On this page" value={qty(list.data?.rows.length ?? 0)} />
        <KpiCard label="Total recorded" value={qty(list.data?.total ?? 0)} />
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(i) => i.id}
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
        searchPlaceholder="Search invoice number, supplier, order, receipt…"
        emptyTitle="No supplier invoices"
        emptyNote="Record one when a supplier bills the studio."
        filters={(
          <>
            <select className="select" value={status} onChange={(e) => reset(setStatus)(e.target.value)} aria-label="State">
              <option value="all">Every state</option>
              {Object.entries(INVOICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="select" value={supplierId}
              onChange={(e) => reset(setSupplierId)(e.target.value)} aria-label="Supplier">
              <option value="all">All suppliers</option>
              {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </>
        )}
      />

      {/* ── record one ── */}
      <Modal
        open={creating}
        wide
        onClose={() => setCreating(false)}
        title="Record a supplier invoice"
        subtitle="No stock moves. This records what the studio is being asked to pay for."
        footer={(
          <>
            <button className="btn" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="inv-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Record it'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="inv-form" onSubmit={save} className="stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="i-supplier">Supplier</label>
              <select id="i-supplier" className="select" value={form.supplierId ?? ''}
                onChange={(e) => setForm({ ...form, supplierId: e.target.value, goodsReceiptNoteId: '' })} required>
                <option value="">Choose…</option>
                {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="i-no">Invoice number</label>
              <input id="i-no" className="input" value={form.invoiceNo ?? ''}
                onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} required />
              <span className="tiny muted">
                The supplier&rsquo;s own number. The same one twice from one supplier
                is refused &mdash; that is how an invoice gets paid twice.
              </span>
            </div>
          </div>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="i-date">Invoice date</label>
              <input id="i-date" className="input" type="date" value={form.invoiceDate ?? ''}
                onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="i-due">Due date</label>
              <input id="i-due" className="input" type="date" value={form.dueDate ?? ''}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              <span className="tiny muted">Left blank, it follows the supplier&rsquo;s credit period.</span>
            </div>
            <div className="field">
              <label htmlFor="i-amount">Invoice amount</label>
              <input id="i-amount" className="input" type="number" min="0" step="0.01"
                value={form.invoiceAmount ?? ''}
                onChange={(e) => setForm({ ...form, invoiceAmount: e.target.value })} required />
            </div>
          </div>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="i-taxable">Taxable amount</label>
              <input id="i-taxable" className="input" type="number" min="0" step="0.01"
                value={form.taxableAmount ?? ''}
                onChange={(e) => setForm({ ...form, taxableAmount: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="i-tax">Tax</label>
              <input id="i-tax" className="input" type="number" min="0" step="0.01"
                value={form.taxAmount ?? ''}
                onChange={(e) => setForm({ ...form, taxAmount: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="i-grn">Against receipt</label>
              <select id="i-grn" className="select" value={form.goodsReceiptNoteId ?? ''}
                onChange={(e) => setForm({ ...form, goodsReceiptNoteId: e.target.value })}
                disabled={!form.supplierId}>
                <option value="">Not linked</option>
                {(receipts.data?.rows ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.grnNo} — {day(r.receiptDate)}</option>
                ))}
              </select>
              <span className="tiny muted">
                Only posted receipts are listed: a draft is not evidence that anything arrived.
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="i-ref">Document reference</label>
            <input id="i-ref" className="input" value={form.documentRef ?? ''}
              onChange={(e) => setForm({ ...form, documentRef: e.target.value })}
              placeholder="Where the scanned invoice is filed" />
          </div>
        </form>
      </Modal>

      {/* ── one invoice, and the three-way match ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={d ? d.invoiceNo : 'Supplier invoice'}
        subtitle={d ? d.supplier.name : ''}
        footer={(
          <>
            <button className="btn" onClick={closeDetail}>Close</button>
            {d && d.status !== 'CANCELLED' && (
              <>
                <button className="btn" onClick={() => { setActing({ invoice: d, status: 'DISPUTED' }); setError(null); }}>
                  Dispute
                </button>
                <button className="btn btn-primary"
                  onClick={() => { setActing({ invoice: d, status: 'MATCHED' }); setError(null); }}>
                  Mark matched
                </button>
              </>
            )}
          </>
        )}
      >
        {detail.loading && <p className="muted">Reading…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="summary-strip">
              <div><span className="kpi-label">Dated</span><strong>{day(d.invoiceDate)}</strong></div>
              <div><span className="kpi-label">Due</span><strong>{d.dueDate ? day(d.dueDate) : '—'}</strong></div>
              <div><span className="kpi-label">Amount</span><strong className="num">{money(d.invoiceAmount)}</strong></div>
              <div><span className="kpi-label">Tax</span><strong className="num">{money(d.taxAmount)}</strong></div>
              <div><span className="kpi-label">State</span><strong>{INVOICE_STATUS[d.status]?.label}</strong></div>
            </div>

            {/* THE THREE-WAY MATCH, computed and never adjusted. */}
            <div
              className={'notice ' + (d.match?.state === 'AGREES' ? 'notice-ok'
                : d.match?.state === 'UNLINKED' || d.match?.state === 'NO_RECEIPT_VALUE' ? 'notice-info'
                  : 'notice-warn')}
              style={{ marginTop: 14 }}
            >
              <span aria-hidden="true">●</span>
              <div>
                <strong>
                  {{
                    AGREES: 'The invoice matches what was received.',
                    INVOICE_HIGHER: 'The invoice is higher than the goods received.',
                    INVOICE_LOWER: 'The invoice is lower than the goods received.',
                    UNLINKED: 'Not linked to an order or a receipt.',
                    NO_RECEIPT_VALUE: 'The receipt carries no costs to compare against.',
                  }[d.match?.state] ?? 'Not matched.'}
                </strong>
                <div className="tiny" style={{ marginTop: 4 }}>{d.match?.note}</div>
                {d.match?.receivedValue !== null && d.match?.receivedValue !== undefined && (
                  <div className="tiny num" style={{ marginTop: 4 }}>
                    Invoice {money(d.match.invoiceAmount)} · goods received{' '}
                    {money(d.match.receivedValue)}
                    {d.match.orderAmount !== null && <> · order {money(d.match.orderAmount)}</>}
                    {d.match.difference !== 0 && <> · difference {money(d.match.difference)}</>}
                  </div>
                )}
              </div>
            </div>

            <p className="tiny muted" style={{ marginTop: 12 }}>
              {d.goodsReceiptNote
                ? <>Against receipt <Link to={'/goods-receipts?open=' + d.goodsReceiptNote.id}>{d.goodsReceiptNote.grnNo}</Link>.</>
                : 'No receipt is linked to this invoice.'}
              {d.purchaseOrder && (
                <> Order <Link to={'/purchase-orders?open=' + d.purchaseOrder.id}>{d.purchaseOrder.orderNo}</Link>.</>
              )}
              {d.notes && <> {d.notes}</>}
            </p>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(acting)}
        onClose={() => { setActing(null); setError(null); }}
        title={acting ? (acting.status === 'MATCHED' ? 'Mark matched' : 'Dispute') + ' — ' + acting.invoice.invoiceNo : ''}
        footer={(
          <>
            <button className="btn" onClick={() => setActing(null)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={changeStatus} disabled={busy}>
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <p className="tiny muted">
          {acting?.status === 'MATCHED'
            ? 'Says a person has checked this invoice against what arrived and agrees with it.'
            : 'Says this invoice is being queried with the supplier. A reason is required.'}
        </p>
        <div className="field">
          <label htmlFor="i-note">{acting?.status === 'DISPUTED' ? 'What is being disputed' : 'Note'}</label>
          <input id="i-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
