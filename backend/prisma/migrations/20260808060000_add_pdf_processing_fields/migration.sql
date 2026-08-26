-- AlterTable
ALTER TABLE "catalogs" ADD COLUMN "fileHash" TEXT;
ALTER TABLE "catalogs" ADD COLUMN "duplicateImagesSkipped" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "catalogs" ADD COLUMN "duplicateTilesSkipped" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "catalogs" ADD COLUMN "processingLog" TEXT;

-- CreateIndex
CREATE INDEX "catalogs_brandId_fileHash_idx" ON "catalogs"("brandId", "fileHash");
