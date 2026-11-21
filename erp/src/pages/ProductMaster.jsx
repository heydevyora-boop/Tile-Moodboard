import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { Failed, FieldErrors } from '../components/ApiState.jsx';
import ProductForm from '../components/ProductForm.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, qty, day } from '../lib/format.js';

/* ============================================================
   PRODUCT MASTER — CONNECTED TO THE ERP DATABASE
   ============================================================
   The same screen that was reviewed and approved: the same
   columns, filters, bulk bar, detail panel and layout. What
   changed is underneath — every row now comes from the ERP's
   PostgreSQL database through the Product Master API, and the
   search, filters, sort and paging are done THERE rather than in
   the browser.
   ============================================================ */

/** The five words this screen uses for a product's state.
 *  Four of them are statuses the studio sets; "Out of Stock" is
 *  not — it is derived from inventory, and never written to the
 *  product. */
const STATUS_LABEL = {
  ACTIVE: { label: 'Active', tone: 'ok', note: 'On sale.' },
  INACTIVE: { label: 'Inactive', tone: 'info', note: 'Withdrawn for now. Not deleted; may return.' },
  DISCONTINUED: { label: 'Discontinued', tone: 'inert', note: 'Retired. Do not reorder, even at zero stock.' },
};

function availabilityOf(product) {
  if (product.status === 'DISCONTINUED') return null;
  if (product.stock.isOutOfStock) {
    return { label: 'Out of Stock', tone: 'danger', note: 'Nothing on hand. Still an active product — reorder it.' };
  }
  if (product.stock.isLowStock) {
    return { label: 'Low Stock', tone: 'warn', note: 'At or below the reorder level.' };
  }
  return null;
}

