-- ============================================================
-- STEP 6: PURCHASE MANAGEMENT
-- ============================================================
-- Every statement here is additive. No table is dropped, no
-- column removed, no row deleted, no data reset.
--
-- Written by hand rather than generated, for one reason: Prisma
-- diffs two enum members as "dropped and added", which would mean
-- recreating the type and rewriting the column. They are RENAMED
-- instead, which touches no rows at all.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. THE PURCHASE ORDER LIFECYCLE
-- ────────────────────────────────────────────────────────────
--
-- ORDERED already meant "placed with the supplier", which is what
-- the approved state is; RECEIVED already meant fully received.
-- Renaming keeps the vocabulary the brief asks for WITHOUT
-- leaving two dead members behind, and ALTER TYPE ... RENAME
-- VALUE rewrites nothing. There were zero purchase orders in
-- every database when this ran, so there is no data either way.

ALTER TYPE "PurchaseOrderStatus" RENAME VALUE 'ORDERED' TO 'APPROVED';
ALTER TYPE "PurchaseOrderStatus" RENAME VALUE 'RECEIVED' TO 'FULLY_RECEIVED';

ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'APPROVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'CLOSED';

-- New kinds of stock reference. A receipt is not an order: the
-- order is the agreement, the note is the delivery, and only the
-- second one moved stock.
ALTER TYPE "StockReferenceType" ADD VALUE IF NOT EXISTS 'GOODS_RECEIPT_NOTE';
ALTER TYPE "StockReferenceType" ADD VALUE IF NOT EXISTS 'PURCHASE_RETURN';

-- Approving, receiving and closing are distinct auditable acts.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPROVE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLOSE';

CREATE TYPE "GoodsReceiptStatus"    AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
CREATE TYPE "PurchaseReturnStatus"  AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('RECEIVED', 'MATCHED', 'DISPUTED', 'CANCELLED');
CREATE TYPE "GstTreatment"          AS ENUM ('INTRA_STATE', 'INTER_STATE', 'UNREGISTERED');


-- ────────────────────────────────────────────────────────────
-- 2. SUPPLIERS AND WAREHOUSES GAIN WHAT GST NEEDS
-- ────────────────────────────────────────────────────────────

ALTER TABLE "suppliers"
  ADD COLUMN "postalCode"          TEXT,
  ADD COLUMN "stateCode"           TEXT,
  ADD COLUMN "shippingAddressLine" TEXT,
  ADD COLUMN "shippingCity"        TEXT,
  ADD COLUMN "shippingState"       TEXT,
  ADD COLUMN "shippingStateCode"   TEXT,
  ADD COLUMN "shippingPostalCode"  TEXT,
  ADD COLUMN "creditPeriodDays"    INTEGER,
  ADD COLUMN "notes"               TEXT;

CREATE INDEX "suppliers_stateCode_idx" ON "suppliers" ("stateCode");

ALTER TABLE "warehouses"
  ADD COLUMN "stateCode" TEXT,
  ADD COLUMN "gstin"     TEXT;

-- A GST state code is exactly two digits, 01..38 plus the few
-- special codes. Checked rather than trusted, because "Gujarat"
-- typed into a code field produces tax that is wrong in a way
-- nobody notices until an audit.
ALTER TABLE "suppliers"
  ADD CONSTRAINT supplier_state_code_is_two_digits
  CHECK ("stateCode" IS NULL OR "stateCode" ~ '^[0-9]{2}$');

ALTER TABLE "suppliers"
  ADD CONSTRAINT supplier_shipping_state_code_is_two_digits
  CHECK ("shippingStateCode" IS NULL OR "shippingStateCode" ~ '^[0-9]{2}$');

ALTER TABLE "warehouses"
  ADD CONSTRAINT warehouse_state_code_is_two_digits
  CHECK ("stateCode" IS NULL OR "stateCode" ~ '^[0-9]{2}$');

ALTER TABLE "suppliers"
  ADD CONSTRAINT supplier_credit_period_not_negative
  CHECK ("creditPeriodDays" IS NULL OR "creditPeriodDays" >= 0);

