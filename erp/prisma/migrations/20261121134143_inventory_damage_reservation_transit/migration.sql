-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementReason" ADD VALUE 'DAMAGE_RECOVERY';
ALTER TYPE "StockMovementReason" ADD VALUE 'RESERVATION';
ALTER TYPE "StockMovementReason" ADD VALUE 'RESERVATION_RELEASE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'RESERVATION';
ALTER TYPE "StockMovementType" ADD VALUE 'RESERVATION_RELEASE';
ALTER TYPE "StockMovementType" ADD VALUE 'DAMAGE';
ALTER TYPE "StockMovementType" ADD VALUE 'DAMAGE_RECOVERY';

-- AlterTable
ALTER TABLE "inventory_balances" ADD COLUMN     "quantityDamaged" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "quantityInTransit" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_ledger_entries" ADD COLUMN     "balanceBefore" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "damagedAfter" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "reservedAfter" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "warehouse_transfers" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedById" UUID,
ADD COLUMN     "receivedById" UUID;

-- AddForeignKey
ALTER TABLE "warehouse_transfers" ADD CONSTRAINT "warehouse_transfers_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_transfers" ADD CONSTRAINT "warehouse_transfers_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
-- STEP 5: BACKFILL, AND THE GUARDS THE SCHEMA CANNOT STATE
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. BACKFILL balanceBefore FOR THE ROWS THAT PREDATE IT
-- ────────────────────────────────────────────────────────────
--
-- Every existing entry already records balanceAfter and the
-- quantity, and the direction is in the movement type -- so the
-- previous balance is arithmetic, not a guess. The ledger is
-- append-only and MUST NOT be rewritten, so this runs with the
-- triggers disabled for exactly this statement and nothing else.
--
-- This is the one legitimate exception: filling in a column that
-- did not exist when the row was written is not changing what the
-- row says. Every quantity, direction, date and reference is
-- untouched, and the value written is derived from the row
-- itself. A reviewer can recompute it and get the same answer.

ALTER TABLE "stock_ledger_entries" DISABLE TRIGGER "stock_ledger_entries_no_update";

UPDATE "stock_ledger_entries"
SET "balanceBefore" =
  CASE
    WHEN "movementType" IN ('INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN')
      THEN "balanceAfter" - "quantity"
    ELSE "balanceAfter" + "quantity"
  END,
  "reservedAfter" = 0,
  "damagedAfter"  = 0;

ALTER TABLE "stock_ledger_entries" ENABLE TRIGGER "stock_ledger_entries_no_update";


-- ────────────────────────────────────────────────────────────
-- 2. THE NUMBERS THAT MUST STAY SANE
-- ────────────────────────────────────────────────────────────

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT inventory_damaged_not_negative
  CHECK ("quantityDamaged" >= 0);

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT inventory_in_transit_not_negative
  CHECK ("quantityInTransit" >= 0);

-- AVAILABLE STOCK CANNOT GO BELOW ZERO.
--
--     available = on hand - reserved - damaged
--
-- Reserved and damaged are both SUBSETS of what is on the shelf,
-- so between them they can never exceed it. Without this, a
-- reservation could promise stock that is already broken, and the
-- system would cheerfully confirm an order for boxes nobody can
-- ship. It is the single most useful constraint in this file.
ALTER TABLE "inventory_balances"
  ADD CONSTRAINT inventory_available_not_negative
  CHECK ("quantityOnHand" - "quantityReserved" - "quantityDamaged" >= 0);

-- A ledger entry's own arithmetic has to hold. Physical movements
-- must move the balance by exactly their quantity; reservation and
-- damage movements must leave it alone, because the boxes have not
-- gone anywhere.
ALTER TABLE "stock_ledger_entries"
  ADD CONSTRAINT stock_ledger_balance_arithmetic
  CHECK (
    CASE
      WHEN "movementType" IN ('INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN')
        THEN "balanceAfter" = "balanceBefore" + "quantity"
      WHEN "movementType" IN ('OUTWARD', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT')
        THEN "balanceAfter" = "balanceBefore" - "quantity"
      ELSE "balanceAfter" = "balanceBefore"
    END
  );

ALTER TABLE "stock_ledger_entries"
  ADD CONSTRAINT stock_ledger_after_balances_not_negative
  CHECK ("balanceAfter" >= 0 AND "reservedAfter" >= 0 AND "damagedAfter" >= 0);

-- A transfer that has been received must say who signed for it,
-- and one that was dispatched must say who sent it. A movement
-- with nobody's name on it is not a control.
ALTER TABLE "warehouse_transfers"
  ADD CONSTRAINT transfer_receipt_is_attributed
  CHECK ("receivedAt" IS NULL OR "receivedById" IS NOT NULL);

ALTER TABLE "warehouse_transfers"
  ADD CONSTRAINT transfer_dispatch_is_attributed
  CHECK ("dispatchedAt" IS NULL OR "dispatchedById" IS NOT NULL);

-- Only ONE opening stock entry per product per warehouse. A
-- second one is not an opening balance, it is a correction, and
-- it has to be posted as an adjustment so the reason is on the
-- record.
CREATE UNIQUE INDEX stock_ledger_one_opening_per_product_warehouse
  ON "stock_ledger_entries" ("productId", "warehouseId")
  WHERE "reason" = 'OPENING_STOCK';
