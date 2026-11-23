import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import KpiCard from '../components/KpiCard.jsx';
import { Failed, Loading } from '../components/ApiState.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { money, moneyShort, qty, stamp } from '../lib/format.js';

/* ============================================================
   SALES DASHBOARD
   ============================================================
   Every figure is a count or a sum from the ERP database, the
   same discipline as the purchase dashboard. No demo data is
   behind this screen: an empty database reads zero.
   ============================================================ */

export default function SalesDashboard() {
  const [customerId, setCustomerId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useMemo(() => ({ customerId, from: from || undefined, to: to || undefined }),
    [customerId, from, to]);

  const board = useApi(() => api.sales.dashboard(query), [JSON.stringify(query)]);
  const customers = useApi(() => api.customers.options(), []);

  if (board.loading && !board.data) return <Loading what="Reading the sales ledger" />;
  if (board.error) return <Failed error={board.error} onRetry={board.reload} />;

  const d = board.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            What customers have ordered, what has shipped and what they owe &mdash;
            three different questions, kept as three different records.{' '}
            <strong>A sales order does not change stock, and neither does invoicing
            it.</strong> Stock moves when a delivery challan is dispatched, and
            nothing else.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/sales-orders">Sales orders</Link>
          <Link className="btn btn-primary" to="/quotations">New quotation</Link>
        </div>
      </div>

      <div className="toolbar" style={{ borderRadius: 'var(--r)', border: '1px solid var(--line)', marginBottom: 16 }}>
        <select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Customer">
          <option value="all">All customers</option>
          {(customers.data?.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          aria-label="From" style={{ width: 150 }} />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)}
          aria-label="To" style={{ width: 150 }} />
        {(customerId !== 'all' || from || to) && (
          <button className="btn btn-sm" onClick={() => { setCustomerId('all'); setFrom(''); setTo(''); }}>Clear</button>
        )}
      </div>

      <div className="grid-4">
        <KpiCard
          label="Customers"
          value={qty(d.customers.total)}
          note={qty(d.customers.active) + ' active, ' + qty(d.customers.inactive) + ' deactivated'}
          to="/customers"
        />
        <KpiCard
          label="Sales orders"
          value={qty(d.orders.total)}
          note={qty(d.orders.draft) + ' draft, ' + qty(d.orders.cancelled) + ' cancelled'}
          to="/sales-orders"
        />
        <KpiCard
          label="Confirmed value"
          value={moneyShort(d.orders.valueConfirmed)}
          note="confirmed and beyond; drafts and cancellations excluded"
        />
        <KpiCard
          label="Awaiting dispatch"
          value={qty(d.stock.ordersAwaitingDispatch)}
          note={qty(d.stock.pendingDispatchQuantity) + ' unit(s) still owed'}
          to="/delivery-challans"
        />
      </div>

      <div className="grid-4" style={{ marginTop: 14 }}>
        <KpiCard label="Pending approval" value={qty(d.orders.pendingApproval)}
          tone={d.orders.pendingApproval > 0 ? 'warn' : undefined}
          note="raised, not yet committed" to="/sales-orders?status=PENDING_APPROVAL" />
        <KpiCard label="Reserved" value={qty(d.orders.reserved)}
          note={qty(d.stock.reservedQuantity) + ' unit(s) held, nothing shipped'}
          to="/sales-orders?status=RESERVED" />
        <KpiCard label="Partly dispatched" value={qty(d.orders.partiallyDispatched)}
          note="some lines still outstanding" to="/sales-orders?status=PARTIALLY_DISPATCHED" />
        <KpiCard label="Fully dispatched" value={qty(d.orders.fullyDispatched)}
          note={qty(d.orders.closed) + ' closed short'} to="/sales-orders?status=FULLY_DISPATCHED" />
      </div>

      <div className="grid-4" style={{ marginTop: 14 }}>
        <KpiCard label="Delivery challans dispatched" value={qty(d.dispatch.posted)}
          note="the only sales document that moves stock" to="/delivery-challans" />
        <KpiCard label="Invoiced value" value={money(d.invoices.invoicedValue)}
          note={qty(d.invoices.posted) + ' posted invoice(s)'} to="/sales-invoices" />
        <KpiCard label="Outstanding payments" value={money(d.payments.outstanding)}
          tone={d.payments.outstanding > 0 ? 'warn' : 'ok'}
          note={money(d.payments.received) + ' received to date'} to="/customer-payments" />
        <KpiCard label="Sales returns" value={qty(d.returns.posted)}
          note="stock received back from customers" to="/sales-returns" />
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Recent dispatches</h3>
            <p className="tiny muted">The moments stock actually left the building.</p>
          </div>
          {d.recentDispatches.length === 0 ? (
            <div className="empty"><h3>Nothing dispatched yet</h3><p>When a delivery challan is posted, it appears here.</p></div>
          ) : (
            <table className="table">
              <thead><tr><th>Challan</th><th>Customer</th><th>Against</th><th style={{ textAlign: 'right' }}>Quantity</th><th>When</th></tr></thead>
              <tbody>
                {d.recentDispatches.map((r) => (
                  <tr key={r.id}>
                    <td><Link className="sku" to={'/delivery-challans?open=' + r.id}>{r.challanNo}</Link></td>
                    <td>{r.customer}<div className="tiny muted">{r.warehouse}</div></td>
                    <td>{r.orderNo ? <span className="sku">{r.orderNo}</span> : <span className="muted">&mdash;</span>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(r.quantity)}</td>
                    <td className="tiny">{stamp(r.dispatchedAt ?? r.dispatchDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Where the business is coming from</h3>
            <p className="tiny muted">By confirmed order value. Drafts and cancellations excluded.</p>
          </div>
          {d.topCustomers.length === 0 ? (
            <div className="empty"><h3>No confirmed orders</h3><p>Confirm a sales order and it will be counted here.</p></div>
          ) : (
            <table className="table">
              <thead><tr><th>Customer</th><th style={{ textAlign: 'right' }}>Orders</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
              <tbody>
                {d.topCustomers.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={'/customers?open=' + c.id}>{c.name}</Link><div className="sku">{c.code}</div></td>
                    <td className="num" style={{ textAlign: 'right' }}>{qty(c.orders)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(c.value)}</td>
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
