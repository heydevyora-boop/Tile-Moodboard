import 'tsconfig-paths/register';
import { getRecommendedTiles, PrismaTileClient } from '../src/services/tileRecommendation.service';

/**
 * Candidate-pool regression tests for Mood Board generation.
 *
 * THE REQUIREMENT these pin down: every valid stored tile -- from an older
 * extraction or a newly extracted catalog, including several extractions of
 * the SAME product whose images differ -- is a candidate, and the EXISTING
 * room/style/colour/type scoring alone decides which one belongs in a
 * board. A newer extraction is never automatically preferred; an older tile
 * is never displaced merely for being older.
 *
 * WHAT THIS REPLACES: an earlier version of getRecommendedTiles collapsed
 * repeat extractions of one product to a single "current" copy (chosen by
 * extraction recency) BEFORE ranking, and re-sorted ties newest-first.
 * Both removed the age-based preference this file now guards against:
 * test 1 below is the exact case that logic broke -- two rows of one SKU,
 * identical scores, one silently dropped before scoring ever ran.
 *
 * rankTiles(), interleaveBySource(), the WHERE filters and the pool limit
 * are NOT modified by that fix or by these tests -- tests 6-9 assert they
 * still behave exactly as before.
 */

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra, null, 2) : '');
    fail++;
  }
}

const OLD_EXTRACTION = new Date('2026-01-10T10:00:00Z');
const NEW_EXTRACTION = new Date('2026-09-01T10:00:00Z');

interface FakeTile {
  id: string;
  name: string;
  brandId: string;
  catalogId: string | null;
  size: string | null;
  finish: string | null;
  type: string;
  colorTone: string | null;
  bestRoom: string | null;
  collection: string | null;
  productCode: string | null;
  imageUrl: string | null;
  sheetRowRef: number | null;
  createdAt: Date;
  brand: { name: string };
}

function tile(overrides: Partial<FakeTile> & { id: string }): FakeTile {
  return {
    name: 'Carrara Ivory',
    brandId: 'brand-1',
    catalogId: null,
    size: '600x1200mm',
    finish: 'Matte',
    type: 'BASE',
    colorTone: 'Ivory',
    bestRoom: 'Bathroom',
    collection: null,
    productCode: 'URVI-0008',
    imageUrl: 'https://drive.google.com/thumbnail?id=an-image',
    sheetRowRef: 0,
    createdAt: OLD_EXTRACTION,
    brand: { name: 'Urvi' },
    ...overrides,
  };
}

function fakePrisma(tiles: FakeTile[]): PrismaTileClient {
  return { tile: { findMany: async () => tiles } };
}

