import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import * as products from '../services/product.service.mjs';

const router = Router();

/* A number that may arrive as a string from a form, and may be
   deliberately cleared. Written once because eight fields need
   exactly this. */
const num = z.union([z.number(), z.string()])
  .transform((v) => (v === '' ? null : Number(v)))
  .refine((v) => v === null || Number.isFinite(v), 'Must be a number.')
  .nullish();

const VariantBody = {
  name: z.string().min(1).max(200),
  brandId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  headId: z.string().uuid().nullish(),
  size: z.string().min(1).max(60),
  lengthMm: num,
  widthMm: num,
  thicknessMm: num,
  finish: z.string().max(60).nullish(),
  colour: z.string().max(60).nullish(),
  uom: z.enum(['BOX', 'PIECE', 'SQFT', 'SQM', 'SET']).optional(),
  piecesPerUnit: num,
  areaSqftPerUnit: num,
  purchasePrice: num,
  sellingPrice: num,
  mrp: num,
  priceBasis: z.enum(['PER_BOX', 'PER_PIECE', 'PER_SQFT', 'PER_SQM']).optional(),
  hsnCode: z.string().max(20).nullish(),
  reorderLevel: num,
  imageUrl: z.string().max(2000).nullish(),
  attributes: z.record(z.any()).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional(),
};

// `sku` is accepted ONLY on create, as an authorised manual
// assignment. It is absent from the update schema on purpose, so a
// client that tries to renumber a product is told rather than
// quietly ignored.
const CreateVariant = z.object({
  ...VariantBody,
  sku: z.string().max(60).optional(),
  confirmDistinct: z.boolean().optional(),
});

const UpdateVariant = z.object(
  Object.fromEntries(Object.entries(VariantBody).map(([k, v]) => [k, v.optional()])),
).extend({ sku: z.string().optional() });

router.get('/', handler(async (req, res) => {
  const q = req.query;
  res.json(await products.list({
    search: q.search || undefined,
    brandId: q.brandId || undefined,
    categoryId: q.categoryId || undefined,
    headId: q.headId || undefined,
    status: q.status ? String(q.status).split(',') : undefined,
    colour: q.colour || undefined,
    finish: q.finish || undefined,
    size: q.size || undefined,
    thicknessMm: q.thicknessMm || undefined,
    includeArchived: q.includeArchived === 'true',
    sortBy: q.sortBy || 'sku',
    sortDir: q.sortDir === 'desc' ? 'desc' : 'asc',
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 25,
  }));
}));

/** The values the filter dropdowns should offer. */
router.get('/filter-options', handler(async (_req, res) => {
  res.json(await products.filterOptions());
}));

router.get('/:id', handler(async (req, res) => {
  res.json(await products.get(req.params.id));
}));

/** Read-only. Stock is moved by the inventory system, not here. */
router.get('/:id/stock', handler(async (req, res) => {
  res.json(await products.stockSummary(req.params.id));
}));

router.post('/', handler(async (req, res) => {
  res.status(201).json(await products.create(parse(CreateVariant, req.body), req.actor));
}));

router.patch('/:id', handler(async (req, res) => {
  res.json(await products.update(req.params.id, parse(UpdateVariant, req.body), req.actor));
}));

const StatusBody = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']),
  reason: z.string().max(500).optional(),
});

router.post('/:id/status', handler(async (req, res) => {
  const { status, reason } = parse(StatusBody, req.body);
  res.json(await products.setStatus(req.params.id, status, req.actor, reason));
}));

/* Archive rather than delete. There is no DELETE route at all:
   a product with stock movements cannot be removed without
   orphaning the entries that explain where the stock went, and
   offering a button that fails for half the catalogue is worse
   than not offering one. */
router.post('/:id/archive', handler(async (req, res) => {
  res.json(await products.archive(req.params.id, req.actor, req.body?.reason));
}));

router.post('/:id/restore', handler(async (req, res) => {
  res.json(await products.restore(req.params.id, req.actor));
}));

export default router;
