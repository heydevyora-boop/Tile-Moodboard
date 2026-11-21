import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/**
 * PRODUCT MASTER — THE TWENTY CASES THE BRIEF ASKS FOR.
 *
 * Against an ISOLATED test database, built from the project's own
 * migrations and seed. Never the development database, never
 * production: the name is checked before a single query runs.
 *
 * Run:  node test/product_master_test.mjs
 */

// Before any import that opens a connection. db/client.mjs reads
// the URL once, at import time, so this has to come first.
useTestDatabase();
migrate();
seed();

const { prisma, disconnect } = await import('../db/client.mjs');
const products = await import('../server/services/product.service.mjs');
const brands = await import('../server/services/brand.service.mjs');
const heads = await import('../server/services/productHead.service.mjs');
const { candidateSku } = await import('../server/services/sku.mjs');
const { validateProduct } = await import('../server/services/productRules.mjs');
const { postStockMovement } = await import('../db/stock.mjs');

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra, null, 0).slice(0, 240)));
}

async function refused(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (err) { return { threw: true, err }; }
}

/** Everything this run created, removed at the end. */
const made = { products: [], heads: [], brands: [] };
const stamp = Date.now();

const actor = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
const floor = await prisma.productCategory.findUniqueOrThrow({ where: { code: 'FLOOR' } });
const grcCategory = await prisma.productCategory.upsert({
  where: { code: 'GRC' },
  update: {},
  create: { code: 'GRC', name: 'GRC / Architectural', hsnCode: '68109990', sortOrder: 90 },
});

