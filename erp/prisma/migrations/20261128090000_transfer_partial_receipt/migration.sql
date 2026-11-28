-- ============================================================
-- PARTIAL TRANSFER RECEIPT, AND A LOSS DIMENSION FOR IN-TRANSIT
-- ============================================================
--
-- Until now a transfer receipt could only be all-or-nothing:
-- receiveTransfer() always recorded the full dispatched quantity
-- as received. Real receiving docks don't work that way -- a
-- lorry can arrive with some boxes short, some broken, and the
-- rest genuinely still on its way on a later run.
--
-- This migration adds the columns a partial, discrepancy-aware
-- receipt needs, following the goods-receipt-note precedent
-- exactly (same split: accepted / damaged / received = accepted +
-- damaged), plus one more dimension that a purchase receipt never
-- needed: missing. A box a supplier never shipped is the
-- supplier's problem; a box a transfer dispatched between the
-- studio's own two warehouses and that never turns up is the
-- studio's own stock, and has to be written off through the
-- ledger like anything else that happens to it.
--
-- ── ENUM VALUES FIRST, IN THEIR OWN STATEMENTS ────────────────
-- Postgres refuses to USE a new enum value in the same
-- transaction that adds it. This migration only ADDS values; the
-- view and any other SQL that names them by literal lives in the
-- next migration, same as the damage/reservation split before it.

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_LOSS';
-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_LOSS_REVERSAL';
-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE 'TRANSFER_LOSS';

-- ── THE LEDGER GAINS A FOURTH "AFTER" COLUMN ──────────────────
-- Nullable, unlike reservedAfter/damagedAfter: those were
-- backfilled from arithmetic that always held (physical movements
-- moved the balance by exactly their quantity, everything else
-- left it alone). In-transit has no such invariant to reconstruct
-- from -- dispatch and receipt wrote quantityInTransit directly
-- with raw SQL, outside the ledger, so there is no way to compute
-- what it was at any past entry. NULL says "not recorded", which
-- is the truth, rather than claiming zero.
ALTER TABLE "stock_ledger_entries" ADD COLUMN "inTransitAfter" DECIMAL(14,3);

-- ── THE TRANSFER LINE'S RUNNING TOTALS ────────────────────────
ALTER TABLE "warehouse_transfer_lines"
  ADD COLUMN "acceptedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN "damagedQuantity"  DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN "missingQuantity"  DECIMAL(14,3) NOT NULL DEFAULT 0;

-- Every transfer line received before this migration was received
-- in full, with no concept of damage or loss -- that is exactly
-- what receivedQuantity > 0 already means under the old code.
-- Recording that history as acceptedQuantity = receivedQuantity
-- is not a guess, it is what actually happened; nothing about an
-- existing row's receivedQuantity, quantity or status changes.
UPDATE "warehouse_transfer_lines"
SET "acceptedQuantity" = "receivedQuantity"
WHERE "receivedQuantity" > 0;

-- Quantities can never be negative.
ALTER TABLE "warehouse_transfer_lines"
  ADD CONSTRAINT transfer_line_quantities_not_negative
  CHECK ("acceptedQuantity" >= 0 AND "damagedQuantity" >= 0 AND "missingQuantity" >= 0);

-- WHAT ARRIVED is accepted plus damaged -- the same rule as a
-- goods receipt line, and for the same reason: a broken box still
-- came through the door and a stock-take would still count it.
ALTER TABLE "warehouse_transfer_lines"
  ADD CONSTRAINT transfer_line_received_is_accepted_plus_damaged
  CHECK ("receivedQuantity" = "acceptedQuantity" + "damagedQuantity");

-- The three resolved quantities, together, can never exceed what
-- was actually dispatched. This is the database-level backstop
-- for over-receipt prevention; the service checks it first, with
-- a readable message, but the constraint is what actually makes
-- it impossible.
ALTER TABLE "warehouse_transfer_lines"
  ADD CONSTRAINT transfer_line_resolved_not_over_dispatched
  CHECK ("acceptedQuantity" + "damagedQuantity" + "missingQuantity" <= "quantity");
