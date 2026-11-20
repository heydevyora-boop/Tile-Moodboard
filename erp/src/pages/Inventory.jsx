import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { PRODUCTS, stockValue, WAREHOUSE } from '../data/ledger.js';
import { CATEGORIES, STATUSES } from '../data/catalogue.js';
import { money, moneyShort, qty } from '../lib/format.js';

/* Inventory answers a different question from the Product Master.
   The Master is "what do we sell"; this is "what is on the shelf,
   what is it worth, and what has to be ordered". Same rows, a
   narrower set of columns, and a default view that opens on the
   work rather than on the whole catalogue. */

const VIEWS = {
  all:     { label: 'Everything',      match: () => true },
  order:   { label: 'Needs ordering',  match: (p) => p.status === 'low' || p.status === 'out' },
  low:     { label: 'Running low',     match: (p) => p.status === 'low' },
  out:     { label: 'Out of stock',    match: (p) => p.status === 'out' },
  holding: { label: 'Holding stock',   match: (p) => p.stockQty > 0 },
  dead:    { label: 'Discontinued, still held', match: (p) => p.status === 'discontinued' && p.stockQty > 0 },
};

export default function Inventory() {
  const [view, setView] = useState('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');

  const rows = useMemo(() => PRODUCTS.filter((p) =>
    VIEWS[view].match(p) && (category === 'all' || p.category === category)),
  [view, category]);

  const low = PRODUCTS.filter((p) => p.status === 'low');
  const out = PRODUCTS.filter((p) => p.status === 'out');
  const deadStock = PRODUCTS.filter((p) => p.status === 'discontinued' && p.stockQty > 0);

  const columns = [
    { key: 'productCode', label: 'Code', width: 96, render: (p) => <span className="sku">{p.productCode}</span> },
    {
      key: 'name',
      label: 'Product',
      render: (p) => (
        <>
          <strong>{p.name}</strong>
          <div className="tiny muted">{p.brand} · {p.size} · {p.finish}</div>
        </>
      ),
    },
    {
      key: 'category',
      label: 'Category',
      width: 130,
      value: (p) => CATEGORIES.find((c) => c.id === p.category)?.name,
    },
    { key: 'stockQty', label: 'On hand', align: 'right', width: 92, render: (p) => <span className="num">{qty(p.stockQty)}</span> },
    { key: 'reorderLevel', label: 'Reorder at', align: 'right', width: 100, render: (p) => <span className="num">{qty(p.reorderLevel)}</span> },
    {
      key: 'shortfall',
      label: 'Short by',
      align: 'right',
      width: 92,
      value: (p) => Math.max(0, p.reorderLevel - p.stockQty),
      render: (p) => {
        const short = Math.max(0, p.reorderLevel - p.stockQty);
        // A retired product is not "short": nobody is going to order
        // more of it. Showing a shortfall there would read as a
        // to-do, which is exactly the mistake to avoid.
        if (p.status === 'discontinued') return <span className="tiny muted">not reordered</span>;
        return short > 0 ? <span className="num" style={{ color: 'var(--danger)' }}>{qty(short)}</span> : <span className="muted">—</span>;
      },
    },
    {
      key: 'value',
      label: 'Value at cost',
      align: 'right',
      width: 120,
      value: (p) => Math.round(p.stockQty * p.purchaseRate * p.sqftPerBox),
      render: (p) => <span className="num">{money(p.stockQty * p.purchaseRate * p.sqftPerBox)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 140,
      value: (p) => STATUSES[p.status].label,
      render: (p) => (
        <StatusPill tone={STATUSES[p.status].tone} title={STATUSES[p.status].note}>
          {STATUSES[p.status].label}
        </StatusPill>
      ),
    },
    {
      key: 'card',
      label: '',
      sortable: false,
      width: 92,
      render: (p) => <Link className="btn btn-sm" to={'/ledger?product=' + p.productCode}>Stock card</Link>,
    },
  ];

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What is on the shelf at <strong>{WAREHOUSE.name}</strong>, {WAREHOUSE.city}
            {' '}— the only stock location in this build. Every figure here is the
            closing balance of that product&rsquo;s stock card, not a separate
            number kept alongside it.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/inward">Record inward</Link>
          <Link className="btn" to="/outward">Record outward</Link>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard label="Stock value" value={moneyShort(stockValue())} note="at cost, across every product" />
        <KpiCard
          label="Running low"
          value={qty(low.length)}
          tone={low.length ? 'warn' : undefined}
          note="at or below the reorder level"
        />
        <KpiCard
          label="Out of stock"
          value={qty(out.length)}
          tone={out.length ? 'danger' : undefined}
          note="still on sale — reorder these"
        />
        <KpiCard
          label="Discontinued, still held"
          value={qty(deadStock.length)}
          note="retired, but stock remains to clear"
        />
      </div>

      <div className="viewbar">
        {Object.entries(VIEWS).map(([k, v]) => (
          <button
            key={k}
            className={'viewtab' + (view === k ? ' is-on' : '')}
            onClick={() => setView(k)}
          >
            {v.label}
            <span className="num">{PRODUCTS.filter(v.match).length}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.productCode}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search code, name, brand…"
        initialSort={{ key: 'stockQty', dir: 'asc' }}
        emptyTitle="Nothing in this view"
        emptyNote="No product matches this combination right now."
        filters={(
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      />
    </>
  );
}
