import { seeded } from './rand.js';
import { SUPPLIERS, DEMO_TODAY } from './catalogue.js';
import { PRODUCTS, CUSTOMERS } from './ledger.js';

/* ============================================================
   PURCHASE ORDERS, SALES ORDERS, WEBSITE SYNC, PEOPLE
   ============================================================
   All demo data. The stock side of the prototype lives in
   ledger.js, which owns every quantity; nothing here invents a
   second stock figure.
   ============================================================ */

const DAY = 86400000;
const iso = (daysAgo) => new Date(DEMO_TODAY.getTime() - daysAgo * DAY).toISOString();
const dateOnly = (s) => s.slice(0, 10);

/* ── purchases ───────────────────────────────────────────────── */

function buildPurchases() {
  const r = seeded(31415926);
  const orders = [];
  const live = PRODUCTS.filter((p) => p.status !== 'discontinued' && p.status !== 'draft');

  /* Spread across six months, not three. The dashboard's trend
     chart shows six, and a chart whose first three months sit at
     zero reads as a broken feed rather than as a quiet summer. */
  for (let i = 0; i < 46; i += 1) {
    const sup = r.pick(SUPPLIERS);
    const placed = r.int(1, 178);
    const lines = [];
    for (let l = 0; l < r.int(1, 5); l += 1) {
      const p = r.pick(live);
      if (lines.some((x) => x.productCode === p.productCode)) continue;
      const qty = r.int(20, 180);
      lines.push({
        productCode: p.productCode,
        name: p.name,
        size: p.size,
        qty,
        rate: p.purchaseRate,
        amount: Math.round(qty * p.purchaseRate * p.sqftPerBox),
      });
    }

    // Older orders have had time to arrive; recent ones have not.
    // Older orders have had time to arrive; this week's have not.
    const status = placed > 60 ? (r.chance(0.92) ? 'received' : 'cancelled')
      : placed > 21 ? r.pick(['received', 'received', 'part', 'ordered'])
      : r.pick(['ordered', 'ordered', 'part', 'draft']);

    orders.push({
      id: 'PO-' + String(2100 + i),
      supplierId: sup.id,
      supplier: sup.name,
      placedOn: dateOnly(iso(placed)),
      expectedOn: dateOnly(iso(placed - r.int(7, 30))),
      status,
      terms: sup.terms,
      lines,
      total: lines.reduce((s, l) => s + l.amount, 0),
    });
  }
  return orders.sort((a, b) => b.placedOn.localeCompare(a.placedOn));
}

export const PURCHASES = buildPurchases();

export const PURCHASE_STATUS = {
  draft:     { label: 'Draft',             tone: 'info' },
  ordered:   { label: 'Ordered',           tone: 'warn' },
  part:      { label: 'Partly received',   tone: 'warn' },
  received:  { label: 'Received',          tone: 'ok' },
  cancelled: { label: 'Cancelled',         tone: 'inert' },
};

/* ── sales ───────────────────────────────────────────────────── */

function buildSales() {
  const r = seeded(27182818);
  const orders = [];
  const sellable = PRODUCTS.filter((p) => p.status !== 'draft');

  for (let i = 0; i < 64; i += 1) {
    const cus = r.pick(CUSTOMERS);
    const placed = r.int(0, 178);
    const lines = [];
    for (let l = 0; l < r.int(1, 4); l += 1) {
      const p = r.pick(sellable);
      if (lines.some((x) => x.productCode === p.productCode)) continue;
      const qty = r.int(2, 60);
      lines.push({
        productCode: p.productCode,
        name: p.name,
        size: p.size,
        qty,
        rate: p.sellingRate,
        amount: Math.round(qty * p.sellingRate * p.sqftPerBox),
      });
    }

    const status = placed > 40 ? r.pick(['delivered', 'delivered', 'invoiced'])
      : placed > 12 ? r.pick(['invoiced', 'dispatched', 'confirmed'])
      : r.pick(['quote', 'confirmed', 'dispatched']);

    orders.push({
      id: 'SO-' + String(5100 + i),
      customerId: cus.id,
      customer: cus.name,
      customerType: cus.type,
      placedOn: dateOnly(iso(placed)),
      status,
      lines,
      total: lines.reduce((s, l) => s + l.amount, 0),
    });
  }
  return orders.sort((a, b) => b.placedOn.localeCompare(a.placedOn));
}

