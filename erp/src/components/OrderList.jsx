import { useMemo, useState } from 'react';
import DataTable from './DataTable.jsx';
import Modal from './Modal.jsx';
import StatusPill from './StatusPill.jsx';
import { money, qty, day } from '../lib/format.js';

/* ============================================================
   PURCHASE AND SALES ORDERS
   ============================================================
   The two differ in who the other party is and in what the
   statuses mean; the shape of the screen -- a list, a filter by
   status, a line-item detail -- is the same, so it is written
   once.
   ============================================================ */

export default function OrderList({
  orders, statuses, partyLabel, partyKey, intro, newLabel, rateLabel, extraColumn,
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(
    () => orders.filter((o) => status === 'all' || o.status === status),
    [orders, status],
  );

  const value = rows.reduce((s, o) => s + o.total, 0);
  // Cancelled orders are counted in the list but never in the money:
  // an order that was called off is not trade the studio did.
  const live = rows.filter((o) => o.status !== 'cancelled');
  const liveValue = live.reduce((s, o) => s + o.total, 0);

  const columns = [
    { key: 'id', label: 'Order', width: 96, render: (o) => <span className="sku">{o.id}</span> },
    { key: partyKey, label: partyLabel, render: (o) => <strong>{o[partyKey]}</strong> },
    { key: 'placedOn', label: 'Placed', width: 118, render: (o) => day(o.placedOn) },
    ...(extraColumn ? [extraColumn] : []),
    {
      key: 'lines',
      label: 'Lines',
      align: 'right',
      width: 72,
      value: (o) => o.lines.length,
      render: (o) => <span className="num">{o.lines.length}</span>,
    },
    {
      key: 'boxes',
      label: 'Boxes',
      align: 'right',
      width: 84,
      value: (o) => o.lines.reduce((s, l) => s + l.qty, 0),
      render: (o) => <span className="num">{qty(o.lines.reduce((s, l) => s + l.qty, 0))}</span>,
    },
    {
      key: 'total',
      label: 'Value',
      align: 'right',
      width: 124,
      render: (o) => <span className="num">{money(o.total)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 148,
      value: (o) => statuses[o.status].label,
      render: (o) => <StatusPill tone={statuses[o.status].tone}>{statuses[o.status].label}</StatusPill>,
    },
  ];

  return (
    <>
      <div className="page-intro">
        <div><p>{intro}</p></div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>{newLabel}</button>
        </div>
      </div>

      <div className="summary-strip">
        <div><span className="kpi-label">Orders</span><strong className="num">{qty(rows.length)}</strong></div>
        <div><span className="kpi-label">Value</span><strong className="num">{money(liveValue)}</strong></div>
        <div>
          <span className="kpi-label">Average order</span>
          <strong className="num">{money(live.length ? liveValue / live.length : 0)}</strong>
        </div>
        <p className="tiny muted">
          {rows.length - live.length > 0
            ? (rows.length - live.length) + ' cancelled order(s) are listed but not counted in the value.'
            : 'Last six months.'}
          {value !== liveValue ? '' : ''}
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(o) => o.id}
        search={search}
        onSearch={setSearch}
        searchPlaceholder={'Search order, ' + partyLabel.toLowerCase() + '…'}
        initialSort={{ key: 'placedOn', dir: 'desc' }}
        onRowClick={setOpen}
        emptyTitle="No orders"
        emptyNote="Nothing matches this status or search."
        filters={(
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="all">All statuses</option>
            {Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        )}
      />

      <Modal
        open={!!open}
        wide
        onClose={() => setOpen(null)}
        title={open ? open.id : ''}
        subtitle={open ? open[partyKey] + ' · placed ' + day(open.placedOn) : ''}
        footer={<button className="btn" onClick={() => setOpen(null)}>Close</button>}
      >
        {open && (
          <>
            <div className="summary-strip" style={{ marginBottom: 14 }}>
              <div>
                <span className="kpi-label">Status</span>
                <StatusPill tone={statuses[open.status].tone}>{statuses[open.status].label}</StatusPill>
              </div>
              <div><span className="kpi-label">Lines</span><strong className="num">{open.lines.length}</strong></div>
              <div><span className="kpi-label">Value</span><strong className="num">{money(open.total)}</strong></div>
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Size</th>
                    <th className="right">Boxes</th>
                    <th className="right">{rateLabel}</th>
                    <th className="right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {open.lines.map((l) => (
                    <tr key={l.productCode}>
                      <td>
                        <strong>{l.name}</strong>
                        <div className="sku">{l.productCode}</div>
                      </td>
                      <td><span className="sku">{l.size}</span></td>
                      <td className="right num">{qty(l.qty)}</td>
                      <td className="right num">{money(l.rate)}</td>
                      <td className="right num">{money(l.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4} className="right"><strong>Total</strong></td>
                    <td className="right"><strong className="num">{money(open.total)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="tiny muted" style={{ marginTop: 12 }}>
              Demo order. No invoice, no tax calculation and no document is
              produced — the audit found the website has no invoice, quotation
              or order model at all, so those are new ground for the ERP rather
              than something to mirror.
            </p>
          </>
        )}
      </Modal>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={newLabel}
        footer={<button className="btn btn-primary" onClick={() => setCreating(false)}>Understood</button>}
      >
        <p>This is a UI prototype. Nothing is saved and no stock would move.</p>
        <p className="muted tiny">
          Worth agreeing before this is built for real: whether confirming an
          order should reserve stock, and at what point the movement is written
          to the ledger — on dispatch, or on invoice.
        </p>
      </Modal>
    </>
  );
}
