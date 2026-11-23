-- ============================================================
-- STEP 7: SALES MANAGEMENT
-- ============================================================
-- Every statement here is additive. No table is dropped, no
-- column removed, no row deleted, no data reset.
--
-- Written by hand rather than generated, for the same reason as
-- step 6's purchase migration: Prisma diffs a renamed enum member
-- as "dropped and added", which would recreate the type and
-- rewrite the column. Renamed instead, which touches no rows.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. THE SALES ORDER LIFECYCLE
-- ────────────────────────────────────────────────────────────
--
-- QUOTATION predates the separate Quotation document this step
-- adds and is renamed to DRAFT; DISPATCHED/INVOICED/DELIVERED are
-- renamed to the clearer PARTIALLY_DISPATCHED/FULLY_DISPATCHED/
-- CLOSED. There were zero sales orders in every database when
-- this ran, so there is no data to migrate either way.

ALTER TYPE "SalesOrderStatus" RENAME VALUE 'QUOTATION' TO 'DRAFT';
ALTER TYPE "SalesOrderStatus" RENAME VALUE 'DISPATCHED' TO 'PARTIALLY_DISPATCHED';
ALTER TYPE "SalesOrderStatus" RENAME VALUE 'INVOICED' TO 'FULLY_DISPATCHED';
ALTER TYPE "SalesOrderStatus" RENAME VALUE 'DELIVERED' TO 'CLOSED';

ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'CONFIRMED';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RESERVED' BEFORE 'PARTIALLY_DISPATCHED';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'RESERVED' BEFORE 'PARTIALLY_DISPATCHED';

-- New kinds of stock reference. A dispatch is not an order: the
-- order is the agreement, the challan is the delivery, and only
-- the second one moved stock.
ALTER TYPE "StockReferenceType" ADD VALUE IF NOT EXISTS 'DELIVERY_CHALLAN';
ALTER TYPE "StockReferenceType" ADD VALUE IF NOT EXISTS 'SALES_RETURN';

-- Reservation and dispatch are distinct auditable acts.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESERVE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPATCH';

CREATE TYPE "QuotationStatus"        AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED');
CREATE TYPE "SalesInvoiceStatus"     AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
CREATE TYPE "DeliveryChallanStatus"  AS ENUM ('DRAFT', 'DISPATCHED', 'CANCELLED');
CREATE TYPE "SalesReturnStatus"      AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');
CREATE TYPE "ReturnDisposition"      AS ENUM ('ACCEPTED_GOOD', 'DAMAGED', 'REJECTED');
CREATE TYPE "PaymentStatus"          AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE');
CREATE TYPE "PaymentMethod"          AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER');
CREATE TYPE "SalesGstTreatment"      AS ENUM ('INTRA_STATE', 'INTER_STATE');


-- ────────────────────────────────────────────────────────────
-- 2. THE CUSTOMER GAINS WHAT GST AND CREDIT NEED
-- ────────────────────────────────────────────────────────────

ALTER TABLE "customers"
  ADD COLUMN "postalCode"          TEXT,
  ADD COLUMN "stateCode"           TEXT,
  ADD COLUMN "shippingAddressLine" TEXT,
  ADD COLUMN "shippingCity"        TEXT,
  ADD COLUMN "shippingState"       TEXT,
  ADD COLUMN "shippingStateCode"   TEXT,
  ADD COLUMN "shippingPostalCode"  TEXT,
  ADD COLUMN "paymentTerms"        TEXT,
  ADD COLUMN "creditPeriodDays"    INTEGER,
  ADD COLUMN "notes"               TEXT;

CREATE INDEX "customers_stateCode_idx" ON "customers" ("stateCode");

ALTER TABLE "customers"
  ADD CONSTRAINT customer_state_code_is_two_digits
  CHECK ("stateCode" IS NULL OR "stateCode" ~ '^[0-9]{2}$');
ALTER TABLE "customers"
  ADD CONSTRAINT customer_shipping_state_code_is_two_digits
  CHECK ("shippingStateCode" IS NULL OR "shippingStateCode" ~ '^[0-9]{2}$');