try {
  /* ── 1. creating a brand ──────────────────────────────── */
  console.log('\n1. creating a brand');

  const kajaria = await brands.create({ name: 'Kajaria ' + stamp }, actor);
  made.brands.push(kajaria.id);
  check('1a. a brand is created', !!kajaria.id && kajaria.name === 'Kajaria ' + stamp);
  check('1b. it gets a code, for the SKUs issued under it', !!kajaria.code, kajaria.code);

  const blank = await refused(() => brands.create({ name: '   ' }, actor));
  check('1c. a blank brand name is refused with the field named',
    blank.threw && blank.err.fields?.[0]?.field === 'name');

  /* ── 2. a brand is its name, however it was typed ─────── */
  console.log('\n2. duplicate brands, including by case and spacing');

  const exact = await refused(() => brands.create({ name: 'Kajaria ' + stamp }, actor));
  check('2a. the same brand name twice is refused', exact.threw && exact.err.code === 'CONFLICT');

  const spaced = await refused(() => brands.create({ name: '  KAJARIA  ' + stamp + ' ' }, actor));
  check('2b. ...and so is the same name in another case, with stray spaces',
    spaced.threw, spaced.threw ? spaced.err.code : 'IT WAS CREATED');

  const near = await refused(() => brands.create({ name: 'Kajaria ' + stamp + 'a' }, actor));
  check('2c. a near-match is sent for human review, not merged and not refused outright',
    near.threw && near.err.code === 'NEEDS_HUMAN_REVIEW' && near.err.details.candidates.length > 0);

  const forced = await brands.create({ name: 'Kajaria ' + stamp + 'a', confirmDistinct: true }, actor);
  made.brands.push(forced.id);
  check('2d. ...and a person can say it really is different', forced.id !== kajaria.id);

  /* ── 3. creating a product head ───────────────────────── */
  console.log('\n3. creating a product head');

  const neoSapien = await heads.create({
    name: 'Neo Sapien', brandId: kajaria.id, categoryId: floor.id,
  }, actor);
  made.heads.push(neoSapien.id);
  check('3a. a product head is created under its brand',
    neoSapien.brand.id === kajaria.id && neoSapien.name === 'Neo Sapien');
  check('3b. it carries a category, which decides what its variants need',
    neoSapien.category.id === floor.id);

  const noBrand = await refused(() => heads.create({ name: 'Orphan' }, actor));
  check('3c. a head with no brand is refused', noBrand.threw);

  const sameNameOtherBrand = await heads.create({
    name: 'Neo Sapien', brandId: forced.id, categoryId: floor.id,
  }, actor);
  made.heads.push(sameNameOtherBrand.id);
  check('3d. the same series name under ANOTHER brand is allowed — they are different ranges',
    sameNameOtherBrand.id !== neoSapien.id);

  const dupHead = await refused(() => heads.create({
    name: 'neo  sapien', brandId: kajaria.id, categoryId: floor.id,
  }, actor));
  check('3e. the same series name within one brand is refused, case and spacing ignored',
    dupHead.threw, dupHead.threw ? dupHead.err.code : 'IT WAS CREATED');

  /* ── 4. creating variants ─────────────────────────────── */
  console.log('\n4. creating variants under one head');

  const base = {
    headId: neoSapien.id,
    categoryId: floor.id,
    size: '600x1200mm',
    thicknessMm: 9,
    finish: 'Matte',
    purchasePrice: 70,
    sellingPrice: 95,
  };

  const grey = await products.create({ ...base, name: 'Neo Sapien Grey', colour: 'Grey' }, actor);
  const brown = await products.create({ ...base, name: 'Neo Sapien Brown', colour: 'Brown' }, actor);
  const blue = await products.create({ ...base, name: 'Neo Sapien Blue', colour: 'Blue' }, actor);
  made.products.push(grey.id, brown.id, blue.id);

  check('4a. three colours are three variants', new Set([grey.id, brown.id, blue.id]).size === 3);

  /* THE RULE THE WHOLE HIERARCHY RESTS ON. Adding a colour must
     not create a second Neo Sapien. */
  const headNow = await heads.get(neoSapien.id);
  check('4b. ...and they sit under ONE head, not three',
    headNow.variantCount === 3 && headNow.variants.length === 3,
    { variantCount: headNow.variantCount });
  check('4c. the head is still called Neo Sapien and there is only one of it',
    (await prisma.collection.count({ where: { brandId: kajaria.id, name: 'Neo Sapien' } })) === 1);

  /* ── 5. SKUs ──────────────────────────────────────────── */
  console.log('\n5. SKUs');

  check('5a. every variant has its own SKU',
    new Set([grey.sku, brown.sku, blue.sku]).size === 3,
    [grey.sku, brown.sku, blue.sku]);
  check('5b. a SKU is deterministic — the same inputs give the same candidate',
    candidateSku({ brandCode: 'KAJ', headCode: 'NEOSAPIEN', colour: 'Grey', finish: 'Matte', size: '600x1200mm' })
    === candidateSku({ brandCode: 'KAJ', headCode: 'NEOSAPIEN', colour: 'Grey', finish: 'Matte', size: '600x1200mm' }));
  check('5c. it is readable, and carries brand, head and attributes',
    /^[A-Z0-9]+-[A-Z0-9]+-/.test(grey.sku), grey.sku);

  const manual = await products.create({
    ...base, name: 'Neo Sapien Ivory', colour: 'Ivory', sku: 'kaj-manual-' + stamp,
  }, actor);
  made.products.push(manual.id);
  check('5d. an authorised manual SKU is used as given, in upper case',
    manual.sku === ('KAJ-MANUAL-' + stamp).toUpperCase(), manual.sku);

  const clash = await refused(() => products.create({
    ...base, name: 'Clashing', colour: 'Black', sku: manual.sku,
  }, actor));
  check('5e. a manual SKU that is taken is refused rather than silently changed',
    clash.threw && clash.err.code === 'CONFLICT');

  const dbClash = await refused(() => prisma.product.create({
    data: {
      sku: grey.sku, name: 'Direct duplicate', brandId: kajaria.id,
      categoryId: floor.id, size: '600x600mm', purchasePrice: 1, sellingPrice: 2,
    },
  }));
  check('5f. the database refuses a duplicate SKU written around the service', dbClash.threw);

  /* ── 6. a SKU survives an edit ────────────────────────── */
  console.log('\n6. a SKU is permanent');

  const renamed = await products.update(grey.id, { name: 'Neo Sapien Grey — revised' }, actor);
  check('6a. renaming a product does not renumber it', renamed.sku === grey.sku, { was: grey.sku, now: renamed.sku });

  const edited = await products.update(grey.id, { sellingPrice: 108, finish: 'Satin' }, actor);
  check('6b. nor does changing its price or finish', edited.sku === grey.sku);
  check('6c. ...and the edit did land', Number(edited.sellingPrice) === 108 && edited.finish === 'Satin');

  const renumber = await refused(() => products.update(grey.id, { sku: 'SOMETHING-ELSE' }, actor));
  check('6d. an attempt to change a SKU is REFUSED, not ignored',
    renumber.threw && renumber.err.code === 'CONFLICT');

  /* ── 7. mandatory fields ──────────────────────────────── */
  console.log('\n7. mandatory fields, by category');

  const noBrandField = await refused(() => products.create({
    name: 'No brand', categoryId: floor.id, size: '600x600mm',
    thicknessMm: 9, finish: 'Matte', colour: 'Grey',
  }, actor));
  check('7a. a product with no brand is refused',
    noBrandField.threw && noBrandField.err.fields?.some((f) => f.field === 'brandId'));

  const noName = await refused(() => products.create({ ...base, colour: 'Grey', name: '' }, actor));
  check('7b. a product with no name is refused',
    noName.threw && noName.err.fields?.some((f) => f.field === 'name'));

  const noSize = await refused(() => products.create({ ...base, colour: 'Teal', name: 'Sizeless', size: '' }, actor));
  check('7c. a tile with no size is refused',
    noSize.threw && noSize.err.fields?.some((f) => f.field === 'size'));

  const manyMissing = await refused(() => products.create({
    headId: neoSapien.id, categoryId: floor.id, name: '', size: '',
  }, actor));
  check('7d. every missing field is reported at once, not one at a time',
    manyMissing.threw && manyMissing.err.fields.length >= 2,
    manyMissing.threw ? manyMissing.err.fields.map((f) => f.field) : null);

  /* NOT EVERY PRODUCT IS A TILE. A GRC panel is specified by its
     projection and material and has no tile thickness at all. */
  const grcHead = await heads.create({ name: 'Facade Jali ' + stamp, brandId: kajaria.id, categoryId: grcCategory.id }, actor);
  made.heads.push(grcHead.id);

  const grcMissing = await refused(() => products.create({
    headId: grcHead.id, categoryId: grcCategory.id, name: 'Jali A',
    size: '1200x600mm', lengthMm: 1200, widthMm: 600, finish: 'Textured',
    attributes: { material: 'GRC' },
  }, actor));
  check('7e. a GRC panel with no projection is refused',
    grcMissing.threw && grcMissing.err.fields?.some((f) => f.field === 'attributes.projectionMm'));

  const grcOk = await products.create({
    headId: grcHead.id, categoryId: grcCategory.id, name: 'Jali A',
    size: '1200x600mm', lengthMm: 1200, widthMm: 600, finish: 'Textured',
    purchasePrice: 900, sellingPrice: 1400,
    attributes: { material: 'GRC', projectionMm: 75 },
  }, actor);
  made.products.push(grcOk.id);
  check('7f. ...and accepted once it has one', grcOk.attributes.projectionMm === 75);

  check('7g. a GRC panel is NOT asked for a tile thickness', (() => {
    try {
      validateProduct({
        brandId: 'x', name: 'Jali', size: '1200x600', lengthMm: 1200, widthMm: 600,
        finish: 'Textured', attributes: { material: 'GRC', projectionMm: 75 },
      }, 'GRC');
      return true;
    } catch { return false; }
  })());

  const tileWithProjection = await refused(() => products.create({
    ...base, name: 'Confused tile', colour: 'Teal', attributes: { projectionMm: 75 },
  }, actor));
  check('7h. ...and a tile is not allowed a projection either',
    tileWithProjection.threw && tileWithProjection.err.fields?.some((f) => f.field.startsWith('attributes.')));

  /* ── 8. duplicate variant detection ───────────────────── */
  console.log('\n8. duplicate detection within a head');

  const dupVariant = await refused(() => products.create({
    ...base, name: 'Neo Sapien Brown again', colour: 'Brown',
  }, actor));
  check('8a. the same colour, finish and size under one head goes to human review',
    dupVariant.threw && dupVariant.err.code === 'NEEDS_HUMAN_REVIEW',
    dupVariant.threw ? dupVariant.err.code : 'IT WAS CREATED');
  check('8b. ...and the existing variant is named, so a person can look at it',
    dupVariant.threw && dupVariant.err.details.candidates.some((c) => c.sku === brown.sku));

  const confirmed = await products.create({
    ...base, name: 'Neo Sapien Brown 800', colour: 'Brown', size: '800x1600mm', confirmDistinct: true,
  }, actor);
  made.products.push(confirmed.id);
  check('8c. a genuinely different size is not a duplicate at all', confirmed.id !== brown.id);

  /* ── 9. status changes ────────────────────────────────── */
  console.log('\n9. status');

  const deactivated = await products.setStatus(blue.id, 'INACTIVE', actor, 'Supplier out of production');
  check('9a. a product can be deactivated', deactivated.status === 'INACTIVE');

  const reactivated = await products.setStatus(blue.id, 'ACTIVE', actor);
  check('9b. ...and activated again', reactivated.status === 'ACTIVE');

  const discontinued = await products.setStatus(brown.id, 'DISCONTINUED', actor, 'Range retired');
  check('9c. ...and discontinued', discontinued.status === 'DISCONTINUED');

  const statuses = await prisma.$queryRaw`SELECT unnest(enum_range(NULL::"ProductStatus"))::text AS v`;
  check('9d. there is no OUT_OF_STOCK status, and never was',
    !statuses.map((s) => s.v).includes('OUT_OF_STOCK'), statuses.map((s) => s.v));

  const badStatus = await refused(() => products.setStatus(blue.id, 'OUT_OF_STOCK', actor));
  check('9e. ...and one cannot be set', badStatus.threw);

  /* ── 10. stock, read only ─────────────────────────────── */
  console.log('\n10. the inventory relationship');

  const emptySummary = await products.stockSummary(grey.id);
  check('10a. a never-stocked product reads as out of stock, derived',
    emptySummary.totalStock === 0 && emptySummary.isOutOfStock === true);

  // Stock arrives the only way it can: through the step-2 ledger.
  await postStockMovement({
    productId: grey.id, warehouseId: warehouse.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT',
    quantity: 120, uom: 'BOX', unitCost: 70,
    referenceType: 'MANUAL', idempotencyKey: 'pm-test:in:' + stamp,
    createdById: actor.id,
  });
  await postStockMovement({
    productId: grey.id, warehouseId: warehouse.id,
    movementType: 'OUTWARD', reason: 'SALES_DISPATCH',
    quantity: 20, uom: 'BOX',
    referenceType: 'MANUAL', idempotencyKey: 'pm-test:out:' + stamp,
    createdById: actor.id,
  });

  const summary = await products.stockSummary(grey.id);
  check('10b. the summary reads inward, outward and on-hand from the ledger',
    summary.stockInward === 120 && summary.stockOutward === 20 && summary.totalStock === 100,
    { in: summary.stockInward, out: summary.stockOutward, onHand: summary.totalStock });
  check('10c. available stock accounts for what is reserved',
    summary.availableStock === summary.totalStock - summary.reservedStock);
  check('10d. it is broken down by warehouse', summary.byWarehouse.length === 1
    && summary.byWarehouse[0].quantityOnHand === 100);

  await products.update(grey.id, { reorderLevel: 150 }, actor);
  const low = await products.stockSummary(grey.id);
  check('10e. low stock is derived from the reorder level, not stored',
    low.isLowStock === true && low.isOutOfStock === false);

  const stillActive = await products.get(grey.id);
  check('10f. ...and being low did NOT change the product status', stillActive.status === 'ACTIVE');

  /* PRODUCT MASTER MUST NOT BE A SECOND WAY TO MOVE STOCK. */
  const viaProduct = await refused(() => products.update(grey.id, { stockQty: 999, quantityOnHand: 999 }, actor));
  const afterTry = await products.stockSummary(grey.id);
  check('10g. Product Master cannot change a stock figure',
    afterTry.totalStock === 100, { threw: viaProduct.threw, onHand: afterTry.totalStock });

  /* ── 11. archival ─────────────────────────────────────── */
  console.log('\n11. archival, not deletion');

  const ledgerBefore = await prisma.stockLedgerEntry.count({ where: { productId: grey.id } });

  const deleteTried = await refused(() => prisma.product.delete({ where: { id: grey.id } }));
  check('11a. a product with stock movements cannot be deleted', deleteTried.threw);

  const archived = await products.archive(grey.id, actor, 'Replaced by a newer range');
  check('11b. it can be archived', archived.isArchived === true && archived.archivedAt !== null);

  const ledgerAfter = await prisma.stockLedgerEntry.count({ where: { productId: grey.id } });
  check('11c. ...and every stock movement survives it',
    ledgerAfter === ledgerBefore && ledgerAfter > 0, { before: ledgerBefore, after: ledgerAfter });

  const defaultList = await products.list({ search: grey.sku });
  check('11d. an archived product is out of the default list',
    defaultList.rows.every((r) => r.id !== grey.id));

  const withArchived = await products.list({ search: grey.sku, includeArchived: true });
  check('11e. ...but findable when asked for', withArchived.rows.some((r) => r.id === grey.id));

  const restored = await products.restore(grey.id, actor);
  check('11f. and it can be restored', restored.isArchived === false);

  /* ── 12. search, filter, sort, paginate ───────────────── */
  console.log('\n12. search, filter, sort and paging');

  const bySku = await products.list({ search: brown.sku });
  check('12a. search by SKU', bySku.total === 1 && bySku.rows[0].id === brown.id);

  const byName = await products.list({ search: 'Neo Sapien' });
  check('12b. search by product name finds the whole series', byName.total >= 4, byName.total);

  const byBrand = await products.list({ search: 'Kajaria ' + stamp });
  check('12c. search by brand name', byBrand.total >= 4, byBrand.total);

  const byHead = await products.list({ headId: neoSapien.id });
  check('12d. filter by product head', byHead.rows.every((r) => r.productHead?.id === neoSapien.id));

  const byColour = await products.list({ colour: 'Blue' });
  check('12e. filter by colour',
    byColour.total > 0 && byColour.rows.every((r) => r.colour.toLowerCase() === 'blue'));

  const byStatus = await products.list({ status: 'DISCONTINUED' });
  check('12f. filter by status', byStatus.rows.every((r) => r.status === 'DISCONTINUED'));

  const byFinish = await products.list({ finish: 'Matte' });
  check('12g. filter by finish', byFinish.rows.every((r) => r.finish === 'Matte'));

  const bySize = await products.list({ size: '600x1200mm' });
  check('12h. filter by size', bySize.rows.every((r) => r.size === '600x1200mm'));

  const combined = await products.list({ search: 'Neo Sapien', colour: 'Blue', finish: 'Matte' });
  check('12i. filters combine rather than replace each other',
    combined.rows.every((r) => r.colour === 'Blue' && r.finish === 'Matte' && /Neo Sapien/i.test(r.name)));

  const asc = await products.list({ sortBy: 'sellingPrice', sortDir: 'asc', pageSize: 100 });
  const prices = asc.rows.map((r) => r.sellingPrice);
  check('12j. sorting ascending', prices.every((v, i) => i === 0 || prices[i - 1] <= v));

  const desc = await products.list({ sortBy: 'sellingPrice', sortDir: 'desc', pageSize: 100 });
  const descPrices = desc.rows.map((r) => r.sellingPrice);
  check('12k. sorting descending', descPrices.every((v, i) => i === 0 || descPrices[i - 1] >= v));

  const p1 = await products.list({ pageSize: 5, page: 1, sortBy: 'sku' });
  const p2 = await products.list({ pageSize: 5, page: 2, sortBy: 'sku' });
  check('12l. a page holds the page size', p1.rows.length === 5);
  check('12m. page two is different rows, and the total is the whole set',
    p1.rows[0].id !== p2.rows[0].id && p1.total === p2.total && p1.total > 5,
    { total: p1.total });
  check('12n. the page count matches the total',
    p1.pageCount === Math.ceil(p1.total / 5));

  /* The brief: do not load the whole Product Master into the
     browser. Paging has to happen in the database. */
  check('12o. a page returns only its own rows, not the whole catalogue',
    p1.rows.length < p1.total, { returned: p1.rows.length, total: p1.total });

  const options = await products.filterOptions();
  check('12p. the filter lists come from the data itself',
    options.colours.includes('Blue') && options.finishes.includes('Matte'));

  /* ── 13. concurrent SKU creation ──────────────────────── */
  console.log('\n13. ten variants created at the same instant');

  /* The real risk: two clerks adding variants of the same head at
     once compute the same candidate SKU, and one overwrites the
     other -- or the request fails. Neither is acceptable, so the
     unique constraint is the arbiter and the loser retries. */
  const racers = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => products.create({
      headId: neoSapien.id,
      categoryId: floor.id,
      name: 'Race ' + i,
      colour: 'Race',
      finish: 'Matte',
      // A floor tile needs its thickness. Omitting it made all ten
      // fail validation before they ever raced -- and the "all
      // different SKUs" check passed anyway, because a set of zero
      // SKUs has no duplicates in it. See 13b.
      thicknessMm: 9,
      size: '600x1200mm',
      purchasePrice: 50,
      sellingPrice: 70,
      confirmDistinct: true,
    }, actor)),
  );

  const created = racers.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  made.products.push(...created.map((p) => p.id));
  const skus = created.map((p) => p.sku);

  check('13a. all ten were created', created.length === 10,
    racers.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).slice(0, 2));
  /* COUNTED, not just deduplicated. `new Set([]).size === 0` is
     true, so the first version of this check reported success
     while every single creation was failing -- a green tick over
     an empty result is worse than a red one. */
  check('13b. every one got a DIFFERENT SKU',
    skus.length === 10 && new Set(skus).size === 10, skus);
  check('13c. ...and they are all still there', (await prisma.product.count({
    where: { id: { in: created.map((p) => p.id) } },
  })) === 10);

  /* ── 14. the audit trail ──────────────────────────────── */
  console.log('\n14. audit');

  const greyAudit = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: grey.id },
    orderBy: { createdAt: 'asc' },
  });
  check('14a. creating a product writes an audit row',
    greyAudit.some((a) => a.action === 'CREATE'));
  check('14b. the SKU assignment is recorded in its own right',
    greyAudit.some((a) => /Assigned SKU/.test(a.summary ?? '')));
  check('14c. editing writes one, with what changed',
    greyAudit.some((a) => a.action === 'UPDATE' && a.changes && Object.keys(a.changes).length > 0));
  check('14d. archiving writes one that says what was preserved',
    greyAudit.some((a) => /Archived/.test(a.summary ?? '') && /stock movement/.test(a.summary ?? '')));
  check('14e. every row names who did it',
    greyAudit.every((a) => a.actorUserId === actor.id));
  check('14f. a status change says what it changed from and to',
    (await prisma.auditLog.findMany({ where: { entityType: 'Product', entityId: brown.id } }))
      .some((a) => /ACTIVE -> DISCONTINUED/.test(a.summary ?? '')));

  const brandAudit = await prisma.auditLog.findMany({ where: { entityType: 'Brand', entityId: kajaria.id } });
  check('14g. creating a brand writes one', brandAudit.some((a) => a.action === 'CREATE'));

  const headAudit = await prisma.auditLog.findMany({ where: { entityType: 'ProductHead', entityId: neoSapien.id } });
  check('14h. creating a product head writes one', headAudit.some((a) => a.action === 'CREATE'));

  /* Filtered in JS rather than in the query. A null Json column
     is not a null SQL value to Prisma -- `NOT: { changes: null }`
     is rejected outright -- and the correct form needs a
     DbNull import for a one-row lookup in a test. */
  const updates = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: grey.id, action: 'UPDATE' },
  });
  const editAudit = updates.find((a) => a.changes && Object.keys(a.changes).length > 0);
  check('14i-pre. an edit recorded what changed', !!editAudit);
  const tamper = await refused(() => prisma.$executeRaw`
    UPDATE "audit_logs" SET "summary" = 'tampered' WHERE "id" = ${editAudit.id}::uuid
  `);
  check('14i. an audit row cannot be edited afterwards', tamper.threw);

  /* ── 15. brand and head editing ───────────────────────── */
  console.log('\n15. editing brands and heads');

  const renamedBrand = await brands.update(kajaria.id, { name: 'Kajaria Ceramics ' + stamp }, actor);
  check('15a. a brand can be renamed', renamedBrand.name === 'Kajaria Ceramics ' + stamp);

  const stillSame = await products.get(brown.id);
  check('15b. ...and its products keep their SKUs', stillSame.sku === brown.sku);

  const codeChange = await refused(() => brands.update(kajaria.id, { code: 'NEWCODE' }, actor));
  check('15c. a brand code cannot be changed, because SKUs carry it', codeChange.threw);

  const deactivatedBrand = await brands.setActive(forced.id, false, actor);
  check('15d. a brand can be deactivated rather than deleted', deactivatedBrand.isActive === false);

  const headRename = await heads.update(neoSapien.id, { name: 'Neo Sapien Plus' }, actor);
  check('15e. a product head can be renamed', headRename.name === 'Neo Sapien Plus');

  const headMove = await refused(() => heads.update(neoSapien.id, { brandId: forced.id }, actor));
  check('15f. a head with variants cannot be moved to another brand', headMove.threw);

  /* ── 16. nothing reached the website or its database ──── */
  console.log('\n16. isolation');

  const dbName = (await prisma.$queryRaw`SELECT current_database() AS n`)[0].n;
  check('16a. the whole suite ran against a test database', /test/i.test(dbName), dbName);

  const mappings = await prisma.websiteProductMapping.findMany({
    where: { productId: { in: [grey.id, brown.id, blue.id] } },
  });
  check('16b. creating a product does not sync it anywhere',
    mappings.every((m) => m.syncStatus === 'NOT_SYNCED' && m.lastSyncedAt === null));

  const events = await prisma.integrationEvent.count();
  check('16c. no integration event was emitted — that is a later phase', events === 0, events);
} finally {
  /* ── clean up ──────────────────────────────────────────── */
  // In reverse order of dependency, and only what this run made.
  // Products with stock history cannot be deleted, so they are
  // left; the test database is disposable and that is the point
  // of it being separate.
  for (const id of made.products) {
    await prisma.product.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.heads) {
    await prisma.collection.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.brands) {
    await prisma.brand.delete({ where: { id } }).catch(() => {});
  }

  console.log('\n' + passed + '/' + (passed + failures.length) + ' checks passed');
  if (failures.length) {
    console.log('failed:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
  await disconnect();
}
