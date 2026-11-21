-- ============================================================
-- A CANCELLED TRANSFER MAY STILL HAVE MOVED STOCK
-- ============================================================
--
-- The previous rule said a CANCELLED transfer is balanced only
-- when nothing was ever dispatched or received. That is true of a
-- transfer cancelled while still a DRAFT, and wrong for one
-- cancelled IN TRANSIT: the lorry turned round, the stock went
-- back to the source as a TRANSFER_IN, and the correct state is
--
--     dispatched = received,  still in transit = 0
--
-- exactly as for a completed transfer. The old rule reported
-- every such cancellation as unaccounted-for stock, which is the
-- worst kind of false alarm: it trains people to ignore the
-- reconciliation report.
--
-- Found by the lifecycle test, which cancelled a dispatched
-- transfer and then asked the database whether everything still
-- added up.
--
-- The view is dropped and recreated rather than replaced because
-- a new column is added and CREATE OR REPLACE VIEW cannot change
-- a view's column list.

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
  COALESCE(m.dispatched, 0) - COALESCE(m.received, 0) AS still_in_transit,
  -- Where the stock that came back actually landed. For a
  -- completed transfer this is the destination; for one cancelled
  -- in transit it is the source it was returned to.
  COALESCE(m.received_at_destination, 0) AS received_at_destination,
  COALESCE(m.returned_to_source, 0)      AS returned_to_source,
  CASE
    -- Received in full. Whether that receipt was the arrival at
    -- the destination or the return to the source, every box that
    -- left is accounted for.
    WHEN t."status" IN ('COMPLETED', 'CANCELLED')
      THEN COALESCE(m.dispatched, 0) = COALESCE(m.received, 0)
    -- On its way: dispatched, not yet received anywhere.
    WHEN t."status" = 'IN_TRANSIT'
      THEN COALESCE(m.received, 0) = 0 AND COALESCE(m.dispatched, 0) > 0
    -- Not started: nothing may have moved.
    WHEN t."status" = 'DRAFT'
      THEN COALESCE(m.dispatched, 0) = 0 AND COALESCE(m.received, 0) = 0
    ELSE false
  END AS balanced
FROM "warehouse_transfers" t
LEFT JOIN (
  SELECT
    "referenceId",
    SUM(CASE WHEN "movementType" = 'TRANSFER_OUT' THEN "quantity" ELSE 0 END) AS dispatched,
    SUM(CASE WHEN "movementType" = 'TRANSFER_IN'  THEN "quantity" ELSE 0 END) AS received,
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
  'One row per warehouse transfer, comparing what left the source with what was received -- at the destination on completion, or back at the source if it was cancelled in transit. balanced = false means stock is unaccounted for between two of the studio''s own warehouses.';
