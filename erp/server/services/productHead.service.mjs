import { prisma } from '../../db/client.mjs';
import { normaliseName, normaliseCode, similarity, REVIEW_THRESHOLD } from './normalise.mjs';
import { record } from './audit.mjs';
import { ValidationError, NotFoundError, ConflictError, NeedsReviewError } from '../errors.mjs';

/* ============================================================
   PRODUCT HEADS  (SERIES)
   ============================================================
   "Kajaria Neo Sapien" is ONE head. Grey, Brown and Blue are
   three variants under it. The rule this service exists to keep
   is that adding a colour never creates a second head -- which in
   practice means catching the duplicate at creation, because once
   two heads exist the variants are split between them and nobody
   notices until a report is wrong.

   STORED IN `collections`. The table was created in step 2 before
   the term "Product Head" was agreed; they are the same thing.
   ============================================================ */

export async function list({ search, brandId, categoryId, isActive, page = 1, pageSize = 50 } = {}) {
  const where = {
    ...(brandId ? { brandId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(isActive === undefined ? {} : { isActive }),
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy: [{ brand: { name: 'asc' } }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        brand: { select: { id: true, name: true, code: true } },
        category: { select: { id: true, name: true, code: true } },
        _count: { select: { products: true } },
      },
    }),
    prisma.collection.count({ where }),
  ]);

  return {
    rows: rows.map(shape),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** One head with every variant under it. */
export async function get(id) {
  const head = await prisma.collection.findUnique({
    where: { id },
    include: {
      brand: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true, code: true } },
      _count: { select: { products: true } },
      products: {
        where: { archivedAt: null },
        orderBy: [{ colour: 'asc' }, { size: 'asc' }],
        select: {
          id: true, sku: true, name: true, colour: true, finish: true,
          size: true, thicknessMm: true, status: true, imageUrl: true,
          purchasePrice: true, sellingPrice: true,
          inventory: { select: { quantityOnHand: true, warehouseId: true } },
        },
      },
    },
  });
  if (!head) throw new NotFoundError('Product head');

  return {
    ...shape(head),
    variants: head.products.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      colour: v.colour,
      finish: v.finish,
      size: v.size,
      thicknessMm: v.thicknessMm,
      status: v.status,
      imageUrl: v.imageUrl,
      purchasePrice: v.purchasePrice,
      sellingPrice: v.sellingPrice,
      // Read-only, from the inventory the step-2 ledger maintains.
      // Product Master never writes this.
      quantityOnHand: v.inventory.reduce((s, i) => s + Number(i.quantityOnHand), 0),
    })),
  };
}

/**
 * Heads in the same brand whose name is close to this one.
 *
 * Scoped to the brand AND, where given, the category — because
 * "Verona" under Somany and "Verona" under Morson are genuinely
 * different ranges, and flagging them as duplicates of each other
 * would train people to click past the warning.
 */
