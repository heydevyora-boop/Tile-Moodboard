-- THE CLIENT'S OWN DRIVE FOLDER, recorded.
--
-- Three nullable columns and nothing else. No table is created, none is
-- dropped, no existing column is altered and no row is touched: every
-- wishlist that exists keeps working, with these reading null until the
-- next submission fills them.
--
--   client_wishlists.driveSyncedAt  when Drive was last brought up to date
--   client_wishlists.driveError     why it was not, if it was not
--   wishlist_items.driveCopyId      the copy in the client's folder
--
-- driveCopyId is what stops a repeated submission copying a picture
-- twice: set means copied. It names the COPY, never the original.

-- AlterTable
ALTER TABLE "client_wishlists" ADD COLUMN     "driveError" TEXT,
ADD COLUMN     "driveSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wishlist_items" ADD COLUMN     "driveCopyId" TEXT;

