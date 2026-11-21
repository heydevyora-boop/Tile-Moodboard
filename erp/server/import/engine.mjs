import { prisma } from '../../db/client.mjs';
import { mapMasterRow, inferCategoryCode, FIELDS_ABSENT_FROM_SOURCE } from './mapping.mjs';
import { rowFingerprint, classify } from './duplicates.mjs';
import { readUpload, describeHeaders, readGoogleSheet, googleSheetsConfig } from './sources.mjs';
import { validateProduct } from '../services/productRules.mjs';
import * as productService from '../services/product.service.mjs';
import * as brandService from '../services/brand.service.mjs';
import { record } from '../services/audit.mjs';
import { nextDocumentNumber } from '../../db/stock.mjs';
import { AppError, NotFoundError } from '../errors.mjs';

/* ============================================================
   THE IMPORT ENGINE
   ============================================================

       read  ->  map  ->  validate  ->  classify  ->  PREVIEW
                                                        |
                                            explicit confirmation
                                                        |
                                                     import
                                                        |
                                                  reconcile

   NOTHING IS WRITTEN TO THE PRODUCT MASTER BEFORE THE PREVIEW IS
   CONFIRMED. Reading, mapping, validating and classifying all
   happen first and are stored on the batch; `confirm` is the only
   function that creates a product, and it only acts on rows the
   preview already marked importable.

   IT GOES THROUGH THE PRODUCT MASTER SERVICES, not around them.
   productService.create() does the category-aware validation, the
   SKU allocation, the duplicate check and the audit row. An
   import that wrote to `products` directly would be a second,
   weaker set of rules — and the weaker one always wins, because
   it is the one that loads nine hundred rows at a time.
   ============================================================ */

/** Final row states, and the batch counter each feeds. */
const FINAL_STATUS_COUNTER = {
  IMPORTED: 'rowsImported',
  SKIPPED_DUPLICATE: 'rowsDuplicate',
  SKIPPED_EXISTING: 'rowsExisting',
  INCOMPLETE: 'rowsIncomplete',
  REVIEW_REQUIRED: 'rowsReview',
  REJECTED: 'rowsRejected',
  FAILED: 'rowsFailed',
};

/* ── 1. READ AND PREPARE ─────────────────────────────────── */

/**
 * Create a batch, read the source, map, validate and classify
 * every row. Writes nothing to the Product Master.
 */
export async function prepare({ sourceType, buffer, filename, sheetName }, actor) {
  const source = sourceType === 'GOOGLE_SHEETS'
    ? await readGoogleSheet()                 // throws: not verified
    : await readUpload(buffer, filename, sheetName);

  const batchNo = await nextDocumentNumber('IMPORT_BATCH');

  const batch = await prisma.importBatch.create({
    data: {
      batchNo,
      sourceType,
      sourceRef: filename ?? googleSheetsConfig().spreadsheetId ?? 'unknown',
      sourceSheet: source.sheetName,
      sourceFingerprint: source.fingerprint,
      sourceRowsExpected: source.sourceRowsExpected,
      status: 'READING',
      startedById: actor?.id ?? null,
    },
  });

  const headerReport = describeHeaders(source.headers);

  // Rows are written in one transaction so a batch is never half
  // read: either every row is there to be previewed, or the batch
  // failed and nothing is.
  const prepared = [];
  const seenFingerprints = new Set();

  for (const row of source.rows) {
    const mapped = mapMasterRow(row.data);
    const fingerprint = rowFingerprint(mapped);

    /* THE SAME PRODUCT TWICE IN ONE FILE. The database would
       refuse the second on (batchId, fingerprint), which would
       fail the whole batch. Caught here instead and recorded as
       what it is. */
    const repeated = seenFingerprints.has(fingerprint);
    seenFingerprints.add(fingerprint);

    prepared.push({ row, mapped, fingerprint, repeated });
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: 'VALIDATING', sourceRowsRead: prepared.length },
  });

  const categories = await prisma.productCategory.findMany({ select: { id: true, code: true, name: true } });
  const byCode = new Map(categories.map((c) => [c.code, c]));

  const rowRecords = [];
  for (const { row, mapped, fingerprint, repeated } of prepared) {
    const assessment = repeated
      ? {
        status: 'SKIPPED_DUPLICATE',
        classification: 'EXACT_DUPLICATE',
        errors: [{ field: '(row)', message: 'The same product appears earlier in this same file.' }],
        matchedProductId: null,
      }
      : await assess(mapped, byCode, batch.id);

    rowRecords.push({
      batchId: batch.id,
      sourceRowNumber: row.sourceRowNumber,
      fingerprint: repeated ? fingerprint + ':dup:' + row.sourceRowNumber : fingerprint,
      rawData: row.data,
      mappedData: mapped,
      status: assessment.status,
      classification: assessment.classification,
      errors: assessment.errors.length ? assessment.errors : undefined,
      matchedProductId: assessment.matchedProductId,
    });
  }

  await prisma.importRow.createMany({ data: rowRecords });
  await refreshCounters(batch.id, 'PREVIEW_READY');

  await record(prisma, {
    entityType: 'ImportBatch',
    entityId: batch.id,
    action: 'IMPORT',
    actorUserId: actor?.id,
    summary: 'Read ' + rowRecords.length + ' row(s) from ' + (filename ?? source.sheetName)
      + ' into batch ' + batchNo + '. Nothing imported yet.',
  });

  return { batchId: batch.id, batchNo, headerReport };
}