export async function findSimilar({ name, brandId, categoryId, excludeId }) {
  const wanted = normaliseName(name);
  if (!wanted || !brandId) return [];

  const siblings = await prisma.collection.findMany({
    where: {
      brandId,
      ...(categoryId ? { OR: [{ categoryId }, { categoryId: null }] } : {}),
    },
    select: { id: true, name: true, categoryId: true, _count: { select: { products: true } } },
  });

  return siblings
    .filter((c) => c.id !== excludeId)
    .map((c) => ({
      id: c.id,
      name: c.name,
      variantCount: c._count.products,
      score: Number(similarity(wanted, c.name).toFixed(3)),
    }))
    .filter((c) => c.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function create({ name, brandId, categoryId, code, description, coverImageUrl, catalogueDocumentUrl, isActive = true, confirmDistinct = false }, actor) {
  const fields = [];
  if (!String(name ?? '').trim()) fields.push({ field: 'name', message: 'Product head name is required.' });
  if (!brandId) fields.push({ field: 'brandId', message: 'Brand is required.' });
  if (fields.length) throw new ValidationError(fields);

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw new ValidationError([{ field: 'brandId', message: 'No such brand.' }]);

  if (categoryId) {
    const category = await prisma.productCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);
  }

  const cleanName = String(name).replace(/\s+/g, ' ').trim();

  const exact = await prisma.collection.findFirst({
    where: { brandId, name: { equals: cleanName, mode: 'insensitive' } },
  });
  if (exact) {
    throw new ConflictError(
      brand.name + ' already has a product head called "' + exact.name + '".',
      { existingId: exact.id, existingName: exact.name },
    );
  }

  /* NEAR-MATCHES GO TO A PERSON. The brief is explicit: do not
     automatically merge products on similar names; an ambiguous
     match requires human review. So this refuses with the
     candidates attached rather than guessing either way. */
  if (!confirmDistinct) {
    const similar = await findSimilar({ name: cleanName, brandId, categoryId });
    if (similar.length > 0) {
      throw new NeedsReviewError(
        brand.name + ' already has a product head with a very similar name. '
        + 'If this is the same series, add a variant to it instead of creating a second head.',
        similar,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const head = await tx.collection.create({
      data: {
        brandId,
        categoryId: categoryId ?? null,
        name: cleanName,
        code: await freeCode(tx, brandId, normaliseCode(code) || normaliseCode(cleanName).slice(0, 8) || 'HEAD'),
        description: description ?? null,
        coverImageUrl: coverImageUrl ?? null,
        catalogueDocumentUrl: catalogueDocumentUrl ?? null,
        isActive,
      },
      include: {
        brand: { select: { id: true, name: true, code: true } },
        category: { select: { id: true, name: true, code: true } },
        _count: { select: { products: true } },
      },
    });

    await record(tx, {
      entityType: 'ProductHead',
      entityId: head.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: head.name, code: head.code, brandId, categoryId: categoryId ?? null },
      summary: 'Created product head ' + brand.name + ' ' + head.name,
    });

    return shape(head);
  });
}

export async function update(id, patch, actor) {
  const before = await prisma.collection.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Product head');

  const data = {};
  if (patch.name !== undefined) {
    const cleanName = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!cleanName) throw new ValidationError([{ field: 'name', message: 'Product head name is required.' }]);
    if (normaliseName(cleanName) !== normaliseName(before.name)) {
      const clash = await prisma.collection.findFirst({
        where: { brandId: before.brandId, name: { equals: cleanName, mode: 'insensitive' }, id: { not: id } },
      });
      if (clash) throw new ConflictError('This brand already has a head called "' + clash.name + '".');
    }
    data.name = cleanName;
  }
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.coverImageUrl !== undefined) data.coverImageUrl = patch.coverImageUrl;
  if (patch.catalogueDocumentUrl !== undefined) data.catalogueDocumentUrl = patch.catalogueDocumentUrl;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  if (patch.categoryId !== undefined) {
    if (patch.categoryId) {
      const category = await prisma.productCategory.findUnique({ where: { id: patch.categoryId } });
      if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);
    }
    data.categoryId = patch.categoryId || null;
  }

  /* MOVING A HEAD TO ANOTHER BRAND IS REFUSED. Every SKU under it
     carries the old brand's code, and the head's variants would
     then claim a brand their own identifiers contradict. Create
     the head under the right brand and move the variants
     deliberately. */
  if (patch.brandId !== undefined && patch.brandId !== before.brandId) {
    const count = await prisma.product.count({ where: { collectionId: id } });
    if (count > 0) {
      throw new ConflictError(
        'This product head cannot be moved to another brand: its '
        + count + ' variant(s) carry SKUs built from the current brand code.',
        { variantCount: count },
      );
    }
    data.brandId = patch.brandId;
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.collection.update({
      where: { id },
      data,
      include: {
        brand: { select: { id: true, name: true, code: true } },
        category: { select: { id: true, name: true, code: true } },
        _count: { select: { products: true } },
      },
    });
    await record(tx, {
      entityType: 'ProductHead',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated product head ' + after.name,
    });
    return shape(after);
  });
}

function shape(head) {
  return {
    id: head.id,
    code: head.code,
    name: head.name,
    description: head.description ?? null,
    coverImageUrl: head.coverImageUrl ?? null,
    catalogueDocumentUrl: head.catalogueDocumentUrl ?? null,
    isActive: head.isActive,
    brand: head.brand ?? null,
    category: head.category ?? null,
    variantCount: head._count?.products ?? 0,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  };
}

async function freeCode(tx, brandId, wanted) {
  let code = wanted;
  for (let n = 2; n < 50; n += 1) {
    const taken = await tx.collection.findUnique({
      where: { brandId_code: { brandId, code } }, select: { id: true },
    });
    if (!taken) return code;
    code = wanted.slice(0, 6) + n;
  }
  throw new ConflictError('Could not allocate a product head code.');
}
