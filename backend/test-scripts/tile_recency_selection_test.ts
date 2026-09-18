/**
 * Regression: a newly extracted catalog must be able to win a board.
 *
 * THE FAILURE THIS COVERS
 * -----------------------
 * A new catalog was extracted, its products were visible in Saved
 * Catalog, and every generated mood board still came back built from the
 * older products.
 *
 * It was not a filter, a cache or a stale fetch. Measured against the
 * real scorer, with the pool the real query returns:
 *
 *     an established, fully tagged tile   scores 72
 *     a freshly extracted tile            scores 10
 *
 * The gap is metadata, not recency. masterTileSync writes what the
 * extraction pipeline sends -- product code, image, collection -- so a
 * new tile arrives with no bestRoom, no colorTone, no finish and no
 * size. scoreRoom gives it the +8 "versatile" credit instead of a +40
 * exact-room match and the rest give it nothing, so it sorted below
 * everything that was already there, every time.
 *
 * Two things now hold, and the second is the one that keeps this honest:
 *
 *   1. a tile from the latest extraction is PREFERRED over an equally
 *      suitable older one, and
 *   2. it does NOT displace an older tile that is a genuinely better
 *      match -- "prefer the latest" must not become "always replace".
 *
 * Run:  npx ts-node -r tsconfig-paths/register \
 *         test-scripts/tile_recency_selection_test.ts
 */

import { rankTiles, extractionTime } from '../src/services/tileRecommendation.service';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000);

const results: Array<[string, boolean, string]> = [];
function check(label: string, ok: boolean, detail = '') {
  results.push([label, Boolean(ok), detail]);
}

type T = Parameters<typeof rankTiles>[0][number];

/** An older tile, tagged the way established rows are. */
const old = (id: string, over: Partial<T> = {}): T => ({
  id,
  name: id,
  brandName: 'B',
  size: '600x1200',
  finish: 'MATTE',
  type: 'BASE',
  colorTone: 'BEIGE',
  bestRoom: 'BATHROOM',
  productCode: id,
  createdAt: hoursAgo(1000),
  updatedAt: hoursAgo(1000),
  ...over,
});

/** A tile from the latest extraction, with the same tags for a fair test. */
const fresh = (id: string, over: Partial<T> = {}): T => ({
  ...old(id),
  createdAt: hoursAgo(1),
  updatedAt: hoursAgo(1),
  ...over,
});

const BRIEF = { room: 'BATHROOM', style: 'MODERN', colorTone: 'BEIGE' };

