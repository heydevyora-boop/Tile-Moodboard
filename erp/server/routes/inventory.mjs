import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as inventory from '../services/inventory.service.mjs';
import * as warehouses from '../services/warehouse.service.mjs';

/* ============================================================
   THE INVENTORY API
   ============================================================

   EVERY stock change on this router goes through the inventory
   service, which goes through db/stock.mjs. There is no route
   here that writes inventory_balances or stock_ledger_entries
   itself, and there deliberately is no route that can: the one
   place a balance changes is postStockMovement, and that is the
   whole point of having it.

   Reads are reads. Writes are POSTs, each with an idempotency key
   so a double-submitted form or a retried request posts the
   movement once.

   NOT PUBLIC. The server binds to 127.0.0.1 and authentication is
   still the x-erp-user placeholder from step 3, documented as
   such. Nothing on this router may be exposed to the internet
   until real sign-in exists.
   ============================================================ */

const router = Router();

/** A quantity, which arrives from a form as a string. */
const qty = z.union([z.number(), z.string()])
  .transform((v) => Number(v))
  .refine((v) => Number.isFinite(v) && v > 0, 'Must be a quantity above zero.');

const money = z.union([z.number(), z.string()])
  .transform((v) => (v === '' || v === null ? null : Number(v)))
  .refine((v) => v === null || Number.isFinite(v), 'Must be a number.')
  .nullish();

/** A product, named either by id or by SKU. The service resolves it. */
const productRef = z.string().min(1);

const UOM = z.enum(['BOX', 'PIECE', 'SQFT', 'SQM', 'SET']);
const REFERENCE_TYPE = z.enum([
  'PURCHASE_ORDER', 'SALES_ORDER', 'STOCK_ADJUSTMENT',
  'WAREHOUSE_TRANSFER', 'OPENING_BALANCE', 'MANUAL',
]);

const base = {
  product: productRef,
  warehouseId: z.string().uuid(),
  quantity: qty,
  uom: UOM.optional(),
  referenceType: REFERENCE_TYPE.optional(),
  referenceId: z.string().uuid().nullish(),
  referenceNo: z.string().max(60).nullish(),
  remarks: z.string().max(1000).nullish(),
  transactionDate: z.string().nullish(),
  /* THE CALLER'S OWN KEY. Sent by the form, so pressing Save
     twice posts one movement. Optional: when it is absent the
     service generates one, which makes the request safe but not
     idempotent, and that is the caller's choice to make
     knowingly. */
  idempotencyKey: z.string().max(200).nullish(),
};

/* ── reads ───────────────────────────────────────────────── */

router.get('/', handler(async (req, res) => {
  const q = req.query;
  res.json(await inventory.listStock({
    search: q.search || undefined,
    warehouseId: q.warehouseId || undefined,
    brandId: q.brandId || undefined,
    categoryId: q.categoryId || undefined,
    headId: q.headId || undefined,
    lowOnly: q.lowOnly === 'true',
    outOnly: q.outOnly === 'true',
    damagedOnly: q.damagedOnly === 'true',
    sortBy: q.sortBy || 'sku',
    sortDir: q.sortDir === 'desc' ? 'desc' : 'asc',
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
  }));
}));

router.get('/dashboard', handler(async (_req, res) => {
  res.json(await inventory.dashboard());
}));

router.get('/totals', handler(async (_req, res) => {
  res.json(await inventory.companyTotals());
}));

/** The stock card: every movement, with the balance it produced. */
router.get('/ledger', handler(async (req, res) => {
  const q = req.query;
  res.json(await inventory.ledger({
    productId: q.productId || undefined,
    sku: q.sku || undefined,
    search: q.search || undefined,
    warehouseId: q.warehouseId || undefined,
    brandId: q.brandId || undefined,
    headId: q.headId || undefined,
    movementType: q.movementType || undefined,
    referenceNo: q.referenceNo || undefined,
    performedById: q.performedById || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
  }));
}));

/**
 * RECONCILIATION. Reports, and never repairs.
 *
 * There is no "fix" endpoint beside this one, on purpose. A
 * discrepancy is corrected by posting an adjustment with a reason
 * on it, through the same service as every other movement, so the
 * record shows who decided what and why.
 */
