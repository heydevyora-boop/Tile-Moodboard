import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';
import { SO_STATUS, CUSTOMER_TYPE } from '../data/salesStatus.js';

/* ============================================================
   CUSTOMERS — LIST AND DETAIL
   ============================================================
   THERE IS NO DELETE, for the same reason as a supplier: a
   customer with any sales history cannot be removed without
   orphaning the quotations, orders and invoices that explain it.
   Deactivating is the supported answer.

   Customers and suppliers stay separate records, mirroring step
   6's own decision for the same reason: the two relationships
   carry different registrations, terms and histories, even when
   the same company is both.
   ============================================================ */

const EMPTY = {
  name: '', code: '', type: 'RETAIL', gstin: '', contactName: '', contactEmail: '', contactPhone: '',
  addressLine: '', city: '', state: '', stateCode: '', postalCode: '',
  shippingAddressLine: '', shippingCity: '', shippingState: '', shippingStateCode: '',
  paymentTerms: '', creditPeriodDays: '', notes: '',
};

export default function Customers() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');

  const [search, setSearch] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [editing, setEditing] = useState(null);   // 'new' | customer
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

  const list = useApi(() => api.customers.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.customers.history(openId), [openId], { skip: !openId });

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };

  const startNew = () => { setForm(EMPTY); setError(null); setEditing('new'); };
  const startEdit = (c) => {
    setForm({
      name: c.name ?? '', code: c.code ?? '', type: c.type ?? 'RETAIL', gstin: c.gstin ?? '',
      contactName: c.contact?.name ?? '', contactEmail: c.contact?.email ?? '', contactPhone: c.contact?.phone ?? '',
      addressLine: c.billing?.addressLine ?? '', city: c.billing?.city ?? '',
      state: c.billing?.state ?? '', stateCode: c.billing?.stateCode ?? '', postalCode: c.billing?.postalCode ?? '',
      shippingAddressLine: c.shipping?.addressLine ?? '', shippingCity: c.shipping?.city ?? '',
      shippingState: c.shipping?.state ?? '', shippingStateCode: c.shipping?.stateCode ?? '',
      paymentTerms: c.paymentTerms ?? '', creditPeriodDays: c.creditPeriodDays ?? '', notes: c.notes ?? '',
    });
    setError(null);
    setEditing(c);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      body.name = form.name;
      body.type = form.type || null;
      if (editing === 'new') await api.customers.create(body);
      else await api.customers.update(editing.id, body);
      setEditing(null);
      list.reload();
      if (openId) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setActiveFlag = async (c, isActive, reason) => {
    setBusy(true);
    setError(null);
    try {
      await api.customers.setActive(c.id, isActive, reason);
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
    { key: 'code', label: 'Code', width: 110, sortable: false, render: (c) => <span className="sku">{c.code}</span> },
    {
      key: 'name',
      label: 'Customer',
      sortable: false,
      render: (c) => (
        <>
          <strong>{c.name}</strong>
          <div className="tiny muted">
            {CUSTOMER_TYPE[c.type] ?? c.type}
            {c.billing?.city ? ' · ' + c.billing.city : ''}
          </div>
        </>
      ),
    },
    {
      key: 'gstin',
      label: 'GSTIN',
      width: 170,
      sortable: false,
      render: (c) => (c.gstin
        ? (<><span className="sku">{c.gstin}</span><div className="tiny muted">state {c.billing?.stateCode ?? '—'}</div></>)
        : <span className="tiny muted">{c.billing?.stateCode ? 'state ' + c.billing.stateCode : 'no state on record'}</span>),
    },
    {
      key: 'contact',
      label: 'Contact',
      width: 170,
      sortable: false,
      render: (c) => (c.contact?.name || c.contact?.phone
        ? (<>{c.contact.name}<div className="tiny muted">{c.contact.phone ?? c.contact.email}</div></>)
        : <span className="muted">—</span>),
    },
    {
      key: 'orderCount',
      label: 'Orders',
      align: 'right',
      width: 86,
      sortable: false,
      render: (c) => <span className="num">{qty(c.orderCount ?? 0)}</span>,
    },
    {
      key: 'isActive',
      label: 'State',
      width: 110,
      sortable: false,
      render: (c) => <StatusPill tone={c.isActive ? 'ok' : 'inert'}>{c.isActive ? 'Active' : 'Deactivated'}</StatusPill>,
    },
    {
      key: 'actions',
      label: '',
      width: 210,
      sortable: false,
      render: (c) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => open(c.id)}>History</button>
          <button className="btn btn-sm" onClick={() => startEdit(c)}>Edit</button>
          {c.isActive
            ? <button className="btn btn-sm" onClick={() => { setClosing(c); setError(null); }}>Deactivate</button>
            : <button className="btn btn-sm" onClick={() => setActiveFlag(c, true)}>Reactivate</button>}
        </div>
      ),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Who the studio sells to. A customer&rsquo;s shipping state &mdash; not the
            billing state &mdash; decides how a sale to them is taxed, because place
            of supply for goods is where they are delivered.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={startNew}>New customer</button>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(c) => c.id}
        server={{
          total: list.data?.total ?? 0, page, pageSize, pageCount: list.data?.pageCount ?? 1,
          loading: list.loading, sort: null,
          onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onSort: () => {},
        }}
        search={search}
        onSearch={reset(setSearch)}
        searchPlaceholder="Search name, code, GSTIN, city, contact…"
        emptyTitle="No customers"
        emptyNote="Add one to start raising quotations and orders."
        filters={(
          <select className="select" value={active} onChange={(e) => reset(setActive)(e.target.value)} aria-label="State">
            <option value="all">Active and deactivated</option>
            <option value="active">Active only</option>
            <option value="inactive">Deactivated only</option>
          </select>
        )}
      />

      <p className="tiny muted" style={{ marginTop: 10 }}>
        A customer is never deleted. One with sales history cannot be removed without
        orphaning the quotations, orders and invoices that explain it, so there is no
        delete here and none in the API.
      </p>

      {/* ── create / edit ── */}
      <Modal
        open={Boolean(editing)}
        wide
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New customer' : 'Edit ' + (editing?.name ?? '')}
        subtitle="The shipping state code sets the tax on every sale — set it even when billing and shipping agree."
        footer={(
          <>
            <button className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="customer-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="customer-form" onSubmit={save} className="stack">
          <div className="grid-3">
            <Field id="c-name" label="Name" required>
              <input id="c-name" className="input" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field id="c-code" label="Code" hint="Left blank, one is derived from the name.">
              <input id="c-code" className="input" value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="CUS-XXX" />
            </Field>
            <Field id="c-type" label="Type">
              <select id="c-type" className="select" value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {Object.entries(CUSTOMER_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid-2">
            <Field id="c-gstin" label="GSTIN" hint="Leave blank for an unregistered customer — GST is still charged as a plain B2C sale.">
              <input id="c-gstin" className="input" value={form.gstin}
                onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                placeholder="24AAACS1234F1Z5" />
            </Field>
            <Field id="c-statecode" label="Billing state code" hint="Derived from the GSTIN when there is one.">
              <input id="c-statecode" className="input" value={form.stateCode} maxLength={2}
                onChange={(e) => setForm({ ...form, stateCode: e.target.value })} placeholder="24" />
            </Field>
          </div>
          <div className="grid-3">
            <Field id="c-contact" label="Contact person">
              <input id="c-contact" className="input" value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </Field>
            <Field id="c-phone" label="Phone">
              <input id="c-phone" className="input" value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
            <Field id="c-email" label="Email">
              <input id="c-email" className="input" type="email" value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </Field>
          </div>
          <Field id="c-address" label="Billing address">
            <input id="c-address" className="input" value={form.addressLine}
              onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />
          </Field>
          <div className="grid-3">
            <Field id="c-city" label="City">
              <input id="c-city" className="input" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field id="c-state" label="State">
              <input id="c-state" className="input" value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
            <Field id="c-pin" label="Postal code">
              <input id="c-pin" className="input" value={form.postalCode}
                onChange={(e) => setForm({ ...form, postalCode: e.target.value })} />
            </Field>
          </div>
          <Field id="c-ship" label="Shipping address" hint="Where goods are delivered, if different from billing.">
            <input id="c-ship" className="input" value={form.shippingAddressLine}
              onChange={(e) => setForm({ ...form, shippingAddressLine: e.target.value })} />
          </Field>
          <div className="grid-3">
            <Field id="c-shipcity" label="Shipping city">
              <input id="c-shipcity" className="input" value={form.shippingCity}
                onChange={(e) => setForm({ ...form, shippingCity: e.target.value })} />
            </Field>
            <Field id="c-shipstate" label="Shipping state">
              <input id="c-shipstate" className="input" value={form.shippingState}
                onChange={(e) => setForm({ ...form, shippingState: e.target.value })} />
            </Field>
            <Field id="c-shipstatecode" label="Shipping state code" hint="Decides the tax. Not guessed if left blank.">
              <input id="c-shipstatecode" className="input" maxLength={2} value={form.shippingStateCode}
                onChange={(e) => setForm({ ...form, shippingStateCode: e.target.value })} placeholder="24" />
            </Field>
          </div>
          <div className="grid-3">
            <Field id="c-terms" label="Payment terms">
              <input id="c-terms" className="input" value={form.paymentTerms}
                onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} placeholder="30 days" />
            </Field>
            <Field id="c-credit" label="Credit period (days)" hint="Sets an invoice's due date.">
              <input id="c-credit" className="input" type="number" min="0" max="365"
                value={form.creditPeriodDays}
                onChange={(e) => setForm({ ...form, creditPeriodDays: e.target.value })} />
            </Field>
            <Field id="c-notes" label="Notes">
              <input id="c-notes" className="input" value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
        </form>
      </Modal>

      {/* ── deactivate ── */}
      <Modal
        open={Boolean(closing)}
        onClose={() => { setClosing(null); setError(null); }}
        title={closing ? 'Deactivate ' + closing.name : ''}
        subtitle="Nothing is deleted. The customer keeps every quotation, order and invoice it ever had."
        footer={(
          <>
            <button className="btn" onClick={() => setClosing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => setActiveFlag(closing, false, form.reason)}>
              {busy ? 'Working…' : 'Deactivate'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <p className="tiny muted">
          A deactivated customer cannot be chosen for a new quotation or order. If any
          order is still open this is refused.
        </p>
        <Field id="c-reason" label="Reason (recorded in the audit log)">
          <input id="c-reason" className="input" value={form.reason ?? ''}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="No longer buying from the studio." />
        </Field>
      </Modal>

      {/* ── customer detail and history ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={detail.data ? detail.data.customer.name : 'Customer'}
        subtitle={detail.data
          ? detail.data.customer.code + (detail.data.customer.gstin ? ' · ' + detail.data.customer.gstin : ' · unregistered')
          : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {detail.data && (
          <>
            <div className="grid-4">
              <KpiCard label="Orders placed" value={qty(detail.data.summary.ordersPlaced)} />
              <KpiCard label="Value ordered" value={money(detail.data.summary.valueOrdered)} />
              <KpiCard label="Invoiced" value={money(detail.data.summary.invoiced)} />
              <KpiCard label="Outstanding" value={money(detail.data.summary.outstanding)}
                tone={detail.data.summary.outstanding > 0 ? 'warn' : 'ok'} />
            </div>

            <h4 style={{ margin: '18px 0 6px' }}>Sales orders</h4>
            {(detail.data.orders ?? []).length === 0
              ? <p className="muted tiny">Nothing has been ordered by this customer yet.</p>
              : (
                <table className="table">
                  <thead><tr><th>Order</th><th>Date</th><th>Warehouse</th><th>State</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
                  <tbody>
                    {detail.data.orders.map((o) => (
                      <tr key={o.id}>
                        <td><span className="sku">{o.orderNo}</span></td>
                        <td className="tiny">{day(o.orderDate)}</td>
                        <td className="tiny">{o.warehouse?.name}</td>
                        <td><StatusPill tone={SO_STATUS[o.status]?.tone ?? 'info'}>{SO_STATUS[o.status]?.label ?? o.status}</StatusPill></td>
                        <td className="num" style={{ textAlign: 'right' }}>{money(o.grandTotal)}</td>
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
      <label htmlFor={id}>{label}{required && <span style={{ color: 'var(--err)' }}> *</span>}</label>
      {children}
      {hint && <span className="tiny muted">{hint}</span>}
    </div>
  );
}
