-- ============================================================
-- THE GUARANTEES THE SCHEMA FILE CANNOT STATE
-- ============================================================
--
-- Prisma's schema language can express tables, keys and indexes. It
-- cannot express "this table may never be updated", "this number
-- may never be negative", or "prove the running total is right".
-- Those are the three things this inventory most needs, so they are
-- written here as SQL and applied as a migration like anything else.
--
-- They are enforced by POSTGRES, not by the application. An ORM
-- bug, a psql session, a future developer in a hurry and a
-- half-written script all hit the same wall.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. APPEND-ONLY: THE STOCK LEDGER AND THE AUDIT LOG
-- ────────────────────────────────────────────────────────────
--
-- A stock history that can be quietly edited is a stock history
-- nobody can rely on in a dispute -- and an audit trail that can be
-- edited documents nothing at all.
--
-- A correction is made by POSTING THE OPPOSITE ENTRY, linked back
-- through "reversalOfEntryId". The wrong entry stays visible for
-- ever. That is the point, not a side effect.

CREATE OR REPLACE FUNCTION erp_refuse_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Post a reversing entry instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Insert a correcting row that references the original; never change or remove history.';
END;
$$;

CREATE TRIGGER stock_ledger_entries_no_update
  BEFORE UPDATE ON "stock_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION erp_refuse_mutation();

CREATE TRIGGER stock_ledger_entries_no_delete
  BEFORE DELETE ON "stock_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION erp_refuse_mutation();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its
-- own statement-level guard. Without this, one TRUNCATE erases the
-- whole stock history and every row trigger above stays silent.
CREATE TRIGGER stock_ledger_entries_no_truncate
  BEFORE TRUNCATE ON "stock_ledger_entries"
  EXECUTE FUNCTION erp_refuse_mutation();

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION erp_refuse_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION erp_refuse_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  EXECUTE FUNCTION erp_refuse_mutation();


-- ────────────────────────────────────────────────────────────
-- 2. NUMBERS THAT CANNOT BE NONSENSE
-- ────────────────────────────────────────────────────────────

-- A movement of zero or minus five boxes is not a quantity, it is a
-- bug. Direction lives in "movementType", so the quantity itself is
-- always positive and can never be accidentally negated into the
-- wrong direction.
ALTER TABLE "stock_ledger_entries"
  ADD CONSTRAINT stock_ledger_quantity_positive
  CHECK ("quantity" > 0);

-- "We dispatched more than we had" is a data error, not a number.
-- Catching it at the moment it is written means the alternative --
-- discovering it a month later with no idea which movement was
-- wrong -- never happens.
ALTER TABLE "inventory_balances"
  ADD CONSTRAINT inventory_on_hand_not_negative
  CHECK ("quantityOnHand" >= 0);

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT inventory_reserved_not_negative
  CHECK ("quantityReserved" >= 0);

-- Prices are not negative. A discount is a discount; a negative
-- price is a typo nobody notices until it is invoiced.
ALTER TABLE "products"
  ADD CONSTRAINT product_prices_not_negative
  CHECK ("purchasePrice" >= 0 AND "sellingPrice" >= 0
         AND ("mrp" IS NULL OR "mrp" >= 0));

-- A transfer from a warehouse to itself moves nothing and would
-- write a matching pair of entries that cancel out, leaving a
-- document that looks real and did nothing.
ALTER TABLE "warehouse_transfers"
  ADD CONSTRAINT transfer_between_different_warehouses
  CHECK ("fromWarehouseId" <> "toWarehouseId");

-- A category cannot be its own parent.
ALTER TABLE "product_categories"
  ADD CONSTRAINT category_not_its_own_parent
  CHECK ("parentId" IS NULL OR "parentId" <> "id");


-- ────────────────────────────────────────────────────────────
-- 3. EXACTLY ONE DEFAULT WAREHOUSE
-- ────────────────────────────────────────────────────────────
--
-- A partial unique index: any number of warehouses, at most one of
-- them flagged default. Two defaults would make "where did this
-- land?" ambiguous for every receipt that did not name a location.