function main() {
  // ------------------------------------------------------------------
  // THE USER'S TEST CASE. Equally suitable old and new products; the
  // latest must be selectable and preferred for every role.
  // ------------------------------------------------------------------
  const roles = ['BASE', 'HIGHLIGHT', 'ACCENT'];

  for (const role of roles) {
    const ranked = rankTiles(
      [old(`OLD-${role}`, { type: role }), fresh(`NEW-${role}`, { type: role })],
      BRIEF,
    );
    check(
      `${role}: the latest extraction outranks an equally suitable older tile`,
      ranked[0].id === `NEW-${role}`,
      `${ranked[0].id} won (${ranked[0].score} vs ${ranked[1].score})`,
    );
  }

  const full = rankTiles(
    roles.flatMap((r) => [old(`OLD-${r}`, { type: r }), fresh(`NEW-${r}`, { type: r })]),
    BRIEF,
  );
  check(
    'all three latest products lead their roles (BASE B + HIGHLIGHT B + ACCENT B)',
    roles.every((r) => {
      const forRole = full.filter((t) => t.type === r);
      return forRole[0].id === `NEW-${r}`;
    }),
    full.map((t) => t.id).join(', '),
  );

  // ------------------------------------------------------------------
  // ...and the older products are still THERE. Preferring the latest
  // must not remove anything from the pool.
  // ------------------------------------------------------------------
  check(
    'every older product is still a candidate',
    roles.every((r) => full.some((t) => t.id === `OLD-${r}`)),
    `${full.length} candidates`,
  );

  // ------------------------------------------------------------------
  // THE OTHER HALF. A better older match must still win, or this has
  // become "always replace the old with the new".
  // ------------------------------------------------------------------
  const betterOld = rankTiles(
    [
      old('OLD-EXACT'),                                   // exact room + colour
      fresh('NEW-WRONG-ROOM', { bestRoom: 'KITCHEN', colorTone: 'CHARCOAL' }),
    ],
    BRIEF,
  );
  check(
    'a genuinely better older match still beats a newer mismatch',
    betterOld[0].id === 'OLD-EXACT',
    `${betterOld[0].id} won (${betterOld[0].score} vs ${betterOld[1].score})`,
  );

  const untagged = rankTiles(
    [
      old('OLD-EXACT'),
      fresh('NEW-UNTAGGED', { bestRoom: null, colorTone: null, finish: null, size: null }),
    ],
    BRIEF,
  );
  check(
    'recency alone does not lift an untagged new tile over a tagged old one',
    untagged[0].id === 'OLD-EXACT',
    `${untagged[0].id} won (${untagged[0].score} vs ${untagged[1].score})`,
  );

  // ------------------------------------------------------------------
  // MIXED BOARDS must remain reachable -- the user's second case.
  // ------------------------------------------------------------------
  const mixed = rankTiles(
    [
      old('OLD-BASE', { type: 'BASE' }),
      fresh('NEW-BASE', { type: 'BASE' }),
      old('OLD-HL', { type: 'HIGHLIGHT' }),
      // The new highlight is a poor match; the OLD one should lead here.
      fresh('NEW-HL', { type: 'HIGHLIGHT', bestRoom: 'KITCHEN', colorTone: 'CHARCOAL' }),
      old('OLD-AC', { type: 'ACCENT' }),
      fresh('NEW-AC', { type: 'ACCENT' }),
    ],
    BRIEF,
  );
  const leaderFor = (t: string) => mixed.filter((x) => x.type === t)[0].id;
  check(
    'a mixed board is reachable (BASE new + HIGHLIGHT old + ACCENT new)',
    leaderFor('BASE') === 'NEW-BASE' &&
      leaderFor('HIGHLIGHT') === 'OLD-HL' &&
      leaderFor('ACCENT') === 'NEW-AC',
    `${leaderFor('BASE')} / ${leaderFor('HIGHLIGHT')} / ${leaderFor('ACCENT')}`,
  );

  // ------------------------------------------------------------------
  // "Latest" must come from timestamps, never from anything that merely
  // looks like an order.
  // ------------------------------------------------------------------
  const reordered = rankTiles([fresh('NEW-X'), old('OLD-X')], BRIEF);
  const reversed = rankTiles([old('OLD-X'), fresh('NEW-X')], BRIEF);
  check(
    'array order does not decide which tile is latest',
    reordered[0].id === reversed[0].id && reordered[0].id === 'NEW-X',
  );

  const noStamps = rankTiles(
    [
      { ...old('A'), createdAt: null, updatedAt: null },
      { ...old('B'), createdAt: null, updatedAt: null },
    ],
    BRIEF,
  );
  check(
    'tiles with no timestamps rank by merit alone, with no recency credit',
    noStamps.every((t) => !t.matchReasons.includes('From the latest extraction')),
  );

  check(
    'extractionTime prefers the later of createdAt/updatedAt',
    extractionTime({
      ...old('C'),
      createdAt: hoursAgo(500),
      updatedAt: hoursAgo(2),
    }) === hoursAgo(2).getTime(),
  );

  // A whole batch written over several minutes counts as one extraction.
  const batch = rankTiles(
    [
      fresh('NEW-FIRST', { createdAt: hoursAgo(1.2), updatedAt: hoursAgo(1.2) }),
      fresh('NEW-LAST', { createdAt: hoursAgo(1), updatedAt: hoursAgo(1) }),
      old('OLD-ONE'),
    ],
    BRIEF,
  );
  check(
    'a whole extraction batch is treated as "latest", not just its last row',
    batch
      .filter((t) => t.id.startsWith('NEW-'))
      .every((t) => t.matchReasons.includes('From the latest extraction')),
    batch.map((t) => `${t.id}:${t.score}`).join(', '),
  );

  let failures = 0;
  for (const [label, ok, detail] of results) {
    if (ok) console.log(`  PASS  ${label}`);
    else {
      failures += 1;
      console.log(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
    }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
