/* ============================================================
   MONEY AND GST, WITHOUT FLOATING POINT
   ============================================================

   WHY THIS FILE EXISTS.

       0.1 + 0.2 === 0.30000000000000004

   That is not a curiosity, it is what happens to a tax figure
   computed in JavaScript numbers. Round a few hundred of them and
   a purchase total ends a rupee out from the supplier's invoice,
   and somebody spends an afternoon finding out why.

   So nothing here holds money in a float. Every amount is an
   integer number of PAISE, every quantity an integer number of
   THOUSANDTHS (the schema's Decimal(14,3)), and every rate an
   integer number of HUNDREDTHS OF A PERCENT. Integers in,
   integers through, a decimal string out at the very end for
   Prisma to hand to PostgreSQL as a DECIMAL.

   JavaScript integers are exact to 2^53, which is ninety thousand
   crore rupees in paise. The studio will not reach it.

   WHAT ROUNDS WHERE.

   Each LINE is rounded to the paisa, and the document total is
   the SUM OF THE ROUNDED LINES -- not a recomputation from the
   un-rounded figures. That is how an Indian tax invoice is
   constructed, and it is why a document's total always equals
   what you get by adding its printed lines with a calculator.
   Rounding once at the end would be more "accurate" and would
   disagree with the paperwork, which is worse.

   Half-up at every rounding point, which is the convention the
   rest of the trade uses.
   ============================================================ */

/** Rupees-and-paise string, or a number, to an integer of paise. */
export function toPaise(value) {
  return scaledFrom(value, 2, 'amount');
}

/** A quantity to an integer of thousandths. */
export function toMilli(value) {
  return scaledFrom(value, 3, 'quantity');
}

/** A percentage to an integer of hundredths of a percent. */
export function toBasis(value) {
  return scaledFrom(value, 2, 'rate');
}

/**
 * Parse a decimal WITHOUT going through a float.
 *
 * `Number('0.07') * 100` is 7.000000000000001, so the obvious
 * implementation is already wrong at the second decimal place.
 * This splits the string instead and never multiplies a
 * fractional value by anything.
 */
function scaledFrom(value, places, what) {
  if (value === null || value === undefined || value === '') return 0;

  const text = String(typeof value === 'object' && value !== null ? value.toString() : value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(text) || text === '' || text === '-' || text === '.') {
    throw new TypeError('Not a usable ' + what + ': ' + JSON.stringify(value));
  }

  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = digits.split('.');

  // Pad or cut the fraction to exactly `places`, rounding the cut
  // half-up from the first digit dropped.
  let scaled = BigInt(whole || '0') * 10n ** BigInt(places)
    + BigInt((fraction + '0'.repeat(places)).slice(0, places) || '0');

  if (fraction.length > places && Number(fraction[places]) >= 5) scaled += 1n;

  const out = Number(negative ? -scaled : scaled);
  if (!Number.isSafeInteger(out)) {
    throw new RangeError('That ' + what + ' is too large to handle exactly: ' + text);
  }
  return out;
}

/** An integer of minor units back to the decimal string Prisma wants. */
export function fromScaled(scaled, places) {
  const negative = scaled < 0;
  const digits = String(Math.abs(scaled)).padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = places === 0 ? '' : '.' + digits.slice(digits.length - places);
  return (negative ? '-' : '') + whole + fraction;
}

export const fromPaise = (p) => fromScaled(p, 2);
export const fromMilli = (m) => fromScaled(m, 3);
export const fromBasis = (b) => fromScaled(b, 2);

/**
 * Divide two integers, rounding half away from zero.
 *
 * Written out rather than `Math.round(a / b)`, because that goes
 * through a float and rounds half-to-even for ties at the edge of
 * precision.
 */
function divRound(numerator, denominator) {
  const negative = (numerator < 0) !== (denominator < 0);
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  const q = Math.floor(a / b);
  const r = a - q * b;
  const rounded = r * 2 >= b ? q + 1 : q;
  return negative ? -rounded : rounded;
}

/* ============================================================
   WHICH GST APPLIES
   ============================================================ */