async function main() {
  // ───────────────────────────────────────────────────────────────────
  // Both extraction records participate
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({ id: 'row-old', imageUrl: 'https://drive.google.com/thumbnail?id=OLD', createdAt: OLD_EXTRACTION }),
      tile({ id: 'row-new', imageUrl: 'https://drive.google.com/thumbnail?id=NEW', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '1. Same SKU from an older AND a newer extraction: BOTH remain candidates',
      result.length === 2 && result.some((t) => t.id === 'row-old') && result.some((t) => t.id === 'row-new'),
      result.map((t) => t.id),
    );
    // Neither row is dropped on an age rule, AND neither is promoted on
    // one. A bounded recency preference lived here for a while, to stop
    // a freshly extracted catalog losing every board; it over-corrected,
    // so old and new now score on fit alone and tie when they match the
    // brief equally.
    check(
      '2. Neither row was dropped on an age rule, and both stay candidates',
      result.length === 2 &&
        result.some((t) => t.id === 'row-old') &&
        result.some((t) => t.id === 'row-new'),
      result.map((t) => ({ id: t.id, score: t.score })),
    );
    check(
      '2b. Equal merit scores equally -- age buys no points either way',
      result[0].score === result[1].score,
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  {
    // Same product, but the newer copy has no image yet. The older copy
    // must NOT be hidden, and the newer must NOT be dropped -- both are
    // real stored rows and both stay eligible.
    const tiles = [
      tile({ id: 'old-with-image', imageUrl: 'https://drive.google.com/thumbnail?id=OLD', createdAt: OLD_EXTRACTION }),
      tile({ id: 'new-without-image', imageUrl: null, createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '3. A newer image-less copy neither hides nor is hidden by an older one -- both eligible',
      result.length === 2,
      result.map((t) => t.id),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Score is the only thing that decides
  // ───────────────────────────────────────────────────────────────────
  {
    // NEW tile is the better match for this brief; it must be able to win.
    const tiles = [
      tile({ id: 'old-poor-match', productCode: 'OLD-1', name: 'Old Charcoal', bestRoom: 'Kitchen', colorTone: 'Black', createdAt: OLD_EXTRACTION }),
      tile({ id: 'new-great-match', productCode: 'NEW-1', name: 'New Ivory', bestRoom: 'Bathroom', colorTone: 'Ivory', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom', colorTone: 'Ivory' });
    check(
      '4. A suitable NEW tile beats an unsuitable OLD tile (on score, not age)',
      result[0]?.id === 'new-great-match' && result[0].score > result[1].score,
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  {
    // OLD tile is the better match; being older must not cost it the win.
    const tiles = [
      tile({ id: 'old-great-match', productCode: 'OLD-2', name: 'Old Ivory', bestRoom: 'Bathroom', colorTone: 'Ivory', createdAt: OLD_EXTRACTION }),
      tile({ id: 'new-poor-match', productCode: 'NEW-2', name: 'New Charcoal', bestRoom: 'Kitchen', colorTone: 'Black', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom', colorTone: 'Ivory' });
    check(
      '5. A suitable OLD tile still beats an unsuitable NEW tile',
      result[0]?.id === 'old-great-match' && result[0].score > result[1].score,
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  {
    // Equally suitable, and the OLDER tile sorts first alphabetically.
    // Nothing about being newly extracted may displace it: both are
    // candidates, both score the same, and the ordinary tie-break -- not
    // the extraction date -- decides which reads first.
    const tiles = [
      tile({ id: 'old-alpha-first', productCode: 'OLD-3', name: 'Aaa Old Tile', createdAt: OLD_EXTRACTION }),
      tile({ id: 'new-alpha-last', productCode: 'NEW-3', name: 'Zzz New Tile', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '6. Equally suitable: both are candidates and neither is promoted by age',
      result.length === 2 &&
        result.some((t) => t.id === 'old-alpha-first') &&
        result.some((t) => t.id === 'new-alpha-last') &&
        result[0].score === result[1].score,
      result.map((t) => ({ id: t.id, name: t.name, score: t.score })),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Existing behaviour that must be untouched
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({ id: 'exact-room', productCode: 'A-1', name: 'Exact', bestRoom: 'Bathroom', createdAt: OLD_EXTRACTION }),
      tile({ id: 'versatile', productCode: 'A-2', name: 'Versatile', bestRoom: null, createdAt: NEW_EXTRACTION }),
      tile({ id: 'wrong-room', productCode: 'A-3', name: 'Wrong', bestRoom: 'Kitchen', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    const order = result.map((t) => t.id);
    check(
      '7. Room scoring preserved: exact > versatile > wrong-room, regardless of age',
      order[0] === 'exact-room' && order[1] === 'versatile' && order[2] === 'wrong-room',
      result.map((t) => ({ id: t.id, score: t.score })),
    );
    check('8. A wrong-room tile is ranked lower but NOT filtered out', result.length === 3);
  }

  {
    // Source diversity + pool limit untouched: a brand-new catalog still
    // gets its best tile into the pool alongside large older catalogs.
    const tiles: FakeTile[] = [];
    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < 40; i += 1) {
        tiles.push(tile({
          id: `old-c${c}-${i}`, productCode: `OLDCAT${c}-${String(i).padStart(4, '0')}`,
          name: `Old ${c}-${i}`, createdAt: OLD_EXTRACTION,
        }));
      }
    }
    tiles.push(tile({ id: 'new-1', productCode: 'NEWCAT-0001', name: 'New One', createdAt: NEW_EXTRACTION }));
    tiles.push(tile({ id: 'new-2', productCode: 'NEWCAT-0002', name: 'New Two', createdAt: NEW_EXTRACTION }));

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom', limit: 80 });
    const newInPool = result.filter((t) => t.id.startsWith('new-'));

    check('9. Pool limit still respected exactly', result.length === 80, result.length);
    check(
      '10. A small NEW catalog is still represented alongside large older ones (diversity intact)',
      newInPool.length > 0,
      newInPool.map((t) => t.id),
    );
    check(
      '11. Older catalogs are not displaced wholesale by the new one',
      result.filter((t) => t.id.startsWith('old-')).length > 0,
    );
  }

  {
    const tiles = [
      tile({ id: 'no-code-a', productCode: null, name: 'Brillo Slab', size: '800x2400mm', createdAt: OLD_EXTRACTION }),
      tile({ id: 'no-code-b', productCode: null, name: 'Brillo Slab', size: '800x2400mm', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '12. Two code-less rows with the same name+size BOTH stay candidates (no name-based collapsing)',
      result.length === 2,
      result.map((t) => t.id),
    );
  }

  {
    const result = await getRecommendedTiles(fakePrisma([]), { room: 'Bathroom' });
    check('13. Empty catalog returns an empty pool without crashing', result.length === 0);
  }

  {
    // Metadata passes through from each row untouched.
    const tiles = [
      tile({ id: 'meta', productCode: 'URVI-0008', size: '600x1200mm', finish: 'Matte', createdAt: NEW_EXTRACTION }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    const winner = result[0];
    check('14. SKU preserved', winner?.productCode === 'URVI-0008', winner);
    check('15. Size preserved', winner?.size === '600x1200mm', winner);
    check('16. Finish preserved', winner?.finish === 'Matte', winner);
    check('17. Brand preserved', winner?.brandName === 'Urvi', winner);
    check('18. catalogGroup still populated (source-diversity metadata intact)',
      typeof winner?.catalogGroup === 'string' && winner.catalogGroup.length > 0, winner);
  }

  // ── the same catalog must not always yield the same pool ──────────
  //
  // The tie-break was the tile's NAME, so one catalog and one brief gave
  // byte-identical candidates in byte-identical order on every
  // generation -- the model saw the same products every time and picked
  // the same ones. A catalog of four hundred behaved like a catalog of
  // eighty.
  {
    // Forty tiles that all score the same: nothing but the tie-break can
    // separate them, which is exactly the case that was frozen.
    const equal = Array.from({ length: 40 }, (_, i) => tile({
      id: `equal-${String(i).padStart(2, '0')}`,
      name: `Tile ${String.fromCharCode(65 + (i % 26))}${i}`,
      productCode: `EQ-${i}`,
      catalogId: 'cat-1',
    }));

    const draw = async (seed?: number) =>
      (await getRecommendedTiles(fakePrisma(equal), { room: 'Bathroom', limit: 10, varietySeed: seed }))
        .map((t) => t.id).join(',');

    const noSeedA = await draw();
    const noSeedB = await draw();
    check('30. With no seed the order is unchanged, exactly as before', noSeedA === noSeedB, noSeedA);

    const seeded = await Promise.all([1, 2, 3, 4, 5].map((n) => draw(n * 7919)));
    check('31. Different seeds draw different tiles from the same catalog',
      new Set(seeded).size >= 4, seeded.map((s) => s.slice(0, 40)));
    check('32. The same seed always draws the same tiles',
      (await draw(12345)) === (await draw(12345)));

    // Across a handful of generations, far more of the catalog is seen
    // than the pool limit -- which is the whole complaint.
    const seen = new Set<string>();
    for (let n = 0; n < 8; n += 1) {
      (await draw(n * 104729)).split(',').forEach((id) => seen.add(id));
    }
    check('33. Eight generations reach well past the pool limit of 10',
      seen.size >= 25, `${seen.size} of 40 tiles seen`);

    // ...and score still decides. A better tile must never be displaced.
    // One tile that scores HIGHER (its colour matches the brief's) and
    // sorts LAST alphabetically -- so only its score can keep it in.
    const withBest = [
      tile({ id: 'best', name: 'Zzz Last Alphabetically', colorTone: 'Ivory', catalogId: 'cat-1' }),
      ...equal.map((t) => ({ ...t, colorTone: 'Charcoal' })),
    ];
    for (let n = 0; n < 6; n += 1) {
      const pool = await getRecommendedTiles(fakePrisma(withBest), {
        room: 'Bathroom', colorTone: 'Ivory', limit: 5, varietySeed: n * 31337,
      });
      if (!pool.some((t) => t.id === 'best')) {
        check('34. The best-scoring tile is never dropped by the shuffle', false, { seed: n, pool: pool.map((t) => t.id) });
        break;
      }
      if (n === 5) check('34. The best-scoring tile is never dropped by the shuffle', true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
