import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as brands from '../services/brand.service.mjs';

const router = Router();

const CreateBrand = z.object({
  name: z.string().min(1, 'Brand name is required.').max(120),
  code: z.string().max(12).optional(),
  isActive: z.boolean().optional(),
  confirmDistinct: z.boolean().optional(),
});

const UpdateBrand = z.object({
  name: z.string().min(1).max(120).optional(),
  code: z.string().max(12).optional(),
  isActive: z.boolean().optional(),
});

router.get('/', handler(async (req, res) => {
  res.json(await brands.list({
    search: req.query.search || undefined,
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 50, 200),
  }));
}));

/** Near-matches, for the form to warn before anything is saved. */
router.get('/similar', handler(async (req, res) => {
  res.json({ candidates: await brands.findSimilar(req.query.name || '') });
}));

router.get('/:id', handler(async (req, res) => {
  res.json(await brands.get(req.params.id));
}));

router.post('/', requirePermission('product:write'), handler(async (req, res) => {
  const body = parse(CreateBrand, req.body);
  res.status(201).json(await brands.create(body, req.actor));
}));

router.patch('/:id', requirePermission('product:write'), handler(async (req, res) => {
  const body = parse(UpdateBrand, req.body);
  res.json(await brands.update(req.params.id, body, req.actor));
}));

router.post('/:id/activate', requirePermission('product:write'), handler(async (req, res) => {
  res.json(await brands.setActive(req.params.id, true, req.actor));
}));

router.post('/:id/deactivate', requirePermission('product:write'), handler(async (req, res) => {
  res.json(await brands.setActive(req.params.id, false, req.actor));
}));

export default router;
