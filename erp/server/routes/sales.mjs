import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as customers from '../services/customer.service.mjs';
import * as quotations from '../services/quotation.service.mjs';
import * as orders from '../services/salesOrder.service.mjs';
import * as reservation from '../services/reservation.service.mjs';
import * as dispatchSvc from '../services/dispatch.service.mjs';
import * as invoices from '../services/salesInvoice.service.mjs';
import * as returns from '../services/salesReturn.service.mjs';
import * as payments from '../services/payment.service.mjs';
import * as board from '../services/salesDashboard.service.mjs';

/* ============================================================
   THE SALES API
   ============================================================

   Customers, quotations, sales orders, stock reservation,
   dispatch, invoices, returns and payments. Same Express 4 /
   Zod 3 / `parse()` / `handler()` convention as every other
   router here.

   WHAT MOVES STOCK AND WHAT DOES NOT

     POST /customers                     nothing moves
     POST /quotations                    nothing moves
     POST /quotations/:id/convert        nothing moves (creates an order)
     POST /sales-orders                  nothing moves
     POST /sales-orders/:id/approve      nothing moves
     POST /sales-invoices                nothing moves -- a claim, not a delivery
     POST /sales-orders/:id/reserve      RESERVED dimension only, not physical
     POST /sales-orders/:id/release      releases the reservation, nothing else
     POST /delivery-challans             <- RELEASE + OUTWARD, in that order
     POST /sales-returns                 <- INWARD (+ DAMAGE for damaged goods)

   Only dispatch.service.mjs and salesReturn.service.mjs import
   postStockMovement; everything else here is paperwork.

   NOT PUBLIC, same placeholder-identity limitation as purchase:
   the server binds to 127.0.0.1, and req.actor still arrives
   through x-erp-user from step 3. The permission checks below
   stop a mistake -- a sales clerk approving their own order,
   dispatching without a reservation -- not a determined caller
   on the same host.
   ============================================================ */

const router = Router();

/* ── shared pieces ───────────────────────────────────────── */

const uuid = z.string().uuid();
const money = z.union([z.number(), z.string()]).nullish();
const quantity = z.union([z.number(), z.string()]);
const text = (max) => z.string().max(max).nullish();
const UOM = z.enum(['BOX', 'PIECE', 'SQFT', 'SQM', 'SET']);

const paging = (q, fallback = 25) => ({ page: Number(q.page) || 1, pageSize: Number(q.pageSize) || fallback });
const range = (q) => ({ from: q.from || undefined, to: q.to || undefined });

/* ============================================================
   CUSTOMERS
   ============================================================ */

