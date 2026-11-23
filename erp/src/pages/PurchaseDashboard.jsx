import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import KpiCard from '../components/KpiCard.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { Failed, Loading } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, moneyShort, qty, day, stamp } from '../lib/format.js';
import { PO_STATUS } from '../data/purchaseStatus.js';

/* ============================================================
   PURCHASE DASHBOARD
   ============================================================
   Every figure is a count or a sum from the ERP database. There
   is no demo data behind this screen: an empty database reads
   zero, which is the truthful answer and looks nothing like a
   plausible invented one.
   ============================================================ */

export default function PurchaseDashboard() {
  const [supplierId, setSupplierId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useMemo(() => ({ supplierId, from: from || undefined, to: to || undefined }),
    [supplierId, from, to]);

  const board = useApi(() => api.purchase.dashboard(query), [JSON.stringify(query)]);
  const suppliers = useApi(() => api.suppliers.options(), []);

  if (board.loading && !board.data) return <Loading what="Reading the purchase ledger" />;
  if (board.error) return <Failed error={board.error} onRetry={board.reload} />;

  const d = board.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What the studio has ordered, what has arrived and what it is being billed
            for &mdash; three different questions, kept as three different records.
            <strong> A purchase order does not change stock.</strong> Neither does
            approving one, and neither does a supplier&rsquo;s invoice. Stock moves
            when goods physically arrive and a receipt is posted.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/purchase-orders">Purchase orders</Link>
          <Link className="btn btn-primary" to="/goods-receipts">Receive goods</Link>
        </div>
      </div>

      <div className="toolbar" style={{ borderRadius: 'var(--r)', border: '1px solid var(--line)', marginBottom: 16 }}>
        <select
          className="select"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          aria-label="Supplier"
        >
          <option value="all">All suppliers</option>
          {(suppliers.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          aria-label="From" style={{ width: 150 }} />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)}
          aria-label="To" style={{ width: 150 }} />
        {(supplierId !== 'all' || from || to) && (
          <button className="btn btn-sm" onClick={() => { setSupplierId('all'); setFrom(''); setTo(''); }}>
            Clear
          </button>
        )}
        <span className="tiny muted" style={{ marginLeft: 'auto' }}>
          Order counts and committed value follow these filters. Invoices and returns are shown in full.
        </span>
      </div>

      <div className="grid-4">
        <KpiCard
          label="Suppliers"
          value={qty(d.suppliers.total)}
          note={qty(d.suppliers.active) + ' active, ' + qty(d.suppliers.inactive) + ' deactivated'}
          to="/suppliers"
        />
        <KpiCard
          label="Purchase orders"
          value={qty(d.orders.total)}
          note={qty(d.orders.draft) + ' draft, ' + qty(d.orders.cancelled) + ' cancelled'}
          to="/purchase-orders"
        />
        <KpiCard
          label="Committed value"
          value={moneyShort(d.orders.valueCommitted)}
          note="approved and beyond; drafts and cancellations excluded"
        />
        <KpiCard
          label="Awaiting delivery"
          value={qty(d.deliveries.ordersAwaiting)}
          tone={d.deliveries.overdue > 0 ? 'warn' : undefined}
          note={d.deliveries.overdue > 0
            ? qty(d.deliveries.overdue) + ' past the expected date'
            : qty(d.deliveries.outstandingQuantity) + ' unit(s) still owed'}
          to="/purchase-orders?status=APPROVED,PARTIALLY_RECEIVED"
        />
      </div>

      <div className="grid-4" style={{ marginTop: 14 }}>
        <KpiCard
          label="Pending approval"
          value={qty(d.orders.pendingApproval)}
          tone={d.orders.pendingApproval > 0 ? 'warn' : undefined}
          note="raised, not yet committed"
          to="/purchase-orders?status=PENDING_APPROVAL"
        />
        <KpiCard
          label="Approved"
          value={qty(d.orders.approved)}
          note="placed, nothing received yet"
          to="/purchase-orders?status=APPROVED"
        />
        <KpiCard
          label="Partly received"
          value={qty(d.orders.partiallyReceived)}
          note="some lines still outstanding"
          to="/purchase-orders?status=PARTIALLY_RECEIVED"
        />
        <KpiCard
          label="Fully received"
          value={qty(d.orders.fullyReceived)}
          note={qty(d.orders.closed) + ' closed short'}
          to="/purchase-orders?status=FULLY_RECEIVED"
        />
      </div>

      <div className="grid-4" style={{ marginTop: 14 }}>
        <KpiCard
          label="Goods receipts posted"
          value={qty(d.receipts.posted)}
          note="the only purchase document that moves stock"
          to="/goods-receipts"
        />
        <KpiCard
          label="Quantity received"
          value={qty(d.receipts.totalReceivedQuantity)}
          note={d.receipts.damagedQuantity > 0 || d.receipts.rejectedQuantity > 0
            ? qty(d.receipts.damagedQuantity) + ' damaged, ' + qty(d.receipts.rejectedQuantity) + ' rejected at the gate'
            : 'all of it sound'}
        />
        <KpiCard
          label="Open supplier invoices"
          value={qty(d.invoices.open)}
          tone={d.invoices.disputed > 0 ? 'danger' : undefined}
          note={d.invoices.disputed > 0
            ? qty(d.invoices.disputed) + ' disputed · ' + money(d.invoices.openValue) + ' open'
            : money(d.invoices.openValue) + ' outstanding'}
          to="/supplier-invoices"
        />
        <KpiCard
          label="Purchase returns"
          value={qty(d.returns.posted)}
          note="stock sent back to suppliers"
          to="/purchase-returns"
        />
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Recent goods receipts</h3>
            <p className="tiny muted">
              The moments stock actually entered the building. Each one wrote its
              movements to the append-only ledger.
            </p>
          </div>
          {d.recentReceipts.length === 0 ? (
            <div className="empty">
              <h3>Nothing received yet</h3>
              <p>When goods arrive against an approved order, the receipt appears here.</p>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Receipt</th><th>Supplier</th><th>Against</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th><th>When</th>
                </tr>
              </thead>
              <tbody>
                {d.recentReceipts.map((r) => (
                  <tr key={r.id}>
                    <td><Link className="sku" to={'/goods-receipts?open=' + r.id}>{r.grnNo}</Link></td>
                    <td>
                      {r.supplier}
                      <div className="tiny muted">{r.warehouse}</div>
                    </td>
                    <td>
                      {r.orderNo
                        ? <span className="sku">{r.orderNo}</span>
                        : <span className="muted">&mdash;</span>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {qty(r.quantity)}
                      {r.damaged > 0 && (
                        <div className="tiny" style={{ color: 'var(--warn)' }}>{qty(r.damaged)} damaged</div>
                      )}
                      {r.rejected > 0 && (
                        <div className="tiny" style={{ color: 'var(--danger)' }}>{qty(r.rejected)} rejected</div>
                      )}
                    </td>
                    <td className="tiny">{stamp(r.postedAt ?? r.receiptDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Where the money is going</h3>
            <p className="tiny muted">
              By committed order value. Drafts and cancelled orders are excluded:
              neither is trade the studio actually did.
            </p>
          </div>
          {d.topSuppliers.length === 0 ? (
            <div className="empty">
              <h3>No committed orders</h3>
              <p>Approve a purchase order and it will be counted here.</p>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {d.topSuppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={'/suppliers?open=' + s.id}>{s.name}</Link>
                      <div className="sku">{s.code}</div>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(s.orders)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(s.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
