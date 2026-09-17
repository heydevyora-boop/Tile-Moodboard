/*
  Warnings:

  - A unique constraint covering the columns `[productCode]` on the table `tiles` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "tiles_productCode_key" ON "tiles"("productCode");