router.get('/reconciliation', handler(async (_req, res) => {
  res.json(await warehouses.reconciliationReport());
}));

/* ── writes, all through the one service ─────────────────── */

const Opening = z.object({
  product: productRef,
  warehouseId: z.string().uuid(),
  quantity: z.union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v >= 0, 'Must be zero or more.'),
  unitCost: money,
  remarks: z.string().max(1000).nullish(),
  transactionDate: z.string().nullish(),
});

router.post('/opening', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.openingStock(parse(Opening, req.body), req.actor));
}));

const Inward = z.object({
  ...base,
  reason: z.enum(['PURCHASE_RECEIPT', 'SALES_RETURN', 'OTHER']).optional(),
  unitCost: money,
});

router.post('/inward', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.stockInward(parse(Inward, req.body), req.actor));
}));

const Outward = z.object({
  ...base,
  reason: z.enum(['SALES_DISPATCH', 'SAMPLE_ISSUE', 'PURCHASE_RETURN', 'OTHER']).optional(),
});

router.post('/outward', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.stockOutward(parse(Outward, req.body), req.actor));
}));

/* An adjustment MUST say why. The schema requires remarks with
   real text in it, so the rejection happens before the service is
   even called and the message names the field. */
const Adjustment = z.object({
  product: productRef,
  warehouseId: z.string().uuid(),
  quantity: qty,
  direction: z.enum(['IN', 'OUT']),
  reason: z.enum(['STOCK_COUNT_CORRECTION', 'DAMAGE', 'SAMPLE_ISSUE', 'OTHER']).optional(),
  remarks: z.string().trim().min(3, 'An adjustment must say why, in a few words at least.').max(1000),
  transactionDate: z.string().nullish(),
  idempotencyKey: z.string().max(200).nullish(),
});

router.post('/adjustments', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.stockAdjustment(parse(Adjustment, req.body), req.actor));
}));

/* Reservation and release. Neither moves a box: the stock stays
   on the shelf and becomes somebody else's. */
const Reservation = z.object({
  product: productRef,
  warehouseId: z.string().uuid(),
  quantity: qty,
  referenceType: REFERENCE_TYPE.optional(),
  referenceId: z.string().uuid().nullish(),
  referenceNo: z.string().max(60).nullish(),
  remarks: z.string().max(1000).nullish(),
  idempotencyKey: z.string().max(200).nullish(),
});

router.post('/reservations', requirePermission('stock:reserve'), handler(async (req, res) => {
  res.status(201).json(await inventory.reserve(parse(Reservation, req.body), req.actor));
}));

router.post('/reservations/release', requirePermission('stock:reserve'), handler(async (req, res) => {
  res.status(201).json(await inventory.releaseReservation(parse(Reservation, req.body), req.actor));
}));

/* Damage, and recovery. Marking a box damaged does NOT write it
   off: it stays on hand, because it is still physically in the
   warehouse and a stock-take would find it. Writing it off is an
   adjustment, which is a separate decision with its own reason. */
const Damage = z.object({
  product: productRef,
  warehouseId: z.string().uuid(),
  quantity: qty,
  remarks: z.string().trim().min(3, 'Say what happened to it.').max(1000),
  idempotencyKey: z.string().max(200).nullish(),
});

router.post('/damage', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.markDamaged(parse(Damage, req.body), req.actor));
}));

router.post('/damage/recover', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await inventory.recoverDamaged(parse(Damage, req.body), req.actor));
}));

/**
 * REVERSE a movement.
 *
 * Not a delete and not an edit: the ledger is append-only and the
 * database refuses both. This writes the OPPOSITE movement,
 * carrying reversalOfEntryId, so the stock card shows the mistake
 * and the correction side by side -- which is what a ledger is
 * for.
 */
const Reversal = z.object({
  entryId: z.string().uuid(),
  remarks: z.string().max(1000).nullish(),
});

router.post('/ledger/reverse', requirePermission('stock:post'), handler(async (req, res) => {
  const body = parse(Reversal, req.body);
  const result = await inventory.reverseStockMovement({
    entryId: body.entryId,
    createdById: req.actor.id,
    remarks: body.remarks ?? undefined,
  });
  res.status(201).json(result);
}));

export default router;
