import 'tsconfig-paths/register';
import { getRecommendedTiles, PrismaTileClient } from '../src/services/tileRecommendation.service';

/**
 * Regression tests for extraction-recency priority in the Mood Board
 * candidate pool (getRecommendedTiles).
 *
 * THE BUG: re-running the catalog extractor inserts a NEW Tile row per
 * product instead of updating the previous run's row, so one physical
 * product exists once per extraction it has appeared in. Nothing
 * distinguished those copies, so which one reached the prompt came down to
 * rankTiles' alphabetical tie-break -- and two rows of the same product
 * have the SAME name, making the winner arbitrary. A freshly extracted
 * product kept being represented by an older row (and an older image).
 *
 * Prisma is faked here: these assert the selection/priority logic, not the
 * database. Dates are fixed so ordering is deterministic.
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
  createdAt: Date;
  brand: { name: string };
  catalog: { completedAt: Date | null; createdAt: Date } | null;
}

function tile(overrides: Partial<FakeTile> & { id: string }): FakeTile {
  return {
    name: 'Carrara Ivory',
    brandId: 'brand-1',
    catalogId: 'catalog-old',
    size: '600x1200mm',
    finish: 'Matte',
    type: 'BASE',
    colorTone: 'Ivory',
    bestRoom: 'Bathroom',
    collection: null,
    productCode: 'URVI-0008',
    imageUrl: 'https://drive.google.com/thumbnail?id=old-image',
    createdAt: OLD_EXTRACTION,
    brand: { name: 'Urvi' },
    catalog: { completedAt: OLD_EXTRACTION, createdAt: OLD_EXTRACTION },
    ...overrides,
  };
}

function fakePrisma(tiles: FakeTile[]): PrismaTileClient {
  return { tile: { findMany: async () => tiles } };
}

async function main() {
  // ───────────────────────────────────────────────────────────────────
  // The reported case: same SKU extracted twice, new run must win
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({ id: 'old-row', imageUrl: 'https://drive.google.com/thumbnail?id=OLD' }),
      tile({
        id: 'new-row',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
        imageUrl: 'https://drive.google.com/thumbnail?id=NEW',
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check('1. The same product extracted twice appears only ONCE in the pool', result.length === 1, result.map((t) => t.id));
    check('2. The NEWLY extracted row wins, not the older stored one', result[0]?.id === 'new-row', result.map((t) => t.id));
  }

  // ───────────────────────────────────────────────────────────────────
  // Older row remains a genuine fallback
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({ id: 'old-row-with-image', imageUrl: 'https://drive.google.com/thumbnail?id=OLD' }),
      tile({
        id: 'new-row-no-image',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
        imageUrl: null,
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '3. A newer copy with NO image does not hide an older copy that has one',
      result.length === 1 && result[0]?.id === 'old-row-with-image',
      result.map((t) => t.id),
    );
  }

  {
    const tiles = [
      tile({ id: 'only-old-row', imageUrl: 'https://drive.google.com/thumbnail?id=OLD' }),
      tile({
        id: 'different-product-new',
        productCode: 'URVI-9999',
        name: 'Rose Quartz Listello',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '4. A product with no newer extraction is still kept (old data is a fallback, not deleted)',
      result.some((t) => t.id === 'only-old-row'),
      result.map((t) => t.id),
    );
    check('5. Distinct products are never collapsed together', result.length === 2, result.map((t) => t.id));
  }

  // ───────────────────────────────────────────────────────────────────
  // Recency only breaks TIES -- compatibility scoring still leads
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({
        id: 'new-but-wrong-room',
        productCode: 'URVI-1111',
        name: 'Black Granite',
        bestRoom: 'Kitchen',
        colorTone: 'Black',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
      }),
      tile({ id: 'old-but-exact-room', productCode: 'URVI-2222', name: 'Ivory Stone', bestRoom: 'Bathroom' }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '6. An exact room match still outranks a newer tile for the wrong room (scoring preserved)',
      result[0]?.id === 'old-but-exact-room',
      result.map((t) => ({ id: t.id, score: t.score })),
    );
  }

  {
    // Identical attributes => identical score => previously resolved
    // alphabetically ("Aaa..." beat "Zzz..."). Recency must decide now.
    const tiles = [
      tile({ id: 'old-alphabetically-first', productCode: 'URVI-3333', name: 'Aaa Old Tile' }),
      tile({
        id: 'new-alphabetically-last',
        productCode: 'URVI-4444',
        name: 'Zzz New Tile',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '7. Among equally-scored tiles the newer extraction now leads (was alphabetical)',
      result[0]?.id === 'new-alphabetically-last',
      result.map((t) => ({ id: t.id, name: t.name, score: t.score })),
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Metadata and existing behaviour preserved
  // ───────────────────────────────────────────────────────────────────
  {
    const tiles = [
      tile({ id: 'old-row', productCode: 'URVI-0008', size: '300x300mm', finish: 'Glossy' }),
      tile({
        id: 'new-row',
        productCode: 'URVI-0008',
        size: '600x1200mm',
        finish: 'Matte',
        colorTone: 'Ivory',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });
    const winner = result[0];

    check('8. The winning row carries its OWN metadata (SKU preserved)', winner?.productCode === 'URVI-0008', winner);
    check('9. Dimensions come from the winning (new) extraction', winner?.size === '600x1200mm', winner);
    check('10. Finish comes from the winning (new) extraction', winner?.finish === 'Matte', winner);
    check('11. Brand is preserved', winner?.brandName === 'Urvi', winner);
    check('12. catalogGroup is still populated (source-diversity logic intact)', typeof winner?.catalogGroup === 'string' && winner.catalogGroup.length > 0, winner);
  }

  {
    // MASTER-sheet tiles have no Catalog row at all -- must not crash and
    // must still be selectable.
    const tiles = [
      tile({ id: 'master-tile', catalogId: null, catalog: null, productCode: 'URVI-5555', createdAt: NEW_EXTRACTION }),
      tile({ id: 'catalog-tile', productCode: 'URVI-6666' }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check('13. Tiles with no Catalog row (MASTER sync) still rank without crashing', result.length === 2, result.map((t) => t.id));
    check('14. A MASTER tile created later still sorts ahead on recency', result[0]?.id === 'master-tile', result.map((t) => t.id));
  }

  {
    const result = await getRecommendedTiles(fakePrisma([]), { room: 'Bathroom' });
    check('15. Empty catalog returns an empty pool without crashing', result.length === 0);
  }

  {
    // No productCode (extractor could not read one): identity falls back to
    // name+size, so two extractions of the same product still collapse.
    const tiles = [
      tile({ id: 'old-no-code', productCode: null, name: 'Brillo Slab', size: '800x2400mm' }),
      tile({
        id: 'new-no-code',
        productCode: null,
        name: 'Brillo Slab',
        size: '800x2400mm',
        catalogId: 'catalog-new',
        createdAt: NEW_EXTRACTION,
        catalog: { completedAt: NEW_EXTRACTION, createdAt: NEW_EXTRACTION },
      }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check(
      '16. Products without a SKU still de-duplicate by name+size, newest winning',
      result.length === 1 && result[0]?.id === 'new-no-code',
      result.map((t) => t.id),
    );
  }

  {
    // Same name, DIFFERENT size => genuinely different products.
    const tiles = [
      tile({ id: 'size-a', productCode: null, name: 'Brillo Slab', size: '800x2400mm' }),
      tile({ id: 'size-b', productCode: null, name: 'Brillo Slab', size: '600x1200mm' }),
    ];

    const result = await getRecommendedTiles(fakePrisma(tiles), { room: 'Bathroom' });

    check('17. Same name but different size stays two distinct products', result.length === 2, result.map((t) => t.id));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