ALTER TABLE "customers"
  ADD CONSTRAINT customer_credit_period_not_negative
  CHECK ("creditPeriodDays" IS NULL OR "creditPeriodDays" >= 0);

-- Derived from the GSTIN where there is one, same as the supplier
-- backfill in step 6.
UPDATE "customers" SET "stateCode" = substring("gstin" FROM 1 FOR 2)
  WHERE "gstin" ~ '^[0-9]{2}' AND "stateCode" IS NULL;
UPDATE "customers" SET "stateCode" = '24', "shippingStateCode" = '24'
  WHERE "stateCode" IS NULL AND lower("state") = 'gujarat';


-- ────────────────────────────────────────────────────────────
-- 3. THE SALES ORDER
-- ────────────────────────────────────────────────────────────

ALTER TABLE "sales_orders" RENAME COLUMN "dispatchDate" TO "legacyDispatchDate";
COMMENT ON COLUMN "sales_orders"."legacyDispatchDate" IS
  'Superseded by expectedDispatchDate (planned) and each delivery challan''s own dispatchDate (actual). Always null: no sales order existed before step 7.';

ALTER TABLE "sales_orders"
  ADD COLUMN "quotationId"          UUID,
  ADD COLUMN "expectedDispatchDate" TIMESTAMP(3),
  ADD COLUMN "billingAddress"       TEXT,
  ADD COLUMN "shippingAddress"      TEXT,
  ADD COLUMN "paymentTerms"         TEXT,
  ADD COLUMN "deliveryTerms"        TEXT,
  ADD COLUMN "gstTreatment"         "SalesGstTreatment" NOT NULL DEFAULT 'INTRA_STATE',
  ADD COLUMN "sellerStateCode"      TEXT,
  ADD COLUMN "placeOfSupplyCode"    TEXT,
  ADD COLUMN "discountTotal"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxableTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cgstTotal"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgstTotal"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igstTotal"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "otherCharges"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "submittedAt"          TIMESTAMP(3),
  ADD COLUMN "approvedById"         UUID,
  ADD COLUMN "approvedAt"           TIMESTAMP(3),
  ADD COLUMN "cancelledById"        UUID,
  ADD COLUMN "cancelledAt"          TIMESTAMP(3),
  ADD COLUMN "cancelReason"         TEXT,
  ADD COLUMN "closedById"           UUID,
  ADD COLUMN "closedAt"             TIMESTAMP(3),
  ADD COLUMN "closeReason"          TEXT;

-- The default above exists only so the column can be NOT NULL on
-- an empty table. Dropped immediately: every order must state its
-- own GST treatment, and a default would let one through that
-- nobody decided.
ALTER TABLE "sales_orders" ALTER COLUMN "gstTreatment" DROP DEFAULT;

ALTER TABLE "sales_orders" RENAME COLUMN "discount" TO "legacyDiscount";
-- The step-2 column was a single undifferentiated "discount" with
-- no breakdown; it is superseded by discountTotal (line-level
-- discounts summed) and kept, renamed, so no data is dropped even
-- though it held nothing (zero rows existed).
COMMENT ON COLUMN "sales_orders"."legacyDiscount" IS
  'Superseded by discountTotal. Kept only because dropping a column is not additive; always zero, since no sales order existed before this migration.';

ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sales_orders_warehouseId_idx" ON "sales_orders" ("warehouseId");
CREATE INDEX "sales_orders_quotationId_idx" ON "sales_orders" ("quotationId");

ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_approval_is_attributed
  CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL));
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_cancellation_is_attributed
  CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL));
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_closure_is_attributed
  CHECK (("closedAt" IS NULL) = ("closedById" IS NULL));
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_not_both_cancelled_and_closed
  CHECK ("cancelledAt" IS NULL OR "closedAt" IS NULL);

ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_totals_not_negative
  CHECK ("subTotal" >= 0 AND "discountTotal" >= 0 AND "taxableTotal" >= 0
     AND "cgstTotal" >= 0 AND "sgstTotal" >= 0 AND "igstTotal" >= 0
     AND "taxTotal" >= 0 AND "otherCharges" >= 0 AND "grandTotal" >= 0);