CREATE UNIQUE INDEX warehouses_single_default
  ON "warehouses" ("isDefault")
  WHERE "isDefault" = true;


-- ────────────────────────────────────────────────────────────
-- 4. PROVING THE RUNNING TOTAL
-- ────────────────────────────────────────────────────────────
--
-- "inventory_balances" is a PROJECTION of the ledger, kept because
-- summing a product's whole history on every page load stops being
-- viable at a few hundred thousand rows. It is written only inside
-- the same transaction as the ledger entry that caused it, with the
-- row locked.
--
-- This view is how that claim is CHECKED rather than trusted. It
-- recomputes every balance from the ledger and reports any row
-- where the two disagree. A healthy database returns nothing from:
--
--     SELECT * FROM v_inventory_reconciliation WHERE NOT reconciled;

CREATE OR REPLACE VIEW v_inventory_reconciliation AS
SELECT
  b."productId",
  b."warehouseId",
  p."sku",
  b."quantityOnHand"                                  AS projected_quantity,
  COALESCE(l.ledger_quantity, 0)                      AS ledger_quantity,
  b."quantityOnHand" - COALESCE(l.ledger_quantity, 0) AS difference,
  b."quantityOnHand" = COALESCE(l.ledger_quantity, 0) AS reconciled,
  COALESCE(l.movement_count, 0)                       AS movement_count
FROM "inventory_balances" b
JOIN "products" p ON p."id" = b."productId"
LEFT JOIN (
  SELECT
    "productId",
    "warehouseId",
    SUM(
      CASE
        WHEN "movementType" IN ('INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN')
          THEN "quantity"
        ELSE -"quantity"
      END
    ) AS ledger_quantity,
    COUNT(*) AS movement_count
  FROM "stock_ledger_entries"
  GROUP BY "productId", "warehouseId"
) l ON l."productId" = b."productId" AND l."warehouseId" = b."warehouseId";

COMMENT ON VIEW v_inventory_reconciliation IS
  'Recomputes every stock balance from the append-only ledger. Any row with reconciled = false is a projection that has drifted from its own history and must be investigated before it is trusted.';


-- ────────────────────────────────────────────────────────────
-- 5. WHAT IS ACTUALLY AVAILABLE
-- ────────────────────────────────────────────────────────────
--
-- Out of stock is NOT a product status, so this is where the
-- question is answered: derived from inventory, per product, across
-- warehouses. Discontinued is reported separately from out of
-- stock, because one is a product to stop buying and the other a
-- product to buy more of.

CREATE OR REPLACE VIEW v_product_availability AS
SELECT
  p."id"            AS product_id,
  p."sku",
  p."name",
  p."status",
  COALESCE(SUM(b."quantityOnHand"), 0)                                AS quantity_on_hand,
  COALESCE(SUM(b."quantityReserved"), 0)                              AS quantity_reserved,
  COALESCE(SUM(b."quantityOnHand"), 0)
    - COALESCE(SUM(b."quantityReserved"), 0)                          AS quantity_available,
  COALESCE(MAX(b."reorderLevel"), p."reorderLevel")                   AS reorder_level,
  CASE
    WHEN p."status" = 'DISCONTINUED' THEN 'DISCONTINUED'
    WHEN p."status" = 'INACTIVE'     THEN 'INACTIVE'
    WHEN COALESCE(SUM(b."quantityOnHand"), 0) <= 0 THEN 'OUT_OF_STOCK'
    WHEN COALESCE(SUM(b."quantityOnHand"), 0)
         <= COALESCE(MAX(b."reorderLevel"), p."reorderLevel") THEN 'LOW_STOCK'
    ELSE 'IN_STOCK'
  END AS availability
FROM "products" p
LEFT JOIN "inventory_balances" b ON b."productId" = p."id"
GROUP BY p."id", p."sku", p."name", p."status", p."reorderLevel";

COMMENT ON VIEW v_product_availability IS
  'Availability derived from inventory, never stored on the product. OUT_OF_STOCK and DISCONTINUED are reported separately: one is a product to buy more of, the other one to stop buying.';