-- The seeded suppliers and the studio warehouse are all Gujarat,
-- and every seeded GSTIN already begins 24. Derived from the
-- GSTIN where there is one, so the two can never disagree.
UPDATE "suppliers" SET "stateCode" = substring("gstin" FROM 1 FOR 2)
  WHERE "gstin" ~ '^[0-9]{2}' AND "stateCode" IS NULL;
UPDATE "suppliers" SET "stateCode" = '24'
  WHERE "stateCode" IS NULL AND lower("state") = 'gujarat';
UPDATE "warehouses" SET "stateCode" = '24'
  WHERE "stateCode" IS NULL AND lower("state") = 'gujarat';


-- ────────────────────────────────────────────────────────────
-- 3. THE PURCHASE ORDER
-- ────────────────────────────────────────────────────────────

ALTER TABLE "purchase_orders"
  ADD COLUMN "billingAddress"    TEXT,
  ADD COLUMN "shippingAddress"   TEXT,
  ADD COLUMN "paymentTerms"      TEXT,
  ADD COLUMN "gstTreatment"      "GstTreatment" NOT NULL DEFAULT 'INTRA_STATE',
  ADD COLUMN "supplierStateCode" TEXT,
  ADD COLUMN "placeOfSupplyCode" TEXT,
  ADD COLUMN "discountTotal"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxableTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cgstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "otherCharges"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "submittedAt"       TIMESTAMP(3),
  ADD COLUMN "approvedById"      UUID,
  ADD COLUMN "approvedAt"        TIMESTAMP(3),
  ADD COLUMN "cancelledById"     UUID,
  ADD COLUMN "cancelledAt"       TIMESTAMP(3),
  ADD COLUMN "cancelReason"      TEXT,
  ADD COLUMN "closedById"        UUID,
  ADD COLUMN "closedAt"          TIMESTAMP(3),
  ADD COLUMN "closeReason"       TEXT;

-- The default above exists only so the column can be NOT NULL on
-- a table that happens to be empty. Dropped immediately: every
-- order must state its own GST treatment, and a default would let
-- one through that nobody decided.
ALTER TABLE "purchase_orders" ALTER COLUMN "gstTreatment" DROP DEFAULT;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "purchase_orders_warehouseId_idx" ON "purchase_orders" ("warehouseId");

-- AN APPROVED ORDER MUST SAY WHO APPROVED IT. An order that
-- reached a supplier with nobody's name against it is not a
-- control, and the pair being all-or-nothing is what makes the
-- audit trail answerable.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_approval_is_attributed
  CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL));

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_cancellation_is_attributed
  CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL));

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_closure_is_attributed
  CHECK (("closedAt" IS NULL) = ("closedById" IS NULL));

-- Cancelling and closing are different answers to "this order is
-- finished with", and an order cannot be both.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_not_both_cancelled_and_closed
  CHECK ("cancelledAt" IS NULL OR "closedAt" IS NULL);

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_totals_not_negative
  CHECK ("subTotal" >= 0 AND "discountTotal" >= 0 AND "taxableTotal" >= 0
     AND "cgstTotal" >= 0 AND "sgstTotal" >= 0 AND "igstTotal" >= 0
     AND "taxTotal" >= 0 AND "otherCharges" >= 0 AND "grandTotal" >= 0);

-- THE TAX SPLIT HAS TO ADD UP. Intra-state means CGST and SGST and
-- no IGST; inter-state means IGST and neither of the others. A row
-- with both is a calculation bug, and it is refused here rather
-- than discovered on a return.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_tax_split_matches_treatment
  CHECK (
    CASE "gstTreatment"
      WHEN 'INTER_STATE'  THEN "cgstTotal" = 0 AND "sgstTotal" = 0
      WHEN 'INTRA_STATE'  THEN "igstTotal" = 0
      WHEN 'UNREGISTERED' THEN "cgstTotal" = 0 AND "sgstTotal" = 0 AND "igstTotal" = 0
    END
  );

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_tax_total_is_the_sum_of_its_parts
  CHECK ("taxTotal" = "cgstTotal" + "sgstTotal" + "igstTotal");

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT purchase_order_grand_total_adds_up
  CHECK ("grandTotal" = "taxableTotal" + "taxTotal" + "otherCharges");


