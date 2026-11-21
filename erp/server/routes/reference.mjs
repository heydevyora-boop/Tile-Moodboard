import { Router } from 'express';
import { handler } from '../validate.mjs';
import { prisma } from '../../db/client.mjs';
import { describeRules, CATEGORY_RULES } from '../services/productRules.mjs';

/* The lists a form needs to render itself: categories, warehouses,
   and which fields each category requires. Served from the
   database and the rule table rather than duplicated in the
   frontend, so a new category needs no frontend change. */

const router = Router();

router.get('/categories', handler(async (_req, res) => {
  const rows = await prisma.productCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true, code: true, name: true, parentId: true, hsnCode: true, isActive: true,
      _count: { select: { products: true, productHeads: true } },
    },
  });
  res.json({
    rows: rows.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      parentId: c.parentId,
      hsnCode: c.hsnCode,
      isActive: c.isActive,
      productCount: c._count.products,
      productHeadCount: c._count.productHeads,
      // What a product in this category must have.
      rules: describeRules(c.code),
    })),
  });
}));

/** Every category's field rules, for a form that switches category. */
router.get('/product-rules', handler(async (_req, res) => {
  res.json({
    categories: Object.keys(CATEGORY_RULES).map((code) => describeRules(code)),
    fallback: describeRules(null),
  });
}));

router.get('/warehouses', handler(async (_req, res) => {
  res.json({
    rows: await prisma.warehouse.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, city: true, isDefault: true },
    }),
  });
}));

export default router;
