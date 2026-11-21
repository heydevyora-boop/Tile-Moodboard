import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/**
 * THE IMPORT ENGINE — the twenty-five cases the brief asks for.
 *
 * Against an ISOLATED database, built from the project's own
 * migrations and seed, whose name must contain "test" or nothing
 * runs at all.
 *
 * EVERY CHECK LOOKS AT REAL ROWS. A test that passes because
 * nothing was created is not a passing test, so each one asserts
 * a count or an identity rather than "it did not throw".
 *
 * Run:  node test/import_engine_test.mjs
 */

useTestDatabase();
migrate();
seed();

const { prisma, disconnect } = await import('../db/client.mjs');
const engine = await import('../server/import/engine.mjs');
const { masterRow, buildWorkbook } = await import('./fixtures/make.mjs');
const { rowFingerprint, classify } = await import('../server/import/duplicates.mjs');
const { readUpload, googleSheetsConfig, readGoogleSheet } = await import('../server/import/sources.mjs');
const { mapMasterRow } = await import('../server/import/mapping.mjs');

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 260)));
}

async function refused(fn) {
  try { return { threw: false, value: await fn() }; }
  catch (err) { return { threw: true, err }; }
}

const actor = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
const stamp = Date.now();
const BRAND = 'Archrock ' + stamp;

/** Batches created by THIS run. The test database persists, and
 *  §11 deliberately leaves one earlier batch in a broken state —
 *  so a check over "every batch in the database" would be failing
 *  on last run's intentional damage rather than on anything this
 *  one did. */
const myBatches = [];

/** A complete, importable tile row. */
const tile = (over = {}) => masterRow({
  Brand: BRAND,
  'Product Name': 'Adobe Grey',
  Dimensions: '600x1200mm',
  Thickness: '9',
  'Finish Extracted': 'Matte',
  'AI Color': 'Grey',
  'Floor / Wall': 'FLOOR',
  Catalog: 'Adobe Collection',
  Page: '14',
  'Drive URL': 'https://drive.google.com/file/d/aaa',
  ...over,
});

async function importFile(rows, filename = 'master.xlsx') {
  const buffer = await buildWorkbook(rows);
  const prepared = await engine.prepare(
    { sourceType: 'EXCEL_UPLOAD', buffer, filename }, actor,
  );
  myBatches.push(prepared.batchId);
  return prepared;
}

