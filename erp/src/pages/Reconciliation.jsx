import { Link } from 'react-router-dom';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, Loading } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { qty, stamp } from '../lib/format.js';

/* ============================================================
   RECONCILIATION — DOES THE LEDGER STILL AGREE WITH ITSELF?
   ============================================================
   Every stock figure in this ERP is a projection: a running total
   kept beside the append-only ledger so that reading a balance
   does not mean summing a hundred thousand rows. A projection can
   drift. This screen re-derives every balance from the ledger
   that produced it and compares the two, across all three
   dimensions — on hand, reserved and damaged — plus both sides of
   every warehouse transfer.

   IT REPORTS. IT NEVER REPAIRS.

   There is no "fix it" button, and that is deliberate. A silent
   repair makes the numbers agree and destroys the only evidence
   of what went wrong; the next time it happens nobody knows it is
   the second time. A discrepancy is a question for a person, and
   the answer is an authorised adjustment with a reason on it,
   which leaves both the error and the correction on the record.
   ============================================================ */

export default function Reconciliation() {
  const report = useApi(() => api.inventory.reconciliation(), []);

  if (report.loading && !report.data) return <Loading what="Re-deriving every balance from the ledger" />;
  if (report.error) return <Failed error={report.error} onRetry={report.reload} />;

  const r = report.data;
  const passed = r.status === 'PASSED';

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            Checked against the real database, just now. Every balance below was
            recomputed from the movements that produced it — nothing here is
            cached, and nothing here is repaired automatically.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={report.reload} disabled={report.loading}>
            {report.loading ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>

      <div className={'notice ' + (passed ? 'notice-ok' : 'notice-danger')}>
        <span aria-hidden="true">●</span>
        <div>
          <strong>
            {passed
              ? 'Reconciled. Every balance matches the ledger that produced it.'
              : r.problems + ' discrepanc' + (r.problems === 1 ? 'y' : 'ies') + ' found.'}
          </strong>
          <div className="tiny" style={{ marginTop: 4 }}>
            Checked {stamp(r.checkedAt)}. {r.note}
          </div>
        </div>
      </div>

      <div className="grid-4">
        <KpiCard
          label="On the shelves"
          value={qty(r.company.physicalOnHand)}
          note={'across ' + qty(r.company.skusHeld) + ' product(s) in '
            + qty(r.company.warehousesUsed) + ' warehouse(s)'}
        />
        <KpiCard
          label="In transit"
          value={qty(r.company.inTransit)}
          note="dispatched, not yet received"
          tone={r.company.inTransit > 0 ? 'warn' : undefined}
        />
        <KpiCard
          label="Total physical stock"
          value={qty(r.company.physicalTotal)}
          note="on hand plus in transit — a transfer never changes this"
        />
        <KpiCard
          label="Can be sold"
          value={qty(r.company.available)}
          note={qty(r.company.reserved) + ' reserved, ' + qty(r.company.damaged) + ' damaged'}
        />
      </div>

      <Section
        title="Balances that have drifted from their ledger"
        note="A row here is a stock figure that no longer equals the sum of its own movements. Until it is explained, do not trust it."
        rows={r.driftedBalances}
        clean="Every projected balance equals the ledger total behind it, for on hand, reserved and damaged alike."
        columns={['Code', 'Warehouse', 'Projected', 'From the ledger', 'Difference']}
        cells={(d) => [
          <span className="sku">{d.sku}</span>,
          d.warehouse_name,
          <span className="num">{d.projected}</span>,
          <span className="num">{d.ledger}</span>,
          <strong className="num" style={{ color: 'var(--danger)' }}>{d.difference}</strong>,
        ]}
      />

      <Section
        title="Negative balances"
        note="Physically impossible. A database CHECK refuses these outright, so a row here would mean a constraint was dropped."
        rows={r.negativeBalances}
        clean="No balance is below zero, on hand or sellable."
        columns={['Code', 'Warehouse', 'On hand', 'Can be sold']}
        cells={(d) => [
          <span className="sku">{d.sku}</span>,
          d.warehouse_name,
          <span className="num">{d.on_hand}</span>,
          <span className="num">{d.available}</span>,
        ]}
      />

      <Section
        title="Movements with no balance row"
        note="Stock has moved for this product and warehouse but no balance exists. The first movement creates one, so a row here means something wrote the ledger directly instead of going through the stock service."
        rows={r.missingProjections}
        clean="Every product with movements has the balance row those movements created."
        columns={['Code', 'Warehouse']}
        cells={(d) => [<span className="sku">{d.sku}</span>, d.warehouse_name]}
      />

      <Section
        title="Transfers that do not add up"
        note="What left the source does not match what was received. This is stock unaccounted for between two of the studio's own doors."
        rows={r.unbalancedTransfers}
        clean="Every transfer accounts for its stock: dispatched, received, or returned to where it came from."
        columns={['Transfer', 'State', 'Dispatched', 'Received', 'Still in transit']}
        cells={(d) => [
          <span className="sku">{d.transferNo}</span>,
          d.status,
          <span className="num">{d.dispatched}</span>,
          <span className="num">{d.received}</span>,
          <span className="num">{d.in_transit}</span>,
        ]}
      />

      {/* NOT A FAILURE, and labelled as one of those. A purchase
          order received in two deliveries legitimately quotes the
          same document twice. */}
      {r.repeatedReferences?.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Documents quoted more than once</h3>
            <p className="tiny muted">
              For information, not a problem. A purchase order received in two
              deliveries legitimately appears twice. Worth a look if one of these
              was meant to be a single receipt.
            </p>
          </div>
          <table className="table">
            <thead>
              <tr><th>Document</th><th>Code</th><th style={{ textAlign: 'right' }}>Times</th></tr>
            </thead>
            <tbody>
              {r.repeatedReferences.map((d) => (
                <tr key={d.referenceNo + ':' + d.sku}>
                  <td><span className="sku">{d.referenceNo}</span></td>
                  <td><span className="sku">{d.sku}</span></td>
                  <td className="num" style={{ textAlign: 'right' }}>{d.times}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!passed && (
        <div className="notice notice-warn" style={{ marginTop: 18 }}>
          <span aria-hidden="true">●</span>
          <div>
            <strong>How a discrepancy is corrected.</strong> Not from this screen.
            Post an{' '}
            <Link to="/adjustments">adjustment</Link>{' '}
            with a reason that says what was found and when, so the record shows
            both the error and the decision. Nothing here will quietly make the
            numbers agree.
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, note, rows, clean, columns, cells }) {
  const empty = !rows || rows.length === 0;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head">
        <h3>
          {title}
          {!empty && <span className="pill pill-danger" style={{ marginLeft: 8 }}>{rows.length}</span>}
        </h3>
        <p className="tiny muted">{empty ? clean : note}</p>
      </div>
      {!empty && (
        <table className="table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c} style={i >= 2 ? { textAlign: 'right' } : undefined}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {cells(row).map((cell, ci) => (
                  <td key={ci} style={ci >= 2 ? { textAlign: 'right' } : undefined}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