-- ────────────────────────────────────────────────────────────
-- 4. THE PURCHASE ORDER LINE
-- ────────────────────────────────────────────────────────────

ALTER TABLE "purchase_order_lines"
  ADD COLUMN "hsnAtOrder"       TEXT,
  ADD COLUMN "description"      TEXT,
  ADD COLUMN "expectedDate"     TIMESTAMP(3),
  ADD COLUMN "discountPercent"  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  ADD COLUMN "discountAmount"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "grossAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxableValue"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxRate"          DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN "cgstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "rejectedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_quantity_is_positive
  CHECK ("quantity" > 0);

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_amounts_not_negative
  CHECK ("unitPrice" >= 0 AND "discountAmount" >= 0 AND "grossAmount" >= 0
     AND "taxableValue" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0
     AND "receivedQuantity" >= 0 AND "rejectedQuantity" >= 0);

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_discount_percent_in_range
  CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100);

-- A discount cannot exceed what is being discounted.
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_discount_within_gross
  CHECK ("discountAmount" <= "grossAmount");

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_taxable_value_adds_up
  CHECK ("taxableValue" = "grossAmount" - "discountAmount");

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_tax_adds_up
  CHECK ("taxAmount" = "cgstAmount" + "sgstAmount" + "igstAmount");

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT purchase_order_line_total_adds_up
  CHECK ("lineTotal" = "taxableValue" + "taxAmount");


-- ────────────────────────────────────────────────────────────
-- 5. GOODS RECEIPT
-- ────────────────────────────────────────────────────────────

CREATE TABLE "goods_receipt_notes" (
  "id"              UUID NOT NULL,
  "grnNo"           TEXT NOT NULL,
  "status"          "GoodsReceiptStatus" NOT NULL DEFAULT 'DRAFT',
  "purchaseOrderId" UUID NOT NULL,
  "supplierId"      UUID NOT NULL,
  "warehouseId"     UUID NOT NULL,
  "receiptDate"     TIMESTAMP(3) NOT NULL,
  "supplierDocNo"   TEXT,
  "supplierDocDate" TIMESTAMP(3),
  "documentRef"     TEXT,
  "remarks"         TEXT,
  "receivedById"    UUID NOT NULL,
  "postedById"      UUID,
  "postedAt"        TIMESTAMP(3),
  "cancelledById"   UUID,
  "cancelledAt"     TIMESTAMP(3),
  "cancelReason"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "goods_receipt_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "goods_receipt_notes_grnNo_key" ON "goods_receipt_notes" ("grnNo");
CREATE INDEX "goods_receipt_notes_purchaseOrderId_idx" ON "goods_receipt_notes" ("purchaseOrderId");
CREATE INDEX "goods_receipt_notes_supplierId_idx" ON "goods_receipt_notes" ("supplierId");
CREATE INDEX "goods_receipt_notes_status_receiptDate_idx" ON "goods_receipt_notes" ("status", "receiptDate");

-- A POSTED receipt is the thing that moved stock, so it must say
-- who posted it and when. Same all-or-nothing rule as approval.
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT goods_receipt_posting_is_attributed
  CHECK (("postedAt" IS NULL) = ("postedById" IS NULL));

ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT goods_receipt_cancellation_is_attributed
  CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL));

-- A posted receipt carries its posting time, and a draft does not.
-- Without this a note could read POSTED with nothing behind it.
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT goods_receipt_status_matches_its_timestamps
  CHECK (
    CASE "status"
      WHEN 'POSTED'    THEN "postedAt" IS NOT NULL AND "cancelledAt" IS NULL
      WHEN 'CANCELLED' THEN "cancelledAt" IS NOT NULL
      WHEN 'DRAFT'     THEN "postedAt" IS NULL AND "cancelledAt" IS NULL
    END
  );