/** Validate and classify one mapped row. No writes. */
async function assess(mapped, categoriesByCode, batchId) {
  const errors = [];

  // ── the three that are mandatory whatever the product is ──
  if (!mapped.brandName) errors.push({ field: 'Brand', message: 'Brand is missing.' });
  if (!mapped.name) errors.push({ field: 'Product Name', message: 'Product name is missing.' });
  if (!mapped.size) {
    errors.push({
      field: 'Dimensions',
      message: 'Size is missing. Neither "Dimensions" nor both "Length" and "Width" were given.',
    });
  }

  if (errors.length > 0) {
    // INCOMPLETE, not REJECTED. The row is not wrong, it is
    // unfinished: fill the gap in the sheet and re-import, and it
    // will come through.
    return { status: 'INCOMPLETE', classification: null, errors, matchedProductId: null };
  }

  // ── the category decides the rest ────────────────────────
  const code = inferCategoryCode(mapped);
  const category = code ? categoriesByCode.get(code) : null;
  if (!category) {
    return {
      status: 'REVIEW_REQUIRED',
      classification: null,
      errors: [{
        field: 'Floor / Wall',
        message: 'The source does not say whether this is a floor or a wall product, so its '
          + 'category cannot be decided. Choose one before importing.',
      }],
      matchedProductId: null,
    };
  }

  // The SAME rules the Product Master applies by hand, so an
  // imported product is held to exactly the standard a typed one
  // is. Two standards would mean imports quietly lowering the bar.
  try {
    validateProduct({
      brandId: 'pending',          // resolved at import; presence is what is checked
      name: mapped.name,
      size: mapped.size,
      thicknessMm: mapped.thicknessMm,
      finish: mapped.finish,
      colour: mapped.colour,
    }, category.code);
  } catch (err) {
    return {
      status: 'INCOMPLETE',
      classification: null,
      errors: (err.fields ?? []).map((f) => ({
        field: sourceColumnFor(f.field),
        message: f.message,
      })),
      matchedProductId: null,
    };
  }

  // ── already in the ERP? ──────────────────────────────────
  const verdict = await classify(mapped, { batchId });

  if (verdict.classification === 'EXACT_DUPLICATE') {
    return {
      status: 'SKIPPED_DUPLICATE',
      classification: verdict.classification,
      errors: [{ field: '(row)', message: verdict.reason }],
      matchedProductId: verdict.matchedProductId,
    };
  }
  if (verdict.classification === 'EXISTING_RECORD') {
    return {
      status: 'SKIPPED_EXISTING',
      classification: verdict.classification,
      errors: [{
        field: 'SKU / Product Code',
        message: verdict.reason
          + ' Not overwritten: this phase has no approved update rule.',
      }],
      matchedProductId: verdict.matchedProductId,
    };
  }
  if (verdict.classification === 'POSSIBLE_DUPLICATE') {
    return {
      status: 'REVIEW_REQUIRED',
      classification: verdict.classification,
      errors: [{ field: '(row)', message: verdict.reason, candidates: verdict.candidates }],
      matchedProductId: null,
    };
  }

  return { status: 'VALID', classification: 'NEW_RECORD', errors: [], matchedProductId: null };
}

