import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import Modal from '../components/Modal.jsx';
import { PRODUCTS } from '../data/ledger.js';
import { CATEGORIES, SUPPLIERS, STATUSES, FIELD_ORIGIN } from '../data/catalogue.js';
import { money, qty, day } from '../lib/format.js';

/* The order statuses are listed in, from "fine" to "needs a
   decision". Used for sorting the status column, so sorting it
   groups the work rather than alphabetising it into Active,
   Discontinued, Draft, Low, Out. */
const SEVERITY = { active: 0, draft: 1, discontinued: 2, low: 3, out: 4 };

export default function ProductMaster() {
  /* The search term lives in the URL, so the dashboard's reorder
     list can link straight to a product and the reader lands on it
     already filtered -- and so a filtered view can be sent to
     somebody else. */
  const [params, setParams] = useSearchParams();
  const search = params.get('q') || '';
  const setSearch = (q) => setParams(q ? { q } : {}, { replace: true });

  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [brand, setBrand] = useState('all');
  const [selected, setSelected] = useState([]);
  const [open, setOpen] = useState(null);
  const [bulk, setBulk] = useState(null);

  const brands = useMemo(() => [...new Set(PRODUCTS.map((p) => p.brand))].sort(), []);

  const rows = useMemo(() => PRODUCTS.filter((p) =>
    (category === 'all' || p.category === category)
    && (status === 'all' || p.status === status)
    && (brand === 'all' || p.brand === brand)), [category, status, brand]);

  const columns = [
    {
      key: 'productCode',
      label: 'Code',
      width: 96,
      render: (p) => <span className="sku">{p.productCode}</span>,
    },
    {
      key: 'name',
      label: 'Product',
      render: (p) => (
        <>
          <strong>{p.name}</strong>
          <div className="tiny muted">{p.collection} · {p.type}</div>
        </>
      ),
    },
    { key: 'brand', label: 'Brand', width: 90 },
    { key: 'size', label: 'Size', width: 110, render: (p) => <span className="sku">{p.size}</span> },
    { key: 'finish', label: 'Finish', width: 88 },
    {
      key: 'colorTone',
      label: 'Colour',
      width: 96,
      render: (p) => <>{p.colorTone}</>,
    },
    {
      key: 'category',
      label: 'Category',
      width: 130,
      value: (p) => CATEGORIES.find((c) => c.id === p.category)?.name,
    },
    { key: 'bestRoom', label: 'Best room', width: 120 },
    {
      key: 'purchaseRate',
      label: 'Cost / sqft',
      align: 'right',
      width: 100,
      render: (p) => <span className="num">{money(p.purchaseRate)}</span>,
    },
    {
      key: 'sellingRate',
      label: 'Sell / sqft',
      align: 'right',
      width: 100,
      render: (p) => <span className="num">{money(p.sellingRate)}</span>,
    },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      width: 84,
      value: (p) => Math.round(((p.sellingRate - p.purchaseRate) / p.purchaseRate) * 100),
      render: (p) => (
        <span className="num">{Math.round(((p.sellingRate - p.purchaseRate) / p.purchaseRate) * 100)}%</span>
      ),
    },
    {
      key: 'stockQty',
      label: 'On hand',
      align: 'right',
      width: 92,
      render: (p) => <span className="num">{qty(p.stockQty)}</span>,
    },
    {
      key: 'reorderLevel',
      label: 'Reorder at',
      align: 'right',
      width: 100,
      render: (p) => <span className="num">{qty(p.reorderLevel)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 140,
      sortKey: (p) => SEVERITY[p.status],
      value: (p) => STATUSES[p.status].label,
      render: (p) => (
        <StatusPill tone={STATUSES[p.status].tone} title={STATUSES[p.status].note}>
          {STATUSES[p.status].label}
        </StatusPill>
      ),
    },
    {
      key: 'onWebsite',
      label: 'On website',
      width: 104,
      value: (p) => (p.onWebsite ? 'Listed' : 'Not listed'),
      render: (p) => (
        <span className={p.onWebsite ? 'tiny' : 'tiny muted'}>
          {p.onWebsite ? 'Listed' : 'Not listed'}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      label: 'Updated',
      width: 112,
      render: (p) => <span className="tiny muted">{day(p.updatedAt)}</span>,
    },
  ];

  /* Every bulk action opens a confirmation naming the rows it would
     touch. In this build it then stops: the prototype does not
     pretend to write. That is deliberate -- a button that appears to
     change 24 prices and silently does nothing is worse than one
     that says so. */
  const bulkActions = (
    <>
      <button className="btn btn-sm" onClick={() => setBulk('price')}>Change price</button>
      <button className="btn btn-sm" onClick={() => setBulk('category')}>Move category</button>
      <button className="btn btn-sm" onClick={() => setBulk('status')}>Set status</button>
      <button className="btn btn-sm" onClick={() => setBulk('export')}>Export selected</button>
      <button className="btn btn-sm btn-danger" onClick={() => setBulk('discontinue')}>Discontinue</button>
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
          <button className="btn btn-primary" onClick={() => setBulk('new')}>New product</button>
        </div>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.productCode}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search code, name, brand, colour…"
        initialSort={{ key: 'productCode', dir: 'asc' }}
        selectable
        selected={selected}
        onSelect={setSelected}
        bulkActions={bulkActions}
        onRowClick={setOpen}
        emptyTitle="No products match"
        emptyNote="Try a different search, or clear the filters above."
        filters={(
          <>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
              <option value="all">All brands</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="all">All statuses</option>
              {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </>
        )}
      />

      <ProductDrawer product={open} onClose={() => setOpen(null)} />

      <Modal
        open={!!bulk}
        onClose={() => setBulk(null)}
        title="Not wired up in this build"
        subtitle={selected.length ? selected.length + ' product(s) selected' : undefined}
        footer={<button className="btn btn-primary" onClick={() => setBulk(null)}>Understood</button>}
      >
        <p>
          This is a UI prototype. The screens, the columns and the actions are
          here to be reviewed and agreed; nothing writes to a database, and no
          real product is changed.
        </p>
        <p className="muted tiny">
          Showing you a confirmation that then does nothing is the honest
          version. A button that appears to change
          {' '}{selected.length || 'several'} products and silently does not is
          how a prototype gets mistaken for a working system.
        </p>
      </Modal>
    </>
  );
}

/* ── one product, in full ─────────────────────────────────────── */

function ProductDrawer({ product, onClose }) {
  if (!product) return null;

  const cat = CATEGORIES.find((c) => c.id === product.category);
  const sup = SUPPLIERS.find((s) => s.id === product.supplier);

  const rows = [
    ['productCode', 'Product code', product.productCode],
    ['name', 'Name', product.name],
    ['brand', 'Brand', product.brand],
    ['collection', 'Collection', product.collection],
    ['size', 'Size', product.size],
    ['finish', 'Finish', product.finish],
    ['type', 'Type', product.type],
    ['colorTone', 'Colour tone', product.colorTone],
    ['bestRoom', 'Best room', product.bestRoom],
    ['category', 'Category', cat?.name],
    ['hsnCode', 'HSN code', product.hsnCode],
    ['unit', 'Unit', product.unit + ' of ' + product.pcsPerBox + ' pcs (' + product.sqftPerBox + ' sqft)'],
    ['purchaseRate', 'Cost per sqft', money(product.purchaseRate)],
    ['sellingRate', 'Selling per sqft', money(product.sellingRate)],
    ['mrp', 'MRP per sqft', money(product.mrp)],
    ['stockQty', 'On hand', qty(product.stockQty) + ' boxes'],
    ['reorderLevel', 'Reorder level', qty(product.reorderLevel) + ' boxes'],
    ['supplier', 'Supplier', sup?.name],
    ['updatedAt', 'Last updated', day(product.updatedAt)],
  ];

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={product.name}
      subtitle={product.productCode + ' · ' + product.brand + ' · ' + product.size}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div className="notice notice-info">
        <span aria-hidden="true">●</span>
        <div>
          <strong>Where each field would come from.</strong> Marked
          {' '}<em>website</em> where the existing site already stores it, and
          {' '}<em>ERP</em> where it has no counterpart there today — which is
          every commercial field below, and the reason the ERP has to be the
          master rather than a mirror.
        </div>
      </div>

      <div className="detail-grid">
        {rows.map(([key, label, value]) => (
          <div className="detail-row" key={key}>
            <span className="detail-label">
              {label}
              <span className={'origin is-' + (FIELD_ORIGIN[key] || 'erp')}>
                {FIELD_ORIGIN[key] === 'website' ? 'website' : 'ERP'}
              </span>
            </span>
            <span className="detail-value">{value}</span>
          </div>
        ))}

        <div className="detail-row">
          <span className="detail-label">
            Status
            <span className="origin is-erp">ERP</span>
          </span>
          <span className="detail-value">
            <StatusPill tone={STATUSES[product.status].tone}>{STATUSES[product.status].label}</StatusPill>
            <div className="tiny muted" style={{ marginTop: 4 }}>{STATUSES[product.status].note}</div>
          </span>
        </div>
      </div>
    </Modal>
  );
}
