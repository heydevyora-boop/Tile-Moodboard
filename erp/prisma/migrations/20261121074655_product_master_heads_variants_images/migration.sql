-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('MANUAL_UPLOAD', 'CATALOGUE_EXTRACTION', 'CATALOGUE_REFERENCE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ImageRole" AS ENUM ('MAIN', 'GALLERY', 'CATALOGUE_PAGE');

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" UUID,
ADD COLUMN     "attributes" JSONB;

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "storageRef" TEXT,
    "role" "ImageRole" NOT NULL DEFAULT 'GALLERY',
    "source" "ImageSource" NOT NULL DEFAULT 'MANUAL_UPLOAD',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "altText" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "catalogueName" TEXT,
    "cataloguePage" INTEGER,
    "extractionRef" TEXT,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_images_productId_role_sortOrder_idx" ON "product_images"("productId", "role", "sortOrder");

-- CreateIndex
CREATE INDEX "product_images_isApproved_idx" ON "product_images"("isApproved");

-- CreateIndex
CREATE INDEX "product_images_extractionRef_idx" ON "product_images"("extractionRef");

-- CreateIndex
CREATE INDEX "collections_categoryId_idx" ON "collections"("categoryId");

-- CreateIndex
CREATE INDEX "products_archivedAt_idx" ON "products"("archivedAt");

-- CreateIndex
CREATE INDEX "products_colour_idx" ON "products"("colour");

-- CreateIndex
CREATE INDEX "products_finish_idx" ON "products"("finish");

-- CreateIndex
CREATE INDEX "products_size_idx" ON "products"("size");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- STEP 3 GUARDS: THE DUPLICATES A UNIQUE COLUMN DOES NOT CATCH
-- ============================================================

-- A BRAND IS ITS NAME, however it was typed.
--
-- "name" is already unique, which stops the second "Kajaria" and
-- nothing else. "kajaria", "Kajaria " and "KAJARIA" all pass that
-- constraint and all create a fourth brand, and from then on the
-- studio's catalogue is split four ways and every report is wrong
-- in a way nobody can see.
--
-- An expression index on the folded, trimmed, internally-collapsed
-- name catches all of them at the database, so no service, script,
-- import or console session can create one.
CREATE UNIQUE INDEX brands_unique_normalised_name
  ON "brands" (lower(btrim(regexp_replace("name", '\s+', ' ', 'g'))));

-- THE SAME, FOR A PRODUCT HEAD WITHIN ITS BRAND.
--
-- Scoped to the brand on purpose. Two brands may both sell a
-- series called Verona, and they are different ranges; one brand
-- selling "Neo Sapien" and "neo sapien" is one range typed twice.
CREATE UNIQUE INDEX collections_unique_normalised_name_per_brand
  ON "collections" ("brandId", lower(btrim(regexp_replace("name", '\s+', ' ', 'g'))));

-- A VARIANT IS ITS ATTRIBUTES, within its head.
--
-- Not a hard constraint -- it is a partial index over the columns
-- that distinguish one variant from another, so the duplicate
-- CHECK the service runs before creating a variant is an index
-- lookup rather than a scan of the catalogue. Deliberately not
-- UNIQUE: two genuinely different products can share a colour and
-- a size, and the brief is explicit that an ambiguous match needs
-- human review rather than an automatic refusal.
CREATE INDEX products_variant_signature
  ON "products" ("collectionId", lower(coalesce("colour", '')), lower(coalesce("finish", '')), "size")
  WHERE "collectionId" IS NOT NULL;


-- ────────────────────────────────────────────────────────────
-- ONE MAIN IMAGE PER PRODUCT, AND ONLY AN APPROVED ONE
-- ────────────────────────────────────────────────────────────

-- Two main images means the list screen and the detail screen can
-- disagree about what the product looks like.
CREATE UNIQUE INDEX product_images_single_main
  ON "product_images" ("productId")
  WHERE "role" = 'MAIN';

-- An unapproved image may exist -- the extraction pipeline writes
-- them by the thousand -- but it may never be the face of the
-- product. This is the rule "an extracted catalogue image is not
-- automatically a product image", written where it cannot be
-- forgotten.
ALTER TABLE "product_images"
  ADD CONSTRAINT product_images_main_must_be_approved
  CHECK ("role" <> 'MAIN' OR "isApproved" = true);

-- An approval is either complete or absent: an image flagged
-- approved with nobody and no date behind it is not an approval.
ALTER TABLE "product_images"
  ADD CONSTRAINT product_images_approval_is_complete
  CHECK (
    ("isApproved" = false AND "approvedAt" IS NULL AND "approvedById" IS NULL)
    OR ("isApproved" = true AND "approvedAt" IS NOT NULL)
  );


-- ────────────────────────────────────────────────────────────
-- ARCHIVAL IS COMPLETE OR ABSENT
-- ────────────────────────────────────────────────────────────

ALTER TABLE "products"
  ADD CONSTRAINT product_archival_is_complete
  CHECK (("archivedAt" IS NULL) = ("archivedById" IS NULL));


-- ────────────────────────────────────────────────────────────
-- THE PRODUCT HEAD'S VARIANTS, AND WHAT THEY HOLD
-- ────────────────────────────────────────────────────────────
--
-- Answers "show me Neo Sapien" in one query: every variant under a
-- head with its stock, so the Product Head screen never has to
-- fetch the variants and then fetch each one's inventory.

CREATE OR REPLACE VIEW v_product_head_summary AS
SELECT
  c."id"                                   AS head_id,
  c."name"                                 AS head_name,
  c."brandId",
  b."name"                                 AS brand_name,
  c."categoryId",
  c."isActive",
  COUNT(p."id") FILTER (WHERE p."archivedAt" IS NULL)                            AS variant_count,
  COUNT(p."id") FILTER (WHERE p."archivedAt" IS NULL AND p."status" = 'ACTIVE')   AS active_variant_count,
  COUNT(DISTINCT p."colour") FILTER (WHERE p."archivedAt" IS NULL)                AS colour_count,
  COUNT(DISTINCT p."size")   FILTER (WHERE p."archivedAt" IS NULL)                AS size_count,
  COALESCE(SUM(i.on_hand), 0)                                                     AS total_on_hand
FROM "collections" c
JOIN "brands" b ON b."id" = c."brandId"
LEFT JOIN "products" p ON p."collectionId" = c."id"
LEFT JOIN (
  SELECT "productId", SUM("quantityOnHand") AS on_hand
  FROM "inventory_balances" GROUP BY "productId"
) i ON i."productId" = p."id"
GROUP BY c."id", c."name", c."brandId", b."name", c."categoryId", c."isActive";

COMMENT ON VIEW v_product_head_summary IS
  'One row per Product Head (series) with its variant counts and total stock. A Product Head is a row in "collections"; the table predates the term.';
