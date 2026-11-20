import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, BarChart, DonutChart } from '../components/Charts.jsx';
import StatusPill from '../components/StatusPill.jsx';
import KpiCard from '../components/KpiCard.jsx';
import { SALES_TREND, PURCHASE_TREND, VALUE_BY_CATEGORY, TOP_MOVERS, KPIS } from '../data/metrics.js';
import { PRODUCTS, stockValue, CUSTOMERS } from '../data/ledger.js';
import { SALES } from '../data/operations.js';
import { SUPPLIERS, STATUSES } from '../data/catalogue.js';
import { money, moneyShort, qty } from '../lib/format.js';

/* Reports are a reading of the same rows, never a second set of
   numbers. Every figure on this page can be reached by filtering a
   table elsewhere in the ERP, which is what keeps a report from
   quietly becoming its own version of the truth. */

const REPORTS = {
  trade: 'Sales and purchases',
  stock: 'Stock and valuation',
  margin: 'Margin by product',
  customer: 'Customers and suppliers',
};

export default function Reports() {
  const [report, setReport] = useState('trade');

  return (
    <>
      <div className="page-intro">
        <div>
          <p>
            A reading of the same rows the rest of the ERP lists — never a
            second set of numbers. Every figure here can be reached by
            filtering a table elsewhere.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/transfer">Export data</Link>
        </div>
      </div>

      <div className="viewbar">
        {Object.entries(REPORTS).map(([k, label]) => (
          <button key={k} className={'viewtab' + (report === k ? ' is-on' : '')} onClick={() => setReport(k)}>
            {label}
          </button>
        ))}
      </div>

      {report === 'trade' && <TradeReport />}
      {report === 'stock' && <StockReport />}
      {report === 'margin' && <MarginReport />}
      {report === 'customer' && <PartyReport />}
    </>
  );
}

function TradeReport() {
  return (
    <div className="stack">
      <div className="grid-4">
        <KpiCard label="Sales, 30 days" value={moneyShort(KPIS.sales30)} note={KPIS.sales30Count + ' orders'} to="/sales" />
        <KpiCard label="Purchases, 30 days" value={moneyShort(KPIS.purchases30)} note={KPIS.purchases30Count + ' orders'} to="/purchase" />
        <KpiCard
          label="Gross margin, 30 days"
          value={moneyShort(KPIS.sales30 - KPIS.purchases30)}
          note="sales less purchases — not profit"
        />
        <KpiCard label="Stock value" value={moneyShort(KPIS.stockValue)} note="at cost" to="/inventory" />
      </div>

      <div className="notice notice-info">
        <span aria-hidden="true">●</span>
        <div>
          <strong>Sales less purchases is not profit.</strong> It is the
          difference between two cash movements in the same window, and a month
          with a big restock will read as a loss. Real margin needs cost of
          goods sold against the stock that actually left — which the ledger
          can give, once somebody decides whether to value it at the last cost
          or at a weighted average.
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><div><h2>Sales by month</h2><p>Last six months</p></div></div>
          <div className="panel-body"><LineChart series={SALES_TREND} format={moneyShort} label="Sales by month" /></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Purchases by month</h2><p>Last six months</p></div></div>
          <div className="panel-body"><LineChart series={PURCHASE_TREND} format={moneyShort} label="Purchases by month" /></div>
        </section>
      </div>
    </div>
  );
}

