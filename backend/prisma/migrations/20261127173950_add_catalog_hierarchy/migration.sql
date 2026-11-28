-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "code" TEXT,
ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "tiles" ADD COLUMN     "material" TEXT,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "thickness" TEXT;

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "description" TEXT,
    "coverImageUrl" TEXT,
    "catalogueDocumentUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "collectionId" TEXT NOT NULL,
    "description" TEXT,
    "specifications" TEXT,
    "coverImageUrl" TEXT,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collections_brandId_idx" ON "collections"("brandId");

-- CreateIndex
CREATE INDEX "collections_brandId_name_idx" ON "collections"("brandId", "name");

-- CreateIndex
CREATE INDEX "products_collectionId_idx" ON "products"("collectionId");

-- CreateIndex
CREATE INDEX "products_code_idx" ON "products"("code");

-- CreateIndex
CREATE INDEX "tiles_productId_idx" ON "tiles"("productId");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiles" ADD CONSTRAINT "tiles_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