const CustomerBody = {
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(20).nullish(),
  type: z.enum(['RETAIL', 'TRADE', 'PROJECT', 'INTERNAL']).optional(),
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

const CreateCustomer = z.object({ ...CustomerBody, isActive: z.boolean().optional() });
const UpdateCustomer = z.object(Object.fromEntries(Object.entries(CustomerBody).map(([k, v]) => [k, v.optional()])));

router.get('/customers', handler(async (req, res) => {
  res.json(await customers.list({
    search: req.query.search || undefined,
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    stateCode: req.query.stateCode || undefined,
    type: req.query.type || undefined,
    ...paging(req.query, 50),
  }));
}));

router.get('/customers/options', handler(async (_req, res) => {
  res.json(await customers.options());
}));

router.post('/customers', requirePermission('customer:write'), handler(async (req, res) => {
  res.status(201).json(await customers.create(parse(CreateCustomer, req.body), req.actor));
}));

router.get('/customers/:id', handler(async (req, res) => {
  res.json(await customers.get(req.params.id));
}));

router.get('/customers/:id/history', handler(async (req, res) => {
  res.json(await customers.history(req.params.id, paging(req.query)));
}));

router.patch('/customers/:id', requirePermission('customer:write'), handler(async (req, res) => {
  res.json(await customers.update(req.params.id, parse(UpdateCustomer, req.body), req.actor));
}));

const SetActive = z.object({ isActive: z.boolean(), reason: text(500) });
router.post('/customers/:id/active', requirePermission('customer:write'), handler(async (req, res) => {
  const body = parse(SetActive, req.body);
  res.json(await customers.setActive(req.params.id, body.isActive, req.actor, body.reason ?? undefined));
}));

/* ============================================================
   QUOTATIONS
   ============================================================ */

const QuoteLine = z.object({
  productId: uuid,
  quantity,
  uom: UOM.optional(),
  unitPrice: money,
  discountPercent: z.union([z.number(), z.string()]).nullish(),
  discountAmount: money,
  taxRate: z.union([z.number(), z.string()]).nullish(),
  description: text(500),
});

const QuoteBody = z.object({
  customerId: uuid,
  warehouseId: uuid.nullish(),
  quotationDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  billingAddress: text(1000),
  shippingAddress: text(1000),
  paymentTerms: text(120),
  deliveryTerms: text(500),
  currency: z.string().max(3).nullish(),
  notes: text(2000),
  lines: z.array(QuoteLine).min(1, 'A quotation needs at least one line.'),
});

router.get('/quotations', handler(async (req, res) => {
  res.json(await quotations.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    customerId: req.query.customerId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/quotations', requirePermission('quotation:write'), handler(async (req, res) => {
  res.status(201).json(await quotations.create(parse(QuoteBody, req.body), req.actor));
}));

router.get('/quotations/:id', handler(async (req, res) => {
  res.json(await quotations.get(req.params.id));
}));

router.patch('/quotations/:id', requirePermission('quotation:write'), handler(async (req, res) => {
  res.json(await quotations.update(req.params.id, parse(QuoteBody, req.body), req.actor));
}));

router.post('/quotations/:id/send', requirePermission('quotation:write'), handler(async (req, res) => {
  res.json(await quotations.send(req.params.id, req.actor));
}));

const RespondBody = z.object({ status: z.enum(['ACCEPTED', 'REJECTED', 'EXPIRED']) });
router.post('/quotations/:id/respond', requirePermission('quotation:write'), handler(async (req, res) => {
  const body = parse(RespondBody, req.body);
  res.json(await quotations.respond(req.params.id, body.status, req.actor));
}));

const WithReason = z.object({ reason: text(1000) });
router.post('/quotations/:id/cancel', requirePermission('quotation:write'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await quotations.cancel(req.params.id, req.actor, body.reason ?? undefined));
}));

router.post('/quotations/:id/revise', requirePermission('quotation:write'), handler(async (req, res) => {
  res.status(201).json(await quotations.revise(req.params.id, parse(QuoteBody.partial(), req.body ?? {}), req.actor));
}));

/* CONVERT is the one path from a quotation to an order, and it
   needs sales:write -- not quotation:write -- because committing
   the studio to an order is a different act from drafting a
   quote. */
const ConvertBody = z.object({ warehouseId: uuid.optional() });
router.post('/quotations/:id/convert', requirePermission('sales:write'), handler(async (req, res) => {
  res.status(201).json(await quotations.convert(req.params.id, req.actor, parse(ConvertBody, req.body ?? {})));
}));

/* ============================================================
   SALES ORDERS
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
  allowInactiveProduct: z.boolean().optional(),
});

const OrderBody = z.object({
  customerId: uuid,
  warehouseId: uuid,
  quotationId: uuid.nullish(),
  orderDate: z.string().nullish(),
  expectedDispatchDate: z.string().nullish(),
  billingAddress: text(1000),
  shippingAddress: text(1000),
  paymentTerms: text(120),
  deliveryTerms: text(500),
  currency: z.string().max(3).nullish(),
  otherCharges: money,
  notes: text(2000),
  lines: z.array(OrderLine).min(1, 'An order needs at least one line.'),
});

router.get('/sales-orders', handler(async (req, res) => {
  res.json(await orders.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    customerId: req.query.customerId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/sales-orders', requirePermission('sales:write'), handler(async (req, res) => {
  res.status(201).json(await orders.create(parse(OrderBody, req.body), req.actor));
}));

router.get('/sales-orders/:id', handler(async (req, res) => {
  res.json(await orders.get(req.params.id));
}));

router.patch('/sales-orders/:id', requirePermission('sales:write'), handler(async (req, res) => {
  res.json(await orders.update(req.params.id, parse(OrderBody, req.body), req.actor));
}));

router.post('/sales-orders/:id/submit', requirePermission('sales:write'), handler(async (req, res) => {
  res.json(await orders.submit(req.params.id, req.actor));
}));

router.post('/sales-orders/:id/approve', requirePermission('sales:approve'), handler(async (req, res) => {
  res.json(await orders.approve(req.params.id, req.actor));
}));

router.post('/sales-orders/:id/return-to-draft', requirePermission('sales:approve'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.returnToDraft(req.params.id, req.actor, body.reason ?? undefined));
}));

router.post('/sales-orders/:id/cancel', requirePermission('sales:write'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.cancel(req.params.id, req.actor, body.reason ?? undefined));
}));

router.post('/sales-orders/:id/close', requirePermission('sales:approve'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await orders.close(req.params.id, req.actor, body.reason ?? undefined));
}));

/* ============================================================
   STOCK AVAILABILITY & RESERVATION
   ============================================================ */

