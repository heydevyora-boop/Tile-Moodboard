import { PRODUCTS, MOVEMENTS, stockValue } from './ledger.js';
import { CATEGORIES, DEMO_TODAY } from './catalogue.js';
import { PURCHASES, SALES, SYNC_EVENTS } from './operations.js';

/* ============================================================
   WHAT THE DASHBOARD COUNTS
   ============================================================
   Every figure on the dashboard is DERIVED from the same rows the
   other screens list, so a KPI and the table it links to can never
   tell different stories. Nothing here is a separately invented
   headline number.
   ============================================================ */

const DAY = 86400000;
const monthKey = (iso) => iso.slice(0, 7);

/* ── the headline figures ────────────────────────────────────── */

export const KPIS = (() => {
  const live = PRODUCTS.filter((p) => p.status !== 'draft');
  const low = PRODUCTS.filter((p) => p.status === 'low');
  const out = PRODUCTS.filter((p) => p.status === 'out');
  const retired = PRODUCTS.filter((p) => p.status === 'discontinued');
  const drafts = PRODUCTS.filter((p) => p.status === 'draft');

  const since30 = new Date(DEMO_TODAY.getTime() - 30 * DAY).toISOString();
  const sales30 = SALES.filter((o) => o.placedOn >= since30.slice(0, 10));
  const purch30 = PURCHASES.filter((o) => o.placedOn >= since30.slice(0, 10));

  return {
    products: live.length,
    retired: retired.length,
    drafts: drafts.length,
    stockValue: stockValue(),
    // Boxes on hand across every product that still has any.
    boxes: PRODUCTS.reduce((s, p) => s + p.stockQty, 0),
    low: low.length,
    out: out.length,
    // Low and out together, because that is the one number the
    // person doing the buying actually acts on.
    needsOrdering: low.length + out.length,
    sales30: sales30.reduce((s, o) => s + o.total, 0),
    sales30Count: sales30.length,
    purchases30: purch30.reduce((s, o) => s + o.total, 0),
    purchases30Count: purch30.length,
    syncFailed: SYNC_EVENTS.filter((e) => e.status === 'failed').length,
    syncPending: SYNC_EVENTS.filter((e) => e.status === 'pending').length,
  };
})();

/* ── trends ──────────────────────────────────────────────────── */

/** Sales and purchases by month, for the trend chart. Months with no
 *  orders still appear, at zero -- dropping them would turn a quiet
 *  month into a line that skips it and reads as continuous trade. */
export function monthlySeries(orders) {
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(DEMO_TODAY.getTime());
    d.setUTCMonth(d.getUTCMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const totals = new Map(months.map((m) => [m, 0]));
  for (const o of orders) {
    const k = monthKey(o.placedOn);
    if (totals.has(k)) totals.set(k, totals.get(k) + o.total);
  }
  return months.map((m) => ({
    label: new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
    value: totals.get(m),
  }));
}

export const SALES_TREND = monthlySeries(SALES);
export const PURCHASE_TREND = monthlySeries(PURCHASES);

/* ── breakdowns ──────────────────────────────────────────────── */

/** Stock value by category, as a share of the whole. */
export const VALUE_BY_CATEGORY = (() => {
  const tones = ['#8A6A3B', '#A8885A', '#C4A878', '#4F6B45', '#45606B', '#9A6B1F'];
  return CATEGORIES.map((c, i) => ({
    label: c.name,
    tone: tones[i % tones.length],
    value: Math.round(stockValue(PRODUCTS.filter((p) => p.category === c.id))),
  })).filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
})();

/** The products that moved most, by boxes dispatched in the window.
 *  Dispatched, not sold: a sample issued and a breakage both leave
 *  the building, and a "top seller" list that counts them is wrong. */
export const TOP_MOVERS = (() => {
  const sold = new Map();
  for (const m of MOVEMENTS) {
    if (m.reason !== 'sale') continue;
    sold.set(m.productCode, (sold.get(m.productCode) || 0) + m.qty);
  }
  return [...sold.entries()]
    .map(([code, qty]) => ({ code, qty, product: PRODUCTS.find((p) => p.productCode === code) }))
    .filter((x) => x.product)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 6);
})();

/** Products at or below their reorder level, worst first -- the one
 *  list on the dashboard that is a to-do rather than a report. */
export const REORDER_LIST = PRODUCTS
  .filter((p) => (p.status === 'low' || p.status === 'out'))
  .sort((a, b) => (a.stockQty - b.stockQty) || a.name.localeCompare(b.name));

/** The most recent movements, for the activity feed. */
export const RECENT_ACTIVITY = [...MOVEMENTS]
  .sort((a, b) => b.at.localeCompare(a.at))
  .slice(0, 12);

/** How the catalogue splits across the five statuses. */
export const STATUS_SPLIT = (() => {
  const tones = { active: '#4F6B45', low: '#9A6B1F', out: '#A8552A', discontinued: '#8B8177', draft: '#45606B' };
  const labels = { active: 'Active', low: 'Low Stock', out: 'Out of Stock', discontinued: 'Discontinued', draft: 'Draft' };
  return Object.keys(labels).map((k) => ({
    key: k,
    label: labels[k],
    tone: tones[k],
    value: PRODUCTS.filter((p) => p.status === k).length,
  })).filter((s) => s.value > 0);
})();
