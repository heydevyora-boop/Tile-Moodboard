import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as warehouses from '../services/warehouse.service.mjs';

/* ============================================================
   WAREHOUSES AND TRANSFERS
   ============================================================
   There is NO DELETE on this router. A warehouse with stock
   movements against it cannot be removed without orphaning the
   entries that explain where the stock went, and the database
   restricts it anyway. Deactivating is the supported answer, and
   it is refused while the warehouse still holds anything --
   because once deactivated, no movement can be posted against it,
   including the one that would empty it.
   ============================================================ */

const router = Router();

const WarehouseBody = {
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(20).optional(),
  city: z.string().max(120).nullish(),
  state: z.string().max(120).nullish(),
  addressLine: z.string().max(500).nullish(),
  postalCode: z.string().max(20).nullish(),
};

const CreateWarehouse = z.object({ ...WarehouseBody, isActive: z.boolean().optional() });
const UpdateWarehouse = z.object(
  Object.fromEntries(Object.entries(WarehouseBody).map(([k, v]) => [k, v.optional()])),
);

router.get('/', handler(async (req, res) => {
  const q = req.query;
  res.json(await warehouses.list({
    search: q.search || undefined,
    isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
  }));
}));

/* Transfers are mounted BEFORE /:id so that "transfers" is not
   read as a warehouse id. Express matches in order, and a literal
   path placed after a parameter is unreachable -- a mistake that
   shows up as a confusing 404 rather than as an error. */

router.get('/transfers', handler(async (req, res) => {
  const q = req.query;
  res.json(await warehouses.listTransfers({
    status: q.status || undefined,
    warehouseId: q.warehouseId || undefined,
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
  }));
}));

const CreateTransfer = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.union([z.number(), z.string()])
      .transform((v) => Number(v))
      .refine((v) => Number.isFinite(v) && v > 0, 'Must be a quantity above zero.'),
    uom: z.enum(['BOX', 'PIECE', 'SQFT', 'SQM', 'SET']).optional(),
  })).min(1, 'A transfer needs at least one line.'),
});

router.post('/transfers', requirePermission('stock:post'), handler(async (req, res) => {
  res.status(201).json(await warehouses.createTransfer(parse(CreateTransfer, req.body), req.actor));
}));

router.get('/transfers/:id', handler(async (req, res) => {
  res.json(await warehouses.getTransfer(req.params.id));
}));

/* The lifecycle. Each step is its own POST, because each is a
   different physical event with a different person's name on it:
   somebody loads the lorry, somebody else signs for it. */

router.post('/transfers/:id/dispatch', requirePermission('stock:post'), handler(async (req, res) => {
  res.json(await warehouses.dispatchTransfer(req.params.id, req.actor));
}));

router.post('/transfers/:id/receive', requirePermission('stock:post'), handler(async (req, res) => {
  res.json(await warehouses.receiveTransfer(req.params.id, req.actor));
}));

const Cancel = z.object({ reason: z.string().max(1000).nullish() });

router.post('/transfers/:id/cancel', requirePermission('stock:post'), handler(async (req, res) => {
  const body = parse(Cancel, req.body ?? {});
  res.json(await warehouses.cancelTransfer(req.params.id, req.actor, body.reason ?? undefined));
}));

/* ── one warehouse ───────────────────────────────────────── */

router.post('/', requirePermission('warehouse:write'), handler(async (req, res) => {
  res.status(201).json(await warehouses.create(parse(CreateWarehouse, req.body), req.actor));
}));

router.get('/:id', handler(async (req, res) => {
  res.json(await warehouses.get(req.params.id));
}));

router.patch('/:id', requirePermission('warehouse:write'), handler(async (req, res) => {
  res.json(await warehouses.update(req.params.id, parse(UpdateWarehouse, req.body), req.actor));
}));

/** What this warehouse is holding, product by product. */
router.get('/:id/stock', handler(async (req, res) => {
  res.json(await warehouses.stockIn(req.params.id, {
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  }));
}));

const SetActive = z.object({
  isActive: z.boolean(),
  reason: z.string().max(500).nullish(),
});

router.post('/:id/active', requirePermission('warehouse:write'), handler(async (req, res) => {
  const body = parse(SetActive, req.body);
  res.json(await warehouses.setActive(req.params.id, body.isActive, req.actor, body.reason ?? undefined));
}));

export default router;