export const GST_TREATMENTS = ['INTRA_STATE', 'INTER_STATE', 'UNREGISTERED'];

/**
 * Decide the GST treatment of a purchase.
 *
 * For GOODS, the place of supply is where they are delivered, so
 * the comparison is the supplier's state against the RECEIVING
 * WAREHOUSE's state -- not the studio's head office, and not the
 * supplier's billing address if the goods come from elsewhere.
 *
 * THERE IS NO FALLBACK. If the two state codes cannot be
 * established this returns a reason instead of a treatment, and
 * the caller refuses the order. Defaulting to intra-state would
 * produce CGST and SGST on an inter-state purchase: a figure
 * that is wrong, looks right, and is found at audit.
 *
 * @returns {{treatment: string} | {error: {field: string, message: string}}}
 */
export function gstTreatmentFor({ supplier, warehouse }) {
  // No GSTIN means an unregistered supplier, who charges no GST.
  // Reverse charge, where it applies, is an accounting entry and
  // explicitly out of this phase.
  if (!supplier?.gstin || !String(supplier.gstin).trim()) {
    return { treatment: 'UNREGISTERED', supplierStateCode: supplier?.stateCode ?? null,
      placeOfSupplyCode: warehouse?.stateCode ?? null };
  }

  const supplierCode = stateCodeOf(supplier);
  const placeOfSupply = warehouse?.stateCode ?? null;

  if (!supplierCode) {
    return {
      error: {
        field: 'supplierId',
        message: 'This supplier has no GST state code, so the tax treatment of the '
          + 'order cannot be worked out. Set it on the supplier first — it is the '
          + 'first two digits of the GSTIN.',
      },
    };
  }
  if (!placeOfSupply) {
    return {
      error: {
        field: 'warehouseId',
        message: 'The receiving warehouse has no GST state code. For goods the place '
          + 'of supply is where they are delivered, so the tax cannot be worked out '
          + 'without it.',
      },
    };
  }

  return {
    treatment: supplierCode === placeOfSupply ? 'INTRA_STATE' : 'INTER_STATE',
    supplierStateCode: supplierCode,
    placeOfSupplyCode: placeOfSupply,
  };
}

/**
 * Decide the GST treatment of a SALE.
 *
 * THIS IS NOT gstTreatmentFor() READ BACKWARDS. Two things differ
 * from the purchase side, and both were found during step 7's
 * inspection before any sales code was written:
 *
 * (1) THE COMPARISON IS MIRRORED. For goods the place of supply is
 *     where they are delivered, so on a purchase that is the
 *     RECEIVING WAREHOUSE's state (compared against the
 *     supplier's). On a sale the goods are delivered TO the
 *     customer, so the place of supply is the CUSTOMER's shipping
 *     state, compared against the SELLING WAREHOUSE's state -- the
 *     seller's registration, not the buyer's, is the other side of
 *     the comparison now.
 *
 * (2) AN UNREGISTERED PARTY IS NOT EXEMPT. A supplier with no
 *     GSTIN charges no GST (UNREGISTERED, step 6). A CUSTOMER with
 *     no GSTIN is an ordinary retail buyer -- a plain B2C sale --
 *     and the sale still carries GST. There is no UNREGISTERED
 *     member in SalesGstTreatment at all; a sale is always
 *     INTRA_STATE or INTER_STATE once a place of supply is known.
 *     Exempt and export sales are not implemented in this phase.
 *
 * As on the purchase side, THERE IS NO FALLBACK. If either state
 * code is missing this returns a reason instead of a treatment,
 * and the caller refuses the order. The arithmetic that follows
 * (computeLine, computeTotals) is the SAME function used for
 * purchases -- nothing here is a second GST engine, only a second
 * decision about which treatment to feed it.
 *
 * @returns {{treatment: string} | {error: {field: string, message: string}}}
 */
