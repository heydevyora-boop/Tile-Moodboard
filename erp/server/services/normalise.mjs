/* ============================================================
   COMPARING NAMES THE WAY PEOPLE MEAN THEM
   ============================================================
   "Kajaria", "kajaria", "KAJARIA " and "Kajaria  Ceramics" are not
   four brands. The database enforces the first three with an
   expression index; this module is the same rule in JavaScript, so
   a service can CHECK before inserting and return a useful message
   instead of a constraint violation.

   The two must agree exactly, or the service says "fine" and the
   database says "no". The SQL is:
       lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
   ============================================================ */

/** Exactly what the database's unique index computes. */
export function normaliseName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A code: upper case, letters digits and hyphens only. */
export function normaliseCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

/**
 * How alike two names are, 0 to 1 — Dice coefficient over
 * character bigrams.
 *
 * Used ONLY to raise a near-match for a person to look at, never
 * to merge anything. "Neo Sapien" and "Neo Sapiens" score high and
 * probably are the same series; "Neo Sapien" and "Neo Classic"
 * score lower and probably are not. Neither judgement is the
 * software's to make, which is why this returns a number and the
 * caller returns candidates.
 */
export function similarity(a, b) {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };

  const ax = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const n of ax.values()) total += n;
  for (const [g, n] of by) { total += n; shared += Math.min(n, ax.get(g) || 0); }
  return (2 * shared) / total;
}

/** Above this, a name is close enough that a person should look. */
export const REVIEW_THRESHOLD = 0.82;
