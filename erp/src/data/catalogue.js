import { seeded } from './rand.js';

/* ============================================================
   THE PRODUCT MASTER, AS DEMO DATA
   ============================================================

   DEMO DATA. None of this is the studio's real catalogue, real
   stock or real cost. It exists so the screens can be judged on
   how they behave with a few hundred realistic rows.

   The vocabulary -- brands, sizes, finishes, tones, collections --
   is taken from the website's own Tile model
   (backend/prisma/schema.prisma) so the columns here are the
   columns the real data would arrive in.

   WHICH COLUMNS ALREADY EXIST, AND WHICH ARE NEW. The audit found
   that the website's Tile row carries name, brand, size, finish,
   type, colourTone, bestRoom, collection, productCode and a single
   `inStock` boolean -- and nothing else. Every commercial field
   below (cost, selling price, quantity, reorder level, status
   beyond in/out) is NEW to the ERP and has no counterpart in the
   website database today. `origin` records that, per field, so the
   Product Master screen can mark which columns the website would
   have to be taught about.
   ============================================================ */

export const FIELD_ORIGIN = {
  productCode: 'website',
  name: 'website',
  brand: 'website',
  collection: 'website',
  size: 'website',
  finish: 'website',
  type: 'website',
  colorTone: 'website',
  bestRoom: 'website',
  imageUrl: 'website',
  // Everything below is the ERP's own. The website has no column for
  // any of it, which is exactly why the ERP is the master.
  category: 'erp',
  hsnCode: 'erp',
  purchaseRate: 'erp',
  sellingRate: 'erp',
  mrp: 'erp',
  unit: 'erp',
  pcsPerBox: 'erp',
  stockQty: 'erp',
  reorderLevel: 'erp',
  status: 'erp',
  supplier: 'erp',
  updatedAt: 'erp',
};

const BRANDS = ['Somany', 'Morson', 'Simpolo', 'Varmora', 'Qutone', 'AGL'];

const SIZES = [
  { size: '600x1200mm', pcsPerBox: 2, sqftPerBox: 15.5 },
  { size: '800x1600mm', pcsPerBox: 2, sqftPerBox: 27.5 },
  { size: '600x600mm',  pcsPerBox: 4, sqftPerBox: 15.5 },
  { size: '300x600mm',  pcsPerBox: 8, sqftPerBox: 15.5 },
  { size: '300x300mm',  pcsPerBox: 11, sqftPerBox: 10.6 },
  { size: '1200x2400mm', pcsPerBox: 1, sqftPerBox: 31.0 },
];

const FINISHES = ['Glossy', 'Matte', 'Satin', 'Sugar', 'Carving', 'Rustic', 'Polished'];

/* Tone and collection are paired, because "Verona" in Charcoal and
   "Verona" in Ivory are the same collection in two colourways --
   which is how a tile catalogue actually reads, and what makes the
   colour filter on the Product Master worth having. */
const COLLECTIONS = [
  { collection: 'Statuario',   tones: ['White', 'Ivory'] },
  { collection: 'Verona',      tones: ['Charcoal', 'Grey'] },
  { collection: 'Travertino',  tones: ['Beige', 'Cream'] },
  { collection: 'Emperador',   tones: ['Brown', 'Tan'] },
  { collection: 'Onyx Lustre', tones: ['Ivory', 'Gold'] },
  { collection: 'Calacatta',   tones: ['White', 'Grey'] },
  { collection: 'Terrazzo',    tones: ['Grey', 'Cream'] },
  { collection: 'Heritage',    tones: ['Green', 'Oxblood'] },
  { collection: 'Slate Form',  tones: ['Charcoal', 'Black'] },
  { collection: 'Lino Wood',   tones: ['Tan', 'Brown'] },
];

const TYPES = ['Base', 'Wall', 'Highlighter', 'Listello'];
const ROOMS = ['Bathroom', 'Kitchen & Dining', 'Living Room', 'Bedroom', 'Balcony', 'Office'];