router.get('/sales-orders/:id/availability', handler(async (req, res) => {
  res.json(await reservation.availability(req.params.id));
}));

const ReserveBody = z.object({
  salesOrderId: uuid,
  lines: z.array(z.object({ salesOrderLineId: uuid, quantity, idempotencyKey: text(100) })).min(1, 'Reserve at least one line.'),
  clientKey: text(100),
});
router.post('/sales-orders/:id/reserve', requirePermission('stock:reserve'), handler(async (req, res) => {
  const body = parse(ReserveBody, { ...req.body, salesOrderId: req.params.id });
  // A TOP-LEVEL clientKey is a convenience for the common case of
  // one request, one retry: it is folded onto every line that did
  // not already name its own key, so one submit button can make
  // the whole reservation idempotent without the caller having to
  // key each line separately.
  if (body.clientKey) {
    body.lines = body.lines.map((l) => ({ ...l, idempotencyKey: l.idempotencyKey ?? body.clientKey }));
  }
  res.json(await reservation.reserveForOrder(body, req.actor));
}));

const ReleaseBody = z.object({
  salesOrderId: uuid,
  lines: z.array(z.object({ salesOrderLineId: uuid, quantity, reason: text(500), idempotencyKey: text(100) })).min(1, 'Release at least one line.'),
  clientKey: text(100),
});
router.post('/sales-orders/:id/release', requirePermission('stock:reserve'), handler(async (req, res) => {
  const body = parse(ReleaseBody, { ...req.body, salesOrderId: req.params.id });
  if (body.clientKey) {
    body.lines = body.lines.map((l) => ({ ...l, idempotencyKey: l.idempotencyKey ?? body.clientKey }));
  }
  res.json(await reservation.releaseFromOrder(body, req.actor));
}));

/* ============================================================
   DISPATCH & DELIVERY CHALLANS — THE ONLY ROUTE THAT ISSUES STOCK
   ============================================================ */

router.get('/sales-orders/:id/dispatchable', handler(async (req, res) => {
  res.json(await dispatchSvc.dispatchableLines(req.params.id));
}));

const DispatchLine = z.object({ salesOrderLineId: uuid, quantity, uom: UOM.optional(), allowUnreserved: z.boolean().optional() });
const DispatchBody = z.object({
  salesOrderId: uuid,
  salesInvoiceId: uuid.nullish(),
  warehouseId: uuid.optional(),
  dispatchDate: z.string().nullish(),
  transporter: text(200),
  vehicleNumber: text(60),
  trackingRef: text(120),
  receiverName: text(200),
  receiverPhone: text(40),
  remarks: text(1000),
  allowUnreservedApproved: z.boolean().optional(),
  allowUnreservedReason: text(500),
  lines: z.array(DispatchLine).min(1, 'A dispatch needs at least one line.'),
});