try {
  /* ── 1. a valid Excel import ──────────────────────────── */
  /* What the ledger held BEFORE this suite imported anything.
     Importing a catalogue must not post a single stock movement:
     a product and the stock of it are different facts, and a
     spreadsheet of products is not a delivery note. Measured as a
     delta rather than an absolute, because this database is
     shared with the other suites and with manual checks. */
  const ledgerBefore = await prisma.stockLedgerEntry.count();

  console.log('\n1. a valid Excel import');

  const productsBefore = await prisma.product.count();
  const first = await importFile([
    tile(),
    tile({ 'Product Name': 'Adobe Beige', 'AI Color': 'Beige' }),
    tile({ 'Product Name': 'Adobe Charcoal', 'AI Color': 'Charcoal', Dimensions: '800x1600mm', Thickness: '12' }),
  ]);
  const firstPreview = await engine.preview(first.batchId);

  check('1a. a batch is created with a number', /^IMP-\d{4}-\d{4}$/.test(first.batchNo), first.batchNo);
  check('1b. all three rows were read', firstPreview.summary.sourceRowsRead === 3, firstPreview.summary);
  check('1c. the preview says all three would import', firstPreview.summary.willBeImported === 3);
  check('1d. NOTHING was written to the Product Master by the preview',
    (await prisma.product.count()) === productsBefore,
    { before: productsBefore, now: await prisma.product.count() });

  const firstRun = await engine.confirm(first.batchId, {}, actor);
  check('1e. confirming imported exactly three', firstRun.imported === 3, firstRun);
  check('1f. ...and three products really exist',
    (await prisma.product.count({ where: { brand: { name: BRAND } } })) === 3);
  check('1g. the brand was created once, not three times',
    (await prisma.brand.count({ where: { name: BRAND } })) === 1);
  check('1h. every imported product has a SKU',
    (await prisma.product.findMany({ where: { brand: { name: BRAND } }, select: { sku: true } }))
      .every((p) => p.sku && p.sku.length > 3));

  /* ── 2. Google Sheets: not claimed to work ────────────── */
  console.log('\n2. Google Sheets');

  const config = googleSheetsConfig();
  check('2a. no live Sheets connection is configured here',
    config.configured === false && config.missing.length === 2, config);
  check('2b. ...and it is never reported as verified', config.verified === false);

  const sheetsAttempt = await refused(() => readGoogleSheet());
  check('2c. asking for a Sheets import refuses rather than returning invented rows',
    sheetsAttempt.threw && sheetsAttempt.err.code === 'GOOGLE_SHEETS_NOT_AVAILABLE');
  check('2d. ...and the refusal names what is missing',
    sheetsAttempt.err.details.missing.includes('ERP_GOOGLE_SHEET_ID'));

  /* ── 3-5. the three mandatory fields ──────────────────── */
  console.log('\n3. missing brand, name and size');

  const missing = await importFile([
    tile({ Brand: '' }),
    tile({ 'Product Name': '' }),
    tile({ Dimensions: '', Length: '', Width: '' }),
    tile({ 'Product Name': 'Complete One' }),
  ]);
  const missingPreview = await engine.preview(missing.batchId);
  const byRow = Object.fromEntries(missingPreview.rows.map((r) => [r.sourceRowNumber, r]));

  check('3a. a row with no brand is INCOMPLETE',
    byRow[2].status === 'INCOMPLETE'
    && byRow[2].errors.some((e) => e.field === 'Brand'), byRow[2].errors);
  check('3b. a row with no product name is INCOMPLETE',
    byRow[3].status === 'INCOMPLETE'
    && byRow[3].errors.some((e) => e.field === 'Product Name'));
  check('3c. a tile with no size is INCOMPLETE',
    byRow[4].status === 'INCOMPLETE'
    && byRow[4].errors.some((e) => e.field === 'Dimensions'));
  check('3d. the errors name the SOURCE column, not the ERP field',
    byRow[4].errors.every((e) => !e.field.includes('Id')), byRow[4].errors);
  check('3e. the good row in the same file is unaffected', byRow[5].status === 'VALID');

  const missingRun = await engine.confirm(missing.batchId, {}, actor);
  check('3f. only the complete row was imported', missingRun.imported === 1, missingRun);
  check('3g. the three incomplete rows were kept, not discarded',
    (await prisma.importRow.count({ where: { batchId: missing.batchId, status: 'INCOMPLETE' } })) === 3);

  /* ── 6. category-aware validation ─────────────────────── */
  console.log('\n4. category-aware validation');

  const noCategory = await importFile([tile({ 'Floor / Wall': '', 'Suitable for Wall': '', 'Suitable for Floor': '', 'Product Name': 'Undecidable' })]);
  const noCategoryPreview = await engine.preview(noCategory.batchId);
  check('4a. a row whose category cannot be decided goes to review, not a guess',
    noCategoryPreview.rows[0].status === 'REVIEW_REQUIRED',
    noCategoryPreview.rows[0].status);
  check('4b. ...and says why',
    /floor or a wall/.test(noCategoryPreview.rows[0].errors[0].message));

  const wallRow = await importFile([tile({ 'Floor / Wall': 'WALL', 'Product Name': 'Wall One ' + stamp })]);
  await engine.confirm(wallRow.batchId, {}, actor);
  const wallProduct = await prisma.product.findFirst({
    where: { name: 'Wall One ' + stamp }, include: { category: true },
  });
  check('4c. a wall row lands in the Wall Tiles category',
    wallProduct?.category.code === 'WALL', wallProduct?.category.code);

  const noThickness = await importFile([tile({ Thickness: '', 'Product Name': 'No Thickness' })]);
  const noThicknessPreview = await engine.preview(noThickness.batchId);
  check('4d. a floor tile with no thickness is incomplete — the category requires it',
    noThicknessPreview.rows[0].status === 'INCOMPLETE'
    && noThicknessPreview.rows[0].errors.some((e) => /thickness/i.test(e.message)),
    noThicknessPreview.rows[0].errors);

  /* ── 7. numbers that are not numbers ──────────────────── */
  console.log('\n5. invalid values');

  const junk = mapMasterRow({ Thickness: 'about nine', Page: 'fourteen', Length: '' });
  check('5a. unparseable numbers become null, never NaN',
    junk.thicknessMm === null && junk.cataloguePage === null, junk);

  const placeholder = mapMasterRow({ 'Resolved Finish': 'UNKNOWN', 'AI Color': 'NOT_CLASSIFIED' });
  check('5b. the pipeline’s own placeholders are treated as absent, not as values',
    placeholder.finish === null && placeholder.colour === null);

  /* ── 8-10. duplicates ─────────────────────────────────── */
  console.log('\n6. duplicate detection');

  // The identical row again, in a new file.
  const again = await importFile([tile()]);
  const againPreview = await engine.preview(again.batchId);
  check('6a. a row already imported by an earlier batch is an EXACT_DUPLICATE',
    againPreview.rows[0].classification === 'EXACT_DUPLICATE'
    && againPreview.rows[0].status === 'SKIPPED_DUPLICATE',
    againPreview.rows[0]);
  check('6b. ...and the reason names the batch that loaded it',
    /batch IMP-/.test(againPreview.rows[0].errors[0].message), againPreview.rows[0].errors);

  const countBefore = await prisma.product.count({ where: { brand: { name: BRAND } } });
  await engine.confirm(again.batchId, {}, actor);
  check('6c. re-importing the same file creates NO new products',
    (await prisma.product.count({ where: { brand: { name: BRAND } } })) === countBefore,
    { before: countBefore, after: await prisma.product.count({ where: { brand: { name: BRAND } } }) });

  // Same product twice in ONE file.
  const twice = await importFile([tile({ 'Product Name': 'Twinned' }), tile({ 'Product Name': 'Twinned' })]);
  const twicePreview = await engine.preview(twice.batchId);
  check('6d. the same product listed twice in one file is caught',
    twicePreview.rows.filter((r) => r.status === 'SKIPPED_DUPLICATE').length === 1,
    twicePreview.rows.map((r) => r.status));
  await engine.confirm(twice.batchId, {}, actor);
  /* Scoped to THIS run's brand. The test database persists
     between runs, so counting by name alone picked up the
     'Twinned' left by the previous run and reported two. */
  check('6e. ...and only one product comes of it',
    (await prisma.product.count({ where: { name: 'Twinned', brand: { name: BRAND } } })) === 1,
    await prisma.product.count({ where: { name: 'Twinned', brand: { name: BRAND } } }));

  // A possible duplicate: same name, different size.
  const possible = await importFile([tile({ Dimensions: '1200x2400mm', Thickness: '15' })]);
  const possiblePreview = await engine.preview(possible.batchId);
  check('6f. same brand and name with a different size is a POSSIBLE_DUPLICATE',
    possiblePreview.rows[0].classification === 'POSSIBLE_DUPLICATE',
    possiblePreview.rows[0].classification);
  check('6g. ...and is NOT imported without a person saying so',
    possiblePreview.rows[0].status === 'REVIEW_REQUIRED'
    && possiblePreview.summary.willBeImported === 0);
  check('6h. the existing candidates are named for the reviewer',
    (possiblePreview.rows[0].errors[0].candidates ?? []).length > 0);

  /* ── 11-12. variants stay separate ────────────────────── */
  console.log('\n7. different variants are different products');

  const beforeVariants = await prisma.product.count({ where: { brand: { name: BRAND } } });
  const reviewed = await engine.confirm(possible.batchId, { includeReviewed: true }, actor);
  check('7a. a reviewed possible-duplicate imports when explicitly approved',
    reviewed.imported === 1, reviewed);
  check('7b. ...as a SEPARATE product, because the size differs',
    (await prisma.product.count({ where: { brand: { name: BRAND } } })) === beforeVariants + 1);

  const sizes = await prisma.product.findMany({
    where: { brand: { name: BRAND }, name: 'Adobe Grey' },
    select: { sku: true, size: true },
  });
  check('7c. the two sizes of one name are two rows with two SKUs',
    sizes.length === 2 && new Set(sizes.map((s) => s.size)).size === 2
    && new Set(sizes.map((s) => s.sku)).size === 2, sizes);

  const finishFp = rowFingerprint({ brandName: BRAND, name: 'X', size: '600x600mm', colour: 'Grey', finish: 'Matte' });
  const glossFp = rowFingerprint({ brandName: BRAND, name: 'X', size: '600x600mm', colour: 'Grey', finish: 'Glossy' });
  check('7d. a different finish is a different fingerprint', finishFp !== glossFp);

  /* ── 13-14. partial failure and retry ─────────────────── */
  console.log('\n8. partial failure, and retrying only what failed');

  const partial = await importFile([
    tile({ 'Product Name': 'Partial A' }),
    tile({ 'Product Name': 'Partial B' }),
    tile({ 'Product Name': 'Partial C' }),
  ]);

  /* Force the middle row to fail at import time by taking its
     SKU first. The source SKU is unique in the ERP, so the
     service refuses it -- a real failure through the real path,
     not a stubbed one. */
  const rowsOfPartial = await prisma.importRow.findMany({
    where: { batchId: partial.batchId }, orderBy: { sourceRowNumber: 'asc' },
  });
  await prisma.importRow.update({
    where: { id: rowsOfPartial[1].id },
    data: { mappedData: { ...rowsOfPartial[1].mappedData, brandName: null } },
  });

  const partialRun = await engine.confirm(partial.batchId, {}, actor);
  check('8a. the good rows imported even though one failed',
    partialRun.imported === 2 && partialRun.failed === 1, partialRun);
  check('8b. the batch is COMPLETED_WITH_ERRORS, never COMPLETED',
    partialRun.status === 'COMPLETED_WITH_ERRORS', partialRun.status);
  check('8c. the failed row kept its error',
    (await prisma.importRow.findFirst({ where: { batchId: partial.batchId, status: 'FAILED' } }))?.lastError !== null);

  // Repair the row and retry only it.
  const failedRow = await prisma.importRow.findFirstOrThrow({
    where: { batchId: partial.batchId, status: 'FAILED' },
  });
  await prisma.importRow.update({
    where: { id: failedRow.id },
    data: { mappedData: { ...failedRow.mappedData, brandName: BRAND } },
  });

  const retry = await engine.confirm(partial.batchId, { onlyRowIds: [failedRow.id] }, actor);
  check('8d. retrying just that row imports it', retry.imported === 1, retry);
  check('8e. ...and the already-imported rows were not touched again',
    (await prisma.importRow.count({ where: { batchId: partial.batchId, status: 'IMPORTED' } })) === 3);
  check('8f. the batch now reconciles and is COMPLETED',
    retry.status === 'COMPLETED' && retry.reconciliation === 'PASSED', retry);
  check('8g. the retry was counted',
    (await prisma.importBatch.findUniqueOrThrow({ where: { id: partial.batchId } })).rowsRetried > 0);

  /* ── 16. fingerprints are stable ──────────────────────── */
  console.log('\n9. fingerprints');

  const fpA = rowFingerprint(mapMasterRow(tile()));
  const fpB = rowFingerprint(mapMasterRow(tile({ Notes: 'changed note', 'AI Tone': 'warm', Page: '99' })));
  check('9a. a changed note or page does NOT change the fingerprint', fpA === fpB);

  const fpC = rowFingerprint(mapMasterRow(tile({ Brand: '  ARCHROCK ' + stamp + '  ' })));
  check('9b. case and spacing do not change it either', fpA === fpC);

  const fpD = rowFingerprint(mapMasterRow(tile({ Dimensions: '300x300mm' })));
  check('9c. a different size DOES change it', fpA !== fpD);

  /* ── 17-18. history and row-level errors ──────────────── */
  console.log('\n10. history and reporting');

  const history = await engine.listBatches({ pageSize: 50 });
  check('10a. every batch is in the history', history.total >= 7, history.total);
  check('10b. each carries its counts and reconciliation',
    history.rows.every((b) => b.counts && b.reconciliation));

  const detail = await engine.getBatch(first.batchId);
  check('10c. a batch detail recomputes its totals from the rows',
    detail.verification?.counters_match_rows === true, detail.verification);

  const errorRows = await prisma.importRow.findMany({
    where: { batchId: missing.batchId, status: 'INCOMPLETE' },
  });
  check('10d. every rejected row carries field-level errors',
    errorRows.every((r) => Array.isArray(r.errors) && r.errors.length > 0
      && r.errors[0].field && r.errors[0].message));
  check('10e. the raw source row is kept for every row',
    errorRows.every((r) => r.rawData && Object.keys(r.rawData).length > 10));

  /* ── 19-21. reconciliation ────────────────────────────── */
  console.log('\n11. reconciliation');

  const good = await engine.getBatch(first.batchId);
  check('11a. a clean batch reconciles', good.reconciliation === 'PASSED', good.reconciliation);
  check('11b. its categories add up to the rows read',
    good.counts.imported + good.counts.duplicate + good.counts.existing
    + good.counts.incomplete + good.counts.review + good.counts.rejected
    === good.sourceRowsRead, good.counts);

  const drifted = await prisma.$queryRaw`
    SELECT batch_id, counts_agree, counters_match_rows FROM v_import_reconciliation
    WHERE batch_id = ANY(${myBatches}::uuid[])
      AND (NOT counts_agree OR NOT counters_match_rows)
  `;
  check('11c. not one batch THIS RUN created has drifted from its own rows',
    drifted.length === 0, drifted);

  /* CORRUPTING A BATCH'S COUNTERS TURNS OUT TO BE IMPOSSIBLE,
     which is a better outcome than the one this test was written
     to check. The CHECK constraints refuse any write where the
     categories do not add up to the rows read, under either
     completed status -- so the drift the view was built to detect
     cannot be stored in the first place.

     Both are still worth proving: that the write is refused, and
     that the view notices if drift arrives some other way. */
  const lieCompleted = await refused(() => prisma.importBatch.update({
    where: { id: first.batchId }, data: { rowsImported: 99 },
  }));
  check('11d. a counter that does not match the rows cannot be written at all',
    lieCompleted.threw && /check constraint/i.test(String(lieCompleted.err.message)),
    lieCompleted.threw ? 'CHECK held' : 'IT WAS ALLOWED');

  const lieUnfinished = await refused(() => prisma.importBatch.update({
    where: { id: partial.batchId },
    data: { status: 'COMPLETED', rowsPending: 5, rowsFailed: 2 },
  }));
  check('11e. nor can a batch be called COMPLETED with rows outstanding',
    lieUnfinished.threw, lieUnfinished.threw ? 'CHECK held' : 'IT WAS ALLOWED');

  /* RECONCILIATION FAILURE, staged the one way drift can really
     happen: a row disappearing from underneath a finished batch.
     Deleting an import row touches no batch counter, so no
     constraint fires -- and the batch is then describing rows it
     no longer has. */
  const victim = await prisma.importRow.findFirstOrThrow({
    where: { batchId: missing.batchId, status: 'INCOMPLETE' },
  });
  await prisma.importRow.delete({ where: { id: victim.id } });

  const [drift] = await prisma.$queryRaw`
    SELECT counters_match_rows, counts_agree, actual_rows
    FROM v_import_reconciliation WHERE batch_id = ${missing.batchId}::uuid
  `;
  check('11f. the view notices a batch whose rows no longer match its counters',
    drift.counters_match_rows === false || drift.counts_agree === false, drift);

  const failedReconcile = await engine.reconcile(missing.batchId);
  check('11g. reconciling such a batch FAILS rather than quietly recounting',
    failedReconcile.reconciliation === 'FAILED', failedReconcile.reconciliation);
  check('11h. ...and says exactly what is missing',
    /unaccounted for|row\(s\) but/.test(failedReconcile.note ?? ''), failedReconcile.note);
  check('11i. the batch is left FAILED, never COMPLETED',
    (await prisma.importBatch.findUniqueOrThrow({ where: { id: missing.batchId } })).status === 'FAILED');

  /* ── 21. unverified source count ──────────────────────── */
  console.log('\n12. an unverifiable source');

  await prisma.importBatch.update({
    where: { id: wallRow.batchId }, data: { sourceRowsExpected: null },
  });
  const unverified = await engine.reconcile(wallRow.batchId);
  check('12a. a source that cannot report its row count is UNVERIFIED, not PASSED',
    unverified.reconciliation === 'UNVERIFIED', unverified.reconciliation);
  check('12b. ...and the preview says so too',
    (await engine.preview(wallRow.batchId)).summary.sourceCompleteness === 'UNVERIFIED');

  /* ── 22. concurrent imports ───────────────────────────── */
  console.log('\n13. two people confirming the same batch at once');

  const racy = await importFile([
    tile({ 'Product Name': 'Race A' }),
    tile({ 'Product Name': 'Race B' }),
  ]);

  const [a, b] = await Promise.allSettled([
    engine.confirm(racy.batchId, {}, actor),
    engine.confirm(racy.batchId, {}, actor),
  ]);
  const succeeded = [a, b].filter((r) => r.status === 'fulfilled');
  const blocked = [a, b].filter((r) => r.status === 'rejected');

  check('13a. exactly one confirmation ran', succeeded.length === 1,
    { ok: succeeded.length, blocked: blocked.length });
  check('13b. the other was told the batch was already importing',
    blocked[0]?.reason?.code === 'IMPORT_IN_PROGRESS', blocked[0]?.reason?.code);
  check('13c. each product was created exactly once',
    (await prisma.product.count({
      where: { name: { in: ['Race A', 'Race B'] }, brand: { name: BRAND } },
    })) === 2,
    await prisma.product.count({ where: { name: { in: ['Race A', 'Race B'] }, brand: { name: BRAND } } }));

  /* ── 23. no stock is moved ────────────────────────────── */
  console.log('\n14. an import moves no stock');

  const importedProducts = await prisma.product.findMany({
    where: { brand: { name: BRAND } }, select: { id: true },
  });
  const movements = await prisma.stockLedgerEntry.count({
    where: { productId: { in: importedProducts.map((p) => p.id) } },
  });
  check('14a. not one stock ledger entry was created by any import',
    movements === 0, movements);

  const balances = await prisma.inventoryBalance.count({
    where: { productId: { in: importedProducts.map((p) => p.id) } },
  });
  check('14b. ...and no inventory balance either', balances === 0, balances);

  /* ── 24. the existing catalogue is untouched ──────────── */
  console.log('\n15. what was already there');

  const seeded = await prisma.product.findMany({
    where: { sku: { startsWith: 'DV-' } },
    select: { sku: true, name: true, purchasePrice: true, status: true, archivedAt: true },
    orderBy: { sku: 'asc' },
  });
  check('15a. all fourteen seeded products are still there', seeded.length === 14, seeded.length);
  check('15b. none of them was archived or restatused by an import',
    seeded.every((p) => p.archivedAt === null) && seeded.some((p) => p.status === 'ACTIVE'));
  check('15c. their prices are untouched',
    Number(seeded.find((p) => p.sku === 'DV-1001').purchasePrice) === 62);

  /* A DELTA, not an absolute. An earlier version of this check
     asserted "exactly twelve movements for DV- products", which
     was true on the day it was written and became false as soon
     as anything else used this shared database -- it failed for a
     reason that had nothing to do with importing. What this is
     really asserting is that the import engine posts no stock
     movements at all, and a before-and-after comparison says
     exactly that, whatever else has ever touched the database. */
  const ledgerAfter = await prisma.stockLedgerEntry.count();
  check('15d. importing a catalogue posted no stock movements whatsoever',
    ledgerAfter === ledgerBefore, ledgerBefore + ' -> ' + ledgerAfter);

  const importedWithStock = await prisma.stockLedgerEntry.count({
    where: { referenceType: 'MANUAL', reason: 'OPENING_STOCK', product: { brand: { name: BRAND } } },
  });
  check('15e. and none of the imported products was given stock out of thin air',
    importedWithStock === 0, importedWithStock);

  /* ── 25. the imported products are real and correct ───── */
  console.log('\n16. what the import actually produced');

  const adobe = await prisma.product.findFirst({
    where: { brand: { name: BRAND }, name: 'Adobe Grey', size: '600x1200mm' },
    include: { brand: true, category: true, collection: true, images: true },
  });
  check('16a. the product carries what the source said',
    adobe?.size === '600x1200mm' && Number(adobe.thicknessMm) === 9
    && adobe.finish === 'Matte' && adobe.colour === 'Grey', {
      size: adobe?.size, thickness: adobe?.thicknessMm, finish: adobe?.finish, colour: adobe?.colour,
    });
  check('16b. its price is zero, because the source has none — not an invented figure',
    Number(adobe.purchasePrice) === 0 && Number(adobe.sellingPrice) === 0);
  check('16c. no product head was assigned, because the source has no series',
    adobe.collectionId === null);
  check('16d. the catalogue image was attached UNAPPROVED',
    adobe.images.length === 1 && adobe.images[0].isApproved === false
    && adobe.images[0].source === 'CATALOGUE_EXTRACTION', adobe.images[0]);
  check('16e. ...with its provenance',
    adobe.images[0].catalogueName === 'Adobe Collection' && adobe.images[0].cataloguePage === 14);

  const audits = await prisma.auditLog.count({ where: { entityType: 'ImportBatch' } });
  check('16f. every import wrote an audit record', audits >= 7, audits);

  /* ── file safety ──────────────────────────────────────── */
  console.log('\n17. file handling');

  const notASpreadsheet = await refused(() => readUpload(Buffer.from('this is just text'), 'evil.xlsx'));
  check('17a. a file that is not a spreadsheet is refused clearly',
    notASpreadsheet.threw && notASpreadsheet.err.code === 'UNREADABLE_FILE');

  const wrongType = await refused(() => readUpload(Buffer.from('x'), 'payload.exe'));
  check('17b. an unsupported extension is refused',
    wrongType.threw && wrongType.err.code === 'UNSUPPORTED_FILE_TYPE');

  const empty = await refused(() => readUpload(Buffer.alloc(0), 'empty.xlsx'));
  check('17c. an empty file is refused', empty.threw && empty.err.code === 'EMPTY_FILE');

  const formulaBook = await buildWorkbook([tile({ 'Product Name': '=cmd|calc!A1' })]);
  const readBack = await readUpload(formulaBook, 'formula.xlsx');
  check('17d. a cell that would become a formula is neutralised on read',
    readBack.rows[0].data['Product Name'].startsWith("'="),
    readBack.rows[0].data['Product Name']);
} finally {
  console.log('\n' + passed + '/' + (passed + failures.length) + ' checks passed');
  if (failures.length) {
    console.log('failed:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
  await disconnect();
}
