import { useState } from 'react';
import Modal from '../components/Modal.jsx';
import { PRODUCTS } from '../data/ledger.js';
import { FIELD_ORIGIN } from '../data/catalogue.js';
import { qty, day } from '../lib/format.js';

/* ============================================================
   IMPORT / EXPORT
   ============================================================
   The brief's own rule, and the right one: Google Sheets must not
   become a second Product Master. A spreadsheet is for getting
   data IN once and for taking a copy OUT to read. It is never the
   place a price is decided, because two places that both decide a
   price will disagree, and nobody will know which is right.

   That rule is not a sentence in a document here; it is the shape
   of the screen. Import is one-way and explicitly a migration or a
   correction. Export is a snapshot, stamped and described as read-
   only. There is no "sync with sheet", and there should not be.
   ============================================================ */

const EXPORTS = [
  {
    id: 'ex-products',
    name: 'Product Master',
    what: 'Every product with its cost, price, stock, reorder level and status.',
    rows: PRODUCTS.length,
    columns: Object.keys(FIELD_ORIGIN).length,
  },
  {
    id: 'ex-stock',
    name: 'Stock on hand',
    what: 'Code, name, quantity, reorder level, value at cost. For a stock-take.',
    rows: PRODUCTS.filter((p) => p.status !== 'draft').length,
    columns: 6,
  },
  {
    id: 'ex-ledger',
    name: 'Stock ledger',
    what: 'Every movement in the period, with the running balance.',
    rows: 1437,
    columns: 11,
  },
  {
    id: 'ex-reorder',
    name: 'Reorder list',
    what: 'Products at or below the reorder level, with the shortfall. Discontinued lines excluded.',
    rows: PRODUCTS.filter((p) => p.status === 'low' || p.status === 'out').length,
    columns: 7,
  },
];

const IMPORTS = [
  {
    id: 'im-products',
    name: 'Products',
    what: 'Create or update products by product code. Used to bring an existing catalogue in, or to correct many rows at once.',
    note: 'Matches on product code. A code the ERP does not know is created; one it knows is updated.',
  },
  {
    id: 'im-stock',
    name: 'Opening stock',
    what: 'Set each product’s starting quantity, once, when the ERP goes live.',
    note: 'Writes an opening balance to the ledger rather than overwriting a quantity — so the stock card still explains the figure.',
  },
  {
    id: 'im-prices',
    name: 'Price revision',
    what: 'A supplier’s new rates across many products.',
    note: 'Cost and selling rate only. Never stock: a quantity has to come from a movement.',
  },
];

export default function Transfer() {
  const [dialog, setDialog] = useState(null);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Getting data in once, and taking a copy out to read. Deliberately
            not a two-way sync.
          </p>
        </div>
      </div>

      <div className="notice notice-warn">
        <span aria-hidden="true">●</span>
        <div>
          <strong>A spreadsheet must not become a second Product Master.</strong>{' '}
          Export is a dated snapshot to read, circulate or check against; import
          is a one-way load for migration and bulk correction. There is no
          &ldquo;keep the sheet in sync&rdquo; option on this screen, and that is
          the design: two places that both decide a price will disagree, and
          nobody will be able to say which one is right.
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Export</h2>
              <p>A snapshot of the data as it stands now. Read-only by nature.</p>
            </div>
          </div>
          <div className="panel-body stack">
            {EXPORTS.map((e) => (
              <div className="transfer-row" key={e.id}>
                <div>
                  <strong>{e.name}</strong>
                  <p className="tiny muted">{e.what}</p>
                  <p className="tiny muted">
                    <span className="num">{qty(e.rows)}</span> rows ·{' '}
                    <span className="num">{e.columns}</span> columns
                  </p>
                </div>
                <div className="transfer-actions">
                  <button className="btn btn-sm" onClick={() => setDialog({ kind: 'export', item: e, as: 'CSV' })}>CSV</button>
                  <button className="btn btn-sm" onClick={() => setDialog({ kind: 'export', item: e, as: 'Excel' })}>Excel</button>
                  <button className="btn btn-sm" onClick={() => setDialog({ kind: 'export', item: e, as: 'Google Sheet' })}>Sheet</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Import</h2>
              <p>One-way, into the ERP. For migration and bulk correction.</p>
            </div>
          </div>
          <div className="panel-body stack">
            {IMPORTS.map((i) => (
              <div className="transfer-row" key={i.id}>
                <div>
                  <strong>{i.name}</strong>
                  <p className="tiny muted">{i.what}</p>
                  <p className="tiny" style={{ color: 'var(--gold)' }}>{i.note}</p>
                </div>
                <div className="transfer-actions">
                  <button className="btn btn-sm" onClick={() => setDialog({ kind: 'template', item: i })}>Template</button>
                  <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'import', item: i })}>Upload</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Recent transfers</h2>
            <p>Every import and export is recorded, with who ran it</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>When</th><th>What</th><th>Direction</th>
                <th className="right">Rows</th><th>By</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{day('2026-11-18')}</td><td>Product Master</td><td>Export · Excel</td>
                <td className="right num">91</td><td>Studio Manager</td><td>Downloaded</td>
              </tr>
              <tr>
                <td>{day('2026-11-11')}</td><td>Price revision — Somany</td><td>Import · CSV</td>
                <td className="right num">14</td><td>Devyora Admin</td><td>14 updated, 0 rejected</td>
              </tr>
              <tr>
                <td>{day('2026-10-28')}</td><td>Reorder list</td><td>Export · Google Sheet</td>
                <td className="right num">19</td><td>Studio Manager</td><td>Downloaded</td>
              </tr>
              <tr>
                <td>{day('2026-09-02')}</td><td>Opening stock</td><td>Import · CSV</td>
                <td className="right num">87</td><td>Devyora Admin</td><td>87 opening balances written</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog ? (dialog.kind === 'export' ? 'Export ' + dialog.item.name
          : dialog.kind === 'template' ? dialog.item.name + ' template'
            : 'Import ' + dialog.item.name) : ''}
        footer={<button className="btn btn-primary" onClick={() => setDialog(null)}>Understood</button>}
      >
        <p>
          This is a UI prototype — no file is produced, read or written.
        </p>
        {dialog && dialog.kind === 'export' && (
          <p className="tiny muted">
            The real version would hand you a {dialog.as} of{' '}
            <span className="num">{qty(dialog.item.rows)}</span> rows, stamped
            with the moment it was taken. The stamp matters: a sheet with no
            date on it is the first step towards somebody treating it as
            current.
          </p>
        )}
        {dialog && dialog.kind === 'import' && (
          <p className="tiny muted">
            The real version would show you what it is about to do — rows to
            create, rows to change with the before and after, and rows it
            cannot read — and change nothing until you accept it. {dialog.item.note}
          </p>
        )}
        {dialog && dialog.kind === 'template' && (
          <p className="tiny muted">
            The template carries only the columns this import may set, so a
            sheet cannot quietly arrive carrying a column it is not allowed to
            write — a stock quantity, for instance, which has to come from a
            movement.
          </p>
        )}
      </Modal>
    </>
  );
}
