import { useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty } from '../lib/format.js';

/* ============================================================
   WAREHOUSES — WHERE THE STOCK PHYSICALLY IS
   ============================================================
   THERE IS NO DELETE ON THIS SCREEN, and there is not going to
   be. A warehouse with movements against it cannot be removed
   without orphaning the entries that explain where the stock
   went; the database restricts it, and the API has no endpoint
   for it. Closing a location is a deactivation, and that is
   refused while it still holds anything — because once
   deactivated, no movement can be posted against it, including
   the one that would empty it. The error says so, with the
   figure.
   ============================================================ */

export default function Warehouses() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);    // 'new' | warehouse
  const [openId, setOpenId] = useState(null);
  const [closing, setClosing] = useState(null);

  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = useApi(() => api.warehouses.list({ search: search || undefined, pageSize: 100 }),
    [search]);
  const detail = useApi(() => api.warehouses.stock(openId), [openId], { skip: !openId });

  const startNew = () => { setForm({ name: '', code: '', city: '', state: '' }); setError(null); setEditing('new'); };
  const startEdit = (w) => {
    setForm({ name: w.name, code: w.code, city: w.city ?? '', state: w.state ?? '',
      addressLine: w.addressLine ?? '', postalCode: w.postalCode ?? '' });
    setError(null);
    setEditing(w);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') await api.warehouses.create(form);
      else await api.warehouses.update(editing.id, form);
      setEditing(null);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (w, isActive, reason) => {
    setBusy(true);
    setError(null);
    try {
      await api.warehouses.setActive(w.id, isActive, reason);
      setClosing(null);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'code', label: 'Code', width: 120, render: (w) => <span className="sku">{w.code}</span> },
    {
      key: 'name',
      label: 'Warehouse',
      render: (w) => (
        <>
          <strong>{w.name}</strong>
          <div className="tiny muted">
            {[w.city, w.state].filter(Boolean).join(', ') || 'No address recorded'}
          </div>
        </>
      ),
    },
    {
      key: 'skuCount',
      label: 'Products held',
      align: 'right',
      width: 118,
      render: (w) => <span className="num">{qty(w.skuCount ?? 0)}</span>,
    },
    { key: 'physical', label: 'On hand', align: 'right', width: 96, render: (w) => <span className="num">{qty(w.physical)}</span> },
    {
      key: 'inTransit',
      label: 'In transit here',
      align: 'right',
      width: 118,
      render: (w) => (w.inTransit > 0
        ? <span className="num">{qty(w.inTransit)}</span>
        : <span className="muted">—</span>),
    },
    {
      key: 'available',
      label: 'Can be sold',
      align: 'right',
      width: 108,
      render: (w) => <strong className="num">{qty(w.available)}</strong>,
    },
    {
      key: 'isActive',
      label: 'State',
      width: 150,
      value: (w) => (w.isActive ? 'Active' : 'Deactivated'),
      render: (w) => (
        <>
          <StatusPill
            tone={w.isActive ? 'ok' : 'inert'}
            title={w.isActive
              ? 'Stock can be received and issued here.'
              : 'No movement can be posted against this warehouse.'}
          >
            {w.isActive ? 'Active' : 'Deactivated'}
          </StatusPill>
          {w.isDefault && <div className="tiny muted">default location</div>}
        </>
      ),
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      width: 230,
      render: (w) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setOpenId(w.id)}>Stock</button>
          <button className="btn btn-sm" onClick={() => startEdit(w)}>Edit</button>
          {w.isActive
            ? <button className="btn btn-sm" onClick={() => { setClosing(w); setError(null); }}>Deactivate</button>
            : <button className="btn btn-sm" onClick={() => setActive(w, true)}>Reactivate</button>}
        </div>
      ),
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const rows = list.data?.rows ?? [];
  const active = rows.filter((w) => w.isActive);
  const totalOnHand = rows.reduce((s, w) => s + w.physical, 0);
  const totalInTransit = rows.reduce((s, w) => s + w.inTransit, 0);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Where stock physically sits. Each product&rsquo;s balance is held per
            warehouse, so a transfer between two of them is two linked movements
            on one transfer reference — never one figure quietly edited in two
            places.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/transfers">Transfers</Link>
          <button className="btn btn-primary" onClick={startNew}>New warehouse</button>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard label="Warehouses" value={qty(rows.length)} note={qty(active.length) + ' active'} />
        <KpiCard label="On the shelves" value={qty(totalOnHand)} note="across every location" />
        <KpiCard
          label="In transit"
          value={qty(totalInTransit)}
          note={totalInTransit > 0 ? 'dispatched, not yet received' : 'nothing on the road'}
          tone={totalInTransit > 0 ? 'warn' : undefined}
        />
        <KpiCard
          label="Total physical stock"
          value={qty(totalOnHand + totalInTransit)}
          note="on hand plus in transit — unchanged by a transfer"
        />
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(w) => w.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search name, code, city…"
        initialSort={{ key: 'name', dir: 'asc' }}
        emptyTitle="No warehouses"
        emptyNote="Create one to start holding stock against a location."
      />

      <p className="tiny muted" style={{ marginTop: 10 }}>
        A warehouse is never deleted. One with stock movements against it cannot be
        removed without orphaning the entries that explain where the stock went, so
        there is no delete here and none in the API.
      </p>

      {/* ── create / edit ── */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New warehouse' : 'Edit ' + (editing?.name ?? '')}
        subtitle={editing === 'new'
          ? 'A location that can hold stock. It starts with nothing in it.'
          : 'The code cannot change once stock has moved through here: the ledger quotes it.'}
        footer={(
          <>
            <button className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="warehouse-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="warehouse-form" onSubmit={save} className="stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="w-name">Name</label>
              <input
                id="w-name"
                className="input"
                value={form.name ?? ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="w-code">Code</label>
              <input
                id="w-code"
                className="input"
                value={form.code ?? ''}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="WH-MAIN"
              />
              <span className="tiny muted">Left blank, one is derived from the name.</span>
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="w-city">City</label>
              <input
                id="w-city"
                className="input"
                value={form.city ?? ''}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="w-state">State</label>
              <input
                id="w-state"
                className="input"
                value={form.state ?? ''}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="w-address">Address</label>
            <input
              id="w-address"
              className="input"
              value={form.addressLine ?? ''}
              onChange={(e) => setForm({ ...form, addressLine: e.target.value })}
            />
          </div>
        </form>
      </Modal>

      {/* ── deactivate ── */}
      <Modal
        open={Boolean(closing)}
        onClose={() => { setClosing(null); setError(null); }}
        title={closing ? 'Deactivate ' + closing.name : 'Deactivate'}
        subtitle="Nothing is deleted. No new movement can be posted here afterwards."
        footer={(
          <>
            <button className="btn" onClick={() => setClosing(null)} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => setActive(closing, false, form.reason)}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Deactivate it'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        {closing && (
          <>
            <p>
              {closing.name} currently holds <strong>{qty(closing.physical)}</strong> on hand
              {closing.inTransit > 0 && <> and <strong>{qty(closing.inTransit)}</strong> in transit</>}.
            </p>
            <p className="tiny muted">
              If anything is still here, this will be refused — and that is the point.
              A deactivated warehouse accepts no movements at all, so stock left
              behind in one would be unreachable, including by the transfer that
              would move it out. Empty it first.
            </p>
            <div className="field">
              <label htmlFor="w-reason">Reason (recorded in the audit log)</label>
              <input
                id="w-reason"
                className="input"
                value={form.reason ?? ''}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Lease ended; stock moved to the main warehouse."
              />
            </div>
          </>
        )}
      </Modal>

      {/* ── what one warehouse is holding ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={() => setOpenId(null)}
        title={detail.data ? detail.data.warehouse.name : 'Warehouse stock'}
        subtitle={detail.data
          ? detail.data.warehouse.code + ' · ' + qty(detail.data.total) + ' product(s) held here'
          : ''}
        footer={<button className="btn" onClick={() => setOpenId(null)}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading from the database…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {detail.data && (detail.data.rows.length === 0
          ? <p className="muted">Nothing is held here.</p>
          : (
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Product</th>
                  <th style={{ textAlign: 'right' }}>On hand</th>
                  <th style={{ textAlign: 'right' }}>Reserved</th>
                  <th style={{ textAlign: 'right' }}>Damaged</th>
                  <th style={{ textAlign: 'right' }}>In transit</th>
                  <th style={{ textAlign: 'right' }}>Can be sold</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.rows.map((r) => (
                  <tr key={r.productId}>
                    <td><span className="sku">{r.sku}</span></td>
                    <td>{r.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(r.physical)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(r.reserved)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(r.damaged)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(r.inTransit)}</td>
                    <td className="num" style={{ textAlign: 'right' }}><strong>{qty(r.available)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </Modal>
    </>
  );
}
