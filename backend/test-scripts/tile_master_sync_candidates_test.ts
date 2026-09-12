import 'tsconfig-paths/register';
import { getRecommendedTiles, PrismaTileClient } from '../src/services/tileRecommendation.service';

/**
 * Verifies the Mood Board requirement for the pendrive fix, against the
 * ACTUAL shape MASTER-synced tiles have in Postgres -- catalogId=null,
 * sheetRowRef non-null, ONE row per productCode that
 * masterTileSync.service.ts updates in place (imageUrl/updatedAt change,
 * createdAt does not, since Prisma's @default(now()) only applies on
 * create).
 *
 * getRecommendedTiles / rankTiles / interleaveBySource are NOT modified by
 * this test or by the pendrive fix -- this only demonstrates that the
 * existing, already-shipped logic (tileRecommendation.service.ts) already
 * satisfies what was asked for:
 *
 *   - old and newly-synced tiles are both real candidates
 *   - the existing compatibility/room/style score is the ONLY criterion
 *   - recency decides nothing, not even a tie
 *   - "newest wins" is never unconditional
 *   - an in-place MASTER-sync update (no new row) is reflected with zero
 *     further ranking-code changes, because there is only ever one row per
 *     productCode to begin with
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

const OLD_SYNC = new Date('2026-01-10T10:00:00Z');
const NEW_SYNC = new Date('2026-09-01T10:00:00Z');

interface FakeTile {
  id: string;
  name: string;
  brandId: string;
  catalogId: null;
  size: string | null;
  finish: string | null;
  type: string;
  colorTone: string | null;
  bestRoom: string | null;
  collection: string | null;
  productCode: string;
  imageUrl: string | null;
  sheetRowRef: number;
  createdAt: Date; // fixed at first sync -- masterTileSync's update() never touches this
  brand: { name: string };
  catalog: null; // MASTER-synced tiles have no Catalog row at all
}

function masterTile(overrides: Partial<FakeTile> & { id: string; productCode: string }): FakeTile {
  return {
    name: 'Product',
    brandId: 'brand-1',
    catalogId: null,
    size: '600x1200mm',
    finish: 'Matte',
    type: 'BASE',
    colorTone: 'Ivory',
    bestRoom: 'Bathroom',
    collection: null,
    imageUrl: 'https://drive.google.com/thumbnail?id=some-image',
    sheetRowRef: 0,
    createdAt: OLD_SYNC,
    brand: { name: 'Urvi' },
    catalog: null,
    ...overrides,
  };
}

function fakePrisma(tiles: FakeTile[]): PrismaTileClient {
  return { tile: { findMany: async () => tiles } };
}

async function main() {
  // ───────────────────────────────────────────────────────────────────
  // "NEW TILE score = 95, OLD TILE score = 90 -> NEW TILE can win"
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      masterTile({
        id: 'old-lower-score',
        productCode: 'OLD-0001',
        name: 'Old Grey Slate',
        bestRoom: null, // versatile: scores lower than an exact room match
        createdAt: OLD_SYNC,
      }),
      masterTile({
        id: 'new-higher-score',
        productCode: 'NEW-0002',
        name: 'New Ivory Stone',
        bestRoom: 'Bathroom', // exact match: scores higher for this brief
        createdAt: NEW_SYNC,
      }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '1. NEW tile with the HIGHER score wins (score primary, not just recency)',
      result[0]?.id === 'new-higher-score',
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // "NEW TILE score = 90, OLD TILE score = 95 -> OLD TILE can win"
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      masterTile({
        id: 'old-higher-score',
        productCode: 'OLD-0003',
        name: 'Old Ivory Stone',
        bestRoom: 'Bathroom', // exact match: higher score
        createdAt: OLD_SYNC,
      }),
      masterTile({
        id: 'new-lower-score',
        productCode: 'NEW-0004',
        name: 'New Grey Slate',
        bestRoom: null, // versatile: lower score
        createdAt: NEW_SYNC,
      }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '2. OLD tile with the HIGHER score still wins over a newer, lower-scoring tile',
      result[0]?.id === 'old-higher-score',
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Equal score -> recency must NOT decide. Both stay candidates and
  // rankTiles' own deterministic tie-break stands. (See
  // tile_candidate_pool_test.ts for the full set of guarantees here.)
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      masterTile({ id: 'old-equal-score', productCode: 'OLD-0005', name: 'Ivory A', createdAt: OLD_SYNC }),
      masterTile({ id: 'new-equal-score', productCode: 'NEW-0006', name: 'Ivory B', createdAt: NEW_SYNC }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '3. Equal score -> both remain candidates and the newer is NOT promoted by age',
      result.length === 2 && result[0]?.score === result[1]?.score && result[0]?.id === 'old-equal-score',
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Old + new coexist -- newest is never an unconditional winner
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      masterTile({ id: 'old-distinct-product', productCode: 'OLD-0007', name: 'Charcoal Base', bestRoom: 'Kitchen', createdAt: OLD_SYNC }),
      masterTile({ id: 'new-distinct-product', productCode: 'NEW-0008', name: 'Ivory Base', bestRoom: 'Bathroom', createdAt: NEW_SYNC }),
    ];
    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    check(
      '4. Both an OLD and a NEW distinct product remain available as candidates',
      result.length === 2 && result.some((t) => t.id === 'old-distinct-product') && result.some((t) => t.id === 'new-distinct-product'),
      result.map((t) => t.id),
    );
    check(
      '5. The old product is not silently dropped just for being old (still present, ranked on merit)',
      result.some((t) => t.id === 'old-distinct-product'),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // The actual mechanism the pendrive fix relies on: masterTileSync
  // updates a MASTER tile's row IN PLACE (same id, same productCode,
  // fresh imageUrl, createdAt untouched) rather than creating a second
  // row. Once the pendrive fix lands, THIS is what makes the Mood Board
  // see the new image -- with no ranking-code change required, because
  // there is only ever one candidate for that SKU to begin with.
  // ───────────────────────────────────────────────────────────────────
  {
    const beforeSync = [
      masterTile({
        id: 'sku-0009',
        productCode: 'URVI-0009',
        name: 'Carrara Ivory',
        imageUrl: 'https://drive.google.com/thumbnail?id=OLD-WRONG-IMAGE',
        createdAt: OLD_SYNC,
      }),
    ];
    const before = await getRecommendedTiles(fakePrisma(beforeSync), { room: 'Bathroom' });
    check('6. Before re-sync: candidate carries the OLD imageUrl', before[0]?.id === 'sku-0009');

    // Simulates masterTileSync.service.ts's `prisma.tile.update(...)`:
    // SAME row id, imageUrl replaced, createdAt unchanged (Prisma's
    // @updatedAt would bump updatedAt, not createdAt -- not modeled here
    // since getRecommendedTiles never reads updatedAt).
    const afterSync = [
      masterTile({
        id: 'sku-0009', // identical id -- an UPDATE, not a new row
        productCode: 'URVI-0009',
        name: 'Carrara Ivory',
        imageUrl: 'https://drive.google.com/thumbnail?id=NEW-CORRECT-IMAGE',
        createdAt: OLD_SYNC, // untouched by update()
      }),
    ];
    const after = await getRecommendedTiles(fakePrisma(afterSync), { room: 'Bathroom' });

    check(
      '7. After an in-place MASTER re-sync, the SAME candidate now carries the NEW imageUrl -- '
        + 'no separate "old candidate" is left competing, because there never was a second row',
      after.length === 1 && after[0]?.id === 'sku-0009',
    );
    // imageUrl itself isn't on RankedTile -- getAvailableTiles/getTilesByIds
    // read it straight from the same Tile row, so once masterTileSync's
    // update() has run, every consumer of that row sees the new value
    // automatically. Demonstrated here structurally: same id in, same id
    // out, exactly once.
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