/** Name the SOURCE column, not the ERP field, in an error a
 *  person will go and fix in their spreadsheet. */
function sourceColumnFor(erpField) {
  return {
    brandId: 'Brand',
    name: 'Product Name',
    size: 'Dimensions',
    thicknessMm: 'Thickness',
    finish: 'Resolved Finish',
    colour: 'AI Color',
  }[erpField] ?? erpField;
}

/* ── 2. PREVIEW ──────────────────────────────────────────── */

export async function preview(batchId, { page = 1, pageSize = 50, status } = {}) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError('Import batch');

  const where = { batchId, ...(status ? { status } : {}) };
  const [rows, total, byStatus, byClass] = await Promise.all([
    prisma.importRow.findMany({
      where,
      orderBy: { sourceRowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        matchedProduct: { select: { id: true, sku: true, name: true } },
        createdProduct: { select: { id: true, sku: true, name: true } },
      },
    }),
    prisma.importRow.count({ where }),
    prisma.importRow.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } }),
    /* Counted SEPARATELY from status, because REVIEW_REQUIRED
       covers two unrelated things: a row that looks like an
       existing product, and a row whose category the source did
       not state. Reporting both as "possible duplicates" told the
       reviewer something untrue about what they were looking at. */
    prisma.importRow.groupBy({ by: ['classification'], where: { batchId }, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
  const classes = Object.fromEntries(byClass.map((c) => [c.classification, c._count._all]));
  const willImport = counts.VALID ?? 0;

  return {
    batch: shapeBatch(batch),
    summary: {
      sourceRowsExpected: batch.sourceRowsExpected,
      sourceRowsRead: batch.sourceRowsRead,
      sourceCompleteness: batch.sourceRowsExpected === null
        ? 'UNVERIFIED'
        : (batch.sourceRowsExpected === batch.sourceRowsRead ? 'VERIFIED' : 'MISMATCH'),
      valid: willImport,
      newProducts: classes.NEW_RECORD ?? 0,
      existingProducts: counts.SKIPPED_EXISTING ?? 0,
      possibleDuplicates: classes.POSSIBLE_DUPLICATE ?? 0,
      exactDuplicates: counts.SKIPPED_DUPLICATE ?? 0,
      missingMandatory: counts.INCOMPLETE ?? 0,
      // Everything a person has to look at, for whatever reason:
      // a possible duplicate OR an undecidable category.
      requiringReview: counts.REVIEW_REQUIRED ?? 0,
      invalid: counts.REJECTED ?? 0,
      failed: counts.FAILED ?? 0,
      willBeImported: willImport,
      willNotBeImported: batch.sourceRowsRead - willImport,
    },
    rows: rows.map(shapeRow),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    /* Said on every preview, because it is the question somebody
       will eventually ask of an imported product: why has it no
       price and no series? */
    fieldsNotInSource: FIELDS_ABSENT_FROM_SOURCE,
  };
}

/* ── 3. IMPORT ───────────────────────────────────────────── */

/**
 * Import the rows the preview marked VALID.
 *
 * @param {string[]} [onlyRowIds]  a subset, for retrying or for
 *        importing only the rows a person has reviewed.
 */
export async function confirm(batchId, { onlyRowIds, includeReviewed = false } = {}, actor) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError('Import batch');

  if (!['PREVIEW_READY', 'COMPLETED_WITH_ERRORS', 'IMPORTING'].includes(batch.status)) {
    throw new AppError(
      'Batch ' + batch.batchNo + ' is ' + batch.status + ' and cannot be imported.',
      { status: 409, code: 'BATCH_NOT_IMPORTABLE' },
    );
  }

  /* ONE IMPORT AT A TIME PER BATCH. Two confirmations racing
     would both read the same VALID rows and both try to create
     the same products; the unique SKU constraint would catch most
     of it and the counters would be wrong either way. The status
     move is the lock: the second caller finds IMPORTING. */
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, status: batch.status },
    data: { status: 'IMPORTING' },
  });
  if (claimed.count === 0) {
    throw new AppError(
      'Batch ' + batch.batchNo + ' is already being imported.',
      { status: 409, code: 'IMPORT_IN_PROGRESS' },
    );
  }

  const importable = ['VALID', 'FAILED', ...(includeReviewed ? ['REVIEW_REQUIRED'] : [])];
  const rows = await prisma.importRow.findMany({
    where: {
      batchId,
      status: { in: importable },
      ...(onlyRowIds?.length ? { id: { in: onlyRowIds } } : {}),
    },
    orderBy: { sourceRowNumber: 'asc' },
  });

  let imported = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const product = await importOneRow(row, actor);
      await prisma.importRow.update({
        where: { id: row.id },
        data: {
          status: 'IMPORTED',
          classification: 'NEW_RECORD',
          createdProductId: product.id,
          attempts: { increment: 1 },
          processedAt: new Date(),
          lastError: null,
          errors: undefined,
        },
      });
      imported += 1;
    } catch (err) {
      /* ONE BAD ROW MUST NOT COST THE BATCH. Each row is its own
         transaction inside importOneRow, so a failure rolls back
         that row and nothing else; it is marked FAILED with the
         reason and can be retried on its own. */
      await prisma.importRow.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          processedAt: new Date(),
          lastError: String(err.message ?? err).slice(0, 1000),
          errors: err.fields ?? undefined,
        },
      });
      failed += 1;
    }
  }

  const retried = rows.filter((r) => r.attempts > 0).length;
  if (retried > 0) {
    await prisma.importBatch.update({
      where: { id: batchId },
      data: { rowsRetried: { increment: retried } },
    });
  }

  const result = await reconcile(batchId);

  await record(prisma, {
    entityType: 'ImportBatch',
    entityId: batchId,
    action: 'IMPORT',
    actorUserId: actor?.id,
    summary: 'Batch ' + batch.batchNo + ': imported ' + imported + ', failed ' + failed
      + '. Reconciliation ' + result.reconciliation + '.',
  });

  return { imported, failed, ...result };
}

