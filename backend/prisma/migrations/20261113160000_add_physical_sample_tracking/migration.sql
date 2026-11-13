-- PHYSICAL SAMPLE PLACEMENT & BARCODE TRACKING.
--
-- Four new tables and two new enums. ADDITIVE ONLY: no table is
-- dropped, no column on an existing table is altered, and no row is
-- touched. The only thing that reaches an existing table is a foreign
-- key FROM the new product_colours INTO tiles, which adds a constraint
-- to the new table and leaves tiles exactly as it was.
--
--   product_colours            one row per product-and-colour, with
--                              how the studio holds it
--   physical_samples           the piece on the panel: its own sample
--                              id and its own barcode, both unique
--   sample_placements          where it has been, including now --
--                              a relocation INSERTS, never updates
--   placement_change_requests  a move asked for but not yet allowed
--
-- The unique constraints are the load-bearing part. Two members of
-- staff registering the same colour at the same moment is exactly the
-- case an application-level check loses, so sampleId and barcode are
-- unique in the database and (productId, colourName) with them.

-- CreateEnum
CREATE TYPE "SampleAvailability" AS ENUM ('PHYSICAL_SAMPLE', 'CATALOGUE_ONLY', 'CUTOUT_ONLY', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "PlacementRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "product_colours" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "colourName" TEXT NOT NULL,
    "colourCode" TEXT,
    "availability" "SampleAvailability" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_colours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_samples" (
    "id" TEXT NOT NULL,
    "colourId" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "photoDriveFileId" TEXT,
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "physical_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_placements" (
    "id" TEXT NOT NULL,
    "physicalSampleId" TEXT NOT NULL,
    "cassetteNo" TEXT NOT NULL,
    "panelNo" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "placedById" TEXT,
    "note" TEXT,

    CONSTRAINT "sample_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placement_change_requests" (
    "id" TEXT NOT NULL,
    "physicalSampleId" TEXT NOT NULL,
    "fromPlacementId" TEXT,
    "fromCassetteNo" TEXT,
    "fromPanelNo" TEXT,
    "toCassetteNo" TEXT NOT NULL,
    "toPanelNo" TEXT NOT NULL,
    "reason" TEXT,
    "status" "PlacementRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultPlacementId" TEXT,

    CONSTRAINT "placement_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_colours_productId_idx" ON "product_colours"("productId");

-- CreateIndex
CREATE INDEX "product_colours_availability_idx" ON "product_colours"("availability");

-- CreateIndex
CREATE UNIQUE INDEX "product_colours_productId_colourName_key" ON "product_colours"("productId", "colourName");

-- CreateIndex
CREATE UNIQUE INDEX "physical_samples_colourId_key" ON "physical_samples"("colourId");

-- CreateIndex
CREATE UNIQUE INDEX "physical_samples_sampleId_key" ON "physical_samples"("sampleId");

-- CreateIndex
CREATE UNIQUE INDEX "physical_samples_barcode_key" ON "physical_samples"("barcode");

-- CreateIndex
CREATE INDEX "sample_placements_physicalSampleId_isCurrent_idx" ON "sample_placements"("physicalSampleId", "isCurrent");

-- CreateIndex
CREATE INDEX "sample_placements_cassetteNo_panelNo_idx" ON "sample_placements"("cassetteNo", "panelNo");

-- CreateIndex
CREATE INDEX "placement_change_requests_physicalSampleId_idx" ON "placement_change_requests"("physicalSampleId");

-- CreateIndex
CREATE INDEX "placement_change_requests_status_idx" ON "placement_change_requests"("status");

-- CreateIndex
CREATE INDEX "placement_change_requests_requestedAt_idx" ON "placement_change_requests"("requestedAt");

-- AddForeignKey
ALTER TABLE "product_colours" ADD CONSTRAINT "product_colours_productId_fkey" FOREIGN KEY ("productId") REFERENCES "tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_samples" ADD CONSTRAINT "physical_samples_colourId_fkey" FOREIGN KEY ("colourId") REFERENCES "product_colours"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_placements" ADD CONSTRAINT "sample_placements_physicalSampleId_fkey" FOREIGN KEY ("physicalSampleId") REFERENCES "physical_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_placements" ADD CONSTRAINT "sample_placements_placedById_fkey" FOREIGN KEY ("placedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_change_requests" ADD CONSTRAINT "placement_change_requests_physicalSampleId_fkey" FOREIGN KEY ("physicalSampleId") REFERENCES "physical_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_change_requests" ADD CONSTRAINT "placement_change_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_change_requests" ADD CONSTRAINT "placement_change_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

