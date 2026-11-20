import { useMemo, useState } from 'react';
import DataTable from './DataTable.jsx';
import Modal from './Modal.jsx';
import { MOVEMENTS, MOVEMENT_REASONS, PRODUCTS } from '../data/ledger.js';
import { DEMO_TODAY } from '../data/catalogue.js';
import { money, qty, stamp, since } from '../lib/format.js';

/* ============================================================
   INWARD AND OUTWARD, FROM ONE STREAM
   ============================================================
   Stock Inward and Stock Outward are not two sets of records. They
   are one ledger read in two directions, which is why they share
   this component: a receipt that appeared on the inward screen but
   not in the ledger would be a bug waiting to happen, and here it
   cannot exist.
   ============================================================ */

export default function MovementList({ dir, title, intro, recordLabel }) {
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('all');
  const [recording, setRecording] = useState(false);

  const reasons = Object.entries(MOVEMENT_REASONS).filter(([, v]) => v.dir === dir);

  const rows = useMemo(() => MOVEMENTS
    .filter((m) => m.dir === dir && (reason === 'all' || m.reason === reason))
    .sort((a, b) => b.at.localeCompare(a.at)), [dir, reason]);

  const totalQty = rows.reduce((s, m) => s + m.qty, 0);
  const totalValue = rows.reduce((s, m) => {
    const p = PRODUCTS.find((x) => x.productCode === m.productCode);
    return s + m.qty * m.rate * (p ? p.sqftPerBox : 1);
  }, 0);

  const columns = [
    {
      key: 'at',
      label: 'When',
      width: 150,
      render: (m) => (
        <>
          {stamp(m.at)}
          <div className="tiny muted">{since(m.at, DEMO_TODAY)}</div>
        </>
      ),
    },
    { key: 'id', label: 'Ref', width: 100, render: (m) => <span className="sku">{m.id}</span> },
    {
      key: 'productName',
      label: 'Product',
      render: (m) => (
        <>
          <strong>{m.productName}</strong>
          <div className="sku">{m.productCode} · {m.brand}</div>
        </>
      ),
    },
    {
      key: 'reason',
      label: 'Reason',
      width: 150,
      value: (m) => MOVEMENT_REASONS[m.reason].label,
    },
    { key: 'party', label: dir === 'in' ? 'From' : 'To', width: 220 },
    { key: 'ref', label: 'Document', width: 120, render: (m) => <span className="sku">{m.ref}</span> },
    { key: 'qty', label: 'Boxes', align: 'right', width: 86, render: (m) => <span className="num">{qty(m.qty)}</span> },
    {
      key: 'value',
      label: 'Value',
      align: 'right',
      width: 110,
      value: (m) => {
        const p = PRODUCTS.find((x) => x.productCode === m.productCode);
        return Math.round(m.qty * m.rate * (p ? p.sqftPerBox : 1));
      },
      render: (m) => {
        const p = PRODUCTS.find((x) => x.productCode === m.productCode);
        return <span className="num">{money(m.qty * m.rate * (p ? p.sqftPerBox : 1))}</span>;
      },
    },
    { key: 'by', label: 'Recorded by', width: 140 },
  ];

  return (
    <>
      <div className="page-intro">
        <div><p>{intro}</p></div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setRecording(true)}>{recordLabel}</button>
        </div>
      </div>

      <div className="summary-strip">
        <div>
          <span className="kpi-label">Movements</span>
          <strong className="num">{qty(rows.length)}</strong>
        </div>
        <div>
          <span className="kpi-label">Boxes {dir === 'in' ? 'received' : 'issued'}</span>
          <strong className="num">{qty(totalQty)}</strong>
        </div>
        <div>
          <span className="kpi-label">Value</span>
          <strong className="num">{money(totalValue)}</strong>
        </div>
        <p className="tiny muted">
          {dir === 'in' ? 'Valued at cost.' : 'Valued at the selling rate.'} Last 90 days.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search product, party, document…"
        initialSort={{ key: 'at', dir: 'desc' }}
        emptyTitle={'No ' + title.toLowerCase() + ' movements'}
        emptyNote="Nothing matches this reason or search."
        filters={(
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
            <option value="all">All reasons</option>
            {reasons.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        )}
      />

      <Modal
        open={recording}
        onClose={() => setRecording(false)}
        title={recordLabel}
        footer={<button className="btn btn-primary" onClick={() => setRecording(false)}>Understood</button>}
      >
        <p>
          This is a UI prototype: the form is not wired to anything, and
          recording a movement here would not change a stock figure.
        </p>
        <p className="muted tiny">
          It matters more here than elsewhere. Every quantity on these screens
          is the closing balance of a stock card — letting you add a movement
          that the ledger never saw would put the two out of step, which is the
          one thing this prototype is built not to do.
        </p>
      </Modal>
    </>
  );
}