/**
 * One row, one transaction, through the Product Master services.
 *
 * NO STOCK IS MOVED. Importing a product says the studio sells
 * it; it says nothing about how many are on the shelf. Stock
 * arrives through the ledger, which is a later phase, and there
 * is no call from here that could write one.
 */
async function importOneRow(row, actor) {
  const mapped = row.mappedData;

  // The brand, found or created. Created with confirmDistinct so
  // a near-match does not stop an import mid-flight -- the import
  // preview is where that judgement belongs, and an exact
  // duplicate is still refused by the service.
  let brand = await prisma.brand.findFirst({
    where: { name: { equals: mapped.brandName, mode: 'insensitive' } },
    select: { id: true, name: true, code: true },
  });
  if (!brand) {
    brand = await brandService.create({ name: mapped.brandName, confirmDistinct: true }, actor);
  }

  const categoryCode = inferCategoryCode(mapped);
  const category = await prisma.productCategory.findUnique({ where: { code: categoryCode } });
  if (!category) {
    throw new AppError('No ERP category matches "' + categoryCode + '".', { status: 422, code: 'NO_CATEGORY' });
  }

  /* THE PRODUCT HEAD IS LEFT UNSET, deliberately. The source's
     "Catalog" is the PDF a product was found in, not a series: a
     PDF may hold several series and a series may span PDFs.
     Assigning one from it would scatter variants across heads
     that do not exist, which is exactly the mistake the hierarchy
     is built to prevent. A person assigns it afterwards. */
  const product = await productService.create({
    name: mapped.name,
    brandId: brand.id,
    categoryId: category.id,
    size: mapped.size,
    lengthMm: mapped.lengthMm ?? undefined,
    widthMm: mapped.widthMm ?? undefined,
    thicknessMm: mapped.thicknessMm ?? undefined,
    finish: mapped.finish ?? undefined,
    colour: mapped.colour ?? undefined,
    // No price in the source. Left at zero rather than invented,
    // and the preview says so out loud.
    purchasePrice: 0,
    sellingPrice: 0,
    imageUrl: mapped.imageUrl ?? undefined,
    // The source SKU where there is one; otherwise generated.
    ...(mapped.sourceSku ? { sku: mapped.sourceSku } : {}),
    confirmDistinct: true,
  }, actor);

  // The catalogue image, UNAPPROVED. An extracted crop is not a
  // product image until a person says so -- the database CHECK
  // from step 3 forbids an unapproved image being MAIN anyway.
  if (mapped.imageUrl) {
    await prisma.productImage.create({
      data: {
        productId: product.id,
        url: mapped.imageUrl,
        role: 'GALLERY',
        source: 'CATALOGUE_EXTRACTION',
        isApproved: false,
        catalogueName: mapped.catalogueName ?? null,
        cataloguePage: mapped.cataloguePage ?? null,
        extractionRef: mapped.extractionRef ?? null,
        uploadedById: actor?.id ?? null,
      },
    });
  }

  return product;
}

