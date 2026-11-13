-- REMOVAL AS A REQUEST, NOT A DELETE.
--
-- Taking a sample off the shelf now goes through the same Admin
-- approval as moving one, and approving it marks the sample REMOVED
-- rather than deleting anything: the record, the barcode and the whole
-- movement history stay, so the piece can be put back later through an
-- approved placement request.
--
--   physical_samples.status / removedAt      on the shelf, or off it
--   placement_change_requests.requestType    MOVE or REMOVAL
--   toCassetteNo / toPanelNo made nullable   a removal names nowhere
--
-- ADDITIVE, with one widening. The two columns that become nullable
-- are on placement_change_requests, a table created in the previous
-- migration: dropping NOT NULL never rejects an existing row, and
-- there are no rows in production to reject. No table is dropped, no
-- column is removed, no row is touched.

-- CreateEnum
CREATE TYPE "PlacementRequestType" AS ENUM ('MOVE', 'REMOVAL');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- AlterTable
ALTER TABLE "physical_samples" ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "status" "SampleStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "placement_change_requests" ADD COLUMN     "requestType" "PlacementRequestType" NOT NULL DEFAULT 'MOVE',
ALTER COLUMN "toCassetteNo" DROP NOT NULL,
ALTER COLUMN "toPanelNo" DROP NOT NULL;