export const SALES = buildSales();

export const SALES_STATUS = {
  quote:      { label: 'Quotation',  tone: 'info' },
  confirmed:  { label: 'Confirmed',  tone: 'warn' },
  dispatched: { label: 'Dispatched', tone: 'warn' },
  invoiced:   { label: 'Invoiced',   tone: 'ok' },
  delivered:  { label: 'Delivered',  tone: 'ok' },
};

/* ── website sync ────────────────────────────────────────────────
   The direction matters and is never left implied. The ERP is the
   master for the commercial fields; the website is told, not asked.
   A row flowing the other way would mean the website had edited
   something the ERP owns, which is the mismatch this screen exists
   to surface. */

function buildSyncEvents() {
  const r = seeded(16180339);
  const rows = [];
  const kinds = [
    { kind: 'product.updated',  what: 'Price and stock pushed to website' },
    { kind: 'product.created',  what: 'New product published' },
    { kind: 'stock.changed',    what: 'Stock figure pushed' },
    { kind: 'product.retired',  what: 'Product delisted from website' },
  ];

  for (let i = 0; i < 46; i += 1) {
    const p = r.pick(PRODUCTS);
    const k = r.pick(kinds);
    const minsAgo = i * r.int(12, 190);
    const status = r.chance(0.08) ? 'failed' : r.chance(0.06) ? 'pending' : 'synced';

    rows.push({
      id: 'SY-' + String(9000 + i),
      at: new Date(DEMO_TODAY.getTime() - minsAgo * 60000).toISOString(),
      productCode: p.productCode,
      productName: p.name,
      kind: k.kind,
      what: k.what,
      direction: 'erp → website',
      status,
      attempts: status === 'failed' ? r.int(2, 4) : 1,
      error: status === 'failed'
        ? r.pick([
          'Website rejected the update: no product with this code',
          'Request timed out after 30s',
          'Website returned 409: the row was changed there since the last sync',
        ])
        : null,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export const SYNC_EVENTS = buildSyncEvents();

export const SYNC_STATUS = {
  synced:  { label: 'Synced',  tone: 'ok' },
  pending: { label: 'Pending', tone: 'warn' },
  failed:  { label: 'Failed',  tone: 'danger' },
};

/* ── people ──────────────────────────────────────────────────── */

export const ROLES = {
  admin:   { label: 'Administrator', can: 'Everything, including users and settings.' },
  manager: { label: 'Studio Manager', can: 'Products, stock, purchase and sales. Not users.' },
  store:   { label: 'Store Keeper',   can: 'Stock inward, outward and the ledger only.' },
  sales:   { label: 'Sales',          can: 'Sales orders and the catalogue, read-only stock.' },
  viewer:  { label: 'Viewer',         can: 'Read-only across every module.' },
};

export const USERS = [
  { id: 'u-1', name: 'Devyora Admin',  email: 'admin@devyora.example',   role: 'admin',   active: true,  lastSeen: iso(0) },
  { id: 'u-2', name: 'Studio Manager', email: 'manager@devyora.example', role: 'manager', active: true,  lastSeen: iso(1) },
  { id: 'u-3', name: 'Store Keeper',   email: 'store@devyora.example',   role: 'store',   active: true,  lastSeen: iso(0) },
  { id: 'u-4', name: 'Sales Desk',     email: 'sales@devyora.example',   role: 'sales',   active: true,  lastSeen: iso(3) },
  { id: 'u-5', name: 'Accounts',       email: 'accounts@devyora.example', role: 'viewer', active: false, lastSeen: iso(62) },
];