/* ── 4. RECONCILE ────────────────────────────────────────── */

/**
 * Recount from the rows, compare, and decide the batch's fate.
 *
 * A batch is COMPLETED only when every row read is in exactly one
 * final category and those add up. Anything else is told the
 * truth: COMPLETED_WITH_ERRORS, or FAILED with the discrepancy.
 */
export async function reconcile(batchId) {
  /* COUNTED FIRST, WRITTEN ONCE.
     An earlier version wrote the counters and then the status in
     two updates, and that made the one case this function exists
     for impossible: a batch that has genuinely lost a row has
     counters that no longer sum to the rows read, so the CHECK
     constraint refused the first write and reconcile() threw
     instead of marking the batch FAILED. Counters and status go
     in together, and FAILED is the status under which they are
     allowed not to add up -- which is the whole point of it. */
  const counters = await computeCounters(batchId);
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });

  const finalTotal = counters.rowsImported + counters.rowsDuplicate + counters.rowsExisting
    + counters.rowsIncomplete + counters.rowsReview + counters.rowsRejected;
  const unfinished = counters.rowsFailed + counters.rowsPending;
  const accounted = finalTotal + unfinished;

  let reconciliation;
  let note = null;

  if (accounted !== batch.sourceRowsRead) {
    reconciliation = 'FAILED';
    note = 'Rows read: ' + batch.sourceRowsRead + '. Rows accounted for: ' + accounted
      + '. ' + Math.abs(batch.sourceRowsRead - accounted) + ' row(s) are unaccounted for.';
  } else if (batch.sourceRowsExpected === null) {
    /* The source could not say how many rows it had, so "did we
       read all of them?" is genuinely unanswerable. Reported as
       UNVERIFIED rather than PASSED: a check that cannot fail is
       not a check. */
    reconciliation = 'UNVERIFIED';
    note = 'The source did not report a row count, so completeness cannot be verified.';
  } else if (batch.sourceRowsExpected !== batch.sourceRowsRead) {
    reconciliation = 'FAILED';
    note = 'The source has ' + batch.sourceRowsExpected + ' row(s) but '
      + batch.sourceRowsRead + ' were read.';
  } else {
    reconciliation = 'PASSED';
  }

  const status = reconciliation === 'FAILED' ? 'FAILED'
    : unfinished > 0 ? 'COMPLETED_WITH_ERRORS'
      : (counters.rowsRejected + counters.rowsIncomplete + counters.rowsReview) > 0
        ? 'COMPLETED_WITH_ERRORS'
        : 'COMPLETED';

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      ...counters,
      status,
      reconciliation,
      reconciliationNote: note,
      completedAt: new Date(),
      errorSummary: unfinished > 0
        ? counters.rowsFailed + ' row(s) failed and can be retried.'
        : null,
    },
  });

  return {
    status,
    reconciliation,
    note,
    counters,
    sourceRowsRead: batch.sourceRowsRead,
    sourceRowsExpected: batch.sourceRowsExpected,
  };
}

