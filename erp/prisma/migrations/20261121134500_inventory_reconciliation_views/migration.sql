-- ============================================================
-- RECONCILIATION VIEWS FOR THE NEW MOVEMENT FAMILIES
-- ============================================================
--
-- SEPARATE FROM THE MIGRATION THAT ADDED THE ENUM VALUES, and it
-- has to be. Postgres refuses to USE a new enum value in the same
-- transaction that ADDS it -- "unsafe use of new value ... of enum
-- type" -- because the value is not committed yet and an index or
-- a constraint built against it could be left referring to
-- something that never existed.
--
-- So: one migration adds RESERVATION, RESERVATION_RELEASE, DAMAGE
-- and DAMAGE_RECOVERY, and this one, in its own transaction,
-- builds the views that read them.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 3. RECONCILIATION, ACROSS ALL THREE DIMENSIONS
-- ────────────────────────────────────────────────────────────
--
-- Replaces the step-2 view, which knew only about physical stock.
-- Same name and same contract -- a healthy database returns
-- nothing from `WHERE NOT reconciled` -- with reserved and damaged
-- now checked the same way.

/* DROPPED AND REBUILT, not replaced. CREATE OR REPLACE VIEW can
   only change a view's body, never the names or the order of its
   columns -- and this one gains warehouse_name, the reserved and
   damaged pairs and in_transit. Dropping a view destroys no data:
   it is a saved query, and the next statement puts it back with
   the same name and the same contract. */
DROP VIEW IF EXISTS v_inventory_reconciliation;

CREATE VIEW v_inventory_reconciliation AS
SELECT
  b."productId",
  b."warehouseId",
  p."sku",
  w."name"                                            AS warehouse_name,
  b."quantityOnHand"                                  AS projected_quantity,
  COALESCE(l.ledger_quantity, 0)                      AS ledger_quantity,
  b."quantityOnHand" - COALESCE(l.ledger_quantity, 0) AS difference,
  b."quantityReserved"                                AS projected_reserved,
  COALESCE(l.ledger_reserved, 0)                      AS ledger_reserved,
  b."quantityDamaged"                                 AS projected_damaged,
  COALESCE(l.ledger_damaged, 0)                       AS ledger_damaged,
  b."quantityInTransit"                               AS in_transit,
  b."quantityOnHand" - b."quantityReserved" - b."quantityDamaged" AS available,
  (b."quantityOnHand"   = COALESCE(l.ledger_quantity, 0)
   AND b."quantityReserved" = COALESCE(l.ledger_reserved, 0)
   AND b."quantityDamaged"  = COALESCE(l.ledger_damaged, 0))      AS reconciled,
  COALESCE(l.movement_count, 0)                       AS movement_count
FROM "inventory_balances" b
JOIN "products" p   ON p."id" = b."productId"
JOIN "warehouses" w ON w."id" = b."warehouseId"
LEFT JOIN (
  SELECT
    "productId",
    "warehouseId",
    SUM(CASE
      WHEN "movementType" IN ('INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN') THEN "quantity"
      WHEN "movementType" IN ('OUTWARD', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT') THEN -"quantity"
      ELSE 0
    END) AS ledger_quantity,
    SUM(CASE
      WHEN "movementType" = 'RESERVATION' THEN "quantity"
      WHEN "movementType" = 'RESERVATION_RELEASE' THEN -"quantity"
      ELSE 0
    END) AS ledger_reserved,
    SUM(CASE
      WHEN "movementType" = 'DAMAGE' THEN "quantity"
      WHEN "movementType" = 'DAMAGE_RECOVERY' THEN -"quantity"
      ELSE 0
    END) AS ledger_damaged,
    COUNT(*) AS movement_count
  FROM "stock_ledger_entries"
  GROUP BY "productId", "warehouseId"
) l ON l."productId" = b."productId" AND l."warehouseId" = b."warehouseId";

COMMENT ON VIEW v_inventory_reconciliation IS
  'Recomputes on-hand, reserved and damaged for every product and warehouse from the append-only ledger. Any row with reconciled = false is a projection that has drifted from its own history and must not be trusted until an authorised adjustment explains it.';


-- COMPANY-WIDE, AND THE ONE SUM A TRANSFER MUST NOT CHANGE.
--
-- Physical stock is on-hand PLUS in-transit. Across a transfer the
-- source's on-hand falls and the destination's in-transit rises by
-- the same amount, so this total is constant from dispatch to
-- receipt. If it ever moves during a transfer, the transfer is
-- double-counting and the report says so.
CREATE OR REPLACE VIEW v_company_stock AS
SELECT
  COUNT(DISTINCT b."productId")                       AS skus_held,
  COUNT(DISTINCT b."warehouseId")                     AS warehouses_used,
  COALESCE(SUM(b."quantityOnHand"), 0)                AS physical_on_hand,
  COALESCE(SUM(b."quantityInTransit"), 0)             AS in_transit,
  COALESCE(SUM(b."quantityOnHand"), 0)
    + COALESCE(SUM(b."quantityInTransit"), 0)         AS physical_total,
  COALESCE(SUM(b."quantityReserved"), 0)              AS reserved,
  COALESCE(SUM(b."quantityDamaged"), 0)               AS damaged,
  COALESCE(SUM(b."quantityOnHand" - b."quantityReserved" - b."quantityDamaged"), 0) AS available
FROM "inventory_balances" b;

COMMENT ON VIEW v_company_stock IS
  'Company-wide totals. physical_total = on hand + in transit, and stays constant across a warehouse transfer: nothing is counted in two places at once.';


-- UNBALANCED TRANSFERS.
--
-- Every transfer should have as much going out of the source as
-- coming into the destination, once received. A row here is a
-- transfer whose two sides disagree -- stock that left one
-- warehouse and never arrived anywhere.
CREATE OR REPLACE VIEW v_transfer_reconciliation AS
SELECT
  t."id"            AS transfer_id,
  t."transferNo",
  t."status",
  t."fromWarehouseId",
  t."toWarehouseId",
  COALESCE(m.dispatched, 0) AS dispatched_quantity,
  COALESCE(m.received, 0)   AS received_quantity,
  COALESCE(m.dispatched, 0) - COALESCE(m.received, 0) AS still_in_transit,
  CASE
    WHEN t."status" = 'COMPLETED'
      THEN COALESCE(m.dispatched, 0) = COALESCE(m.received, 0)
    WHEN t."status" = 'IN_TRANSIT'
      THEN COALESCE(m.received, 0) = 0 AND COALESCE(m.dispatched, 0) > 0
    WHEN t."status" IN ('DRAFT', 'CANCELLED')
      THEN COALESCE(m.dispatched, 0) = 0 AND COALESCE(m.received, 0) = 0
    ELSE false
  END AS balanced
FROM "warehouse_transfers" t
LEFT JOIN (
  SELECT
    "referenceId",
    SUM(CASE WHEN "movementType" = 'TRANSFER_OUT' THEN "quantity" ELSE 0 END) AS dispatched,
    SUM(CASE WHEN "movementType" = 'TRANSFER_IN'  THEN "quantity" ELSE 0 END) AS received
  FROM "stock_ledger_entries"
  WHERE "referenceType" = 'WAREHOUSE_TRANSFER'
  GROUP BY "referenceId"
) m ON m."referenceId" = t."id";

COMMENT ON VIEW v_transfer_reconciliation IS
  'One row per warehouse transfer, comparing what left the source with what arrived at the destination. balanced = false means stock is unaccounted for between two of the studio''s own warehouses.';