function StockReport() {
  const byBrand = [...new Set(PRODUCTS.map((p) => p.brand))]
    .map((b) => ({ label: b, value: Math.round(stockValue(PRODUCTS.filter((p) => p.brand === b))) }))
    .sort((a, b) => b.value - a.value);

  const dead = PRODUCTS.filter((p) => p.status === 'discontinued' && p.stockQty > 0);

  return (
    <div className="stack">
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><div><h2>Value by category</h2><p>At cost</p></div></div>
          <div className="panel-body"><DonutChart slices={VALUE_BY_CATEGORY} centreLabel="at cost" format={moneyShort} /></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Value by brand</h2><p>At cost</p></div></div>
          <div className="panel-body"><BarChart series={byBrand} format={moneyShort} label="Stock value by brand" /></div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Capital tied up in discontinued lines</h2>
            <p>Retired products the studio still holds. Nothing here should be reordered.</p>
          </div>
          <Link className="btn btn-sm" to="/inventory">Inventory</Link>
        </div>
        {dead.length === 0 ? (
          <div className="empty"><h3>Nothing held</h3><p>Every discontinued product has been cleared.</p></div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th><th>Brand</th>
                  <th className="right">Boxes</th><th className="right">At cost</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dead.map((p) => (
                  <tr key={p.productCode}>
                    <td><strong>{p.name}</strong><div className="sku">{p.productCode}</div></td>
                    <td>{p.brand}</td>
                    <td className="right num">{qty(p.stockQty)}</td>
                    <td className="right num">{money(p.stockQty * p.purchaseRate * p.sqftPerBox)}</td>
                    <td><StatusPill tone="inert">Discontinued</StatusPill></td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="right"><strong>Total</strong></td>
                  <td className="right"><strong className="num">{money(stockValue(dead))}</strong></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MarginReport() {
  const rows = PRODUCTS
    .filter((p) => p.status !== 'draft')
    .map((p) => ({
      ...p,
      marginPct: Math.round(((p.sellingRate - p.purchaseRate) / p.purchaseRate) * 100),
      marginRs: Math.round((p.sellingRate - p.purchaseRate) * p.sqftPerBox),
    }))
    .sort((a, b) => b.marginPct - a.marginPct);

  const best = rows.slice(0, 8);
  const worst = rows.slice(-8).reverse();

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Margin per box, highest and lowest</h2>
            <p>Selling rate against cost rate. Does not account for discounts given on an order.</p>
          </div>
        </div>
        <div className="panel-body">
          <BarChart
            series={best.map((p) => ({ label: p.collection + ' ' + p.colorTone, value: p.marginPct }))}
            format={(n) => Math.round(n) + '%'}
            label="Highest margin products"
          />
        </div>
      </section>

      <div className="grid-2">
        {[['Highest margin', best], ['Lowest margin', worst]].map(([title, list]) => (
          <section className="panel" key={title}>
            <div className="panel-head"><div><h2>{title}</h2></div></div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="right">Cost</th><th className="right">Sell</th>
                    <th className="right">Margin</th><th className="right">Per box</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.productCode}>
                      <td><strong>{p.name}</strong><div className="sku">{p.productCode}</div></td>
                      <td className="right num">{money(p.purchaseRate)}</td>
                      <td className="right num">{money(p.sellingRate)}</td>
                      <td className="right num">{p.marginPct}%</td>
                      <td className="right num">{money(p.marginRs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PartyReport() {
  const byCustomer = CUSTOMERS.map((c) => {
    const orders = SALES.filter((o) => o.customerId === c.id && o.status !== 'cancelled');
    return { ...c, orders: orders.length, value: orders.reduce((s, o) => s + o.total, 0) };
  }).sort((a, b) => b.value - a.value);

  const bySupplier = SUPPLIERS.map((s) => {
    const held = PRODUCTS.filter((p) => p.supplier === s.id);
    return { ...s, products: held.length, value: Math.round(stockValue(held)) };
  }).sort((a, b) => b.value - a.value);

  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-head">
          <div><h2>Customers</h2><p>By order value, cancelled orders excluded</p></div>
          <Link className="btn btn-sm" to="/sales">Sales</Link>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Customer</th><th>Type</th><th className="right">Orders</th><th className="right">Value</th></tr>
            </thead>
            <tbody>
              {byCustomer.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.type}</td>
                  <td className="right num">{qty(c.orders)}</td>
                  <td className="right num">{money(c.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><h2>Suppliers</h2><p>By value of their stock currently held</p></div>
          <Link className="btn btn-sm" to="/purchase">Purchases</Link>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Supplier</th><th>City</th><th>Terms</th><th className="right">Products</th><th className="right">Held at cost</th></tr>
            </thead>
            <tbody>
              {bySupplier.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><div className="sku">{s.gstin}</div></td>
                  <td>{s.city}</td>
                  <td>{s.terms}</td>
                  <td className="right num">{qty(s.products)}</td>
                  <td className="right num">{money(s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
