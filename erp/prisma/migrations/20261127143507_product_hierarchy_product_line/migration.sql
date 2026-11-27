-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "description" TEXT,
ADD COLUMN     "logoUrl" TEXT;

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "catalogueDocumentUrl" TEXT,
ADD COLUMN     "coverImageUrl" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "productLineId" UUID;

-- CreateTable
CREATE TABLE "product_lines" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "collectionId" UUID,
    "categoryId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "specifications" JSONB,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_lines_brandId_idx" ON "product_lines"("brandId");

-- CreateIndex
CREATE INDEX "product_lines_collectionId_idx" ON "product_lines"("collectionId");

-- CreateIndex
CREATE INDEX "product_lines_categoryId_idx" ON "product_lines"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "product_lines_brandId_collectionId_code_key" ON "product_lines"("brandId", "collectionId", "code");

-- CreateIndex
CREATE INDEX "products_productLineId_idx" ON "products"("productLineId");

-- AddForeignKey
ALTER TABLE "product_lines" ADD CONSTRAINT "product_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lines" ADD CONSTRAINT "product_lines_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lines" ADD CONSTRAINT "product_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lines" ADD CONSTRAINT "product_lines_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lines" ADD CONSTRAINT "product_lines_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "product_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
