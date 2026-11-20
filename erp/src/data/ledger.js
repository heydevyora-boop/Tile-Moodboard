import { seeded } from './rand.js';
import { BASE_PRODUCTS, SUPPLIERS, DEMO_TODAY } from './catalogue.js';

/* ============================================================
   THE LEDGER, AND THE STOCK FIGURE IT PRODUCES
   ============================================================

   THE ONE RULE THIS FILE KEEPS. Opening balance, plus everything
   in, minus everything out, equals the on-hand quantity the Product
   Master shows -- for every product, with no balance ever going
   negative on any day.

   It is true by CONSTRUCTION, not by checking afterwards. The
   movements are simulated first, and `stockQty` and `status` are
   then written back onto each product from where the simulation
   left it. There is no second, independently invented stock figure
   for the ledger to disagree with, because there is no second
   figure at all.

   An outward movement is never allowed to exceed what is on the
   shelf that day: you cannot dispatch tiles you do not have, and a
   demo that lets you teaches the reader to ignore the balance
   column.
   ============================================================ */

const DAY = 86400000;
const WINDOW = 90;
const iso = (daysAgo) => new Date(DEMO_TODAY.getTime() - daysAgo * DAY).toISOString();

export const WAREHOUSE = {
  id: 'wh-main',
  name: 'Studio Warehouse',
  city: 'Ahmedabad',
  // One location today. The Warehouses module stays a planned
  // placeholder precisely because a second one would change the
  // shape of every figure in this file.
  note: 'The only stock location in this build.',
};

export const MOVEMENT_REASONS = {
  purchase:   { label: 'Purchase receipt',  dir: 'in'  },
  opening:    { label: 'Opening stock',     dir: 'in'  },
  return_in:  { label: 'Customer return',   dir: 'in'  },
  adjust_in:  { label: 'Adjustment (+)',    dir: 'in'  },
  sale:       { label: 'Sale dispatch',     dir: 'out' },
  sample:     { label: 'Sample issued',     dir: 'out' },
  damage:     { label: 'Damage / breakage', dir: 'out' },
  adjust_out: { label: 'Adjustment (−)',    dir: 'out' },
};

export const CUSTOMERS = [
  { id: 'cus-1', name: 'Mehta Residence — Bodakdev',    type: 'Retail' },
  { id: 'cus-2', name: 'Shah Interiors LLP',            type: 'Trade' },
  { id: 'cus-3', name: 'Casa De Aurum — Studio Sample', type: 'Internal' },
  { id: 'cus-4', name: 'Patel Builders Pvt. Ltd.',      type: 'Project' },
  { id: 'cus-5', name: 'Trivedi Villa — Thaltej',       type: 'Retail' },
  { id: 'cus-6', name: 'Anand Hospitality Group',       type: 'Project' },
];

const STAFF = ['Devyora Admin', 'Store Keeper', 'Studio Manager'];

/* How many movements a product sees across the window, by how fast
   it moves. A slow mover with daily dispatches is not a slow mover. */
const PACE_EVENTS = { fast: [14, 26], steady: [6, 13], slow: [2, 6] };