export const CATEGORIES = [
  { id: 'cat-floor',  name: 'Floor Tiles',        parent: null,          hsn: '69072100' },
  { id: 'cat-wall',   name: 'Wall Tiles',         parent: null,          hsn: '69072200' },
  { id: 'cat-slab',   name: 'Large Format Slabs', parent: 'cat-floor',   hsn: '69072300' },
  { id: 'cat-high',   name: 'Highlighters',       parent: 'cat-wall',    hsn: '69072200' },
  { id: 'cat-out',    name: 'Outdoor / Parking',  parent: 'cat-floor',   hsn: '69072100' },
  { id: 'cat-sani',   name: 'Sanitaryware',       parent: null,          hsn: '69101000' },
];

export const SUPPLIERS = [
  { id: 'sup-1', name: 'Somany Ceramics Ltd.',     city: 'Kadi',      gstin: '24AAACS1234F1Z5', terms: '30 days' },
  { id: 'sup-2', name: 'Morson Granito',           city: 'Morbi',     gstin: '24AABCM5678G1Z2', terms: '45 days' },
  { id: 'sup-3', name: 'Simpolo Vitrified Pvt.',   city: 'Morbi',     gstin: '24AADCS9012H1Z9', terms: '30 days' },
  { id: 'sup-4', name: 'Varmora Granito Pvt.',     city: 'Rajkot',    gstin: '24AACCV3456J1Z7', terms: 'Advance' },
  { id: 'sup-5', name: 'Qutone Ceramic Pvt.',      city: 'Morbi',     gstin: '24AAFCQ7890K1Z3', terms: '60 days' },
];

/** The five product states. Out of Stock and Discontinued are NOT
 *  the same thing and never share a presentation: the first is a
 *  product the studio still sells and must reorder, the second one
 *  it has chosen to retire. Conflating them is how a buyer reorders
 *  something nobody intends to sell again. */
export const STATUSES = {
  active:       { label: 'Active',        tone: 'ok',     note: 'On sale and in stock.' },
  low:          { label: 'Low Stock',     tone: 'warn',   note: 'At or below its reorder level. Still on sale.' },
  out:          { label: 'Out of Stock',  tone: 'danger', note: 'Nothing on hand. Still an active product — reorder it.' },
  discontinued: { label: 'Discontinued',  tone: 'inert',  note: 'Retired by the studio. Do not reorder, even at zero stock.' },
  draft:        { label: 'Draft',         tone: 'info',   note: 'Not yet published to the website.' },
};

const DAY = 86400000;
/* A fixed "today" so the ages below never drift. The screens show a
   banner saying the demo clock is frozen, rather than quietly
   ageing a dataset nobody is updating. */
export const DEMO_TODAY = new Date('2026-11-20T00:00:00Z');

function iso(daysAgo) {
  return new Date(DEMO_TODAY.getTime() - daysAgo * DAY).toISOString();
}

