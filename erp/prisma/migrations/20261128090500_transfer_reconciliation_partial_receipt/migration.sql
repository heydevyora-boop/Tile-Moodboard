-- ============================================================
-- RECONCILIATION FOR PARTIAL RECEIPT AND TRANSFER LOSS
-- ============================================================
--
-- SEPARATE FROM THE MIGRATION THAT ADDED TRANSFER_LOSS, and it has
-- to be -- Postgres refuses to USE a new enum value in the same
-- transaction that adds it. Same split as the damage/reservation
-- views before this one.
--
-- The previous rule required an IN_TRANSIT transfer to have
-- received = 0: "nothing may have landed yet while it is still on
-- its way." That stops being true the moment a partial receipt is
-- legitimate -- a transfer can now be IN_TRANSIT with some
-- quantity already accepted, some damaged, and the rest still
-- genuinely in transit. Tightening "nothing received" to "not yet
-- fully resolved" keeps the same intent (does the status agree
-- with the quantities?) without flagging a normal partial receipt
-- as a false alarm.
--
-- COMPLETED and CANCELLED gain a second contributor to "received":
-- missing. A box written off as a transfer loss did not arrive
-- either, but it is resolved -- the question has been asked and
-- answered -- so it belongs on the same side of the equation as
-- what did arrive, not left looking like unaccounted-for stock.
--
--     dispatched = received + missing
--
-- is the completed/cancelled invariant now, generalising the old
-- dispatched = received for the case where missing is always
-- zero (which is still every CANCELLED transfer today -- cancel
-- is refused once any quantity has been resolved).
--
-- Dropped and recreated, not replaced: a new column (missing_
-- quantity) and CREATE OR REPLACE VIEW cannot change a view's
-- column list.

DROP VIEW IF EXISTS v_transfer_reconciliation;

CREATE VIEW v_transfer_reconciliation AS
SELECT
  t."id"            AS transfer_id,
  t."transferNo",
  t."status",
  t."fromWarehouseId",
  t."toWarehouseId",
  COALESCE(m.dispatched, 0) AS dispatched_quantity,
  COALESCE(m.received, 0)   AS received_quantity,
  COALESCE(m.missing, 0)    AS missing_quantity,
  COALESCE(m.dispatched, 0) - COALESCE(m.received, 0) - COALESCE(m.missing, 0) AS still_in_transit,
  -- Where the stock that came back actually landed. For a
  -- completed transfer this is the destination; for one cancelled
  -- in transit it is the source it was returned to.
  COALESCE(m.received_at_destination, 0) AS received_at_destination,
  COALESCE(m.returned_to_source, 0)      AS returned_to_source,
  CASE
    -- Fully resolved. Every box that left either arrived
    -- somewhere, was returned, or was written off with a reason
    -- -- nothing is left unaccounted for.
    WHEN t."status" IN ('COMPLETED', 'CANCELLED')
      THEN COALESCE(m.dispatched, 0) = COALESCE(m.received, 0) + COALESCE(m.missing, 0)
    -- On its way, possibly partly resolved: dispatched, and not
    -- yet fully accounted for everywhere it could be. Equal to
    -- dispatched while still IN_TRANSIT would mean the service
    -- failed to complete the transfer -- a real inconsistency,
    -- not a normal partial receipt.
    WHEN t."status" = 'IN_TRANSIT'
      THEN COALESCE(m.dispatched, 0) > 0
       AND COALESCE(m.received, 0) + COALESCE(m.missing, 0) < COALESCE(m.dispatched, 0)
    -- Not started: nothing may have moved.
    WHEN t."status" = 'DRAFT'
      THEN COALESCE(m.dispatched, 0) = 0 AND COALESCE(m.received, 0) = 0 AND COALESCE(m.missing, 0) = 0
    ELSE false
  END AS balanced
FROM "warehouse_transfers" t
LEFT JOIN (
  SELECT
    "referenceId",
    SUM(CASE WHEN "movementType" = 'TRANSFER_OUT'  THEN "quantity" ELSE 0 END) AS dispatched,
    SUM(CASE WHEN "movementType" = 'TRANSFER_IN'   THEN "quantity" ELSE 0 END) AS received,
    SUM(CASE WHEN "movementType" = 'TRANSFER_LOSS' THEN "quantity" ELSE 0 END) AS missing,
    SUM(CASE WHEN "movementType" = 'TRANSFER_IN'
      AND "warehouseId" = (SELECT "toWarehouseId" FROM "warehouse_transfers" wt
                           WHERE wt."id" = e."referenceId")
      THEN "quantity" ELSE 0 END) AS received_at_destination,
    SUM(CASE WHEN "movementType" = 'TRANSFER_IN'
      AND "warehouseId" = (SELECT "fromWarehouseId" FROM "warehouse_transfers" wt
                           WHERE wt."id" = e."referenceId")
      THEN "quantity" ELSE 0 END) AS returned_to_source
  FROM "stock_ledger_entries" e
  WHERE "referenceType" = 'WAREHOUSE_TRANSFER'
  GROUP BY "referenceId"
) m ON m."referenceId" = t."id";

COMMENT ON VIEW v_transfer_reconciliation IS
  'One row per warehouse transfer, comparing what left the source with what has been resolved -- received at the destination, returned to the source on cancellation, or written off as a transfer loss. balanced = false means stock is unaccounted for between two of the studio''s own warehouses, or a transfer''s status disagrees with its quantities.';