-- THE TAX SPLIT HAS TO MATCH THE TREATMENT, exactly as on a
-- purchase order: intra-state means CGST+SGST and no IGST,
-- inter-state the reverse. (There is no UNREGISTERED case on the
-- sales side: a B2C sale still carries GST.)
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_tax_split_matches_treatment
  CHECK (
    CASE "gstTreatment"
      WHEN 'INTER_STATE' THEN "cgstTotal" = 0 AND "sgstTotal" = 0
      WHEN 'INTRA_STATE' THEN "igstTotal" = 0
    END
  );
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_tax_total_is_the_sum_of_its_parts
  CHECK ("taxTotal" = "cgstTotal" + "sgstTotal" + "igstTotal");
ALTER TABLE "sales_orders"
  ADD CONSTRAINT sales_order_grand_total_adds_up
  CHECK ("grandTotal" = "taxableTotal" + "taxTotal" + "otherCharges");


-- ────────────────────────────────────────────────────────────
-- 4. THE SALES ORDER LINE
-- ────────────────────────────────────────────────────────────

ALTER TABLE "sales_order_lines"
  ADD COLUMN "hsnAtOrder"       TEXT,
  ADD COLUMN "description"      TEXT,
  ADD COLUMN "discountPercent"  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  ADD COLUMN "discountAmount"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "grossAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxableValue"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxRate"          DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN "cgstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igstAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "reservedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN "returnedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

ALTER TABLE "sales_order_lines" RENAME COLUMN "discount" TO "legacyDiscount";
COMMENT ON COLUMN "sales_order_lines"."legacyDiscount" IS
  'Superseded by discountAmount/discountPercent. Always zero: no sales order line existed before this migration.';

ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_quantity_is_positive
  CHECK ("quantity" > 0);
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_amounts_not_negative
  CHECK ("unitPrice" >= 0 AND "discountAmount" >= 0 AND "grossAmount" >= 0
     AND "taxableValue" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0
     AND "reservedQuantity" >= 0 AND "dispatchedQuantity" >= 0 AND "returnedQuantity" >= 0);
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_discount_percent_in_range
  CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100);
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_discount_within_gross
  CHECK ("discountAmount" <= "grossAmount");
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_taxable_value_adds_up
  CHECK ("taxableValue" = "grossAmount" - "discountAmount");
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_tax_adds_up
  CHECK ("taxAmount" = "cgstAmount" + "sgstAmount" + "igstAmount");
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_total_adds_up
  CHECK ("lineTotal" = "taxableValue" + "taxAmount");

-- RESERVED, DISPATCHED AND RETURNED CANNOT EXCEED WHAT WAS
-- ORDERED. Reserved + dispatched is the right sum to bound,
-- because dispatching MOVES quantity out of reserved into
-- dispatched rather than adding a third independent pool.
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_reserved_plus_dispatched_within_ordered
  CHECK ("reservedQuantity" + "dispatchedQuantity" <= "quantity");
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT sales_order_line_returned_within_dispatched
  CHECK ("returnedQuantity" <= "dispatchedQuantity");


-- ────────────────────────────────────────────────────────────
-- 5. QUOTATIONS
-- ────────────────────────────────────────────────────────────