router.get('/delivery-challans', handler(async (req, res) => {
  res.json(await dispatchSvc.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    customerId: req.query.customerId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    salesOrderId: req.query.salesOrderId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/delivery-challans', requirePermission('sales:dispatch'), handler(async (req, res) => {
  res.status(201).json(await dispatchSvc.dispatch(parse(DispatchBody, req.body), req.actor));
}));

router.get('/delivery-challans/:id', handler(async (req, res) => {
  res.json(await dispatchSvc.get(req.params.id));
}));

/* ============================================================
   SALES INVOICES — A CLAIM FOR PAYMENT, NOT A DELIVERY
   ============================================================ */

router.get('/sales-orders/:id/invoiceable', handler(async (req, res) => {
  res.json(await invoices.invoiceableLines(req.params.id));
}));

const InvoiceLine = z.object({ salesOrderLineId: uuid, quantity });
const InvoiceBody = z.object({
  salesOrderId: uuid,
  warehouseId: uuid.optional(),
  invoiceDate: z.string().nullish(),
  dueDate: z.string().nullish(),
  billingAddress: text(1000),
  shippingAddress: text(1000),
  paymentTerms: text(120),
  otherCharges: money,
  notes: text(2000),
  lines: z.array(InvoiceLine).min(1, 'An invoice needs at least one line.'),
});

router.get('/sales-invoices', handler(async (req, res) => {
  res.json(await invoices.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    customerId: req.query.customerId || undefined,
    salesOrderId: req.query.salesOrderId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/sales-invoices', requirePermission('sales:invoice'), handler(async (req, res) => {
  res.status(201).json(await invoices.create(parse(InvoiceBody, req.body), req.actor));
}));

router.get('/sales-invoices/:id', handler(async (req, res) => {
  res.json(await invoices.get(req.params.id));
}));

router.post('/sales-invoices/:id/cancel', requirePermission('sales:invoice'), handler(async (req, res) => {
  const body = parse(WithReason, req.body ?? {});
  res.json(await invoices.cancel(req.params.id, req.actor, body.reason ?? undefined));
}));

/* ============================================================
   SALES RETURNS
   ============================================================ */

router.get('/sales-orders/:id/returnable', handler(async (req, res) => {
  res.json(await returns.returnableLines(req.params.id));
}));

const ReturnLine = z.object({
  salesOrderLineId: uuid,
  quantity,
  uom: UOM.optional(),
  disposition: z.enum(['ACCEPTED_GOOD', 'DAMAGED', 'REJECTED']),
  remarks: text(500),
});
const ReturnBody = z.object({
  salesOrderId: uuid,
  warehouseId: uuid.optional(),
  salesInvoiceId: uuid.nullish(),
  deliveryChallanId: uuid.nullish(),
  returnDate: z.string().nullish(),
  reason: z.string().trim().min(3, 'A return needs a reason.').max(1000),
  remarks: text(1000),
  lines: z.array(ReturnLine).min(1, 'A return needs at least one line.'),
});

router.get('/sales-returns', handler(async (req, res) => {
  res.json(await returns.list({
    search: req.query.search || undefined,
    status: req.query.status || undefined,
    customerId: req.query.customerId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    salesOrderId: req.query.salesOrderId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.post('/sales-returns', requirePermission('sales:return'), handler(async (req, res) => {
  res.status(201).json(await returns.post(parse(ReturnBody, req.body), req.actor));
}));

router.get('/sales-returns/:id', handler(async (req, res) => {
  res.json(await returns.get(req.params.id));
}));

/* ============================================================
   CUSTOMER PAYMENTS
   ============================================================ */

const PaymentBody = z.object({
  salesInvoiceId: uuid,
  amount: z.union([z.number(), z.string()]),
  paymentDate: z.string(),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER']),
  reference: text(120),
  notes: text(1000),
});

router.get('/customer-payments', handler(async (req, res) => {
  res.json(await payments.list({
    customerId: req.query.customerId || undefined,
    salesInvoiceId: req.query.salesInvoiceId || undefined,
    ...range(req.query),
    ...paging(req.query),
  }));
}));

router.get('/sales-invoices/:id/balance', handler(async (req, res) => {
  const balance = await payments.balanceOf(req.params.id);
  delete balance._paise;
  res.json(balance);
}));

router.post('/customer-payments', requirePermission('sales:payment'), handler(async (req, res) => {
  res.status(201).json(await payments.record(parse(PaymentBody, req.body), req.actor));
}));

/* ============================================================
   DASHBOARD AND HISTORY
   ============================================================ */

router.get('/sales-dashboard', handler(async (req, res) => {
  res.json(await board.dashboard({
    customerId: req.query.customerId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    ...range(req.query),
  }));
}));

router.get('/sales-history', handler(async (req, res) => {
  res.json(await board.history({
    customerId: req.query.customerId || undefined,
    warehouseId: req.query.warehouseId || undefined,
    kind: req.query.kind || undefined,
    ...range(req.query),
    ...paging(req.query, 50),
  }));
}));

export default router;
