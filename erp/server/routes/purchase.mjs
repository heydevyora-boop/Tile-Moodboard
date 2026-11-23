import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as suppliers from '../services/supplier.service.mjs';
import * as orders from '../services/purchaseOrder.service.mjs';
import * as receipts from '../services/grn.service.mjs';
import * as returns from '../services/purchaseReturn.service.mjs';
import * as invoices from '../services/supplierInvoice.service.mjs';
import * as board from '../services/purchaseDashboard.service.mjs';

/* ============================================================
   THE PURCHASE API
   ============================================================

   Suppliers, orders, goods receipts, returns and supplier
   invoices. Express 4 and Zod 3, the same `parse()` / `handler()`
   convention every other router here uses.

   WHAT MOVES STOCK AND WHAT DOES NOT

     POST /purchase-orders            nothing moves
     POST /purchase-orders/:id/approve  nothing moves
     POST /supplier-invoices          nothing moves
     POST /goods-receipts             <- THIS, and only this
     POST /purchase-returns           <- and this, the other way

   The two that move stock do it by calling the inventory
   service, in one transaction, with idempotency keys. No route
   in this file touches a balance or a ledger row itself.

   NOT PUBLIC. The server binds to 127.0.0.1 and the actor still
   arrives through the x-erp-user placeholder from step 3. The
   permission checks below stop a store keeper approving their
   own order; they do not stop anyone who can reach the port from
   claiming to be somebody else. That is why it stays on
   localhost, and it is written down rather than glossed over.
   ============================================================ */

const router = Router();

/* ── shared pieces ───────────────────────────────────────── */

const uuid = z.string().uuid();
const money = z.union([z.number(), z.string()]).nullish();
const quantity = z.union([z.number(), z.string()]);
const text = (max) => z.string().max(max).nullish();
const UOM = z.enum(['BOX', 'PIECE', 'SQFT', 'SQM', 'SET']);

const paging = (q, fallback = 25) => ({
  page: Number(q.page) || 1,
  pageSize: Number(q.pageSize) || fallback,
});

const range = (q) => ({
  from: q.from || undefined,
  to: q.to || undefined,
});

/* ============================================================
   SUPPLIERS
   ============================================================ */

const SupplierBody = {
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(20).optional(),
  gstin: text(20),
  contactName: text(120),
  contactEmail: text(200),
  contactPhone: text(40),
  addressLine: text(500),
  city: text(120),
  state: text(120),
  stateCode: text(2),
  postalCode: text(20),
  shippingAddressLine: text(500),
  shippingCity: text(120),
  shippingState: text(120),
  shippingStateCode: text(2),
  shippingPostalCode: text(20),
  paymentTerms: text(120),
  creditPeriodDays: z.union([z.number(), z.string()]).nullish(),
  notes: text(2000),
};

const CreateSupplier = z.object({ ...SupplierBody, isActive: z.boolean().optional() });
const UpdateSupplier = z.object(
  Object.fromEntries(Object.entries(SupplierBody).map(([k, v]) => [k, v.optional()])),
);

router.get('/suppliers', handler(async (req, res) => {
  res.json(await suppliers.list({
    search: req.query.search || undefined,
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    stateCode: req.query.stateCode || undefined,
    ...paging(req.query, 50),
  }));
}));

router.get('/suppliers/options', handler(async (_req, res) => {
  res.json(await suppliers.options());
}));

router.post('/suppliers', requirePermission('purchase:write'), handler(async (req, res) => {
  res.status(201).json(await suppliers.create(parse(CreateSupplier, req.body), req.actor));
}));

router.get('/suppliers/:id', handler(async (req, res) => {
  res.json(await suppliers.get(req.params.id));
}));

router.get('/suppliers/:id/history', handler(async (req, res) => {
  res.json(await suppliers.history(req.params.id, paging(req.query)));
}));

router.patch('/suppliers/:id', requirePermission('purchase:write'), handler(async (req, res) => {
  res.json(await suppliers.update(req.params.id, parse(UpdateSupplier, req.body), req.actor));
}));

/* Activate and deactivate. There is deliberately NO DELETE: a
   supplier with history cannot be removed without orphaning the
   orders and receipts that explain where stock and money went. */