export function salesGstTreatmentFor({ warehouse, customer }) {
  const sellerCode = /^\d{2}$/.test(warehouse?.stateCode ?? '') ? warehouse.stateCode : null;

  // Ship-to, not bill-to -- goods move to the shipping address,
  // and that is where the place of supply is. Falls back to the
  // customer's own state only when no separate shipping state was
  // recorded, i.e. billing and shipping are the same place.
  const placeOfSupply = /^\d{2}$/.test(customer?.shippingStateCode ?? '')
    ? customer.shippingStateCode
    : (/^\d{2}$/.test(customer?.stateCode ?? '') ? customer.stateCode : null);

  if (!sellerCode) {
    return {
      error: {
        field: 'warehouseId',
        message: 'The dispatching warehouse has no GST state code, so the tax on this '
          + 'sale cannot be worked out. Set it on the warehouse first.',
      },
    };
  }
  if (!placeOfSupply) {
    return {
      error: {
        field: 'customerId',
        message: 'This customer has no GST state code, billing or shipping, so the '
          + 'place of supply cannot be determined. Even an unregistered retail sale '
          + 'still carries GST, and it needs a state to be taxed in — set one on the '
          + 'customer first.',
      },
    };
  }

  return {
    treatment: sellerCode === placeOfSupply ? 'INTRA_STATE' : 'INTER_STATE',
    sellerStateCode: sellerCode,
    placeOfSupplyCode: placeOfSupply,
  };
}

/**
 * A supplier's state code, preferring the GSTIN.
 *
 * The first two characters of a GSTIN ARE the state code, so when
 * both are present and disagree the GSTIN wins and the caller is
 * told: a stored code that contradicts the registration number is
 * a typing error, and silently trusting either one is how a batch
 * of orders gets taxed the wrong way.
 */
export function stateCodeOf(party) {
  const fromGstin = /^\d{2}/.test(party?.gstin ?? '') ? String(party.gstin).slice(0, 2) : null;
  return fromGstin ?? (/^\d{2}$/.test(party?.stateCode ?? '') ? party.stateCode : null);
}

/** True when the stored state code contradicts the GSTIN. */
export function stateCodeDisagreesWithGstin(party) {
  if (!/^\d{2}/.test(party?.gstin ?? '')) return false;
  if (!/^\d{2}$/.test(party?.stateCode ?? '')) return false;
  return String(party.gstin).slice(0, 2) !== party.stateCode;
}

/* ============================================================
   ONE LINE
   ============================================================

     gross    = quantity x unitPrice
     discount = gross x discountPercent, or the amount given
     taxable  = gross - discount
     tax      = taxable x taxRate
     total    = taxable + tax

   The tax is then SPLIT according to the treatment. Intra-state
   halves it into CGST and SGST; an odd paisa goes to CGST, which
   is the usual convention and keeps the two adding back to the
   whole.
   ============================================================ */