/** Count the rows. Reads only — writes nothing. */
async function computeCounters(batchId) {
  const grouped = await prisma.importRow.groupBy({
    by: ['status'], where: { batchId }, _count: { _all: true },
  });
  const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));

  return {
    rowsValid: by.VALID ?? 0,
    rowsImported: by.IMPORTED ?? 0,
    rowsDuplicate: by.SKIPPED_DUPLICATE ?? 0,
    rowsExisting: by.SKIPPED_EXISTING ?? 0,
    rowsIncomplete: by.INCOMPLETE ?? 0,
    rowsReview: by.REVIEW_REQUIRED ?? 0,
    rowsRejected: by.REJECTED ?? 0,
    rowsFailed: by.FAILED ?? 0,
    // A row that is valid has not been dealt with yet: it is
    // waiting for somebody to confirm the import.
    rowsPending: (by.PENDING ?? 0) + (by.VALID ?? 0),
  };
}

/** Count the rows and store the result. Used on the preview
 *  path, where the batch is not yet in a status whose totals the
 *  database constrains. */
async function refreshCounters(batchId, status) {
  const counters = await computeCounters(batchId);
  await prisma.importBatch.update({
    where: { id: batchId },
    data: { ...counters, ...(status ? { status } : {}) },
  });
  return counters;
}

/* ── 5. HISTORY ──────────────────────────────────────────── */

export async function listBatches({ page = 1, pageSize = 25 } = {}) {
  const [rows, total] = await Promise.all([
    prisma.importBatch.findMany({
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { startedBy: { select: { name: true, email: true } } },
    }),
    prisma.importBatch.count(),
  ]);
  return {
    rows: rows.map(shapeBatch),
    page, pageSize, total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getBatch(batchId) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { startedBy: { select: { name: true, email: true } } },
  });
  if (!batch) throw new NotFoundError('Import batch');

  const [check] = await prisma.$queryRaw`
    SELECT counts_agree, counters_match_rows, source_count_unverified, actual_rows
    FROM v_import_reconciliation WHERE batch_id = ${batchId}::uuid
  `;

  return {
    ...shapeBatch(batch),
    // Recomputed from the rows, beside the stored counters, so a
    // drift between the two is visible rather than trusted away.
    verification: check ?? null,
  };
}

export function shapeBatch(b) {
  return {
    id: b.id,
    batchNo: b.batchNo,
    sourceType: b.sourceType,
    sourceRef: b.sourceRef,
    sourceSheet: b.sourceSheet,
    status: b.status,
    reconciliation: b.reconciliation,
    reconciliationNote: b.reconciliationNote,
    sourceRowsExpected: b.sourceRowsExpected,
    sourceRowsRead: b.sourceRowsRead,
    counts: {
      valid: b.rowsValid,
      imported: b.rowsImported,
      duplicate: b.rowsDuplicate,
      existing: b.rowsExisting,
      incomplete: b.rowsIncomplete,
      review: b.rowsReview,
      rejected: b.rowsRejected,
      failed: b.rowsFailed,
      pending: b.rowsPending,
      retried: b.rowsRetried,
    },
    errorSummary: b.errorSummary,
    startedBy: b.startedBy?.name ?? null,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
  };
}

function shapeRow(r) {
  return {
    id: r.id,
    sourceRowNumber: r.sourceRowNumber,
    status: r.status,
    classification: r.classification,
    errors: r.errors ?? [],
    attempts: r.attempts,
    lastError: r.lastError,
    matchedProduct: r.matchedProduct ?? null,
    createdProduct: r.createdProduct ?? null,
    // Only the fields a reviewer needs; the raw row is available
    // in the row detail rather than in every list response.
    summary: {
      brand: r.mappedData?.brandName ?? null,
      name: r.mappedData?.name ?? null,
      size: r.mappedData?.size ?? null,
      colour: r.mappedData?.colour ?? null,
      finish: r.mappedData?.finish ?? null,
      sourceSku: r.mappedData?.sourceSku ?? null,
    },
  };
}
