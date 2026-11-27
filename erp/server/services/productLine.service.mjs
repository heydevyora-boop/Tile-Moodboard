import { prisma } from '../../db/client.mjs';
import { normaliseName, normaliseCode, similarity, REVIEW_THRESHOLD } from './normalise.mjs';
import { record } from './audit.mjs';
import { ValidationError, NotFoundError, ConflictError, NeedsReviewError } from '../errors.mjs';

/* ============================================================
   PRODUCTS — THE LEVEL ABOVE THE SKU
   ============================================================

   "Onery Elite Decore" is ONE product. Matte-600x1200 and
   Glossy-600x1200 are two variants (two `Product` rows, two SKUs)
   under it. The rule this service exists to keep is the same one
   productHead.service.mjs keeps for the level above: adding a
   finish never creates a second product, which in practice means
   catching the duplicate at creation.

   STORED IN `product_lines`, exposed as "Product" throughout the
   API and the Product Master screen -- see the long comment on the
   ProductLine model in schema.prisma for why the table is not
   named `products` (that name was already taken, since step 3, by
   the SKU/variant row).
   ============================================================ */

const SELECT = {
  id: true, code: true, name: true, description: true, specifications: true,
  imageUrl: true, isActive: true, createdAt: true, updatedAt: true,
  brand: { select: { id: true, name: true, code: true } },
  collection: { select: { id: true, name: true, code: true } },
  category: { select: { id: true, name: true, code: true } },
  _count: { select: { variants: true } },
};

export async function list({ search, brandId, collectionId, categoryId, isActive, page = 1, pageSize = 50 } = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const where = {
    ...(brandId ? { brandId } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(isActive === undefined ? {} : { isActive }),
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.productLine.findMany({
      where,
      orderBy: [{ brand: { name: 'asc' } }, { name: 'asc' }],
      skip: (Math.max(Number(page) || 1, 1) - 1) * take,
      take,
      select: SELECT,
    }),
    prisma.productLine.count({ where }),
  ]);

  return {
    rows: rows.map(shape),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

/** One product, with every finish/size variant under it. */
export async function get(id) {
  const line = await prisma.productLine.findUnique({
    where: { id },
    select: {
      ...SELECT,
      variants: {
        where: { archivedAt: null },
        orderBy: [{ finish: 'asc' }, { size: 'asc' }],
        select: {
          id: true, sku: true, finish: true, size: true, colour: true,
          thicknessMm: true, status: true, imageUrl: true,
          purchasePrice: true, sellingPrice: true,
          inventory: { select: { quantityOnHand: true } },
        },
      },
    },
  });
  if (!line) throw new NotFoundError('Product');

  return {
    ...shape(line),
    variants: line.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      finish: v.finish,
      size: v.size,
      colour: v.colour,
      thicknessMm: v.thicknessMm === null ? null : Number(v.thicknessMm),
      status: v.status,
      imageUrl: v.imageUrl,
      purchasePrice: Number(v.purchasePrice),
      sellingPrice: Number(v.sellingPrice),
      quantityOnHand: v.inventory.reduce((s, i) => s + Number(i.quantityOnHand), 0),
    })),
  };
}

/**
 * Products in the same brand (and category, where given) whose
 * name is close to this one -- the same near-duplicate check
 * productHead.service.mjs runs one level up, never used to merge
 * anything automatically.
 */
