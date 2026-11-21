import { Link } from 'react-router-dom';
import KpiCard from '../components/KpiCard.jsx';
import { api } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import StatusPill from '../components/StatusPill.jsx';
import { LineChart, BarChart, DonutChart } from '../components/Charts.jsx';
import {
  KPIS, SALES_TREND, PURCHASE_TREND, VALUE_BY_CATEGORY,
  TOP_MOVERS, REORDER_LIST, RECENT_ACTIVITY, STATUS_SPLIT,
} from '../data/metrics.js';
import { MOVEMENT_REASONS } from '../data/ledger.js';
import { SYNC_EVENTS, SYNC_STATUS } from '../data/operations.js';
import { DEMO_TODAY, STATUSES } from '../data/catalogue.js';
import { money, moneyShort, qty, since, day } from '../lib/format.js';

export default function Dashboard() {
  const lastSync = SYNC_EVENTS[0];
  /* The real stock position. If the API is not running this stays
     null and the two stock cards read "—" rather than falling back
     to a demo figure: a dash is obviously missing, a plausible
     wrong number is not. */
  const stock = useApi(() => api.inventory.dashboard(), []);

  return (
    <>
      {/* The demo clock is frozen, and the screen says so rather than
          letting "2 hours ago" quietly become "4 months ago" the week
          after this is reviewed. */}
      <div className="notice notice-info">
        <span aria-hidden="true">●</span>
        <div>
          <strong>Demo data, frozen at {day(DEMO_TODAY.toISOString())}.</strong>{' '}
          Every figure below is generated and self-consistent — the stock
          numbers reconcile with the ledger — but none of it is the studio&rsquo;s
          real catalogue, stock or trade. No live system is read or written.
        </div>
      </div>

      <div className="page-intro">
        <div>
          <h2 className="sr">Overview</h2>
          <p>
            Where the business stands today: what is on the shelf, what needs
            ordering, what has moved, and whether the website is seeing the
            same thing the ERP does.
          </p>
        </div>
      </div>

      {/* ── the four figures worth a glance ───────────────────
          The two STOCK figures are read from the ERP database;
          the rest of this screen is still demo data, which the
          sidebar marks. Mixing the two on one row is deliberate:
          the alternative was leaving a mock stock figure here that
          contradicts the live Inventory screen beside it, and two
          different answers to "how much stock is there" is worse
          than one row sourced from two places.

          THERE IS NO "STOCK VALUE" CARD any more. It used to show
          boxes multiplied by the purchase price, which is a guess:
          the studio has not chosen a valuation method, and FIFO,
          weighted average and standard cost give three different
          answers for the same stock. See docs/INVENTORY_MANAGEMENT.md.
          ─────────────────────────────────────────────────────── */}
      <div className="grid-4">
        <KpiCard
          label="Stock on hand"
          value={stock.data ? qty(stock.data.totals.physicalOnHand) : '—'}
          note={stock.data
            ? qty(stock.data.totals.available) + ' of it sellable, across '
              + qty(stock.data.totals.skusHeld) + ' product(s)'
            : 'reading from the ERP database…'}
          to="/inventory"
        />
        <KpiCard
          label="Products"
          value={qty(KPIS.products)}
          note={KPIS.drafts + ' draft, ' + KPIS.retired + ' discontinued'}
          to="/products"
        />
        <KpiCard
          label="Needs ordering"
          value={stock.data ? qty(stock.data.totals.lowStock + stock.data.totals.outOfStock) : '—'}
          tone={stock.data && (stock.data.totals.lowStock + stock.data.totals.outOfStock) > 0
            ? 'warn' : undefined}
          note={stock.data
            ? stock.data.totals.outOfStock + ' with nothing on hand, '
              + stock.data.totals.lowStock + ' running low'
            : 'reading from the ERP database…'}
          to="/inventory"
        />
        <KpiCard
          label="Sales, last 30 days"
          value={moneyShort(KPIS.sales30)}
          note={'across ' + KPIS.sales30Count + ' orders'}
          to="/sales"
        />
      </div>

      {/* ── trade over six months ───────────────────────────── */}
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Sales</h2>
              <p>Order value by month, last six months</p>
            </div>
            <Link className="btn btn-sm" to="/sales">All orders</Link>
          </div>
          <div className="panel-body">
            <LineChart series={SALES_TREND} format={moneyShort} label="Sales by month" />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Purchases</h2>
              <p>Order value by month, last six months</p>
            </div>
            <Link className="btn btn-sm" to="/purchase">All orders</Link>
          </div>
          <div className="panel-body">
            <LineChart series={PURCHASE_TREND} format={moneyShort} label="Purchases by month" />
          </div>
        </section>
      </div>

      {/* ── what the catalogue looks like ───────────────────── */}
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Stock value by category</h2>
              <p>At cost, across {VALUE_BY_CATEGORY.length} categories</p>
            </div>
          </div>
          <div className="panel-body">
            <DonutChart
              slices={VALUE_BY_CATEGORY}
              centreLabel="total at cost"
              format={moneyShort}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Catalogue by status</h2>
              <p>Out of Stock and Discontinued are counted separately</p>
            </div>
            <Link className="btn btn-sm" to="/products">Product Master</Link>
          </div>
          <div className="panel-body">
            <DonutChart slices={STATUS_SPLIT} centreLabel="products" format={qty} />
          </div>
        </section>
      </div>

      {/* ── the to-do list ──────────────────────────────────── */}
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Needs ordering</h2>
              <p>At or below the reorder level. Discontinued lines are not listed.</p>
            </div>
            <Link className="btn btn-sm btn-primary" to="/purchase">Raise a purchase order</Link>
          </div>
          {REORDER_LIST.length === 0 ? (
            <div className="empty"><h3>Nothing to order</h3><p>Every active product is above its reorder level.</p></div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="right">On hand</th>
                    <th className="right">Reorder at</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {REORDER_LIST.slice(0, 12).map((p) => (
                    <tr key={p.productCode}>
                      <td>
                        <Link to={'/products?q=' + p.productCode}>{p.name}</Link>
                        <div className="sku">{p.productCode} · {p.size}</div>
                      </td>
                      <td className="right num">{qty(p.stockQty)}</td>
                      <td className="right num">{qty(p.reorderLevel)}</td>
                      <td>
                        <StatusPill tone={STATUSES[p.status].tone} title={STATUSES[p.status].note}>
                          {STATUSES[p.status].label}
                        </StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {REORDER_LIST.length > 12 && (
            <div className="table-foot">
              <span>Showing 12 of {REORDER_LIST.length}</span>
              <Link className="btn btn-sm" to="/inventory">See all</Link>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Most dispatched</h2>
              <p>Boxes sold in the last 90 days. Samples and breakages are not counted.</p>
            </div>
          </div>
          <div className="panel-body">
            <BarChart
              series={TOP_MOVERS.map((t) => ({ label: t.product.collection + ' ' + t.product.colorTone, value: t.qty }))}
              format={qty}
              label="Boxes dispatched by product"
            />
          </div>
        </section>
      </div>

      {/* ── activity and sync ───────────────────────────────── */}
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Recent activity</h2>
              <p>Every stock movement, newest first</p>
            </div>
            <Link className="btn btn-sm" to="/ledger">Stock ledger</Link>
          </div>
          <ul className="feed">
            {RECENT_ACTIVITY.map((m) => (
              <li key={m.id}>
                <span className={'feed-dir is-' + m.dir} aria-hidden="true">
                  {m.dir === 'in' ? '↓' : '↑'}
                </span>
                <div className="feed-text">
                  <strong>{MOVEMENT_REASONS[m.reason].label}</strong>
                  {' — '}{m.productName}
                  <div className="tiny muted">
                    <span className="num">{qty(m.qty)}</span> {m.unit.toLowerCase()}
                    {m.party !== '—' && <> · {m.party}</>}
                    {' · '}{since(m.at, DEMO_TODAY)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Website sync</h2>
              <p>The ERP pushes; the website is told, never asked</p>
            </div>
            <Link className="btn btn-sm" to="/sync">Sync status</Link>
          </div>
          <div className="panel-body stack">
            <div className="grid-3">
              <KpiCard label="Failed" value={qty(KPIS.syncFailed)} tone={KPIS.syncFailed ? 'danger' : undefined} note="need attention" to="/sync" />
              <KpiCard label="Pending" value={qty(KPIS.syncPending)} tone={KPIS.syncPending ? 'warn' : undefined} note="queued to push" to="/sync" />
              <KpiCard label="Last push" value={since(lastSync.at, DEMO_TODAY)} note={lastSync.productName} to="/sync" />
            </div>

            <div>
              <p className="kpi-label" style={{ marginBottom: 8 }}>Latest events</p>
              <ul className="feed is-tight">
                {SYNC_EVENTS.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    <StatusPill tone={SYNC_STATUS[e.status].tone}>{SYNC_STATUS[e.status].label}</StatusPill>
                    <div className="feed-text">
                      {e.what}
                      <div className="tiny muted">
                        {e.productName} · {e.direction} · {since(e.at, DEMO_TODAY)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