const SetActive = z.object({ isActive: z.boolean(), reason: text(500) });

router.post('/suppliers/:id/active', requirePermission('purchase:write'), handler(async (req, res) => {
  const body = parse(SetActive, req.body);
  res.json(await suppliers.setActive(req.params.id, body.isActive, req.actor, body.reason ?? undefined));
}));

/* ============================================================
   PURCHASE ORDERS
   ============================================================ */

const OrderLine = z.object({
  productId: uuid,
  quantity,
  uom: UOM.optional(),
  unitPrice: money,
  discountPercent: z.union([z.number(), z.string()]).nullish(),
  discountAmount: money,
  taxRate: z.union([z.number(), z.string()]).nullish(),
  description: text(500),
  expectedDate: z.string().nullish(),
});

const OrderBody = z.object({
  supplierId: uuid,
  warehouseId: uuid,
  orderDate: z.string().nullish(),
  expectedDate: z.string().nullish(),
  billingAddress: text(1000),
  shippingAddress: text(1000),
  paymentTerms: text(120),
  currency: z.string().max(3).nullish(),
  otherCharges: money,
  notes: text(2000),
  lines: z.array(OrderLine).min(1, 'An order needs at least one line.'),
});

router.get('/purchase-orders', handler(async (req, res) => {
  res.json(await orders.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    supplierId: req.query.supplierId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/purchase-orders', requirePermission('purchase:write'), handler(async (req, res) => {
  res.status(201).json(await orders.create(parse(OrderBody, req.body), req.actor));
}));

router.get('/purchase-orders/:id', handler(async (req, res) => {
  res.json(await orders.get(req.params.id));
}));

/** Draft only. The service refuses anything else and says why. */
router.patch('/purchase-orders/:id', requirePermission('purchase:write'), handler(async (req, res) => {
  res.json(await orders.update(req.params.id, parse(OrderBody, req.body), req.actor));
}));

const WithReason = z.object({ reason: text(1000) });

router.post('/purchase-orders/:id/submit', requirePermission('purchase:write'), handler(async (req, res) => {
  res.json(await orders.submit(req.params.id, req.actor));
}));

/* APPROVAL is the one the brief names. purchase:approve is a
   separate permission from purchase:write on purpose: raising an
   order and committing the studio to it are different acts. */
router.post('/purchase-orders/:id/approve', requirePermission('purchase:approve'), handler(async (req, res) => {
  res.json(await orders.approve(req.params.id, req.actor));
}));

router.post('/purchase-orders/:id/return-to-draft', requirePermission('purchase:approve'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.returnToDraft(req.params.id, req.actor, body.reason ?? undefined));
}));

router.post('/purchase-orders/:id/cancel', requirePermission('purchase:write'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.cancel(req.params.id, req.actor, body.reason ?? undefined));
}));

router.post('/purchase-orders/:id/close', requirePermission('purchase:approve'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.close(req.params.id, req.actor, body.reason ?? undefined));
}));

/** What is still outstanding, which is what a receipt form opens on. */
router.get('/purchase-orders/:id/receivable', handler(async (req, res) => {
  res.json(await receipts.receivableLines(req.params.id));
}));

/* ============================================================
   GOODS RECEIPTS — THE ONLY ROUTE THAT INCREASES STOCK
   ============================================================ */

const ReceiptLine = z.object({
  purchaseOrderLineId: uuid,
  acceptedQuantity: quantity.optional(),
  damagedQuantity: quantity.optional(),
  rejectedQuantity: quantity.optional(),
  rejectionReason: text(500),
  uom: UOM.optional(),
  unitCost: money,
  remarks: text(500),
});

const ReceiptBody = z.object({
  purchaseOrderId: uuid,
  warehouseId: uuid.optional(),
  receiptDate: z.string().nullish(),
  supplierDocNo: text(60),
  supplierDocDate: z.string().nullish(),
  documentRef: text(500),
  remarks: text(1000),
  /* Over-receipt is refused unless this pair is given. Not a
     tolerance band: somebody has to say so, and the reason goes
     in the audit log. */
  overReceiptApproved: z.boolean().optional(),
  overReceiptReason: text(500),
  lines: z.array(ReceiptLine).min(1, 'A receipt needs at least one line.'),
});

