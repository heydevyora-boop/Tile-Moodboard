import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, day, stamp } from '../lib/format.js';

/* ============================================================
   PURCHASE RETURNS — STOCK GOING BACK TO THE SUPPLIER
   ============================================================
   Reduces stock through the same service every movement goes
   through. IT DOES NOT EDIT THE RECEIPT that brought the stock
   in: that entry stays on the ledger and the return sits beside
   it, so the stock card reads as what actually happened rather
   than as a history that has been tidied up.
   ============================================================ */

export default function PurchaseReturns() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');

  const [search, setSearch] = useState('');
  const [supplierId, setSupplierId] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ lines: [] });
  const [sku, setSku] = useState('');
  const [lookup, setLookup] = useState('');
  const [quantity, setQuantity] = useState('');
  const [fromDamaged, setFromDamaged] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ search: search || undefined, supplierId, page, pageSize }),
    [search, supplierId, page, pageSize]);

  const list = useApi(() => api.purchaseReturns.list(query), [JSON.stringify(query)]);
  const detail = useApi(() => api.purchaseReturns.get(openId), [openId], { skip: !openId });
  const suppliers = useApi(() => api.suppliers.options(), []);
  const warehouses = useApi(() => api.reference.warehouses(), []);

  useEffect(() => {
    const t = setTimeout(() => setLookup(sku.trim()), 250);
    return () => clearTimeout(t);
  }, [sku]);

  const matches = useApi(() => api.products.list({ search: lookup, pageSize: 10 }), [lookup],
    { skip: lookup.length < 2 });
  const chosen = (matches.data?.rows ?? [])
    .find((p) => p.sku.toUpperCase() === sku.trim().toUpperCase());

  /* HOW MUCH MAY GO BACK, shown before a quantity is typed.
     Received from this supplier, less what has already been
     returned. The server checks it again on save. */
  const able = useApi(
    () => api.purchaseReturns.eligibility({
      supplierId: form.supplierId,
      productId: chosen.id,
      warehouseId: form.warehouseId,
    }),
    [form.supplierId, chosen?.id, form.warehouseId],
    { skip: !chosen || !form.supplierId || !form.warehouseId },
  );

  useEffect(() => {
    const all = warehouses.data?.rows ?? [];
    if (!form.warehouseId && all.length === 1) setForm((f) => ({ ...f, warehouseId: all[0].id }));
  }, [warehouses.data, form.warehouseId]);

  const open = (id) => { const n = new URLSearchParams(params); n.set('open', id); setParams(n, { replace: true }); };
  const closeDetail = () => { const n = new URLSearchParams(params); n.delete('open'); setParams(n, { replace: true }); };
  const reset = (fn) => (v) => { fn(v); setPage(1); };

  const addLine = () => {
    if (!chosen || !(Number(quantity) > 0)) return;
    setForm({
      ...form,
      lines: [...form.lines, {
        productId: chosen.id, sku: chosen.sku, name: chosen.name,
        quantity: Number(quantity), fromDamaged,
      }],
    });
    setSku(''); setQuantity(''); setFromDamaged(false);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.purchaseReturns.post({
        supplierId: form.supplierId,
        warehouseId: form.warehouseId,
        reason: form.reason,
        remarks: form.remarks || null,
        documentRef: form.documentRef || null,
        lines: form.lines.map((l) => ({
          productId: l.productId, quantity: l.quantity, fromDamaged: l.fromDamaged,
        })),
      });
      setCreating(false);
      setForm({ lines: [] });
      list.reload();
      open(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'returnNo', label: 'Return', width: 140, sortable: false, render: (r) => <span className="sku">{r.returnNo}</span> },
    {
      key: 'supplier',
      label: 'Supplier',
      sortable: false,
      render: (r) => (
        <>
          <strong>{r.supplier?.name}</strong>
          <div className="tiny muted">from {r.warehouse?.name}</div>
        </>
      ),
    },
    { key: 'returnDate', label: 'Sent back', width: 112, sortable: false, render: (r) => day(r.returnDate) },
    { key: 'reason', label: 'Why', sortable: false, render: (r) => <span className="tiny">{r.reason}</span> },
    {
      key: 'totalQuantity',
      label: 'Quantity',
      align: 'right',
      width: 100,
      sortable: false,
      render: (r) => <strong className="num">{qty(r.totalQuantity ?? 0)}</strong>,
    },
    {
      key: 'status',
      label: 'State',
      width: 110,
      sortable: false,
      render: (r) => <StatusPill tone={r.status === 'POSTED' ? 'ok' : 'inert'}>{r.status.toLowerCase()}</StatusPill>,
    },
    {
      key: 'actions',
      label: '',
      width: 92,
      sortable: false,
      render: (r) => <button className="btn btn-sm" onClick={() => open(r.id)}>Open</button>,
    },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const d = detail.data;
  const ready = form.supplierId && form.warehouseId
    && String(form.reason ?? '').trim().length >= 3 && form.lines.length > 0;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Stock going back to a supplier. It reduces inventory through the same
            service every movement goes through, and{' '}
            <strong>it does not edit the receipt that brought the stock in</strong>:
            that entry stays on the ledger and the return sits beside it.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary"
            onClick={() => { setForm({ lines: [] }); setError(null); setCreating(true); }}>
            New return
          </button>
        </div>
      </div>

      <DataTable
        rows={list.data?.rows ?? []}
        columns={columns}
        rowKey={(r) => r.id}
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
        searchPlaceholder="Search return number, supplier, reason, product…"
        emptyTitle="No purchase returns"
        emptyNote="Nothing has gone back to a supplier."
        filters={(
          <select className="select" value={supplierId}
            onChange={(e) => reset(setSupplierId)(e.target.value)} aria-label="Supplier">
            <option value="all">All suppliers</option>
            {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      />

      {/* ── raise one ── */}
      <Modal
        open={creating}
        wide
        onClose={() => setCreating(false)}
        title="Return stock to a supplier"
        subtitle="Posting this reduces stock immediately, through the append-only ledger."
        footer={(
          <>
            <button className="btn" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" form="pr-form" type="submit" disabled={busy || !ready}>
              {busy ? 'Posting…' : 'Post return'}
            </button>
          </>
        )}
      >
        <FieldErrors error={error} />
        <form id="pr-form" onSubmit={save} className="stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="r-supplier">Supplier</label>
              <select id="r-supplier" className="select" value={form.supplierId ?? ''}
                onChange={(e) => setForm({ ...form, supplierId: e.target.value })} required>
                <option value="">Choose…</option>
                {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="r-warehouse">Leaving</label>
              <select id="r-warehouse" className="select" value={form.warehouseId ?? ''}
                onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required>
                <option value="">Choose…</option>
                {(warehouses.data?.rows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="r-reason">Why it is going back</label>
            <input id="r-reason" className="input" value={form.reason ?? ''}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="Shade variation outside tolerance." required />
            <span className="tiny muted">Required. Somebody will ask why the goods went back.</span>
          </div>

          <div className="field">
            <label>Lines</label>
            {form.lines.length === 0
              ? <p className="tiny muted">Nothing added yet.</p>
              : (
                <table className="table">
                  <thead>
                    <tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Quantity</th><th>From</th><th /></tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, i) => (
                      <tr key={l.productId + ':' + i}>
                        <td><span className="sku">{l.sku}</span></td>
                        <td>{l.name}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)}</td>
                        <td className="tiny">{l.fromDamaged ? 'damaged stock' : 'sound stock'}</td>
                        <td>
                          <button type="button" className="btn btn-sm"
                            onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          <div className="grid-3">
            <div className="field">
              <label htmlFor="r-sku">Product code</label>
              <input id="r-sku" className="input" list="pr-product-list" value={sku}
                onChange={(e) => setSku(e.target.value)} autoComplete="off" />
              <datalist id="pr-product-list">
                {(matches.data?.rows ?? []).map((p) => <option key={p.id} value={p.sku}>{p.name}</option>)}
              </datalist>
              <span className="tiny muted">
                {able.data
                  ? 'Delivered ' + able.data.receivedFromSupplier + ', already returned '
                    + able.data.alreadyReturned + ', so at most ' + able.data.eligible + ' may go back.'
                  : chosen ? chosen.name : 'Type two characters to search.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="r-qty">Quantity</label>
              <input id="r-qty" className="input" type="number" min="0.001" step="0.001"
                value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="r-damaged" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <input id="r-damaged" type="checkbox" checked={fromDamaged}
                  onChange={(e) => setFromDamaged(e.target.checked)} />
                {' '}From damaged stock
              </label>
              <button type="button" className="btn" style={{ marginTop: 6 }} onClick={addLine}
                disabled={!chosen || !(Number(quantity) > 0)}>
                Add line
              </button>
              {able.data && (
                <span className="tiny muted">{able.data.inStock.damaged} marked damaged here.</span>
              )}
            </div>
          </div>
        </form>
      </Modal>

      {/* ── one return ── */}
      <Modal
        open={Boolean(openId)}
        wide
        onClose={closeDetail}
        title={d ? d.returnNo : 'Purchase return'}
        subtitle={d ? d.warehouse.name + ' → ' + d.supplier.name : ''}
        footer={<button className="btn" onClick={closeDetail}>Close</button>}
      >
        {detail.loading && <p className="muted">Reading…</p>}
        {detail.error && <FieldErrors error={detail.error} />}
        {d && (
          <>
            <div className="summary-strip">
              <div><span className="kpi-label">Sent back</span><strong>{day(d.returnDate)}</strong></div>
              <div><span className="kpi-label">By</span><strong>{d.postedBy ?? d.createdBy ?? '—'}</strong></div>
              <div><span className="kpi-label">Posted</span><strong>{d.postedAt ? stamp(d.postedAt) : '—'}</strong></div>
              <div><span className="kpi-label">Against</span><strong>{d.purchaseOrder?.orderNo ?? '—'}</strong></div>
            </div>
            <p className="tiny muted" style={{ marginTop: 10 }}><strong>Reason:</strong> {d.reason}</p>

            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr><th>Code</th><th>Product</th><th style={{ textAlign: 'right' }}>Quantity</th><th>From</th></tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td><span className="sku">{l.sku}</span></td>
                    <td>{l.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(l.quantity)} {l.uom?.toLowerCase()}</td>
                    <td className="tiny">{l.fromDamaged ? 'damaged stock' : 'sound stock'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4 style={{ margin: '18px 0 6px' }}>What it did to stock</h4>
            <table className="table">
              <thead>
                <tr>
                  <th>Entry</th><th>Code</th><th>Movement</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th>
                  <th style={{ textAlign: 'right' }}>Was</th>
                  <th style={{ textAlign: 'right' }}>Became</th>
                </tr>
              </thead>
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
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Returning stock that was marked damaged takes two movements: it is
              released from the damaged figure first, then issued. Doing only the
              second would leave the damaged count claiming boxes that have left the
              building.{' '}
              <Link to={'/ledger?referenceNo=' + encodeURIComponent(d.returnNo)}>See it in the ledger</Link>.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
