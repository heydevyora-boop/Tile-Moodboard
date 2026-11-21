import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import * as heads from '../services/productHead.service.mjs';

const router = Router();

const CreateHead = z.object({
  name: z.string().min(1, 'Product head name is required.').max(160),
  brandId: z.string().uuid('Brand is required.'),
  categoryId: z.string().uuid().nullish(),
  code: z.string().max(16).optional(),
  description: z.string().max(2000).nullish(),
  isActive: z.boolean().optional(),
  confirmDistinct: z.boolean().optional(),
});

const UpdateHead = z.object({
  name: z.string().min(1).max(160).optional(),
  brandId: z.string().uuid().optional(),
  categoryId: z.string().uuid().nullish(),
  description: z.string().max(2000).nullish(),
  isActive: z.boolean().optional(),
});

router.get('/', handler(async (req, res) => {
  res.json(await heads.list({
    search: req.query.search || undefined,
    brandId: req.query.brandId || undefined,
    categoryId: req.query.categoryId || undefined,
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 50, 200),
  }));
}));

router.get('/similar', handler(async (req, res) => {
  res.json({
    candidates: await heads.findSimilar({
      name: req.query.name || '',
      brandId: req.query.brandId,
      categoryId: req.query.categoryId || undefined,
    }),
  });
}));

/** One head and every variant under it. */
router.get('/:id', handler(async (req, res) => {
  res.json(await heads.get(req.params.id));
}));

router.post('/', handler(async (req, res) => {
  res.status(201).json(await heads.create(parse(CreateHead, req.body), req.actor));
}));

router.patch('/:id', handler(async (req, res) => {
  res.json(await heads.update(req.params.id, parse(UpdateHead, req.body), req.actor));
}));

export default router;
