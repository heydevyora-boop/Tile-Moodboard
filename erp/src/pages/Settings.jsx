import { useState } from 'react';
import Modal from '../components/Modal.jsx';
import { WAREHOUSE } from '../data/ledger.js';
import { DEMO_TODAY } from '../data/catalogue.js';
import { day } from '../lib/format.js';

/* Settings is where the decisions that have NOT been made are most
   visible, so this screen names them rather than offering a toggle
   for each. A switch labelled "stock valuation method" with
   nothing behind it invites somebody to set it and assume it
   took effect. */

const GROUPS = [
  {
    title: 'Business',
    rows: [
      ['Trading name', "De'vyora — Casa De Aurum"],
      ['Stock location', WAREHOUSE.name + ', ' + WAREHOUSE.city],
      ['Currency', 'Indian Rupee (₹)'],
      ['Number format', 'Indian grouping — 2,01,63,533'],
      ['Financial year', '1 April – 31 March'],
    ],
  },
  {
    title: 'Stock',
    rows: [
      ['Unit of stock', 'Box (each product carries its own pieces and sqft per box)'],
      ['Reorder level', 'Set per product, not globally'],
      ['Negative stock', 'Not allowed — an issue cannot exceed what is on hand'],
      ['Opening balances', 'Written to the ledger as a dated receipt, never as a bare quantity'],
    ],
  },
  {
    title: 'Website sync',
    rows: [
      ['Master for cost, price, stock, status', 'ERP'],
      ['Direction', 'ERP → website only'],
      ['Website edits to ERP-owned fields', 'Treated as a conflict, not an update'],
      ['Push', 'On change, with retries'],
    ],
  },
];

/* The questions this prototype deliberately does not answer. Each
   changes what gets built, and each is the studio's to decide. */
const OPEN_QUESTIONS = [
  'How stock is valued when it leaves: at the last cost paid, or at a weighted average. The margin report cannot be honest until this is settled.',
  'Whether confirming a sales order reserves stock, and at what point the movement is written — on dispatch, or on invoice.',
  'Whether ERP accounts are separate from the website’s logins, or one person signs in once for both.',
  'What a second stock location means for every figure in the system — see the Warehouses module, which is left as a placeholder for exactly this reason.',
  'Whether a retry re-sends the value as it is now, or as it was when the change was queued. Only the first is safe.',
  'Whether the website should ever be allowed to edit a field the ERP owns, and what happens when it does.',
];

export default function Settings() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            How the ERP is configured, and — below — the decisions this
            prototype has deliberately not made for the studio.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setOpen(true)}>Edit settings</button>
        </div>
      </div>

      <div className="grid-2">
        {GROUPS.map((g) => (
          <section className="panel" key={g.title}>
            <div className="panel-head"><div><h2>{g.title}</h2></div></div>
            <div className="panel-body">
              <div className="detail-grid">
                {g.rows.map(([label, value]) => (
                  <div className="detail-row" key={label} style={{ gridColumn: '1 / -1' }}>
                    <span className="detail-label">{label}</span>
                    <span className="detail-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Still to be decided</h2>
            <p>Each of these changes what gets built. None is a default worth guessing at.</p>
          </div>
        </div>
        <div className="panel-body">
          <ol className="decisions">
            {OPEN_QUESTIONS.map((q) => <li key={q}>{q}</li>)}
          </ol>
          <p className="tiny muted" style={{ marginTop: 14 }}>
            They are listed rather than given a toggle on purpose. A switch
            labelled &ldquo;stock valuation method&rdquo; with nothing behind it
            invites somebody to set it and assume it took effect.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>About this build</h2></div></div>
        <div className="panel-body">
          <div className="detail-grid">
            <div className="detail-row"><span className="detail-label">What it is</span><span className="detail-value">Frontend prototype</span></div>
            <div className="detail-row"><span className="detail-label">Data</span><span className="detail-value">Generated, self-consistent, frozen</span></div>
            <div className="detail-row"><span className="detail-label">Demo date</span><span className="detail-value">{day(DEMO_TODAY.toISOString())}</span></div>
            <div className="detail-row"><span className="detail-label">Database</span><span className="detail-value">None</span></div>
            <div className="detail-row"><span className="detail-label">Backend API</span><span className="detail-value">None</span></div>
            <div className="detail-row"><span className="detail-label">Website connection</span><span className="detail-value">None — nothing is read or written</span></div>
          </div>
        </div>
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Settings are read-only here"
        footer={<button className="btn btn-primary" onClick={() => setOpen(false)}>Understood</button>}
      >
        <p>
          This is a UI prototype. The values above describe what the ERP would
          be configured to do, so they can be argued with before anything is
          built — but there is nothing behind them to change.
        </p>
      </Modal>
    </>
  );
}
