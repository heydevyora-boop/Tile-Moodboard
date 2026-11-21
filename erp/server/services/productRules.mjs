import { ValidationError } from '../errors.mjs';

/* ============================================================
   WHAT A PRODUCT NEEDS, BY WHAT KIND OF PRODUCT IT IS
   ============================================================

   A tile has a size, a thickness and a surface. A GRC panel has a
   height, a width, a projection and a material. Demanding a tile's
   thickness from a GRC jali is nonsense, and accepting a GRC panel
   with no projection is worse — it looks complete and is not.

   SO: three fields are required of EVERYTHING, because they are
   what makes a product a product in this business --

       brand, name, size

   -- and each category adds its own on top. The brief named those
   three for tiles; they hold for every category here because a
   product with no brand or no name cannot be ordered, and "size"
   is how an architectural product is specified whatever it is
   made of.

   WHY A TABLE OF RULES RATHER THAN COLUMNS. Adding `projection` to
   every product in the catalogue so that GRC can use it gives
   every tile a column that is always null and every report a
   column it must ignore. These rules say which keys of
   Product.attributes a category requires and which it permits, so
   the JSON cannot quietly fill with typos either.

   ADDING A CATEGORY. Give it an entry here, keyed by the category
   CODE. A category with no entry falls back to DEFAULT_RULES:
   the three universal fields and nothing else, which accepts an
   honest minimal record rather than inventing requirements nobody
   agreed to.
   ============================================================ */

/** Required of every product, in every category. */
const UNIVERSAL_REQUIRED = [
  { field: 'brandId', label: 'Brand' },
  { field: 'name', label: 'Product name' },
  { field: 'size', label: 'Size' },
];

const DEFAULT_RULES = {
  label: 'General',
  requiredColumns: [],
  requiredAttributes: [],
  allowedAttributes: ['material', 'surfaceType', 'notes'],
};

export const CATEGORY_RULES = {
  // ── tiles ────────────────────────────────────────────────
  FLOOR: {
    label: 'Floor tile',
    requiredColumns: [
      { field: 'thicknessMm', label: 'Thickness' },
      { field: 'finish', label: 'Finish' },
      { field: 'colour', label: 'Colour' },
    ],
    requiredAttributes: [],
    // Anti-skid rating is the one a floor tile is actually chosen
    // on in a bathroom, so it is permitted and named rather than
    // arriving as a free-text note.
    allowedAttributes: ['surfaceType', 'antiSkidRating', 'pei', 'waterAbsorption', 'notes'],
  },
  WALL: {
    label: 'Wall tile',
    requiredColumns: [
      { field: 'thicknessMm', label: 'Thickness' },
      { field: 'finish', label: 'Finish' },
      { field: 'colour', label: 'Colour' },
    ],
    requiredAttributes: [],
    allowedAttributes: ['surfaceType', 'waterAbsorption', 'notes'],
  },
  SLAB: {
    label: 'Large format slab',
    requiredColumns: [
      { field: 'thicknessMm', label: 'Thickness' },
      { field: 'finish', label: 'Finish' },
      { field: 'colour', label: 'Colour' },
    ],
    requiredAttributes: [],
    allowedAttributes: ['surfaceType', 'bookMatch', 'notes'],
  },
  HIGHLIGHT: {
    label: 'Highlighter',
    requiredColumns: [{ field: 'colour', label: 'Colour' }],
    requiredAttributes: [],
    allowedAttributes: ['surfaceType', 'pattern', 'notes'],
  },
  OUTDOOR: {
    label: 'Outdoor / parking tile',
    requiredColumns: [
      { field: 'thicknessMm', label: 'Thickness' },
      { field: 'finish', label: 'Finish' },
    ],
    // Outdoors, slip resistance is not a nicety.
    requiredAttributes: [{ key: 'antiSkidRating', label: 'Anti-skid rating' }],
    allowedAttributes: ['surfaceType', 'antiSkidRating', 'frostResistant', 'notes'],
  },

  // ── not a tile ───────────────────────────────────────────
  //
  // Here to prove the point the brief makes: do not assume every
  // architectural product has tile attributes. A GRC panel is
  // specified by how far it stands off the wall and what it is
  // made of, and has no thickness in the tile sense at all.
  GRC: {
    label: 'GRC / architectural element',
    requiredColumns: [
      { field: 'lengthMm', label: 'Height' },
      { field: 'widthMm', label: 'Width' },
      { field: 'finish', label: 'Finish' },
    ],
    requiredAttributes: [
      { key: 'projectionMm', label: 'Projection' },
      { key: 'material', label: 'Material' },
    ],
    allowedAttributes: ['projectionMm', 'material', 'reinforcement', 'weightKg', 'notes'],
  },
  SANI: {
    label: 'Sanitaryware',
    requiredColumns: [{ field: 'finish', label: 'Finish' }],
    requiredAttributes: [{ key: 'material', label: 'Material' }],
    allowedAttributes: ['material', 'mountingType', 'waterRating', 'notes'],
  },
};

