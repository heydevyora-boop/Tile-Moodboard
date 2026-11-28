/**
 * BACKFILLING THE CATALOG HIERARCHY — Tile.collection (free text) and
 * ungrouped Tile rows -> real Collection and Product entities.
 *
 * Every Tile created before this stage has productId = null and only a
 * free-text `collection` label (or none at all). This script:
 *
 *   1. Resolves each distinct (brandId, normalized collection name) into
 *      a real Collection row -- creating it if none exists yet, REUSING
 *      it if one already does. Never merges across brands: the grouping
 *      key always includes brandId, so "Classic" under Kajaria and
 *      "Classic" under Somany stay two different Collections.
 *   2. Within each resolved Collection, groups Tiles that share an exact
 *      normalized name into one proposed Product, with every matching
 *      Tile becoming one of its variants (productId set, nothing else
 *      about the Tile touched).
 *   3. Flags, for manual review rather than auto-deciding:
 *        - near-duplicate product names within the same brand+collection
 *          (likely one product misspelled twice, or two that are not
 *          actually the same -- a person decides, not this script);
 *        - Tiles with no collection at all (nothing to group into a
 *          Product without first knowing which collection they belong to).
 *
 * DRY RUN BY DEFAULT. Pass --apply to actually write. Without it this
 * only prints the report: how many Collections/Products would be
 * created, how many Tiles would be linked, and every group left for a
 * person to resolve first -- exactly the discipline the ERP's own
 * backfill-product-lines.mjs uses for the same kind of decision.
 *
 * Never deletes or recreates a Tile row. Never guesses a company (every
 * Tile already carries a required brandId). Never writes anything
 * outside collections/products/tiles.productId.
 *
 *   node scripts/backfill-catalog-hierarchy.js              # report only
 *   node scripts/backfill-catalog-hierarchy.js --apply       # write it
 *
 * Requires DATABASE_URL (and the other env vars the server itself
 * requires) to already be set in the environment -- this script does
 * not choose which database it runs against. Run it against an
 * isolated test database unless a real, approved migration window says
 * otherwise.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

require('tsconfig-paths/register');
require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

const { prisma } = require(path.join(ROOT, 'src/db/connection'));

const APPLY = process.argv.includes('--apply');

/** Trim + collapse whitespace + lowercase -- the same fold a unique
 * index on (brandId, name) would use. Deliberately NOT fuzzy: this is
 * for deciding "is this the same collection/product", not for display. */
