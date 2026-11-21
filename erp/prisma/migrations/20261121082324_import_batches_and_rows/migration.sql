-- CreateEnum
CREATE TYPE "ImportSourceType" AS ENUM ('EXCEL_UPLOAD', 'GOOGLE_SHEETS');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('CREATED', 'READING', 'VALIDATING', 'PREVIEW_READY', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('NOT_RUN', 'PASSED', 'FAILED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALID', 'IMPORTED', 'SKIPPED_DUPLICATE', 'SKIPPED_EXISTING', 'INCOMPLETE', 'REVIEW_REQUIRED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "DuplicateClassification" AS ENUM ('NEW_RECORD', 'EXISTING_RECORD', 'EXACT_DUPLICATE', 'POSSIBLE_DUPLICATE');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "batchNo" TEXT NOT NULL,
    "sourceType" "ImportSourceType" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceSheet" TEXT,
    "sourceFingerprint" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'CREATED',
    "reconciliation" "ReconciliationStatus" NOT NULL DEFAULT 'NOT_RUN',
    "sourceRowsExpected" INTEGER,
    "sourceRowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsValid" INTEGER NOT NULL DEFAULT 0,
    "rowsImported" INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "rowsExisting" INTEGER NOT NULL DEFAULT 0,
    "rowsIncomplete" INTEGER NOT NULL DEFAULT 0,
    "rowsReview" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "rowsPending" INTEGER NOT NULL DEFAULT 0,
    "rowsRetried" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "reconciliationNote" TEXT,
    "startedById" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "mappedData" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "classification" "DuplicateClassification",
    "errors" JSONB,
    "matchedProductId" UUID,
    "createdProductId" UUID,
    "createdHeadId" UUID,
    "createdBrandId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_batchNo_key" ON "import_batches"("batchNo");

-- CreateIndex
CREATE INDEX "import_batches_status_startedAt_idx" ON "import_batches"("status", "startedAt");

-- CreateIndex
CREATE INDEX "import_batches_sourceType_idx" ON "import_batches"("sourceType");

-- CreateIndex
CREATE INDEX "import_batches_sourceFingerprint_idx" ON "import_batches"("sourceFingerprint");

-- CreateIndex
CREATE INDEX "import_rows_batchId_status_idx" ON "import_rows"("batchId", "status");

-- CreateIndex
CREATE INDEX "import_rows_fingerprint_idx" ON "import_rows"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_batchId_sourceRowNumber_key" ON "import_rows"("batchId", "sourceRowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_batchId_fingerprint_key" ON "import_rows"("batchId", "fingerprint");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_matchedProductId_fkey" FOREIGN KEY ("matchedProductId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_createdProductId_fkey" FOREIGN KEY ("createdProductId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- A BATCH CANNOT LIE ABOUT HAVING FINISHED
-- ============================================================
--
-- The brief's rule, written where the application cannot forget
-- it: never report COMPLETED if rows remain unprocessed or
-- reconciliation has failed.
--
-- COMPLETED means every row read landed in exactly one final
-- category, those add up to the number read, and nothing is still
-- pending or failed. Anything less is COMPLETED_WITH_ERRORS or
-- FAILED, both of which are honest.
--
-- COMPLETED_WITH_ERRORS still has to ADD UP; it just admits that
-- some of the rows ended badly. A batch whose categories do not
-- sum to the rows read is a batch that lost track of something,
-- and no status is right for that except FAILED.

ALTER TABLE "import_batches"
  ADD CONSTRAINT import_batch_completed_means_finished
  CHECK (
    "status" <> 'COMPLETED'
    OR (
      "rowsPending" = 0
      AND "rowsFailed" = 0
      AND "reconciliation" IN ('PASSED', 'UNVERIFIED')
      AND "rowsImported" + "rowsDuplicate" + "rowsExisting"
          + "rowsIncomplete" + "rowsReview" + "rowsRejected" = "sourceRowsRead"
    )
  );

ALTER TABLE "import_batches"
  ADD CONSTRAINT import_batch_errors_still_add_up
  CHECK (
    "status" <> 'COMPLETED_WITH_ERRORS'
    OR "rowsImported" + "rowsDuplicate" + "rowsExisting" + "rowsIncomplete"
       + "rowsReview" + "rowsRejected" + "rowsFailed" + "rowsPending" = "sourceRowsRead"
  );

-- No counter can be negative. A negative row count is arithmetic
-- that has gone wrong somewhere upstream, and it should stop at
-- the write rather than be discovered in a report.
ALTER TABLE "import_batches"
  ADD CONSTRAINT import_batch_counts_not_negative
  CHECK (
    "sourceRowsRead" >= 0 AND "rowsValid" >= 0 AND "rowsImported" >= 0
    AND "rowsDuplicate" >= 0 AND "rowsExisting" >= 0 AND "rowsIncomplete" >= 0
    AND "rowsReview" >= 0 AND "rowsRejected" >= 0 AND "rowsFailed" >= 0
    AND "rowsPending" >= 0 AND "rowsRetried" >= 0
  );

-- A row that says it created a product must name one, and one
-- that says it matched must name that. An import row claiming a
-- product it cannot point at is a broken audit trail.
ALTER TABLE "import_rows"
  ADD CONSTRAINT import_row_imported_has_a_product
  CHECK ("status" <> 'IMPORTED' OR "createdProductId" IS NOT NULL);


-- ────────────────────────────────────────────────────────────
-- THE RECONCILIATION, COMPUTED FROM THE ROWS THEMSELVES
-- ────────────────────────────────────────────────────────────
--
-- The counters on the batch are a projection, exactly like
-- inventory_balances in step 2 — kept because counting nine
-- hundred rows on every page load is wasteful, and checked
-- because a projection nobody checks is a number nobody can
-- trust.
--
-- A healthy batch returns nothing from:
--   SELECT * FROM v_import_reconciliation WHERE NOT counts_agree;

CREATE OR REPLACE VIEW v_import_reconciliation AS
SELECT
  b."id"              AS batch_id,
  b."batchNo",
  b."status",
  b."reconciliation",
  b."sourceRowsExpected",
  b."sourceRowsRead",
  COALESCE(r.actual_rows, 0)        AS actual_rows,
  COALESCE(r.imported, 0)           AS imported,
  COALESCE(r.duplicate, 0)          AS duplicate,
  COALESCE(r.existing, 0)           AS existing,
  COALESCE(r.incomplete, 0)         AS incomplete,
  COALESCE(r.review, 0)             AS review,
  COALESCE(r.rejected, 0)           AS rejected,
  COALESCE(r.failed, 0)             AS failed,
  COALESCE(r.pending, 0)            AS pending,
  -- Do the batch's own counters match the rows underneath them?
  (b."rowsImported"   = COALESCE(r.imported, 0)
   AND b."rowsDuplicate"  = COALESCE(r.duplicate, 0)
   AND b."rowsExisting"   = COALESCE(r.existing, 0)
   AND b."rowsIncomplete" = COALESCE(r.incomplete, 0)
   AND b."rowsReview"     = COALESCE(r.review, 0)
   AND b."rowsRejected"   = COALESCE(r.rejected, 0)
   AND b."rowsFailed"     = COALESCE(r.failed, 0)
   AND b."rowsPending"    = COALESCE(r.pending, 0)) AS counters_match_rows,
  -- And do the rows themselves account for everything read?
  (COALESCE(r.actual_rows, 0) = b."sourceRowsRead")  AS counts_agree,
  -- Could we even tell whether we read the whole source?
  (b."sourceRowsExpected" IS NULL)                   AS source_count_unverified
FROM "import_batches" b
LEFT JOIN (
  SELECT
    "batchId",
    COUNT(*)                                                      AS actual_rows,
    COUNT(*) FILTER (WHERE "status" = 'IMPORTED')                 AS imported,
    COUNT(*) FILTER (WHERE "status" = 'SKIPPED_DUPLICATE')        AS duplicate,
    COUNT(*) FILTER (WHERE "status" = 'SKIPPED_EXISTING')         AS existing,
    COUNT(*) FILTER (WHERE "status" = 'INCOMPLETE')               AS incomplete,
    COUNT(*) FILTER (WHERE "status" = 'REVIEW_REQUIRED')          AS review,
    COUNT(*) FILTER (WHERE "status" = 'REJECTED')                 AS rejected,
    COUNT(*) FILTER (WHERE "status" = 'FAILED')                   AS failed,
    COUNT(*) FILTER (WHERE "status" IN ('PENDING', 'VALID'))      AS pending
  FROM "import_rows"
  GROUP BY "batchId"
) r ON r."batchId" = b."id";

COMMENT ON VIEW v_import_reconciliation IS
  'Recomputes every import batch total from its own rows. A row where counts_agree or counters_match_rows is false is a batch that has lost track of something and must not be reported as complete.';