CREATE TABLE "goods_receipt_note_lines" (
  "id"                         UUID NOT NULL,
  "goodsReceiptNoteId"         UUID NOT NULL,
  "lineNo"                     INTEGER NOT NULL,
  "purchaseOrderLineId"        UUID NOT NULL,
  "productId"                  UUID NOT NULL,
  "skuAtReceipt"               TEXT NOT NULL,
  "nameAtReceipt"              TEXT NOT NULL,
  "orderedQuantity"            DECIMAL(14,3) NOT NULL,
  "previouslyReceivedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "acceptedQuantity"           DECIMAL(14,3) NOT NULL,
  "damagedQuantity"            DECIMAL(14,3) NOT NULL DEFAULT 0,
  "rejectedQuantity"           DECIMAL(14,3) NOT NULL DEFAULT 0,
  "receivedQuantity"           DECIMAL(14,3) NOT NULL,
  "uom"                        "UnitOfMeasure" NOT NULL,
  "unitCost"                   DECIMAL(14,2),
  "rejectionReason"            TEXT,
  "remarks"                    TEXT,
  CONSTRAINT "goods_receipt_note_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "goods_receipt_note_lines_goodsReceiptNoteId_lineNo_key"
  ON "goods_receipt_note_lines" ("goodsReceiptNoteId", "lineNo");
CREATE INDEX "goods_receipt_note_lines_purchaseOrderLineId_idx"
  ON "goods_receipt_note_lines" ("purchaseOrderLineId");
CREATE INDEX "goods_receipt_note_lines_productId_idx"
  ON "goods_receipt_note_lines" ("productId");

ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT goods_receipt_line_quantities_not_negative
  CHECK ("orderedQuantity" >= 0 AND "previouslyReceivedQuantity" >= 0
     AND "acceptedQuantity" >= 0 AND "damagedQuantity" >= 0
     AND "rejectedQuantity" >= 0 AND "receivedQuantity" >= 0);

-- WHAT CAME THROUGH THE DOOR is accepted plus damaged, and
-- rejected is deliberately not part of it: those boxes were turned
-- away at the gate, never entered stock, and the supplier still
-- owes them.
ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT goods_receipt_line_received_is_accepted_plus_damaged
  CHECK ("receivedQuantity" = "acceptedQuantity" + "damagedQuantity");

-- A line that records nothing at all is not a receipt line.
ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT goods_receipt_line_records_something
  CHECK ("receivedQuantity" > 0 OR "rejectedQuantity" > 0);

-- Turning stock away needs a reason on the record.
ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT goods_receipt_line_rejection_has_a_reason
  CHECK ("rejectedQuantity" = 0 OR ("rejectionReason" IS NOT NULL AND length(btrim("rejectionReason")) > 0));

ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_postedById_fkey"
  FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_notes"
  ADD CONSTRAINT "goods_receipt_notes_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT "goods_receipt_note_lines_goodsReceiptNoteId_fkey"
  FOREIGN KEY ("goodsReceiptNoteId") REFERENCES "goods_receipt_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT "goods_receipt_note_lines_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_note_lines"
  ADD CONSTRAINT "goods_receipt_note_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 6. PURCHASE RETURNS
-- ────────────────────────────────────────────────────────────

CREATE TABLE "purchase_returns" (
  "id"              UUID NOT NULL,
  "returnNo"        TEXT NOT NULL,
  "status"          "PurchaseReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "supplierId"      UUID NOT NULL,
  "warehouseId"     UUID NOT NULL,
  "purchaseOrderId" UUID,
  "returnDate"      TIMESTAMP(3) NOT NULL,
  "reason"          TEXT NOT NULL,
  "remarks"         TEXT,
  "documentRef"     TEXT,
  "createdById"     UUID NOT NULL,
  "postedById"      UUID,
  "postedAt"        TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_returns_returnNo_key" ON "purchase_returns" ("returnNo");
CREATE INDEX "purchase_returns_supplierId_idx" ON "purchase_returns" ("supplierId");
CREATE INDEX "purchase_returns_status_returnDate_idx" ON "purchase_returns" ("status", "returnDate");

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT purchase_return_posting_is_attributed
  CHECK (("postedAt" IS NULL) = ("postedById" IS NULL));

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT purchase_return_has_a_reason
  CHECK (length(btrim("reason")) > 0);

CREATE TABLE "purchase_return_lines" (
  "id"               UUID NOT NULL,
  "purchaseReturnId" UUID NOT NULL,
  "lineNo"           INTEGER NOT NULL,
  "productId"        UUID NOT NULL,
  "skuAtReturn"      TEXT NOT NULL,
  "nameAtReturn"     TEXT NOT NULL,
  "quantity"         DECIMAL(14,3) NOT NULL,
  "uom"              "UnitOfMeasure" NOT NULL,
  "unitCost"         DECIMAL(14,2),
  "fromDamaged"      BOOLEAN NOT NULL DEFAULT false,
  "remarks"          TEXT,
  CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_return_lines_purchaseReturnId_lineNo_key"
  ON "purchase_return_lines" ("purchaseReturnId", "lineNo");
CREATE INDEX "purchase_return_lines_productId_idx" ON "purchase_return_lines" ("productId");

ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT purchase_return_line_quantity_is_positive
  CHECK ("quantity" > 0);

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_postedById_fkey"
  FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT "purchase_return_lines_purchaseReturnId_fkey"
  FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT "purchase_return_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 7. SUPPLIER INVOICES
-- ────────────────────────────────────────────────────────────

CREATE TABLE "supplier_invoices" (
  "id"                 UUID NOT NULL,
  "supplierId"         UUID NOT NULL,
  "status"             "SupplierInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
  "invoiceNo"          TEXT NOT NULL,
  "invoiceDate"        TIMESTAMP(3) NOT NULL,
  "dueDate"            TIMESTAMP(3),
  "purchaseOrderId"    UUID,
  "goodsReceiptNoteId" UUID,
  "taxableAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxAmount"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "invoiceAmount"      DECIMAL(14,2) NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'INR',
  "documentRef"        TEXT,
  "notes"              TEXT,
  "createdById"        UUID NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- ONE INVOICE NUMBER PER SUPPLIER. The same number from two
-- suppliers is ordinary; the same number twice from one supplier
-- is a double entry, and paying it twice is how money leaves a
-- business quietly. Enforced here so two clerks saving at the same
-- moment cannot both succeed.
CREATE UNIQUE INDEX "supplier_invoices_supplierId_invoiceNo_key"
  ON "supplier_invoices" ("supplierId", "invoiceNo");
CREATE INDEX "supplier_invoices_status_invoiceDate_idx"
  ON "supplier_invoices" ("status", "invoiceDate");

ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT supplier_invoice_amounts_not_negative
  CHECK ("taxableAmount" >= 0 AND "taxAmount" >= 0 AND "invoiceAmount" >= 0);

ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT supplier_invoice_number_is_not_blank
  CHECK (length(btrim("invoiceNo")) > 0);

ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_goodsReceiptNoteId_fkey"
  FOREIGN KEY ("goodsReceiptNoteId") REFERENCES "goods_receipt_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 8. DOCUMENT NUMBERS FOR THE NEW DOCUMENTS
-- ────────────────────────────────────────────────────────────
-- Reusing the existing sequence table and its row-locking
-- allocator. No second numbering mechanism is introduced.

INSERT INTO "document_sequences" ("documentType", "prefix", "periodKey", "lastNumber", "padding", "updatedAt")
VALUES ('GOODS_RECEIPT_NOTE', 'GRN', '2026', 0, 4, now()),
       ('PURCHASE_RETURN',    'PR',  '2026', 0, 4, now())
ON CONFLICT ("documentType") DO NOTHING;
