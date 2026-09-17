/*
  Warnings:

  - A unique constraint covering the columns `[brandId,fileName]` on the table `catalogs` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "activity_logs_createdAt_idx";

-- CreateIndex
CREATE UNIQUE INDEX "catalogs_brandId_fileName_key" ON "catalogs"("brandId", "fileName");