export async function findSimilar({ name, brandId, collectionId, excludeId }) {
  const wanted = normaliseName(name);
  if (!wanted || !brandId) return [];

  const siblings = await prisma.productLine.findMany({
    where: { brandId, ...(collectionId ? { OR: [{ collectionId }, { collectionId: null }] } : {}) },
    select: { id: true, name: true, collectionId: true, _count: { select: { variants: true } } },
  });

  return siblings
    .filter((p) => p.id !== excludeId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      variantCount: p._count.variants,
      score: Number(similarity(wanted, p.name).toFixed(3)),
    }))
    .filter((p) => p.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function create({ name, brandId, collectionId, categoryId, code, description, specifications, imageUrl, isActive = true, confirmDistinct = false }, actor) {
  const fields = [];
  if (!String(name ?? '').trim()) fields.push({ field: 'name', message: 'Product name is required.' });
  if (!brandId) fields.push({ field: 'brandId', message: 'Brand is required.' });
  if (fields.length) throw new ValidationError(fields);

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw new ValidationError([{ field: 'brandId', message: 'No such brand.' }]);

  let resolvedCategoryId = categoryId ?? null;
  if (collectionId) {
    const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
    if (!collection) throw new ValidationError([{ field: 'collectionId', message: 'No such collection.' }]);
    if (collection.brandId !== brandId) {
      throw new ValidationError([{
        field: 'collectionId',
        message: 'This collection belongs to another brand. A product cannot sit under a collection of another brand.',
      }]);
    }
    if (!resolvedCategoryId) resolvedCategoryId = collection.categoryId ?? null;
  }
  if (resolvedCategoryId) {
    const category = await prisma.productCategory.findUnique({ where: { id: resolvedCategoryId } });
    if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);
  }

  const cleanName = String(name).replace(/\s+/g, ' ').trim();

  const exact = await prisma.productLine.findFirst({
    where: { brandId, collectionId: collectionId ?? null, name: { equals: cleanName, mode: 'insensitive' } },
  });
  if (exact) {
    throw new ConflictError(
      brand.name + ' already has a product called "' + exact.name + '".',
      { existingId: exact.id, existingName: exact.name },
    );
  }

  /* NEAR-MATCHES GO TO A PERSON, never merged automatically. */
  if (!confirmDistinct) {
    const similar = await findSimilar({ name: cleanName, brandId, collectionId });
    if (similar.length > 0) {
      throw new NeedsReviewError(
        brand.name + ' already has a product with a very similar name. '
        + 'If this is the same product, add a finish/size variant to it instead of creating a second one.',
        similar,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const line = await tx.productLine.create({
      data: {
        brandId,
        collectionId: collectionId ?? null,
        categoryId: resolvedCategoryId,
        name: cleanName,
        code: await freeCode(tx, brandId, collectionId ?? null, normaliseCode(code) || normaliseCode(cleanName).slice(0, 12) || 'PRODUCT'),
        description: description ?? null,
        specifications: specifications ?? null,
        imageUrl: imageUrl ?? null,
        isActive,
        createdById: actor?.id ?? null,
        updatedById: actor?.id ?? null,
      },
      select: SELECT,
    });

    await record(tx, {
      entityType: 'ProductLine',
      entityId: line.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: line.name, code: line.code, brandId, collectionId: collectionId ?? null },
      summary: 'Created product ' + brand.name + ' ' + line.name,
    });

    return shape(line);
  });
}

export async function update(id, patch, actor) {
  const before = await prisma.productLine.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Product');

  const data = {};
  if (patch.name !== undefined) {
    const cleanName = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!cleanName) throw new ValidationError([{ field: 'name', message: 'Product name is required.' }]);
    if (normaliseName(cleanName) !== normaliseName(before.name)) {
      const clash = await prisma.productLine.findFirst({
        where: { brandId: before.brandId, collectionId: before.collectionId, name: { equals: cleanName, mode: 'insensitive' }, id: { not: id } },
      });
      if (clash) throw new ConflictError('This brand already has a product called "' + clash.name + '".');
    }
    data.name = cleanName;
  }
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.specifications !== undefined) data.specifications = patch.specifications;
  if (patch.imageUrl !== undefined) data.imageUrl = patch.imageUrl;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  if (patch.categoryId !== undefined) {
    if (patch.categoryId) {
      const category = await prisma.productCategory.findUnique({ where: { id: patch.categoryId } });
      if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);
    }
    data.categoryId = patch.categoryId || null;
  }

  /* MOVING A PRODUCT TO ANOTHER BRAND OR COLLECTION IS REFUSED
     WHILE IT HAS VARIANTS, same reasoning as productHead.service.
     mjs: every SKU under it already carries the current brand's
     code, and the move would strand them. */
  if ((patch.brandId !== undefined && patch.brandId !== before.brandId)
    || (patch.collectionId !== undefined && patch.collectionId !== before.collectionId)) {
    const count = await prisma.product.count({ where: { productLineId: id } });
    if (count > 0) {
      throw new ConflictError(
        'This product cannot be moved: its ' + count + ' variant(s) carry SKUs and a collection '
        + 'already built from where it sits today.',
        { variantCount: count },
      );
    }
    if (patch.brandId !== undefined) data.brandId = patch.brandId;
    if (patch.collectionId !== undefined) data.collectionId = patch.collectionId || null;
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.productLine.update({ where: { id }, data: { ...data, updatedById: actor?.id ?? null }, select: SELECT });
    await record(tx, {
      entityType: 'ProductLine',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated product ' + after.name,
    });
    return shape(after);
  });
}

function shape(line) {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    description: line.description ?? null,
    specifications: line.specifications ?? null,
    imageUrl: line.imageUrl ?? null,
    isActive: line.isActive,
    brand: line.brand ?? null,
    collection: line.collection ?? null,
    category: line.category ?? null,
    variantCount: line._count?.variants ?? 0,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  };
}

async function freeCode(tx, brandId, collectionId, wanted) {
  let code = wanted;
  for (let n = 2; n < 50; n += 1) {
    const taken = await tx.productLine.findFirst({
      where: { brandId, collectionId, code }, select: { id: true },
    });
    if (!taken) return code;
    code = wanted.slice(0, 8) + n;
  }
  throw new ConflictError('Could not find a free product code after 48 attempts.');
}
