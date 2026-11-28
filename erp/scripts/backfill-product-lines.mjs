import { prisma, disconnect } from '../db/client.mjs';
import { normaliseName, normaliseCode, similarity, REVIEW_THRESHOLD } from '../server/services/normalise.mjs';

/* ============================================================
   GROUPING EXISTING PRODUCTS INTO PRODUCT LINES
   ============================================================

   Every product created before the "product hierarchy" step has
   `productLineId = null`. This script proposes a ProductLine for
   each group of products that share a brand, a collection (or lack
   one, together) and a name -- "Onery Elite Decore" in Matte and
   in Glossy becomes one ProductLine with two variants under it --
   and REFUSES to guess at anything less certain than that.

   DRY RUN BY DEFAULT. Pass --apply to actually write. Without it,
   this only prints the report: how many ProductLines would be
   created, how many products would be grouped, and -- the part
   that matters most -- every group this script will NOT decide on
   its own, with its reason, for a person to resolve first.

     node scripts/backfill-product-lines.mjs            # report only
     node scripts/backfill-product-lines.mjs --apply     # write it

   WHAT COUNTS AS UNAMBIGUOUS: an exact name match (case and
   whitespace folded, the same rule the database's own unique index
   uses) within the same brand and the same collection (or the same
   "no collection" bucket), where every member already shares one
   category. Nothing here merges two groups whose names are merely
   SIMILAR -- that is exactly the judgement the brief reserves for a
   person, the same rule brand.service.mjs and productHead.
   service.mjs already use for near-duplicate names.
   ============================================================ */

const APPLY = process.argv.includes('--apply');

function groupKey(p) {
  return [p.brandId, p.collectionId ?? '(none)', normaliseName(p.name)].join('::');
}

async function main() {
  const ungrouped = await prisma.product.findMany({
    where: { productLineId: null, archivedAt: null },
    select: {
      id: true, sku: true, name: true, brandId: true, collectionId: true,
      categoryId: true, finish: true, size: true,
      brand: { select: { name: true, code: true } },
      collection: { select: { name: true } },
    },
    orderBy: [{ brandId: 'asc' }, { collectionId: 'asc' }, { name: 'asc' }],
  });

  if (ungrouped.length === 0) {
    console.log('No ungrouped products. Nothing to do.');
    return;
  }

  const groups = new Map();
  for (const p of ungrouped) {
    const key = groupKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // Ambiguity check: within the same brand+collection scope, do two
  // DIFFERENT groups have near-identical names? If so, neither is
  // safe to auto-create -- a person has to say whether they are one
  // product misspelled twice or two products that happen to sound
  // alike.
  const byScope = new Map();
  for (const [key, members] of groups) {
    const scope = key.split('::').slice(0, 2).join('::');
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push({ key, name: members[0].name, members });
  }

  const flagged = new Map(); // key -> reason
  for (const candidates of byScope.values()) {
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const score = similarity(candidates[i].name, candidates[j].name);
        if (score >= REVIEW_THRESHOLD) {
          const reason = 'near-duplicate name (score ' + score.toFixed(3) + ') with "'
            + candidates[j].name + '" in the same brand/collection -- decide whether these are one product or two before either is created.';
          flagged.set(candidates[i].key, reason);
          flagged.set(candidates[j].key, 'near-duplicate name (score ' + score.toFixed(3) + ') with "'
            + candidates[i].name + '" in the same brand/collection -- decide whether these are one product or two before either is created.');
        }
      }
    }
  }

  // Within-group category disagreement: siblings of the same name
  // that do not even agree on category are a second kind of
  // anomaly worth a person's attention rather than a silent pick.
  for (const [key, members] of groups) {
    if (flagged.has(key)) continue;
    const categories = new Set(members.map((m) => m.categoryId));
    if (categories.size > 1) {
      flagged.set(key, members.length + ' product(s) share this name but disagree on category ('
        + categories.size + ' different categories) -- not auto-grouped.');
    }
  }

  const toCreate = [];
  const needsReview = [];
  for (const [key, members] of groups) {
    if (flagged.has(key)) {
      needsReview.push({ name: members[0].name, brand: members[0].brand.name,
        collection: members[0].collection?.name ?? '(none)',
        products: members.map((m) => ({ id: m.id, sku: m.sku, finish: m.finish, size: m.size })),
        reason: flagged.get(key) });
      continue;
    }
    toCreate.push({ key, members });
  }

  console.log('\n' + ungrouped.length + ' ungrouped product(s), in ' + groups.size + ' name-group(s).');
  console.log(toCreate.length + ' group(s) can be auto-created as a ProductLine.');
  console.log(needsReview.length + ' group(s) need a person to decide first.\n');

  if (needsReview.length > 0) {
    console.log('NEEDS MANUAL REVIEW:');
    for (const r of needsReview) {
      console.log('  - "' + r.name + '" (' + r.brand + ' / ' + r.collection + '): ' + r.reason);
      for (const p of r.products) console.log('      ' + p.sku + '  finish=' + (p.finish ?? '—') + '  size=' + (p.size ?? '—'));
    }
    console.log('');
  }

  console.log((APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)') + ':');
  let created = 0;
  let linked = 0;

  if (APPLY) {
    await prisma.$transaction(async (tx) => {
      for (const { members } of toCreate) {
        const first = members[0];
        const wanted = normaliseCode(first.name).slice(0, 12) || 'PRODUCT';
        let code = wanted;
        for (let n = 2; n < 50; n += 1) {
          const taken = await tx.productLine.findFirst({
            where: { brandId: first.brandId, collectionId: first.collectionId, code },
            select: { id: true },
          });
          if (!taken) break;
          code = wanted.slice(0, 8) + n;
        }

        const line = await tx.productLine.create({
          data: {
            brandId: first.brandId,
            collectionId: first.collectionId,
            categoryId: first.categoryId,
            code,
            name: first.name,
          },
        });
        await tx.product.updateMany({
          where: { id: { in: members.map((m) => m.id) } },
          data: { productLineId: line.id },
        });
        created += 1;
        linked += members.length;
      }
    });
  }

  for (const { members } of toCreate) {
    console.log('  ' + (APPLY ? 'created' : 'would create') + ' ProductLine "' + members[0].name
      + '" (' + members[0].brand.name + ' / ' + (members[0].collection?.name ?? 'no collection') + ') with '
      + members.length + ' variant(s): ' + members.map((m) => m.sku).join(', '));
  }

  console.log('\n' + (APPLY ? created + ' ProductLine(s) created, ' + linked + ' product(s) linked.'
    : toCreate.length + ' ProductLine(s) WOULD be created, '
      + toCreate.reduce((s, g) => s + g.members.length, 0) + ' product(s) WOULD be linked. Nothing was written.'));

  if (needsReview.length > 0) {
    console.log('\n' + needsReview.length + ' group(s) were left untouched for manual review (see above). '
      + 'Re-run this script after resolving them -- it only ever looks at products still missing a productLineId.');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => disconnect());
