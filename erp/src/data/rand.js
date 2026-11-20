/* ============================================================
   A DETERMINISTIC LITTLE RANDOM
   ============================================================
   Demo data has to be the SAME on every reload. A reviewer who
   reports "the dashboard says 412 low-stock items" must still see
   412 when they reopen the page, and a screenshot taken today must
   match the screen tomorrow. Math.random() would make every number
   in this prototype unquotable.

   mulberry32: a small, well-known 32-bit PRNG. Same seed, same
   sequence, in every browser.
   ============================================================ */

export function seeded(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** A float in [0, 1). */
    next,
    /** An integer in [lo, hi], inclusive at both ends. */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** One item from a list. */
    pick: (list) => list[Math.floor(next() * list.length)],
    /** True with the given probability. */
    chance: (p) => next() < p,
  };
}