export default function ProductMaster() {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') || '';

  const [brandId, setBrandId] = useState('all');
  const [categoryId, setCategoryId] = useState('all');
  const [status, setStatus] = useState('all');
  const [colour, setColour] = useState('all');
  const [finish, setFinish] = useState('all');
  const [size, setSize] = useState('all');
  const [includeArchived, setIncludeArchived] = useState(false);

  const [sort, setSort] = useState({ key: 'sku', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [selected, setSelected] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null);   // 'new' | product | null
  const [bulk, setBulk] = useState(null);

  const setSearch = useCallback((q) => {
    setParams(q ? { q } : {}, { replace: true });
    setPage(1);
  }, [setParams]);

  const reset = () => setPage(1);

  const query = useMemo(() => ({
    search: search || undefined,
    brandId, categoryId, status, colour, finish, size,
    includeArchived: includeArchived || undefined,
    sortBy: sort.key,
    sortDir: sort.dir,
    page,
    pageSize,
  }), [search, brandId, categoryId, status, colour, finish, size, includeArchived, sort, page, pageSize]);

  const list = useApi(() => api.products.list(query), [JSON.stringify(query)]);
  const brands = useApi(() => api.brands.list({ pageSize: 200 }), []);
  const categories = useApi(() => api.reference.categories(), []);
  const options = useApi(() => api.products.filterOptions(), []);

  const columns = [
    { key: 'sku', label: 'Code', width: 150, render: (p) => <span className="sku">{p.sku}</span> },
    {
      key: 'name',
      label: 'Product',
      render: (p) => (
        <>
          <strong>{p.name}</strong>
          <div className="tiny muted">
            {p.productHead ? p.productHead.name : <span className="muted">no series</span>}
            {p.isArchived && <> · <em>archived</em></>}
          </div>
        </>
      ),
    },
    { key: 'brand', label: 'Brand', width: 100, sortable: false, value: (p) => p.brand?.name },
    { key: 'size', label: 'Size', width: 110, render: (p) => <span className="sku">{p.size}</span> },
    { key: 'finish', label: 'Finish', width: 88 },
    { key: 'colour', label: 'Colour', width: 96 },
    { key: 'category', label: 'Category', width: 130, sortable: false, value: (p) => p.category?.name },
    {
      key: 'thicknessMm',
      label: 'Thickness',
      align: 'right',
      width: 92,
      sortable: false,
      render: (p) => (p.thicknessMm === null ? <span className="muted">—</span> : <span className="num">{p.thicknessMm} mm</span>),
    },
    { key: 'purchasePrice', label: 'Cost / sqft', align: 'right', width: 100, render: (p) => <span className="num">{money(p.purchasePrice)}</span> },
    { key: 'sellingPrice', label: 'Sell / sqft', align: 'right', width: 100, render: (p) => <span className="num">{money(p.sellingPrice)}</span> },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      width: 84,
      sortable: false,
      render: (p) => {
        if (!p.purchasePrice) return <span className="muted">—</span>;
        return <span className="num">{Math.round(((p.sellingPrice - p.purchasePrice) / p.purchasePrice) * 100)}%</span>;
      },
    },
    {
      key: 'onHand',
      label: 'On hand',
      align: 'right',
      width: 92,
      sortable: false,
      render: (p) => <span className="num">{qty(p.stock.onHand)}</span>,
    },
    { key: 'reorderLevel', label: 'Reorder at', align: 'right', width: 100, sortable: false, render: (p) => <span className="num">{qty(p.reorderLevel)}</span> },
    {
      key: 'status',
      label: 'Status',
      width: 190,
      render: (p) => {
        const s = STATUS_LABEL[p.status];
        const avail = availabilityOf(p);
        return (
          <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
            <StatusPill tone={s.tone} title={s.note}>{s.label}</StatusPill>
            {/* Availability sits BESIDE the status, never instead
                of it: a product can be Active and out of stock at
                the same time, and conflating the two is how
                somebody reorders a discontinued line. */}
            {avail && <StatusPill tone={avail.tone} title={avail.note}>{avail.label}</StatusPill>}
          </span>
        );
      },
    },
    { key: 'updatedAt', label: 'Updated', width: 112, render: (p) => <span className="tiny muted">{day(p.updatedAt)}</span> },
  ];

  if (list.error && !list.data) return <Failed error={list.error} onRetry={list.reload} />;

  const rows = list.data?.rows ?? [];

  const bulkActions = (
    <>
      <button className="btn btn-sm" onClick={() => setBulk('price')}>Change price</button>
      <button className="btn btn-sm" onClick={() => setBulk('category')}>Move category</button>
      <button className="btn btn-sm" onClick={() => setBulk('status')}>Set status</button>
      <button className="btn btn-sm" onClick={() => setBulk('export')}>Export selected</button>
      <button className="btn btn-sm btn-danger" onClick={() => setBulk('archive')}>Archive</button>
    </>
  );

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            The ERP&rsquo;s own record of every product. It is the master for
            cost, price, stock and status; the website is told what changes
            here, never the other way round.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setBulk('import')}>Import</button>
          <button className="btn" onClick={() => setBulk('export')}>Export</button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>New product</button>
        </div>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search code, name, brand, series, colour…"
        selectable
        selected={selected}
        onSelect={setSelected}
        bulkActions={bulkActions}
        onRowClick={(p) => setOpenId(p.id)}
        emptyTitle="No products match"
        emptyNote="Try a different search, or clear the filters above."
        server={{
          total: list.data?.total ?? 0,
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? pageSize,
          pageCount: list.data?.pageCount ?? 1,
          loading: list.loading,
          sort,
          onPage: setPage,
          onPageSize: (n) => { setPageSize(n); setPage(1); },
          onSort: (next) => { setSort(next); setPage(1); },
        }}
        filters={(
          <>
            <select className="select" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); reset(); }} aria-label="Category">
              <option value="all">All categories</option>
              {(categories.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="select" value={brandId} onChange={(e) => { setBrandId(e.target.value); reset(); }} aria-label="Brand">
              <option value="all">All brands</option>
              {(brands.data?.rows ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }} aria-label="Status">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="select" value={colour} onChange={(e) => { setColour(e.target.value); reset(); }} aria-label="Colour">
              <option value="all">All colours</option>
              {(options.data?.colours ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="select" value={finish} onChange={(e) => { setFinish(e.target.value); reset(); }} aria-label="Finish">
              <option value="all">All finishes</option>
              {(options.data?.finishes ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select className="select" value={size} onChange={(e) => { setSize(e.target.value); reset(); }} aria-label="Size">
              <option value="all">All sizes</option>
              {(options.data?.sizes ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="tiny muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => { setIncludeArchived(e.target.checked); reset(); }}
              />
              Show archived
            </label>
          </>
        )}
      />

      {openId && (
        <ProductDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={(product) => { setOpenId(null); setEditing(product); }}
          onChanged={() => { list.reload(); }}
        />
      )}

      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          brands={brands.data?.rows ?? []}
          categories={categories.data?.rows ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); options.reload(); }}
        />
      )}

      <Modal
        open={!!bulk}
        onClose={() => setBulk(null)}
        title="Not wired up in this phase"
        subtitle={selected.length ? selected.length + ' product(s) selected' : undefined}
        footer={<button className="btn btn-primary" onClick={() => setBulk(null)}>Understood</button>}
      >
        <p>
          Single-product create, edit, status change and archive are live
          against the ERP database. Bulk actions, import and export are not:
          they are the Excel import phase, which is deliberately separate.
        </p>
        <p className="muted tiny">
          Saying so beats a button that appears to change{' '}
          {selected.length || 'several'} products and silently does not.
        </p>
      </Modal>
    </>
  );
}

/* ── one product, from the database ──────────────────────────── */