function buildLedger() {
  const r = seeded(77001122);
  const rows = [];
  const opening = new Map();
  // Derived here and applied by copying, never by writing back onto
  // the catalogue's own rows: a module that mutates what it imports
  // makes its own output depend on who imported what first.
  const derived = new Map();
  let seq = 0;

  const add = (daysAgo, p, reason, qty, extra = {}) => {
    seq += 1;
    rows.push({
      id: 'MV-' + String(10000 + seq),
      at: iso(daysAgo),
      productCode: p.productCode,
      productName: p.name,
      brand: p.brand,
      reason,
      dir: MOVEMENT_REASONS[reason].dir,
      qty,
      unit: p.unit,
      rate: MOVEMENT_REASONS[reason].dir === 'in' ? p.purchaseRate : p.sellingRate,
      by: r.pick(STAFF),
      ...extra,
    });
  };

  for (const p of BASE_PRODUCTS) {
    // A draft has never been stocked: no opening balance, no history,
    // and therefore nothing on the shelf. That is why it reads as
    // Draft rather than Out of Stock -- the two are different facts.
    if (p.draft) {
      opening.set(p.productCode, 0);
      derived.set(p.productCode, { stockQty: 0, status: 'draft' });
      continue;
    }

    let balance = r.int(40, 260);
    opening.set(p.productCode, balance);
    add(WINDOW + 1, p, 'opening', balance, {
      ref: 'Opening stock',
      party: 'Opening balance',
      by: 'System',
    });

    // Which days anything happened on. Drawn, then sorted, so a
    // product's history is lumpy the way a real one is rather than
    // evenly spaced.
    const [lo, hi] = PACE_EVENTS[p.pace];
    const days = [];
    // The last week is left clear, because the closing movement
    // below has to be the most recent thing that happened to this
    // product. Dated among the others it would re-sort into the
    // middle of the history, and a dispatch applied before the
    // receipt that covered it drives the running balance negative --
    // which it did, for two products, before this line said 7.
    for (let i = 0, n = r.int(lo, hi); i < n; i += 1) days.push(r.int(7, WINDOW));
    days.sort((a, b) => b - a);

    for (const daysAgo of days) {
      // A retired product is never reordered; that is what retiring
      // one means. It can still go out, and still come back.
      const pool = p.retired
        ? ['sale', 'sale', 'sample', 'damage', 'return_in']
        : ['purchase', 'sale', 'sale', 'sale', 'sample', 'damage', 'return_in', 'adjust_in', 'adjust_out'];
      const reason = r.pick(pool);
      const dir = MOVEMENT_REASONS[reason].dir;

      let qty = reason === 'purchase' ? r.int(20, 160)
        : reason === 'sale' ? r.int(2, 45)
        : reason === 'sample' ? r.int(1, 3)
        : r.int(1, 8);

      if (dir === 'out') {
        // Never dispatch more than is on the shelf that day.
        qty = Math.min(qty, balance);
        if (qty <= 0) continue;
        balance -= qty;
      } else {
        balance += qty;
      }

      add(daysAgo, p, reason, qty, {
        ref: reason === 'purchase' ? 'PO-' + String(2100 + (seq % 24))
          : reason === 'sale' ? 'SO-' + String(5100 + (seq % 32))
          : '—',
        party: dir === 'in'
          ? (SUPPLIERS.find((s) => s.id === p.supplier) || SUPPLIERS[0]).name
          : r.pick(CUSTOMERS).name,
      });
    }

    /* ONE LAST MOVEMENT, to land the product where its band says it
       should be today. This is the only steered figure in the file,
       and it is a plain receipt or dispatch of a sensible size -- not
       a silent correction of the balance. A reviewer who wants a
       catalogue with a handful of out-of-stock lines to look at gets
       one, and the ledger still explains every box of it. */
    const target = p.band === 'out' ? 0
      : p.band === 'low' ? r.int(1, p.reorderLevel)
      : p.band === 'retired' ? (r.chance(0.5) ? 0 : r.int(1, 12))
      : r.int(p.reorderLevel + 6, p.reorderLevel + 190);

    const delta = target - balance;
    if (delta !== 0) {
      /* A RETIRED PRODUCT IS NEVER REORDERED, and the closing
         movement is not an exception. Stock coming back to a
         discontinued line is a customer returning it, not the studio
         buying more of something it has stopped selling -- and a
         purchase order against a retired product is precisely the
         mistake the Discontinued status exists to prevent. */
      const reason = delta > 0 ? (p.retired ? 'return_in' : 'purchase') : 'sale';
      const qty = Math.abs(delta);
      add(r.int(0, 6), p, reason, qty, {
        ref: reason === 'purchase' ? 'PO-' + String(2100 + (seq % 24))
          : reason === 'sale' ? 'SO-' + String(5100 + (seq % 32))
          : '—',
        party: delta > 0
          ? (p.retired ? r.pick(CUSTOMERS).name
            : (SUPPLIERS.find((s) => s.id === p.supplier) || SUPPLIERS[0]).name)
          : r.pick(CUSTOMERS).name,
      });
      balance = target;
    }

    // The stock figure and the status, READ OFF the ledger. These are
    // the only places either one is decided.
    derived.set(p.productCode, {
      stockQty: balance,
      status: p.retired ? 'discontinued'
        : balance === 0 ? 'out'
        : balance <= p.reorderLevel ? 'low'
        : 'active',
    });
  }

  return { rows: rows.sort((a, b) => a.at.localeCompare(b.at)), opening, derived };
}

const { rows: MOVEMENT_ROWS, opening: OPENING, derived: DERIVED } = buildLedger();

/**
 * THE FINISHED PRODUCT MASTER.
 *
 * The catalogue's rows with the quantity and the status the ledger
 * arrived at. This is the only product list any screen should
 * import, and the only one that exists outside this module.
 */
export const PRODUCTS = BASE_PRODUCTS.map((p) => ({ ...p, ...DERIVED.get(p.productCode) }));

/** A product by its code, for the screens that link to one. */
export function productByCode(code) {
  return PRODUCTS.find((p) => p.productCode === code) || null;
}

/** Stock valued at what it COST. That is the figure that belongs on
 *  a balance sheet; valuing it at the hoped-for selling price counts
 *  a profit the studio has not made yet. */
export function stockValue(list = PRODUCTS) {
  return list.reduce((sum, p) => sum + p.stockQty * p.purchaseRate * p.sqftPerBox, 0);
}

/** Every movement, oldest first. */
export const MOVEMENTS = MOVEMENT_ROWS;

/** The balance a product's ledger starts from, before the window. */
export function openingFor(code) {
  return OPENING.get(code) || 0;
}

/** A product's movements, oldest first, each carrying the running
 *  balance after it. This is what makes the reconciliation visible
 *  on screen rather than merely asserted in a comment. */
export function ledgerFor(code) {
  // The opening receipt is itself a movement, so the running total
  // starts from nothing and the first row brings it to the opening
  // balance -- which is what a stock card actually looks like.
  let balance = 0;
  return MOVEMENTS
    .filter((m) => m.productCode === code)
    .map((m) => {
      balance += m.dir === 'in' ? m.qty : -m.qty;
      return { ...m, balance };
    });
}