export function computeLine({ quantity, unitPrice, discountPercent = 0, discountAmount, taxRate = 0, treatment }) {
  const qtyMilli = toMilli(quantity);
  const pricePaise = toPaise(unitPrice);
  const ratePercentBasis = toBasis(taxRate);
  const discountBasis = toBasis(discountPercent);

  if (qtyMilli <= 0) throw new RangeError('A line quantity must be above zero.');
  if (pricePaise < 0) throw new RangeError('A unit price cannot be negative.');

  // quantity is in thousandths and price in paise, so the product
  // is in thousandths of a paisa. Rounded once, to the paisa.
  const grossPaise = divRound(qtyMilli * pricePaise, 1000);

  /* An explicit amount beats a percentage. Suppliers quote both,
     and when a negotiated figure is given it is the figure --
     re-deriving it from a percentage would move it by a paisa. */
  const discountPaise = discountAmount === undefined || discountAmount === null || discountAmount === ''
    ? divRound(grossPaise * discountBasis, 10000)
    : toPaise(discountAmount);

  if (discountPaise < 0) throw new RangeError('A discount cannot be negative.');
  if (discountPaise > grossPaise) {
    throw new RangeError('A discount cannot be larger than the line it discounts.');
  }

  const taxablePaise = grossPaise - discountPaise;

  // rate is in hundredths of a percent, so the divisor is 100 for
  // the percent and 100 again for the hundredths.
  const taxPaise = ratePercentBasis === 0 ? 0 : divRound(taxablePaise * ratePercentBasis, 10000);

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (treatment === 'INTRA_STATE') {
    // Half each. The odd paisa goes to CGST so the two still sum
    // to the whole; splitting it any other way loses a paisa.
    sgst = Math.floor(taxPaise / 2);
    cgst = taxPaise - sgst;
  } else if (treatment === 'INTER_STATE') {
    igst = taxPaise;
  } else if (treatment !== 'UNREGISTERED') {
    throw new RangeError('Unknown GST treatment: ' + treatment);
  }
  // UNREGISTERED charges no GST at all, so all three stay zero.
  const chargedTax = cgst + sgst + igst;

  return {
    quantity: fromMilli(qtyMilli),
    unitPrice: fromPaise(pricePaise),
    discountPercent: fromBasis(discountBasis),
    discountAmount: fromPaise(discountPaise),
    grossAmount: fromPaise(grossPaise),
    taxableValue: fromPaise(taxablePaise),
    taxRate: fromBasis(ratePercentBasis),
    cgstAmount: fromPaise(cgst),
    sgstAmount: fromPaise(sgst),
    igstAmount: fromPaise(igst),
    taxAmount: fromPaise(chargedTax),
    lineTotal: fromPaise(taxablePaise + chargedTax),
    // Kept as integers for the document total, so summing does not
    // go back through strings.
    _paise: {
      gross: grossPaise,
      discount: discountPaise,
      taxable: taxablePaise,
      cgst,
      sgst,
      igst,
      tax: chargedTax,
      total: taxablePaise + chargedTax,
    },
  };
}

/**
 * The document total: the SUM OF THE ROUNDED LINES.
 *
 * Deliberately not a recomputation from the raw quantities. A
 * document whose total does not equal its printed lines added up
 * is one nobody can check by hand, and "the computer rounded
 * differently" is not an answer a supplier accepts.
 */
export function computeTotals(lines, { otherCharges = 0 } = {}) {
  const other = toPaise(otherCharges);
  if (other < 0) throw new RangeError('Other charges cannot be negative.');

  const sum = (key) => lines.reduce((t, l) => t + l._paise[key], 0);

  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const tax = cgst + sgst + igst;

  return {
    subTotal: fromPaise(sum('gross')),
    discountTotal: fromPaise(sum('discount')),
    taxableTotal: fromPaise(taxable),
    cgstTotal: fromPaise(cgst),
    sgstTotal: fromPaise(sgst),
    igstTotal: fromPaise(igst),
    taxTotal: fromPaise(tax),
    otherCharges: fromPaise(other),
    grandTotal: fromPaise(taxable + tax + other),
  };
}

/* ============================================================
   THE DEFAULT GST RATE FOR A PRODUCT
   ============================================================
   Taken from the HSN code where the category carries one. These
   are the rates for ceramic and stone tiles, which is what the
   studio buys; anything unrecognised returns null and the caller
   must be told the rate rather than have one invented.

   The rate is SNAPSHOTTED onto the order line, so changing this
   table never alters an order already placed.
   ============================================================ */

const HSN_GST_RATE = {
  // Ceramic flags, paving and wall tiles.
  '6907': 18,
  '690721': 18,
  '690722': 18,
  '690723': 18,
  '690730': 18,
  '690740': 18,
  // Worked monumental or building stone, and articles of it.
  '6802': 18,
  '680221': 18,
  '680223': 18,
  '680291': 18,
  // Sanitary ware.
  '6910': 18,
};

/** The rate an HSN code attracts, or null if it is not known. */
export function gstRateForHsn(hsn) {
  const code = String(hsn ?? '').replace(/\D/g, '');
  if (!code) return null;
  // Longest match first: 690721 before 6907.
  for (let length = code.length; length >= 4; length -= 1) {
    const rate = HSN_GST_RATE[code.slice(0, length)];
    if (rate !== undefined) return rate;
  }
  return null;
}