router.get('/goods-receipts', handler(async (req, res) => {
  res.json(await receipts.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    supplierId: req.query.supplierId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    purchaseOrderId: req.query.purchaseOrderId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/goods-receipts', requirePermission('purchase:receive'), handler(async (req, res) => {
  res.status(201).json(await receipts.receive(parse(ReceiptBody, req.body), req.actor));
}));

router.get('/goods-receipts/:id', handler(async (req, res) => {
  res.json(await receipts.get(req.params.id));
}));

/* Draft only. A posted receipt wrote entries on an append-only
   ledger and they cannot be unwritten; the service says so and
   names the two correcting documents instead. */
router.post('/goods-receipts/:id/cancel', requirePermission('purchase:receive'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await receipts.cancel(req.params.id, req.actor, body.reason ?? undefined));
}));

/* ============================================================
   PURCHASE RETURNS
   ============================================================ */

const ReturnLine = z.object({
  productId: uuid,
  quantity,
  uom: UOM.optional(),
  unitCost: money,
  fromDamaged: z.boolean().optional(),
  remarks: text(500),
});

const ReturnBody = z.object({
  supplierId: uuid,
  warehouseId: uuid,
  purchaseOrderId: uuid.nullish(),
  returnDate: z.string().nullish(),
  reason: z.string().trim().min(3, 'A return needs a reason.').max(1000),
  remarks: text(1000),
  documentRef: text(500),
  lines: z.array(ReturnLine).min(1, 'A return needs at least one line.'),
});

router.get('/purchase-returns', handler(async (req, res) => {
  res.json(await returns.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    supplierId: req.query.supplierId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

/** How much of a product this supplier may still have back. */
router.get('/purchase-returns/eligibility', handler(async (req, res) => {
  const q = parse(z.object({
    supplierId: uuid,
    productId: uuid,
    warehouseId: uuid.optional(),
  }), req.query);
  const able = await returns.eligibility(q);
  delete able._milli;
  res.json(able);
}));

router.post('/purchase-returns', requirePermission('purchase:write'), handler(async (req, res) => {
  res.status(201).json(await returns.post(parse(ReturnBody, req.body), req.actor));
}));

router.get('/purchase-returns/:id', handler(async (req, res) => {
  res.json(await returns.get(req.params.id));
}));

/* ============================================================
   SUPPLIER INVOICES — A CLAIM FOR PAYMENT, NOT A DELIVERY
   ============================================================ */

const InvoiceBody = z.object({
  supplierId: uuid,
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: z.string(),
  dueDate: z.string().nullish(),
  purchaseOrderId: uuid.nullish(),
  goodsReceiptNoteId: uuid.nullish(),
  taxableAmount: money,
  taxAmount: money,
  invoiceAmount: z.union([z.number(), z.string()]),
  currency: z.string().max(3).nullish(),
  documentRef: text(500),
  notes: text(2000),
});

router.get('/supplier-invoices', handler(async (req, res) => {
  res.json(await invoices.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    supplierId: req.query.supplierId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/supplier-invoices', requirePermission('purchase:write'), handler(async (req, res) => {
  res.status(201).json(await invoices.create(parse(InvoiceBody, req.body), req.actor));
}));

router.get('/supplier-invoices/:id', handler(async (req, res) => {
  res.json(await invoices.get(req.params.id));
}));

const InvoiceStatus = z.object({
  status: z.enum(['RECEIVED', 'MATCHED', 'DISPUTED', 'CANCELLED']),
  note: text(1000),
});

router.post('/supplier-invoices/:id/status', requirePermission('purchase:write'), handler(async (req, res) => {
  const body = parse(InvoiceStatus, req.body);
  res.json(await invoices.setStatus(req.params.id, body.status, req.actor, body.note ?? undefined));
}));

/* ============================================================
   DASHBOARD AND HISTORY
   ============================================================ */

router.get('/dashboard', handler(async (req, res) => {
  res.json(await board.dashboard({
    supplierId: req.query.supplierId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    ...range(req.query),
  }));
}));

router.get('/history', handler(async (req, res) => {
  res.json(await board.history({
    supplierId: req.query.supplierId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    kind: req.query.kind || undefined,
    ...range(req.query),
    ...paging(req.query, 50),
  }));
}));

export default router;
