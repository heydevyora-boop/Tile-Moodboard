import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { PO_STATUS } from '../data/purchaseStatus.js';

/* ============================================================
   SUPPLIERS — LIST AND DETAIL
   ============================================================
   THERE IS NO DELETE, and there is not going to be. A supplier
   with any purchase history cannot be removed without orphaning
   the orders, receipts and invoices that explain where stock and
   money went. Deactivating is the supported answer, and it is
   refused while an order is still open.

   Suppliers and customers stay separate records. They were
   separate before step 6 and a party that is both is two rows,
   which is the right answer when the two relationships carry
   different registrations, terms and histories.
   ============================================================ */

const EMPTY = {
  name: '', code: '', gstin: '', contactName: '', contactEmail: '', contactPhone: '',
  addressLine: '', city: '', state: '', stateCode: '', postalCode: '',
  shippingAddressLine: '', shippingCity: '', shippingState: '', shippingStateCode: '',
  paymentTerms: '', creditPeriodDays: '', notes: '',
};

export default function Suppliers() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');

  const [search, setSearch] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [editing, setEditing] = useState(null);   // 'new' | supplier
  const [form, setForm] = useState(EMPTY);
  const [closing, setClosing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({
    search: search || undefined,
    isActive: active === 'all' ? undefined : active === 'active',
    page,
    pageSize,
  }), [search, active, page, pageSize]);

  const list = useApi(() => api.suppliers.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.suppliers.history(openId), [openId], { skip: !openId });

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };

  const startNew = () => { setForm(EMPTY); setError(null); setEditing('new'); };
  const startEdit = (s) => {
    setForm({
      name: s.name ?? '', code: s.code ?? '', gstin: s.gstin ?? '',
      contactName: s.contact?.name ?? '', contactEmail: s.contact?.email ?? '',
      contactPhone: s.contact?.phone ?? '',
      addressLine: s.billing?.addressLine ?? '', city: s.billing?.city ?? '',
      state: s.billing?.state ?? '', stateCode: s.billing?.stateCode ?? '',
      postalCode: s.billing?.postalCode ?? '',
      shippingAddressLine: s.shipping?.addressLine ?? '', shippingCity: s.shipping?.city ?? '',
      shippingState: s.shipping?.state ?? '', shippingStateCode: s.shipping?.stateCode ?? '',
      paymentTerms: s.paymentTerms ?? '',
      creditPeriodDays: s.creditPeriodDays ?? '',
      notes: s.notes ?? '',
    });
    setError(null);
    setEditing(s);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form };
      // Blank is "not recorded", not an empty string.
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      body.name = form.name;
      if (editing === 'new') await api.suppliers.create(body);
      else await api.suppliers.update(editing.id, body);
      setEditing(null);
      list.reload();
      if (openId) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setActiveFlag = async (s, isActive, reason) => {
    setBusy(true);
    setError(null);
    try {
      await api.suppliers.setActive(s.id, isActive, reason);
      setClosing(null);
      list.reload();
      if (openId) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const columns = [
    { key: 'code', label: 'Code', width: 120, sortable: false, render: (s) => <span className="sku">{s.code}</span> },
    {
      key: 'name',
      label: 'Supplier',
      sortable: false,
      render: (s) => (
        <>
          <strong>{s.name}</strong>
          <div className="tiny muted">
            {[s.billing?.city, s.billing?.state].filter(Boolean).join(', ') || 'No address recorded'}
          </div>
        </>
      ),
    },
    {
      key: 'gstin',
      label: 'GSTIN',
      width: 170,
      sortable: false,
      render: (s) => (s.gstin
        ? (
          <>
            <span className="sku">{s.gstin}</span>
            <div className="tiny muted">state {s.billing?.stateCode ?? '—'}</div>
          </>
        )
        /* No GSTIN means an unregistered supplier, and purchases
           from them carry no GST. Worth seeing at a glance. */
        : <span className="tiny muted">unregistered</span>),
    },
    {
      key: 'contact',
      label: 'Contact',
      width: 180,
      sortable: false,
      render: (s) => (s.contact?.name || s.contact?.phone
        ? (
          <>
            {s.contact.name}
            <div className="tiny muted">{s.contact.phone ?? s.contact.email}</div>
          </>
        )
        : <span className="muted">—</span>),
    },
    {
      key: 'terms',
      label: 'Terms',
      width: 130,
      sortable: false,
      render: (s) => (
        <>
          {s.paymentTerms ?? <span className="muted">—</span>}
          {s.creditPeriodDays !== null && s.creditPeriodDays !== undefined && (
            <div className="tiny muted">{s.creditPeriodDays} day credit</div>
          )}
        </>
      ),
    },
    {
      key: 'orderCount',
      label: 'Orders',
      align: 'right',
      width: 86,
      sortable: false,
      render: (s) => <span className="num">{qty(s.orderCount ?? 0)}</span>,
    },
    {
      key: 'isActive',
      label: 'State',
      width: 118,
      sortable: false,
      render: (s) => (
        <StatusPill tone={s.isActive ? 'ok' : 'inert'}>
          {s.isActive ? 'Active' : 'Deactivated'}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: 210,
      sortable: false,
      render: (s) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => open(s.id)}>History</button>
          <button className="btn btn-sm" onClick={() => startEdit(s)}>Edit</button>
          {s.isActive
            ? <button className="btn btn-sm" onClick={() => { setClosing(s); setError(null); }}>Deactivate</button>
            : <button className="btn btn-sm" onClick={() => setActiveFlag(s, true)}>Reactivate</button>}
        </div>
      ),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const rows = list.data?.rows ?? [];

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Who the studio buys from. A supplier&rsquo;s GSTIN decides how every
            purchase from them is taxed &mdash; its first two digits are the state
            code, and comparing that against the receiving warehouse is what makes a
            purchase CGST+SGST or IGST.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={startNew}>New supplier</button>
        </div>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(s) => s.id}
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
        searchPlaceholder="Search name, code, GSTIN, city, contact…"
        emptyTitle="No suppliers"
        emptyNote="Add one to start raising purchase orders."
        filters={(
          <select className="select" value={active} onChange={(e) => reset(setActive)(e.target.value)} aria-label="State">
            <option value="all">Active and deactivated</option>
            <option value="active">Active only</option>
            <option value="inactive">Deactivated only</option>
          </select>
        )}
      />

      <p className="tiny muted" style={{ marginTop: 10 }}>
        A supplier is never deleted. One with purchase history cannot be removed
        without orphaning the orders and receipts that explain where stock and money
        went, so there is no delete here and none in the API.
      </p>

      {/* ── create / edit ── */}
      <Modal
        open={Boolean(editing)}
        wide
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New supplier' : 'Edit ' + (editing?.name ?? '')}
        subtitle="The GSTIN sets the state code, and the state code sets the tax on every order."
        footer={(
          <>
            <button className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="supplier-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="supplier-form" onSubmit={save} className="stack">
          <div className="grid-2">
            <Field id="s-name" label="Name" required>
              <input id="s-name" className="input" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field id="s-code" label="Code" hint="Left blank, one is derived from the name.">
              <input id="s-code" className="input" value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="SUP-XXX" />
            </Field>
          </div>
          <div className="grid-2">
            <Field id="s-gstin" label="GSTIN" hint="Fifteen characters. Leave blank for an unregistered supplier — no GST is then charged.">
              <input id="s-gstin" className="input" value={form.gstin}
                onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                placeholder="24AAACS1234F1Z5" />
            </Field>
            <Field id="s-statecode" label="State code" hint="Derived from the GSTIN when there is one.">
              <input id="s-statecode" className="input" value={form.stateCode} maxLength={2}
                onChange={(e) => setForm({ ...form, stateCode: e.target.value })} placeholder="24" />
            </Field>
          </div>
          <div className="grid-3">
            <Field id="s-contact" label="Contact person">
              <input id="s-contact" className="input" value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </Field>
            <Field id="s-phone" label="Phone">
              <input id="s-phone" className="input" value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
            <Field id="s-email" label="Email">
              <input id="s-email" className="input" type="email" value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </Field>
          </div>
          <Field id="s-address" label="Billing address">
            <input id="s-address" className="input" value={form.addressLine}
              onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />
          </Field>
          <div className="grid-3">
            <Field id="s-city" label="City">
              <input id="s-city" className="input" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field id="s-state" label="State">
              <input id="s-state" className="input" value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
            <Field id="s-pin" label="Postal code">
              <input id="s-pin" className="input" value={form.postalCode}
                onChange={(e) => setForm({ ...form, postalCode: e.target.value })} />
            </Field>
          </div>
          <Field id="s-ship" label="Shipping address" hint="Where goods are collected from, if that is not the billing address.">
            <input id="s-ship" className="input" value={form.shippingAddressLine}
              onChange={(e) => setForm({ ...form, shippingAddressLine: e.target.value })} />
          </Field>
          <div className="grid-3">
            <Field id="s-terms" label="Payment terms">
              <input id="s-terms" className="input" value={form.paymentTerms}
                onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} placeholder="30 days" />
            </Field>
            <Field id="s-credit" label="Credit period (days)" hint="Sets an invoice's due date.">
              <input id="s-credit" className="input" type="number" min="0" max="365"
                value={form.creditPeriodDays}
                onChange={(e) => setForm({ ...form, creditPeriodDays: e.target.value })} />
            </Field>
            <Field id="s-shipstate" label="Shipping state code">
              <input id="s-shipstate" className="input" maxLength={2} value={form.shippingStateCode}
                onChange={(e) => setForm({ ...form, shippingStateCode: e.target.value })} />
            </Field>
          </div>
          <Field id="s-notes" label="Notes">
            <textarea id="s-notes" className="input" rows={2} value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </form>
      </Modal>

      {/* ── deactivate ── */}
      <Modal
        open={Boolean(closing)}
        onClose={() => { setClosing(null); setError(null); }}
        title={closing ? 'Deactivate ' + closing.name : ''}
        subtitle="Nothing is deleted. The supplier keeps every order, receipt and invoice it ever had."
        footer={(
          <>
            <button className="btn" onClick={() => setClosing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => setActiveFlag(closing, false, form.reason)}>
              {busy ? 'Working…' : 'Deactivate'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <p className="tiny muted">
          A deactivated supplier cannot be chosen for a new order. If any order is
          still open this will be refused &mdash; goods already on their way would
          have nowhere to be booked in.
        </p>
        <Field id="s-reason" label="Reason (recorded in the audit log)">
          <input id="s-reason" className="input" value={form.reason ?? ''}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="No longer trading with them." />
        </Field>
      </Modal>

      {/* ── supplier detail and history ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={detail.data ? detail.data.supplier.name : 'Supplier'}
        subtitle={detail.data
          ? detail.data.supplier.code + (detail.data.supplier.gstin ? ' · ' + detail.data.supplier.gstin : ' · unregistered')
          : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {detail.data && (
          <>
            <div className="grid-4">
              <KpiCard label="Orders placed" value={qty(detail.data.summary.ordersPlaced)}
                note="drafts and cancellations excluded" />
              <KpiCard label="Value committed" value={money(detail.data.summary.valueOrdered)} />
              <KpiCard label="Receipts" value={qty(detail.data.summary.receiptsPosted)}
                note="most recent shown below" />
              <KpiCard label="Returns" value={qty(detail.data.summary.returnsPosted)}
                note="stock sent back" />
            </div>

            <h4 style={{ margin: '18px 0 6px' }}>Purchase orders</h4>
            {detail.data.orders.length === 0
              ? <p className="muted tiny">Nothing has been ordered from this supplier yet.</p>
              : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th><th>Date</th><th>Warehouse</th><th>GST</th><th>State</th>
                      <th style={{ textAlign: 'right' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.orders.map((o) => (
                      <tr key={o.id}>
                        <td><span className="sku">{o.orderNo}</span></td>
                        <td className="tiny">{day(o.orderDate)}</td>
                        <td className="tiny">{o.warehouse?.name}</td>
                        <td className="tiny">{o.gstTreatment?.toLowerCase().replace('_', '-')}</td>
                        <td>
                          <StatusPill tone={PO_STATUS[o.status]?.tone ?? 'info'}>
                            {PO_STATUS[o.status]?.label ?? o.status}
                          </StatusPill>
                        </td>
                        <td className="num" style={{ textAlign: 'right' }}>{money(o.grandTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            <h4 style={{ margin: '18px 0 6px' }}>Recent receipts</h4>
            {detail.data.recentReceipts.length === 0
              ? <p className="muted tiny">Nothing has been received from this supplier.</p>
              : (
                <table className="table">
                  <thead><tr><th>Receipt</th><th>Date</th><th>Against</th><th>Lines</th></tr></thead>
                  <tbody>
                    {detail.data.recentReceipts.map((r) => (
                      <tr key={r.id}>
                        <td><span className="sku">{r.grnNo}</span></td>
                        <td className="tiny">{day(r.receiptDate)}</td>
                        <td className="tiny">{r.orderNo ?? '—'}</td>
                        <td className="num">{r.lineCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            <h4 style={{ margin: '18px 0 6px' }}>Recent invoices</h4>
            {detail.data.recentInvoices.length === 0
              ? <p className="muted tiny">No invoices recorded.</p>
              : (
                <table className="table">
                  <thead>
                    <tr><th>Invoice</th><th>Date</th><th>State</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
                  </thead>
                  <tbody>
                    {detail.data.recentInvoices.map((i) => (
                      <tr key={i.id}>
                        <td><span className="sku">{i.invoiceNo}</span></td>
                        <td className="tiny">{day(i.invoiceDate)}</td>
                        <td className="tiny">{i.status.toLowerCase()}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{money(i.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </>
        )}
      </Modal>
    </>
  );
}

function Field({ id, label, hint, required, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span style={{ color: 'var(--err)' }}> *</span>}
      </label>
      {children}
      {hint && <span className="tiny muted">{hint}</span>}
    </div>
  );
}