function buildProducts() {
  const r = seeded(20261120);
  const out = [];
  let n = 0;

  // A real catalogue is brand x collection x colourway x format, and
  // the near-duplicates that produces -- the same Verona in two
  // tones, the same tone in two sizes -- are exactly what the search,
  // the colour filter and the paging have to cope with. A dataset
  // with one row per collection would let a broken filter look fine.
  const plan = [];
  for (const brand of BRANDS) {
    for (const col of COLLECTIONS) {
      if (!r.chance(0.72)) continue;
      for (const tone of col.tones) {
        if (!r.chance(0.78)) continue;
        // Most products come in one format; some in two.
        const formats = r.chance(0.42) ? 2 : 1;
        const chosen = [];
        for (let i = 0; i < formats; i += 1) {
          const spec = r.pick(SIZES);
          if (!chosen.includes(spec.size)) { chosen.push(spec.size); plan.push({ brand, col, tone, spec }); }
        }
      }
    }
  }

  {
    for (const { brand, col, tone, spec } of plan) {
      const type = r.pick(TYPES);
      const isSlab = spec.size === '1200x2400mm' || spec.size === '800x1600mm';

      n += 1;
      const code = 'DV-' + String(1000 + n);

      // Rate per square foot, by format: a large slab costs more to
      // make and to move than a 300x300.
      const rate = isSlab ? r.int(120, 240) : r.int(38, 95);
      const purchaseRate = rate;
      const sellingRate = Math.round(rate * (1.28 + r.next() * 0.3));
      const mrp = Math.round(sellingRate * 1.18);

      const reorderLevel = r.int(10, 40);

      /* NO QUANTITY IS CHOSEN HERE, ON PURPOSE.
       *
       * The first draft of this file picked a status, then invented a
       * quantity to match, then generated a ledger separately -- and
       * the ledger did not add up to the quantity for eighteen
       * products. Both numbers were made up, so both were wrong, and
       * the screens would have shown a stock figure its own history
       * contradicted.
       *
       * So the arrow is reversed and there is only one source. A
       * product declares two things it genuinely owns -- whether it
       * is retired or still a draft, and how fast it moves -- and
       * `stockQty` and `status` are then DERIVED from the movements
       * in buildLedger(). They cannot disagree with the ledger
       * because they are computed from it. */
      const retired = r.chance(0.07);
      const draft = !retired && r.chance(0.05);
      // Where the ledger is told to leave this product by today.
      const band = retired ? 'retired'
        : draft ? 'none'
        : r.chance(0.09) ? 'out'
        : r.chance(0.17) ? 'low'
        : 'healthy';
      const pace = r.pick(['fast', 'fast', 'steady', 'steady', 'slow']);

      const category = isSlab ? 'cat-slab'
        : type === 'Highlighter' || type === 'Listello' ? 'cat-high'
        : type === 'Wall' ? 'cat-wall'
        : 'cat-floor';

      out.push({
        id: code,
        productCode: code,
        name: col.collection + ' ' + tone + (isSlab ? ' Slab' : ''),
        brand,
        collection: col.collection,
        size: spec.size,
        finish: r.pick(FINISHES),
        type,
        colorTone: tone,
        bestRoom: r.pick(ROOMS),
        category,
        hsnCode: CATEGORIES.find((c) => c.id === category).hsn,
        unit: 'Box',
        pcsPerBox: spec.pcsPerBox,
        sqftPerBox: spec.sqftPerBox,
        purchaseRate,
        sellingRate,
        mrp,
        /* No stockQty and no status. Placeholders of 0 and 'active'
           sat here briefly and were worse than nothing: a screen
           that forgot to import the ledger would have rendered a
           plausible-looking catalogue of zeroes instead of failing
           loudly. Absent fields make that mistake visible. */
        reorderLevel,
        retired,
        draft,
        band,
        pace,
        supplier: r.pick(SUPPLIERS).id,
        // Whether the website currently lists it. A draft is not on
        // the site yet; a discontinued product may still be, which is
        // one of the mismatches the Sync screen is for.
        onWebsite: !draft && r.chance(0.92),
        updatedAt: iso(r.int(0, 120)),
      });
    }
  }
  return out;
}

/**
 * THE PRODUCTS BEFORE THEY HAVE A STOCK FIGURE.
 *
 * Deliberately NOT exported as `PRODUCTS`. These rows carry no
 * quantity and no status yet -- ledger.js derives both from the
 * movements and exports the finished list. An earlier version
 * exported this as PRODUCTS and let ledger.js write the quantities
 * onto it afterwards, which meant any screen that imported the
 * catalogue without also importing the ledger silently got a
 * catalogue where everything was zero and everything was "active".
 * The test caught it; the name now makes it impossible.
 *
 * Import PRODUCTS from ./ledger.js. There is no half-built list to
 * get hold of.
 */
export const BASE_PRODUCTS = buildProducts();