function normalize(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Plain Levenshtein distance, turned into a 0..1 similarity score.
 * Only used to FLAG near-duplicates for a person to look at -- never to
 * merge or create anything on its own. */
function similarity(a, b) {
  const s1 = normalize(a);
  const s2 = normalize(b);
  if (s1 === s2) return 1;
  const m = s1.length;
  const n = s2.length;
  if (m === 0 || n === 0) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = s1[i - 1] === s2[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const distance = dp[m][n];
  return 1 - distance / Math.max(m, n);
}

const REVIEW_THRESHOLD = 0.82;

async function main() {
  const dbUrl = process.env.DATABASE_URL || '';
  console.log('Target database (from DATABASE_URL): ' + dbUrl.replace(/:[^:@]*@/, ':***@'));
  console.log(APPLY ? 'MODE: APPLY -- this will write.' : 'MODE: DRY RUN -- no writes, --apply to write.\n');

  // ---- 1. Baseline counts, exactly as Section 3 of the brief asks ----
  const [brandCount, tileCount, existingCollectionCount, existingProductCount] = await Promise.all([
    prisma.brand.count(),
    prisma.tile.count(),
    prisma.collection.count(),
    prisma.product.count(),
  ]);
  const distinctCollectionLabels = await prisma.tile.groupBy({
    by: ['brandId', 'collection'],
    where: { collection: { not: null } },
  });
  const tilesWithNoCollection = await prisma.tile.count({ where: { collection: null } });
  const alreadyLinkedTiles = await prisma.tile.count({ where: { productId: { not: null } } });

  console.log('BASELINE:');
  console.log('  brands (companies):            ' + brandCount);
  console.log('  tiles (variants) total:         ' + tileCount);
  console.log('  tiles already linked to a product: ' + alreadyLinkedTiles);
  console.log('  tiles with NO collection label:  ' + tilesWithNoCollection);
  console.log('  distinct (brand, collection-label) pairs: ' + distinctCollectionLabels.length);
  console.log('  existing Collection rows:       ' + existingCollectionCount);
  console.log('  existing Product rows:          ' + existingProductCount);
  console.log('');

  // ---- 2. Load every ungrouped, labeled tile ----
  const candidates = await prisma.tile.findMany({
    where: { productId: null, collection: { not: null } },
    select: { id: true, name: true, brandId: true, collection: true, brand: { select: { name: true } } },
    orderBy: [{ brandId: 'asc' }, { collection: 'asc' }, { name: 'asc' }],
  });

  if (candidates.length === 0) {
    console.log('No ungrouped, labeled tiles. Nothing to propose.');
    if (tilesWithNoCollection > 0) {
      console.log(tilesWithNoCollection + ' tile(s) have no collection label at all and are left untouched '
        + '(see MISSING MAPPINGS below if this run looked for them).');
    }
    await disconnectAndExit();
    return;
  }

  // ---- 3. Resolve each (brandId, normalized collection label) ----
  const collectionKeyToLabel = new Map(); // "brandId::normalized" -> { brandId, label }
  for (const t of candidates) {
    const key = t.brandId + '::' + normalize(t.collection);
    if (!collectionKeyToLabel.has(key)) collectionKeyToLabel.set(key, { brandId: t.brandId, label: t.collection, brandName: t.brand.name });
  }

  const resolvedCollections = new Map(); // key -> { id, existing, name }
  for (const [key, { brandId, label, brandName }] of collectionKeyToLabel) {
    const existing = await prisma.collection.findFirst({
      where: { brandId, name: { equals: label.trim(), mode: 'insensitive' } },
    });
    resolvedCollections.set(key, { brandId, brandName, name: label.trim(), existingId: existing?.id ?? null });
  }

  // ---- 4. Group tiles into proposed Products within each resolved collection ----
  const productGroups = new Map(); // "brandId::collectionKey::normalizedName" -> { brandId, collectionKey, name, tiles[] }
  for (const t of candidates) {
    const collectionKey = t.brandId + '::' + normalize(t.collection);
    const key = collectionKey + '::' + normalize(t.name);
    if (!productGroups.has(key)) {
      productGroups.set(key, { brandId: t.brandId, brandName: t.brand.name, collectionKey, name: t.name, tiles: [] });
    }
    productGroups.get(key).tiles.push(t);
  }

  // ---- 5. Flag near-duplicate product names within the same brand+collection scope ----
  const byScope = new Map();
  for (const [key, group] of productGroups) {
    if (!byScope.has(group.collectionKey)) byScope.set(group.collectionKey, []);
    byScope.get(group.collectionKey).push({ key, group });
  }

  const flagged = new Map(); // key -> reason
  for (const entries of byScope.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const score = similarity(entries[i].group.name, entries[j].group.name);
        if (score >= REVIEW_THRESHOLD && score < 1) {
          const reasonA = 'near-duplicate name (similarity ' + score.toFixed(3) + ') with "' + entries[j].group.name
            + '" in the same company/collection -- decide whether these are one product or two before either is created.';
          const reasonB = 'near-duplicate name (similarity ' + score.toFixed(3) + ') with "' + entries[i].group.name
            + '" in the same company/collection -- decide whether these are one product or two before either is created.';
          flagged.set(entries[i].key, reasonA);
          flagged.set(entries[j].key, reasonB);
        }
      }
    }
  }

  const toCreate = [];
  const needsReview = [];
  for (const [key, group] of productGroups) {
    if (flagged.has(key)) {
      needsReview.push({ ...group, reason: flagged.get(key) });
    } else {
      toCreate.push(group);
    }
  }

  // ---- 6. Report ----
  console.log('PROPOSED COLLECTIONS: ' + collectionKeyToLabel.size + ' distinct (company, collection-name) pair(s) found among ungrouped tiles.');
  let newCollections = 0;
  let reusedCollections = 0;
  for (const c of resolvedCollections.values()) {
    if (c.existingId) reusedCollections += 1; else newCollections += 1;
  }
  console.log('  ' + newCollections + ' would be newly created, ' + reusedCollections + ' already exist and would be reused.\n');

  console.log('PROPOSED PRODUCTS: ' + productGroups.size + ' name-group(s) among ungrouped tiles.');
  console.log('  ' + toCreate.length + ' group(s) can be auto-created as a Product.');
  console.log('  ' + needsReview.length + ' group(s) need a person to decide first.\n');

  if (needsReview.length > 0) {
    console.log('NEEDS MANUAL REVIEW (not created, in dry run or apply):');
    for (const r of needsReview) {
      console.log('  - "' + r.name + '" (' + r.brandName + '): ' + r.reason);
      for (const t of r.tiles) console.log('      tile ' + t.id + '  "' + t.name + '"');
    }
    console.log('');
  }

  if (tilesWithNoCollection > 0) {
    console.log('MISSING MAPPINGS: ' + tilesWithNoCollection + ' tile(s) have no collection label at all. '
      + 'They cannot be grouped into a Product until someone assigns a collection to them (this script never guesses one).\n');
  }

  console.log((APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)') + ':');

  let collectionsCreated = 0;
  let productsCreated = 0;
  let tilesLinked = 0;

  if (APPLY) {
    await prisma.$transaction(async (tx) => {
      const collectionIdByKey = new Map();
      for (const [key, c] of resolvedCollections) {
        if (c.existingId) {
          collectionIdByKey.set(key, c.existingId);
          continue;
        }
        const created = await tx.collection.create({ data: { brandId: c.brandId, name: c.name } });
        collectionIdByKey.set(key, created.id);
        collectionsCreated += 1;
      }

      for (const group of toCreate) {
        const collectionId = collectionIdByKey.get(group.collectionKey);
        const product = await tx.product.create({ data: { name: group.name, collectionId } });
        await tx.tile.updateMany({
          where: { id: { in: group.tiles.map((t) => t.id) } },
          data: { productId: product.id },
        });
        productsCreated += 1;
        tilesLinked += group.tiles.length;
      }
    });
  }

  for (const group of toCreate) {
    console.log('  ' + (APPLY ? 'created' : 'would create') + ' Product "' + group.name + '" (' + group.brandName
      + ') with ' + group.tiles.length + ' variant(s): ' + group.tiles.map((t) => t.id).join(', '));
  }

  console.log('\n' + (APPLY
    ? collectionsCreated + ' Collection(s) created, ' + productsCreated + ' Product(s) created, ' + tilesLinked + ' tile(s) linked.'
    : newCollections + ' Collection(s) WOULD be created, ' + toCreate.length + ' Product(s) WOULD be created, '
      + toCreate.reduce((s, g) => s + g.tiles.length, 0) + ' tile(s) WOULD be linked. Nothing was written.'));

  if (needsReview.length > 0) {
    console.log('\n' + needsReview.length + ' group(s) were left untouched for manual review (see above). '
      + 'Re-run this script after resolving them -- it only ever looks at tiles still missing a productId.');
  }

  await disconnectAndExit();
}

async function disconnectAndExit() {
  await prisma.$disconnect();
}

main()
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
