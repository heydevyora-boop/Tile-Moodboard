import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as productLines from '../services/productLine.service.mjs';

/* ============================================================
   PRODUCTS — THE LEVEL ABOVE THE SKU, ADDED BY THE
   "PRODUCT HIERARCHY" STEP
   ============================================================
   Mounted the same way brands.mjs and productHeads.mjs are: a
   direct route -> service call, because this is one more sibling
   inside the EXISTING Product Master module, not a new domain of
   its own -- it does not get the separate controllers/validators
   split step 8 reserved for genuinely new modules (Dashboard,
   Parties).

   "View all variants under a product" is `GET /products?
   productLineId=:id` -- the existing products.mjs list endpoint,
   unchanged, with one more filter -- rather than a second nested
   route duplicating the same query.
   ============================================================ */

const router = Router();

const CreateProductLine = z.object({
  name: z.string().min(1, 'Product name is required.').max(200),
  brandId: z.string().uuid('Brand is required.'),
  collectionId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  code: z.string().max(16).optional(),
  description: z.string().max(2000).nullish(),
  specifications: z.record(z.any()).nullish(),
  imageUrl: z.string().max(2000).nullish(),
  isActive: z.boolean().optional(),
  confirmDistinct: z.boolean().optional(),
});

const UpdateProductLine = z.object({
  name: z.string().min(1).max(200).optional(),
  brandId: z.string().uuid().optional(),
  collectionId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  description: z.string().max(2000).nullish(),
  specifications: z.record(z.any()).nullish(),
  imageUrl: z.string().max(2000).nullish(),
  isActive: z.boolean().optional(),
});

router.get('/', handler(async (req, res) => {
  res.json(await productLines.list({
    search: req.query.search || undefined,
    brandId: req.query.brandId || undefined,
    collectionId: req.query.collectionId || undefined,
    categoryId: req.query.categoryId || undefined,
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 50, 200),
  }));
}));

router.get('/similar', handler(async (req, res) => {
  res.json({
    candidates: await productLines.findSimilar({
      name: req.query.name || '',
      brandId: req.query.brandId,
      collectionId: req.query.collectionId || undefined,
    }),
  });
}));

/** One product, and every finish/size variant under it. */
router.get('/:id', handler(async (req, res) => {
  res.json(await productLines.get(req.params.id));
}));

router.post('/', requirePermission('product:write'), handler(async (req, res) => {
  res.status(201).json(await productLines.create(parse(CreateProductLine, req.body), req.actor));
}));

router.patch('/:id', requirePermission('product:write'), handler(async (req, res) => {
  res.json(await productLines.update(req.params.id, parse(UpdateProductLine, req.body), req.actor));
}));

export default router;
