-- De'vyora Client Wishlist: a client's registration round, and what they
-- hearted in it.
--
-- ADDITIVE ONLY. Two new tables, one new enum, their indexes and their
-- foreign keys. Nothing existing is dropped, altered or rewritten:
-- identity reuses the customers table exactly as it stands.
--
-- wishlist_items.libraryReferenceId is ON DELETE SET NULL rather than
-- CASCADE on purpose -- a studio removing a library picture must not
-- quietly rewrite what a client chose last week. The row keeps its
-- imageId, driveFileId, title and theme and still reads correctly.

-- CreateEnum
CREATE TYPE "WishlistStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateTable
CREATE TABLE "client_wishlists" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "WishlistStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "driveFolderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_wishlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "libraryReferenceId" TEXT,
    "driveFileId" TEXT,
    "themeId" TEXT NOT NULL,
    "room" TEXT,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_wishlists_token_key" ON "client_wishlists"("token");

-- CreateIndex
CREATE UNIQUE INDEX "client_wishlists_code_key" ON "client_wishlists"("code");

-- CreateIndex
CREATE INDEX "client_wishlists_customerId_idx" ON "client_wishlists"("customerId");

-- CreateIndex
CREATE INDEX "client_wishlists_status_idx" ON "client_wishlists"("status");

-- CreateIndex
CREATE INDEX "wishlist_items_wishlistId_idx" ON "wishlist_items"("wishlistId");

-- CreateIndex
CREATE INDEX "wishlist_items_themeId_idx" ON "wishlist_items"("themeId");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_items_wishlistId_imageId_key" ON "wishlist_items"("wishlistId", "imageId");

-- AddForeignKey
ALTER TABLE "client_wishlists" ADD CONSTRAINT "client_wishlists_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "client_wishlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_libraryReferenceId_fkey" FOREIGN KEY ("libraryReferenceId") REFERENCES "LibraryReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