CREATE TABLE "quotations" (
  "id"             UUID NOT NULL,
  "quotationNo"    TEXT NOT NULL,
  "status"         "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
  "revisionOf"     UUID,
  "revisionNo"     INTEGER NOT NULL DEFAULT 1,
  "customerId"     UUID NOT NULL,
  "warehouseId"    UUID,
  "quotationDate"  TIMESTAMP(3) NOT NULL,
  "expiryDate"     TIMESTAMP(3),
  "billingAddress" TEXT,
  "shippingAddress" TEXT,
  "paymentTerms"   TEXT,
  "deliveryTerms"  TEXT,
  "notes"          TEXT,
  "subTotal"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountTotal"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxableTotal"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cgstTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgstTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igstTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxTotal"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grandTotal"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currency"       TEXT NOT NULL DEFAULT 'INR',
  "sentAt"         TIMESTAMP(3),
  "respondedAt"    TIMESTAMP(3),
  "convertedAt"    TIMESTAMP(3),
  "convertedById"  UUID,
  "cancelledAt"    TIMESTAMP(3),
  "createdById"    UUID NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quotations_quotationNo_key" ON "quotations" ("quotationNo");
CREATE INDEX "quotations_customerId_idx" ON "quotations" ("customerId");
CREATE INDEX "quotations_status_quotationDate_idx" ON "quotations" ("status", "quotationDate");

ALTER TABLE "quotations"
  ADD CONSTRAINT quotation_totals_not_negative
  CHECK ("subTotal" >= 0 AND "discountTotal" >= 0 AND "taxableTotal" >= 0
     AND "cgstTotal" >= 0 AND "sgstTotal" >= 0 AND "igstTotal" >= 0
     AND "taxTotal" >= 0 AND "grandTotal" >= 0);
ALTER TABLE "quotations"
  ADD CONSTRAINT quotation_conversion_is_attributed
  CHECK (("convertedAt" IS NULL) = ("convertedById" IS NULL));
-- CONVERTED means an order exists, and is reachable only through
-- the service's conversion path, never automatically.
ALTER TABLE "quotations"
  ADD CONSTRAINT quotation_converted_status_matches_timestamp
  CHECK (("status" = 'CONVERTED') = ("convertedAt" IS NOT NULL));

ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_revisionOf_fkey"
  FOREIGN KEY ("revisionOf") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_convertedById_fkey"
  FOREIGN KEY ("convertedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "quotation_lines" (
  "id"              UUID NOT NULL,
  "quotationId"     UUID NOT NULL,
  "lineNo"          INTEGER NOT NULL,
  "productId"       UUID NOT NULL,
  "skuAtQuote"      TEXT NOT NULL,
  "nameAtQuote"     TEXT NOT NULL,
  "hsnAtQuote"      TEXT,
  "description"     TEXT,
  "quantity"        DECIMAL(14,3) NOT NULL,
  "uom"             "UnitOfMeasure" NOT NULL,
  "unitPrice"       DECIMAL(14,2) NOT NULL,
  "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "discountAmount"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grossAmount"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxableValue"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxRate"         DECIMAL(5,2) NOT NULL DEFAULT 0,
  "cgstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "lineTotal"       DECIMAL(14,2) NOT NULL,
  CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quotation_lines_quotationId_lineNo_key" ON "quotation_lines" ("quotationId", "lineNo");
CREATE INDEX "quotation_lines_productId_idx" ON "quotation_lines" ("productId");

ALTER TABLE "quotation_lines"
  ADD CONSTRAINT quotation_line_quantity_is_positive CHECK ("quantity" > 0);
ALTER TABLE "quotation_lines"
  ADD CONSTRAINT quotation_line_amounts_not_negative
  CHECK ("unitPrice" >= 0 AND "discountAmount" >= 0 AND "grossAmount" >= 0
     AND "taxableValue" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "quotation_lines"
  ADD CONSTRAINT quotation_line_total_adds_up CHECK ("lineTotal" = "taxableValue" + "taxAmount");

ALTER TABLE "quotation_lines"
  ADD CONSTRAINT "quotation_lines_quotationId_fkey"
  FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_lines"
  ADD CONSTRAINT "quotation_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deferred from section 3: this FK needs the quotations table,
-- which did not exist yet when sales_orders was altered.
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_quotationId_fkey"
  FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 6. SALES INVOICES
-- ────────────────────────────────────────────────────────────

CREATE TABLE "sales_invoices" (
  "id"                UUID NOT NULL,
  "invoiceNo"         TEXT NOT NULL,
  "status"            "SalesInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "customerId"        UUID NOT NULL,
  "salesOrderId"      UUID,
  "warehouseId"       UUID NOT NULL,
  "invoiceDate"       TIMESTAMP(3) NOT NULL,
  "dueDate"           TIMESTAMP(3),
  "billingAddress"    TEXT,
  "shippingAddress"   TEXT,
  "paymentTerms"      TEXT,
  "gstTreatment"      "SalesGstTreatment" NOT NULL,
  "sellerStateCode"   TEXT,
  "placeOfSupplyCode" TEXT,
  "subTotal"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountTotal"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxableTotal"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cgstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igstTotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxTotal"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "otherCharges"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grandTotal"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currency"          TEXT NOT NULL DEFAULT 'INR',
  "notes"             TEXT,
  "postedById"        UUID,
  "postedAt"          TIMESTAMP(3),
  "cancelledById"     UUID,
  "cancelledAt"       TIMESTAMP(3),
  "cancelReason"      TEXT,
  "createdById"       UUID NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_invoices_invoiceNo_key" ON "sales_invoices" ("invoiceNo");
CREATE INDEX "sales_invoices_customerId_idx" ON "sales_invoices" ("customerId");
CREATE INDEX "sales_invoices_salesOrderId_idx" ON "sales_invoices" ("salesOrderId");
CREATE INDEX "sales_invoices_status_invoiceDate_idx" ON "sales_invoices" ("status", "invoiceDate");

ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_totals_not_negative
  CHECK ("subTotal" >= 0 AND "discountTotal" >= 0 AND "taxableTotal" >= 0
     AND "cgstTotal" >= 0 AND "sgstTotal" >= 0 AND "igstTotal" >= 0
     AND "taxTotal" >= 0 AND "otherCharges" >= 0 AND "grandTotal" >= 0);
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_tax_split_matches_treatment
  CHECK (
    CASE "gstTreatment"
      WHEN 'INTER_STATE' THEN "cgstTotal" = 0 AND "sgstTotal" = 0
      WHEN 'INTRA_STATE' THEN "igstTotal" = 0
    END
  );
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_tax_total_is_the_sum_of_its_parts
  CHECK ("taxTotal" = "cgstTotal" + "sgstTotal" + "igstTotal");
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_grand_total_adds_up
  CHECK ("grandTotal" = "taxableTotal" + "taxTotal" + "otherCharges");
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_posting_is_attributed
  CHECK (("postedAt" IS NULL) = ("postedById" IS NULL));
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_cancellation_is_attributed
  CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL));
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT sales_invoice_status_matches_its_timestamps
  CHECK (
    CASE "status"
      WHEN 'POSTED'    THEN "postedAt" IS NOT NULL AND "cancelledAt" IS NULL
      WHEN 'CANCELLED' THEN "cancelledAt" IS NOT NULL
      WHEN 'DRAFT'     THEN "postedAt" IS NULL AND "cancelledAt" IS NULL
    END
  );

ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_salesOrderId_fkey"
  FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_postedById_fkey"
  FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sales_invoice_lines" (
  "id"              UUID NOT NULL,
  "salesInvoiceId"  UUID NOT NULL,
  "lineNo"          INTEGER NOT NULL,
  "productId"       UUID NOT NULL,
  "skuAtInvoice"    TEXT NOT NULL,
  "nameAtInvoice"   TEXT NOT NULL,
  "hsnAtInvoice"    TEXT,
  "quantity"        DECIMAL(14,3) NOT NULL,
  "uom"             "UnitOfMeasure" NOT NULL,
  "unitPrice"       DECIMAL(14,2) NOT NULL,
  "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "discountAmount"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grossAmount"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxableValue"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxRate"         DECIMAL(5,2) NOT NULL DEFAULT 0,
  "cgstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igstAmount"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "lineTotal"       DECIMAL(14,2) NOT NULL,
  CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_invoice_lines_salesInvoiceId_lineNo_key" ON "sales_invoice_lines" ("salesInvoiceId", "lineNo");
CREATE INDEX "sales_invoice_lines_productId_idx" ON "sales_invoice_lines" ("productId");

ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT sales_invoice_line_quantity_is_positive CHECK ("quantity" > 0);
ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT sales_invoice_line_amounts_not_negative
  CHECK ("unitPrice" >= 0 AND "discountAmount" >= 0 AND "grossAmount" >= 0
     AND "taxableValue" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT sales_invoice_line_total_adds_up CHECK ("lineTotal" = "taxableValue" + "taxAmount");

ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT "sales_invoice_lines_salesInvoiceId_fkey"
  FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT "sales_invoice_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 7. DELIVERY CHALLANS — THE ONE SALES DOCUMENT THAT MOVES STOCK
-- ────────────────────────────────────────────────────────────

CREATE TABLE "delivery_challans" (
  "id"             UUID NOT NULL,
  "challanNo"      TEXT NOT NULL,
  "status"         "DeliveryChallanStatus" NOT NULL DEFAULT 'DRAFT',
  "salesOrderId"   UUID NOT NULL,
  "salesInvoiceId" UUID,
  "customerId"     UUID NOT NULL,
  "warehouseId"    UUID NOT NULL,
  "dispatchDate"   TIMESTAMP(3) NOT NULL,
  "transporter"    TEXT,
  "vehicleNumber"  TEXT,
  "trackingRef"    TEXT,
  "receiverName"   TEXT,
  "receiverPhone"  TEXT,
  "remarks"        TEXT,
  "dispatchedById" UUID,
  "dispatchedAt"   TIMESTAMP(3),
  "cancelledById"  UUID,
  "cancelledAt"    TIMESTAMP(3),
  "cancelReason"   TEXT,
  "createdById"    UUID NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_challans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_challans_challanNo_key" ON "delivery_challans" ("challanNo");
CREATE INDEX "delivery_challans_salesOrderId_idx" ON "delivery_challans" ("salesOrderId");
CREATE INDEX "delivery_challans_customerId_idx" ON "delivery_challans" ("customerId");
CREATE INDEX "delivery_challans_status_dispatchDate_idx" ON "delivery_challans" ("status", "dispatchDate");

ALTER TABLE "delivery_challans"
  ADD CONSTRAINT delivery_challan_dispatch_is_attributed
  CHECK (("dispatchedAt" IS NULL) = ("dispatchedById" IS NULL));
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT delivery_challan_cancellation_is_attributed
  CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL));
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT delivery_challan_status_matches_its_timestamps
  CHECK (
    CASE "status"
      WHEN 'DISPATCHED' THEN "dispatchedAt" IS NOT NULL AND "cancelledAt" IS NULL
      WHEN 'CANCELLED'  THEN "cancelledAt" IS NOT NULL
      WHEN 'DRAFT'      THEN "dispatchedAt" IS NULL AND "cancelledAt" IS NULL
    END
  );

ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_salesOrderId_fkey"
  FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_salesInvoiceId_fkey"
  FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_dispatchedById_fkey"
  FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challans"
  ADD CONSTRAINT "delivery_challans_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "delivery_challan_lines" (
  "id"                UUID NOT NULL,
  "deliveryChallanId" UUID NOT NULL,
  "lineNo"            INTEGER NOT NULL,
  "salesOrderLineId"  UUID NOT NULL,
  "productId"         UUID NOT NULL,
  "skuAtDispatch"     TEXT NOT NULL,
  "nameAtDispatch"    TEXT NOT NULL,
  "quantity"          DECIMAL(14,3) NOT NULL,
  "uom"               "UnitOfMeasure" NOT NULL,
  CONSTRAINT "delivery_challan_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_challan_lines_deliveryChallanId_lineNo_key"
  ON "delivery_challan_lines" ("deliveryChallanId", "lineNo");
CREATE INDEX "delivery_challan_lines_salesOrderLineId_idx" ON "delivery_challan_lines" ("salesOrderLineId");
CREATE INDEX "delivery_challan_lines_productId_idx" ON "delivery_challan_lines" ("productId");

ALTER TABLE "delivery_challan_lines"
  ADD CONSTRAINT delivery_challan_line_quantity_is_positive CHECK ("quantity" > 0);

ALTER TABLE "delivery_challan_lines"
  ADD CONSTRAINT "delivery_challan_lines_deliveryChallanId_fkey"
  FOREIGN KEY ("deliveryChallanId") REFERENCES "delivery_challans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_challan_lines"
  ADD CONSTRAINT "delivery_challan_lines_salesOrderLineId_fkey"
  FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_challan_lines"
  ADD CONSTRAINT "delivery_challan_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 8. SALES RETURNS
-- ────────────────────────────────────────────────────────────

CREATE TABLE "sales_returns" (
  "id"                 UUID NOT NULL,
  "returnNo"           TEXT NOT NULL,
  "status"             "SalesReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "customerId"         UUID NOT NULL,
  "warehouseId"        UUID NOT NULL,
  "salesOrderId"       UUID,
  "salesInvoiceId"     UUID,
  "deliveryChallanId"  UUID,
  "returnDate"         TIMESTAMP(3) NOT NULL,
  "reason"             TEXT NOT NULL,
  "remarks"            TEXT,
  "receivedById"       UUID NOT NULL,
  "postedById"         UUID,
  "postedAt"           TIMESTAMP(3),
  "cancelledAt"        TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_returns_returnNo_key" ON "sales_returns" ("returnNo");
CREATE INDEX "sales_returns_customerId_idx" ON "sales_returns" ("customerId");
CREATE INDEX "sales_returns_status_returnDate_idx" ON "sales_returns" ("status", "returnDate");

ALTER TABLE "sales_returns"
  ADD CONSTRAINT sales_return_posting_is_attributed
  CHECK (("postedAt" IS NULL) = ("postedById" IS NULL));
ALTER TABLE "sales_returns"
  ADD CONSTRAINT sales_return_has_a_reason
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "sales_returns"
  ADD CONSTRAINT "sales_returns_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_returns"
  ADD CONSTRAINT "sales_returns_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_returns"
  ADD CONSTRAINT "sales_returns_salesOrderId_fkey"
  FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_returns"
  ADD CONSTRAINT "sales_returns_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_returns"
  ADD CONSTRAINT "sales_returns_postedById_fkey"
  FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sales_return_lines" (
  "id"            UUID NOT NULL,
  "salesReturnId" UUID NOT NULL,
  "lineNo"        INTEGER NOT NULL,
  "productId"     UUID NOT NULL,
  "skuAtReturn"   TEXT NOT NULL,
  "nameAtReturn"  TEXT NOT NULL,
  "quantity"      DECIMAL(14,3) NOT NULL,
  "uom"           "UnitOfMeasure" NOT NULL,
  "disposition"   "ReturnDisposition" NOT NULL,
  "remarks"       TEXT,
  CONSTRAINT "sales_return_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_return_lines_salesReturnId_lineNo_key"
  ON "sales_return_lines" ("salesReturnId", "lineNo");
CREATE INDEX "sales_return_lines_productId_idx" ON "sales_return_lines" ("productId");

ALTER TABLE "sales_return_lines"
  ADD CONSTRAINT sales_return_line_quantity_is_positive CHECK ("quantity" > 0);

ALTER TABLE "sales_return_lines"
  ADD CONSTRAINT "sales_return_lines_salesReturnId_fkey"
  FOREIGN KEY ("salesReturnId") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_return_lines"
  ADD CONSTRAINT "sales_return_lines_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 9. CUSTOMER PAYMENTS
-- ────────────────────────────────────────────────────────────

CREATE TABLE "customer_payments" (
  "id"             UUID NOT NULL,
  "customerId"     UUID NOT NULL,
  "salesInvoiceId" UUID NOT NULL,
  "amount"         DECIMAL(14,2) NOT NULL,
  "paymentDate"    TIMESTAMP(3) NOT NULL,
  "method"         "PaymentMethod" NOT NULL,
  "reference"      TEXT,
  "notes"          TEXT,
  "recordedById"   UUID NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_payments_customerId_idx" ON "customer_payments" ("customerId");
CREATE INDEX "customer_payments_salesInvoiceId_idx" ON "customer_payments" ("salesInvoiceId");

ALTER TABLE "customer_payments"
  ADD CONSTRAINT customer_payment_amount_is_positive CHECK ("amount" > 0);

ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_salesInvoiceId_fkey"
  FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────
-- 10. DOCUMENT NUMBERS FOR THE NEW DOCUMENTS
-- ────────────────────────────────────────────────────────────
-- Reusing the existing sequence table and its row-locking
-- allocator. No second numbering mechanism is introduced.

INSERT INTO "document_sequences" ("documentType", "prefix", "periodKey", "lastNumber", "padding", "updatedAt")
VALUES ('QUOTATION',        'QT',  '2026', 0, 4, now()),
       ('SALES_INVOICE',    'INV', '2026', 0, 4, now()),
       ('DELIVERY_CHALLAN', 'DC',  '2026', 0, 4, now()),
       ('SALES_RETURN',     'SR',  '2026', 0, 4, now())
ON CONFLICT ("documentType") DO NOTHING;
