import { normaliseCode } from './normalise.mjs';
import { ConflictError } from '../errors.mjs';

/* ============================================================
   SKU
   ============================================================

   A SKU is an IDENTITY, not a label. Three rules follow from that,
   and everything in this file exists to keep them:

   1. IT IS PERMANENT. Renaming a product, re-describing it,
      correcting its finish or moving it to another category does
      NOT change its SKU. Order lines, stock movements and the
      website mapping all quote it; a SKU that moves rewrites what
      those documents appear to say. generateSku() is called when a
      variant is CREATED and at no other time — see
      product.service.mjs, which never passes sku to an update.

   2. IT IS UNIQUE, and the database is what guarantees it. The
      check below is for a good error message; the unique
      constraint is for correctness. Two clerks saving the same new
      variant at the same instant both pass the check and one of
      them loses at the constraint, which is the right outcome and
      is handled rather than crashed on.

   3. IT IS DETERMINISTIC WHERE IT CAN BE. The same brand, head and
      attributes produce the same candidate every time, so a SKU
      can be predicted, read aloud and recognised. Where that
      candidate is taken, a numeric suffix is appended -- a
      sequence, not a random string, so the result is still
      readable.

   SHAPE:  <BRAND>-<HEAD>-<ATTRS>        e.g. KAJ-NEOSAP-GRY600
           <BRAND>-<HEAD>-<ATTRS>-2      if that one is taken
   ============================================================ */

/** Strip a word down to the letters and digits that identify it. */
function token(value, length) {
  const clean = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return clean.slice(0, length);
}

/** 600x1200mm -> 600X1200.  300x300 -> 300X300.
 *  The X is kept because 6001200 reads as both 600x1200 and
 *  6001x200, and a code people have to say out loud across a
 *  warehouse cannot be ambiguous. */
function sizeToken(size) {
  const digits = String(size ?? '').match(/\d+/g);
  if (!digits || digits.length === 0) return '';
  return digits.slice(0, 2).join('X');
}

/**
 * The SKU this variant would naturally have.
 *
 * Deterministic: same inputs, same output, every time and on every
 * machine. No clock, no random, no database.
 */
export function candidateSku({ brandCode, headCode, colour, finish, size }) {
  const parts = [
    token(brandCode, 3) || 'GEN',
    token(headCode, 6) || 'STD',
  ];

  // The attribute block is what distinguishes one variant of a
  // head from another: colour, then finish, then size. Enough of
  // each to be recognisable, not so much that the code is a
  // sentence.
  // Hyphenated, not run together: KAJ-NEOSAP-GRE-MA-600X1200
  // can be read back over a phone; KAJ-NEOSAP-GREMA6001200
  // cannot.
  for (const part of [token(colour, 3), token(finish, 2), sizeToken(size)]) {
    if (part) parts.push(part);
  }
  return parts.join('-');
}

/**
 * Reserve a SKU for a new variant.
 *
 * @param {object} db      a Prisma client or an open transaction
 * @param {object} spec    brandCode, headCode, colour, finish, size
 * @param {string} [manual] an authorised manual SKU. Used as given
 *        — the studio sometimes has to match a supplier's code or
 *        a number already printed on a shelf label, and refusing
 *        that would send people back to spreadsheets.
 */
export async function generateSku(db, spec, manual) {
  if (manual) {
    const sku = normaliseCode(manual);
    if (!sku) {
      throw new ConflictError('A manual SKU must contain letters or digits.');
    }
    const taken = await db.product.findUnique({ where: { sku }, select: { id: true, name: true } });
    if (taken) {
      throw new ConflictError('SKU ' + sku + ' is already used by another product.', {
        sku, existingProductId: taken.id, existingProductName: taken.name,
      });
    }
    return sku;
  }

  const base = candidateSku(spec);

  /* Find the free suffix in ONE query rather than probing one at a
     time. Probing races: two callers both find -2 free, both try
     it, and one fails at the constraint. Reading every taken
     variant of this base at once and taking max + 1 narrows that
     window to almost nothing -- and the caller still retries, so
     when it does happen it costs an attempt rather than an error. */
  const taken = await db.product.findMany({
    where: { OR: [{ sku: base }, { sku: { startsWith: base + '-' } }] },
    select: { sku: true },
  });

  if (taken.length === 0) return base;

  let highest = 1;
  for (const row of taken) {
    if (row.sku === base) continue;
    const suffix = row.sku.slice(base.length + 1);
    // Only a plain number counts. KAJ-NEOSAP-GRE-MA-600X1200-GLOSS
    // is a different product that happens to share the prefix, not
    // the second of this one -- so it must not push the counter.
    if (/^\d+$/.test(suffix)) highest = Math.max(highest, Number(suffix));
  }
  return base + '-' + (highest + 1);
}

/**
 * Create a variant, retrying if another caller took the SKU first.
 *
 * This is the concurrency story. The unique constraint is the
 * arbiter; losing it is expected under load and is not an error
 * worth showing anybody, so the loser recomputes and tries again.
 * Bounded, because an unbounded retry on a genuine duplicate is an
 * infinite loop.
 */
export async function createWithSku(db, spec, manual, build, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sku = await generateSku(db, spec, manual);
    try {
      return await build(sku);
    } catch (err) {
      if (!isSkuClash(err) || manual || attempt === attempts) throw err;

      /* A SHORT, GROWING, JITTERED PAUSE before trying again.
         Ten callers that lost the same race and retry in the same
         instant simply lose it again: they all recompute the same
         next number and collide on that one too. Spreading them
         out is what turns a thundering herd into a queue. The
         jitter matters more than the delay -- without it the
         retries stay in lockstep however long the wait. */
      const backoff = attempt * 12 + Math.floor(Math.random() * 25);
      await new Promise((resolve) => { setTimeout(resolve, backoff); });
    }
  }
  throw new ConflictError('Could not allocate a unique SKU after ' + attempts + ' attempts.');
}

/**
 * Was this a collision on the SKU specifically?
 *
 * Prisma reports the offending columns in `meta.target` -- except
 * that with the pg driver adapter on Prisma 7 it arrives
 * undefined, so a check on `meta.target` alone silently matched
 * nothing and every retry was rethrown as a hard failure. Both
 * sources are read, and the message is the one that actually
 * carries it here.
 */
function isSkuClash(err) {
  if (err?.code !== 'P2002') return false;
  const target = err.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('sku') || /\bsku\b/i.test(String(err.message ?? ''));
}