function ProductDetail({ id, onClose, onEdit, onChanged }) {
  const detail = useApi(() => api.products.get(id), [id]);
  const stock = useApi(() => api.products.stock(id), [id]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await detail.reload(); onChanged(); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  const p = detail.data;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={p ? p.name : 'Loading…'}
      subtitle={p ? p.sku + ' · ' + (p.brand?.name ?? '') + ' · ' + p.size : ''}
      footer={p && (
        <>
          {p.isArchived
            ? <button className="btn" disabled={busy} onClick={() => act(() => api.products.restore(id))}>Restore</button>
            : <button className="btn btn-danger" disabled={busy} onClick={() => act(() => api.products.archive(id, 'Archived from Product Master'))}>Archive</button>}
          {p.status !== 'ACTIVE' && <button className="btn" disabled={busy} onClick={() => act(() => api.products.setStatus(id, 'ACTIVE'))}>Activate</button>}
          {p.status !== 'INACTIVE' && <button className="btn" disabled={busy} onClick={() => act(() => api.products.setStatus(id, 'INACTIVE'))}>Deactivate</button>}
          {p.status !== 'DISCONTINUED' && <button className="btn" disabled={busy} onClick={() => act(() => api.products.setStatus(id, 'DISCONTINUED'))}>Discontinue</button>}
          <button className="btn btn-primary" onClick={() => onEdit(p)}>Edit</button>
        </>
      )}
    >
      {detail.error && <FieldErrors error={detail.error} />}
      {error && <FieldErrors error={error} />}
      {!p && !detail.error && <p className="muted">Reading from the ERP database…</p>}

      {p && (
        <>
          <div className="detail-grid">
            {[
              ['SKU', p.sku],
              ['Brand', p.brand?.name],
              ['Product head', p.productHead?.name ?? '—'],
              ['Category', p.category?.name],
              ['Size', p.size],
              ['Thickness', p.thicknessMm === null ? '—' : p.thicknessMm + ' mm'],
              ['Finish', p.finish ?? '—'],
              ['Colour', p.colour ?? '—'],
              ['Unit', p.uom + (p.piecesPerUnit ? ' of ' + p.piecesPerUnit + ' pcs' : '')
                + (p.areaSqftPerUnit ? ' (' + p.areaSqftPerUnit + ' sqft)' : '')],
              ['Cost', money(p.purchasePrice) + ' ' + p.priceBasis.replace('PER_', 'per ').toLowerCase()],
              ['Selling', money(p.sellingPrice)],
              ['MRP', p.mrp === null ? '—' : money(p.mrp)],
              ['HSN', p.hsnCode ?? '—'],
              ['Reorder level', qty(p.reorderLevel)],
              ['Created', day(p.createdAt)],
              ['Updated', day(p.updatedAt)],
            ].map(([label, value]) => (
              <div className="detail-row" key={label}>
                <span className="detail-label">{label}</span>
                <span className="detail-value">{value}</span>
              </div>
            ))}
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <span className="detail-value">
                <StatusPill tone={STATUS_LABEL[p.status].tone}>{STATUS_LABEL[p.status].label}</StatusPill>
                <div className="tiny muted" style={{ marginTop: 4 }}>{STATUS_LABEL[p.status].note}</div>
              </span>
            </div>
          </div>

          {p.attributes && Object.keys(p.attributes).length > 0 && (
            <>
              <p className="kpi-label" style={{ margin: '18px 0 6px' }}>
                {p.category?.name} attributes
              </p>
              <div className="detail-grid">
                {Object.entries(p.attributes).map(([k, v]) => (
                  <div className="detail-row" key={k}>
                    <span className="detail-label">{k}</span>
                    <span className="detail-value">{String(v)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="kpi-label" style={{ margin: '18px 0 6px' }}>Stock — read only</p>
          {stock.data ? (
            <>
              <div className="summary-strip" style={{ margin: 0 }}>
                <div><span className="kpi-label">On hand</span><strong className="num">{qty(stock.data.totalStock)}</strong></div>
                <div><span className="kpi-label">Available</span><strong className="num">{qty(stock.data.availableStock)}</strong></div>
                <div><span className="kpi-label">Inward</span><strong className="num">{qty(stock.data.stockInward)}</strong></div>
                <div><span className="kpi-label">Outward</span><strong className="num">{qty(stock.data.stockOutward)}</strong></div>
              </div>
              <div className="table-scroll" style={{ marginTop: 10 }}>
                <table className="table">
                  <thead>
                    <tr><th>Warehouse</th><th className="right">On hand</th><th className="right">Reserved</th><th className="right">Reorder at</th></tr>
                  </thead>
                  <tbody>
                    {stock.data.byWarehouse.length === 0 ? (
                      <tr><td colSpan={4} className="muted">Never stocked.</td></tr>
                    ) : stock.data.byWarehouse.map((w) => (
                      <tr key={w.warehouseId}>
                        <td><strong>{w.name}</strong><div className="tiny muted">{w.city}</div></td>
                        <td className="right num">{qty(w.quantityOnHand)}</td>
                        <td className="right num">{qty(w.quantityReserved)}</td>
                        <td className="right num">{qty(w.reorderLevel)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                These figures come from the append-only stock ledger and cannot be
                changed here. Moving stock is the inventory module&rsquo;s job.
              </p>
            </>
          ) : <p className="muted tiny">Reading stock…</p>}
        </>
      )}
    </Modal>
  );
}