/** The rules for a category code, or the honest minimum. */
export function rulesFor(categoryCode) {
  return CATEGORY_RULES[categoryCode] || DEFAULT_RULES;
}

/** What the UI needs to render the right form for a category. */
export function describeRules(categoryCode) {
  const rules = rulesFor(categoryCode);
  return {
    categoryCode: categoryCode ?? null,
    label: rules.label,
    required: [
      ...UNIVERSAL_REQUIRED.map((r) => r.label),
      ...rules.requiredColumns.map((r) => r.label),
      ...rules.requiredAttributes.map((r) => r.label),
    ],
    allowedAttributes: rules.allowedAttributes,
  };
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Check a variant against its category's rules.
 *
 * Collects EVERY failure before throwing. Returning the first
 * problem makes a person fix one field, resubmit, and find the
 * next — six times. One response naming all six is one correction.
 *
 * @param {object} data        the variant as submitted
 * @param {string|null} categoryCode
 * @param {{partial?: boolean}} [opts]  partial: an edit, so only
 *        check the fields actually present. An edit that does not
 *        mention thickness is not an attempt to remove it.
 */
export function validateProduct(data, categoryCode, { partial = false } = {}) {
  const rules = rulesFor(categoryCode);
  const fields = [];

  const check = (field, label) => {
    if (partial && !(field in data)) return;
    if (isBlank(data[field])) {
      fields.push({ field, message: label + ' is required.' });
    }
  };

  for (const r of UNIVERSAL_REQUIRED) check(r.field, r.label);
  for (const r of rules.requiredColumns) check(r.field, r.label);

  // ── attributes ───────────────────────────────────────────
  const attributes = data.attributes;
  if (attributes !== undefined && attributes !== null) {
    if (typeof attributes !== 'object' || Array.isArray(attributes)) {
      fields.push({ field: 'attributes', message: 'Attributes must be an object.' });
    } else {
      // An unknown key is rejected rather than stored. A JSON
      // column that accepts anything accumulates "colour",
      // "color", "Colour" and three different spellings of
      // "projection", and nothing can query it afterwards.
      for (const key of Object.keys(attributes)) {
        if (!rules.allowedAttributes.includes(key)) {
          fields.push({
            field: 'attributes.' + key,
            message: '"' + key + '" is not an attribute of a ' + rules.label.toLowerCase()
              + '. Allowed: ' + (rules.allowedAttributes.join(', ') || 'none') + '.',
          });
        }
      }
    }
  }

  const haveAttributes = (attributes && typeof attributes === 'object') ? attributes : {};
  for (const r of rules.requiredAttributes) {
    if (partial && attributes === undefined) continue;
    if (isBlank(haveAttributes[r.key])) {
      fields.push({ field: 'attributes.' + r.key, message: r.label + ' is required for a ' + rules.label.toLowerCase() + '.' });
    }
  }

  // ── numbers that have to be numbers ──────────────────────
  for (const [field, label] of [
    ['purchasePrice', 'Purchase price'],
    ['sellingPrice', 'Selling price'],
    ['mrp', 'MRP'],
    ['reorderLevel', 'Reorder level'],
  ]) {
    if (!(field in data) || data[field] === null || data[field] === undefined) continue;
    const n = Number(data[field]);
    if (!Number.isFinite(n) || n < 0) {
      fields.push({ field, message: label + ' must be a number of zero or more.' });
    }
  }

  if (data.sellingPrice != null && data.purchasePrice != null) {
    const sell = Number(data.sellingPrice);
    const cost = Number(data.purchasePrice);
    // A warning, not a rejection: a clearance line really can sell
    // below cost, and refusing it would make the ERP wrong about
    // the real world. It is surfaced, not blocked.
    if (Number.isFinite(sell) && Number.isFinite(cost) && sell < cost) {
      fields.push({
        field: 'sellingPrice',
        message: 'Selling price is below purchase price. Allowed, but confirm it is intended.',
        severity: 'warning',
      });
    }
  }

  const errors = fields.filter((f) => f.severity !== 'warning');
  if (errors.length > 0) throw new ValidationError(fields);

  return { warnings: fields.filter((f) => f.severity === 'warning') };
}
