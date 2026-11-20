import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { PRODUCTS, MOVEMENTS, MOVEMENT_REASONS, ledgerFor, openingFor } from '../data/ledger.js';
import { STATUSES, DEMO_TODAY } from '../data/catalogue.js';
import { money, qty, stamp } from '../lib/format.js';

/* ============================================================
   THE STOCK CARD
   ============================================================
   One product, every movement against it, and the balance after
   each one. This is the screen that makes the rest of the
   inventory believable: the number the Product Master shows is the
   last line of this column, and anyone can follow it back.
   ============================================================ */

export default function StockLedger() {
  /* This component holds exactly one hook and then chooses between
     two children. The chooser and the card each own their own state,
     which is what keeps the hook order stable: an early return taken
     AFTER a useState or useMemo would change how many hooks this
     component calls between renders, and React would break. */
  const [params, setParams] = useSearchParams();
  const code = params.get('product') || '';
  const product = PRODUCTS.find((p) => p.productCode === code) || null;

  if (!product) return <ProductChooser onPick={(c) => setParams({ product: c })} />;
  return <StockCard product={product} onBack={() => setParams({})} />;
}

/* ── one product's card ──────────────────────────────────────── */

function StockCard({ product, onBack }) {
  const code = product.productCode;
  const [search, setSearch] = useState('');
  const rows = useMemo(() => ledgerFor(code).slice().reverse(), [code]);
  const opening = openingFor(code);
  const closing = rows.length ? rows[0].balance : 0;

  const totalIn = rows.filter((m) => m.dir === 'in' && m.reason !== 'opening').reduce((s, m) => s + m.qty, 0);
  const totalOut = rows.filter((m) => m.dir === 'out').reduce((s, m) => s + m.qty, 0);

  const columns = [
    { key: 'at', label: 'When', width: 150, render: (m) => stamp(m.at) },
    { key: 'id', label: 'Ref', width: 100, render: (m) => <span className="sku">{m.id}</span> },
    { key: 'reason', label: 'Reason', width: 160, value: (m) => MOVEMENT_REASONS[m.reason].label },
    { key: 'party', label: 'Party', width: 230 },
    { key: 'ref', label: 'Document', width: 120, render: (m) => <span className="sku">{m.ref}</span> },
    {
      key: 'in',
      label: 'In',
      align: 'right',
      width: 80,
      value: (m) => (m.dir === 'in' ? m.qty : 0),
      render: (m) => (m.dir === 'in' ? <span className="num">{qty(m.qty)}</span> : <span className="muted">—</span>),
    },
    {
      key: 'out',
      label: 'Out',
      align: 'right',
      width: 80,
      value: (m) => (m.dir === 'out' ? m.qty : 0),
      render: (m) => (m.dir === 'out' ? <span className="num">{qty(m.qty)}</span> : <span className="muted">—</span>),
    },
    {
      key: 'balance',
      label: 'Balance',
      align: 'right',
      width: 96,
      render: (m) => <strong className="num">{qty(m.balance)}</strong>,
    },
  ];

  return (
    <>
      <div className="page-intro">
        <div>
          <h2>{product.name}</h2>
          <p>
            <span className="sku">{product.productCode}</span> · {product.brand} · {product.size} · {product.finish}
          </p>
        </div>
        <div className="page-actions">
          <StatusPill tone={STATUSES[product.status].tone} title={STATUSES[product.status].note}>
            {STATUSES[product.status].label}
          </StatusPill>
          <button className="btn" onClick={onBack}>Another product</button>
        </div>
      </div>

      {/* The arithmetic, stated. Opening plus in, minus out, equals
          what the Product Master shows -- and the reader can check
          every term of it against the rows below. */}
      <div className="reconcile">
        <div><span className="kpi-label">Opening</span><strong className="num">{qty(opening)}</strong></div>
        <span className="reconcile-op">+</span>
        <div><span className="kpi-label">Received</span><strong className="num">{qty(totalIn)}</strong></div>
        <span className="reconcile-op">−</span>
        <div><span className="kpi-label">Issued</span><strong className="num">{qty(totalOut)}</strong></div>
        <span className="reconcile-op">=</span>
        <div className="is-closing">
          <span className="kpi-label">On hand today</span>
          <strong className="num">{qty(closing)}</strong>
        </div>
        <p className="tiny muted">
          {closing === product.stockQty
            ? 'Agrees with the Product Master.'
            : 'Does NOT agree with the Product Master (' + qty(product.stockQty) + ').'}
          {' '}Valued at {money(closing * product.purchaseRate * product.sqftPerBox)} at cost.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search reason, party, document…"
        initialSort={{ key: 'at', dir: 'desc' }}
        pageSize={50}
        emptyTitle="No movements"
        emptyNote="This product has no stock history in the last 90 days."
      />
    </>
  );
}

/* ── which product's card ────────────────────────────────────── */

function ProductChooser({ onPick }) {
  const [search, setSearch] = useState('');

  const rows = useMemo(() => PRODUCTS.map((p) => ({
    ...p,
    movements: MOVEMENTS.filter((m) => m.productCode === p.productCode).length,
  })), []);

  const columns = [
    { key: 'productCode', label: 'Code', width: 96, render: (p) => <span className="sku">{p.productCode}</span> },
    {
      key: 'name',
      label: 'Product',
      render: (p) => (
        <>
          <strong>{p.name}</strong>
          <div className="tiny muted">{p.brand} · {p.size}</div>
        </>
      ),
    },
    { key: 'movements', label: 'Movements', align: 'right', width: 110, render: (p) => <span className="num">{qty(p.movements)}</span> },
    { key: 'stockQty', label: 'On hand', align: 'right', width: 92, render: (p) => <span className="num">{qty(p.stockQty)}</span> },
    {
      key: 'status',
      label: 'Status',
      width: 140,
      value: (p) => STATUSES[p.status].label,
      render: (p) => <StatusPill tone={STATUSES[p.status].tone}>{STATUSES[p.status].label}</StatusPill>,
    },
  ];

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Pick a product to open its stock card: every movement against it,
            oldest to newest, with the balance after each one. Nothing here is
            a separate record — the card <em>is</em> where the on-hand figure
            comes from.
          </p>
        </div>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.productCode}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search for a product…"
        initialSort={{ key: 'productCode', dir: 'asc' }}
        onRowClick={(p) => onPick(p.productCode)}
        emptyTitle="No products match"
        emptyNote="Try a different search."
      />
    </>
  );
}
