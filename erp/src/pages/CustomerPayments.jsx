import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, day } from '../lib/format.js';

/* ============================================================
   CUSTOMER PAYMENT TRACKING — BASIC, NOT AN ACCOUNTING SYSTEM
   ============================================================
   A payment is recorded against ONE posted invoice. There is no
   bank account and no allocation across several invoices at
   once; a customer paying for two invoices is two payment rows.
   The balance is never stored -- it is derived fresh from every
   payment against the invoice, every time it is shown, so there
   is nowhere for it to drift from the rows that produced it.
   ============================================================ */

const METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER'];
const METHOD_LABEL = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };

export default function CustomerPayments() {
  const [params, setParams] = useSearchParams();
  const invoiceParam = params.get('invoice');

  const [customerId, setCustomerId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [recording, setRecording] = useState(false);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    customerId, from: from || undefined, to: to || undefined, page, pageSize,
  }), [customerId, from, to, page, pageSize]);

  const list = useApi(() => api.customerPayments.list(query), [JSON.stringify(query)]);
  const customers = useApi(() => api.customers.options(), []);
  const openInvoices = useApi(
    () => api.salesInvoices.list({ status: 'POSTED', customerId, pageSize: 100 }),
    [customerId, list.data],
  );
  const balance = useApi(() => api.salesInvoices.balance(invoiceId), [invoiceId], { skip: !invoiceId });

  useEffect(() => { if (invoiceParam) { setInvoiceId(invoiceParam); setRecording(true); } }, [invoiceParam]);

  const reset = (fn) => (v) => { fn(v); setPage(1); };
  const closeForm = () => {
    setRecording(false); setInvoiceId(''); setAmount(''); setReference(''); setNotes(''); setError(null);
    const n = new URLSearchParams(params); n.delete('invoice'); setParams(n, { replace: true });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.customerPayments.record({ salesInvoiceId: invoiceId, amount, paymentDate, method, reference: reference || null, notes: notes || null });
      closeForm(); list.reload(); openInvoices.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'paymentDate', label: 'Received', width: 112, sortable: false, render: (p) => day(p.paymentDate) },
    { key: 'customer', label: 'Customer', sortable: false, render: (p) => <strong>{p.customer?.name}</strong> },
    { key: 'invoice', label: 'Against', width: 140, sortable: false, render: (p) => <span className="sku">{p.salesInvoice?.invoiceNo}</span> },
    { key: 'method', label: 'Method', width: 130, sortable: false, render: (p) => <span className="tiny">{METHOD_LABEL[p.method] ?? p.method}</span> },
    { key: 'reference', label: 'Reference', width: 140, sortable: false, render: (p) => p.reference ? <span className="sku">{p.reference}</span> : <span className="muted">—</span> },
    { key: 'amount', label: 'Amount', align: 'right', width: 130, sortable: false, render: (p) => <strong className="num">{money(p.amount)}</strong> },
    { key: 'recordedBy', label: 'By', width: 130, sortable: false, render: (p) => p.recordedBy ?? '—' },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const amountNum = Number(amount);
  const ready = invoiceId && amountNum > 0 && balance.data && amountNum <= balance.data.outstanding;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What customers have paid against posted invoices. <strong>This is basic
            tracking, not an accounting system</strong>: no bank account, no
            reconciliation, no allocation across invoices. Outstanding is always
            derived fresh from the payments against each invoice, never stored.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => { setRecording(true); setError(null); }}>Record a payment</button>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard label="Received" value={money(list.data?.summary.totalReceived ?? 0)} note="in the filtered range" />
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(p) => p.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        emptyTitle="No payments recorded" emptyNote="Record one against a posted invoice to start tracking receivables."
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

      {/* ── record ── */}
      <Modal
        open={recording} onClose={closeForm}
        title="Record a payment"
        subtitle="Against one posted invoice. A customer paying for two invoices is recorded as two separate payments."
        footer={(
          <>
            <button className="btn" onClick={closeForm} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="pay-form" type="submit" disabled={busy || !ready}>{busy ? 'Recording…' : 'Record payment'}</button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="pay-form" onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="pay-invoice">Invoice</label>
            <select id="pay-invoice" className="select" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} required>
              <option value="">Choose…</option>
              {(openInvoices.data?.rows ?? []).map((i) => (
                <option key={i.id} value={i.id}>{i.invoiceNo} — {i.customer?.name} — {money(i.outstandingAmount)} outstanding</option>
              ))}
            </select>
          </div>
          {balance.data && (
            <div className="notice notice-info">
              <span aria-hidden="true">●</span>
              <div>
                Invoice {balance.data.invoiceNo}: {money(balance.data.grandTotal)} total, {money(balance.data.paid)} already paid,{' '}
                <strong>{money(balance.data.outstanding)} outstanding</strong>.
              </div>
            </div>
          )}
          <div className="grid-3">
            <div className="field">
              <label htmlFor="pay-amount">Amount</label>
              <input id="pay-amount" className="input" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              {balance.data && amountNum > balance.data.outstanding && (
                <span className="tiny" style={{ color: 'var(--danger)' }}>More than the outstanding balance. This would be refused.</span>
              )}
            </div>
            <div className="field">
              <label htmlFor="pay-date">Received on</label>
              <input id="pay-date" className="input" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pay-method">Method</label>
              <select id="pay-method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </select>
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="pay-ref">Reference</label>
              <input id="pay-ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque number" />
            </div>
            <div className="field">
              <label htmlFor="pay-notes">Notes</label>
              <input id="pay-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}
