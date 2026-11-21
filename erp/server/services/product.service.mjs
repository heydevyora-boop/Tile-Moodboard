import { prisma } from '../../db/client.mjs';
import { validateProduct } from './productRules.mjs';
import { createWithSku } from './sku.mjs';
import { record } from './audit.mjs';
import { normaliseName } from './normalise.mjs';
import { ValidationError, NotFoundError, ConflictError, NeedsReviewError } from '../errors.mjs';

/* ============================================================
   PRODUCT VARIANTS — THE PRODUCT MASTER
   ============================================================

   A row in `products` IS a variant: it carries the SKU, the
   colour, the finish, the size and the two prices. Three of them
   under one Product Head are Neo Sapien in Grey, Brown and Blue.

   THREE RULES THIS SERVICE KEEPS

   1. A SKU IS ISSUED ONCE. create() allocates it; update() cannot
      touch it. Renaming a product does not renumber it, because
      every order line and stock movement already quotes the old
      number.

   2. STOCK IS READ, NEVER WRITTEN. Every quantity returned here
      comes from InventoryBalance, which only the step-2 ledger
      writes. There is no path from this file to a stock figure --
      deliberately, and that stays true until the inventory phase.

   3. PRODUCTS WITH HISTORY ARE ARCHIVED, NOT DELETED. The
      database refuses to delete one anyway; archive() is the
      supported answer and keeps the movements that explain where
      the stock went.
   ============================================================ */

const LIST_SELECT = {
  id: true, sku: true, name: true, size: true, lengthMm: true, widthMm: true,
  thicknessMm: true, finish: true, colour: true, uom: true, piecesPerUnit: true,
  areaSqftPerUnit: true, purchasePrice: true, sellingPrice: true, mrp: true,
  priceBasis: true, hsnCode: true, reorderLevel: true, imageUrl: true,
  attributes: true, status: true, archivedAt: true, createdAt: true, updatedAt: true,
  brand: { select: { id: true, name: true, code: true } },
  category: { select: { id: true, name: true, code: true } },
  collection: { select: { id: true, name: true, code: true } },
  inventory: { select: { warehouseId: true, quantityOnHand: true, quantityReserved: true, reorderLevel: true } },
};

const SORTABLE = new Set([
  'sku', 'name', 'size', 'colour', 'finish', 'status',
  'purchasePrice', 'sellingPrice', 'createdAt', 'updatedAt',
]);

/**
 * Search, filter, sort and paginate — IN THE DATABASE.
 *
 * Not in the browser, and not by loading the catalogue into
 * memory and slicing it. At ninety products either would work; at
 * nine thousand the page stops loading, and by then the fix is a
 * rewrite of every screen that reads it.
 */
export async function list(query = {}) {
  const {
    search, brandId, categoryId, headId, status, colour, finish, size,
    thicknessMm, includeArchived = false,
    sortBy = 'sku', sortDir = 'asc', page = 1, pageSize = 25,
  } = query;

  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(brandId ? { brandId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(headId ? { collectionId: headId } : {}),
    ...(status ? { status: Array.isArray(status) ? { in: status } : status } : {}),
    ...(colour ? { colour: { equals: colour, mode: 'insensitive' } } : {}),
    ...(finish ? { finish: { equals: finish, mode: 'insensitive' } } : {}),
    ...(size ? { size: { equals: size, mode: 'insensitive' } } : {}),
    ...(thicknessMm ? { thicknessMm: Number(thicknessMm) } : {}),
    // One search box across the five things a person actually
    // types: the code, the product, the brand, the series and the
    // colour.
    ...(search
      ? {
        OR: [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { colour: { contains: search, mode: 'insensitive' } },
          { brand: { name: { contains: search, mode: 'insensitive' } } },
          { collection: { name: { contains: search, mode: 'insensitive' } } },
        ],
      }
      : {}),
  };

  const orderBy = SORTABLE.has(sortBy)
    ? { [sortBy]: sortDir === 'desc' ? 'desc' : 'asc' }
    : { sku: 'asc' };

  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy, skip, take, select: LIST_SELECT }),
    prisma.product.count({ where }),
  ]);

  return {
    rows: rows.map(shape),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

/** The distinct values the filter dropdowns offer — from the data
 *  itself, so a filter can never list a colour nothing has. */
export async function filterOptions() {
  const [colours, finishes, sizes, thicknesses] = await Promise.all([
    prisma.product.findMany({ where: { colour: { not: null }, archivedAt: null }, distinct: ['colour'], select: { colour: true }, orderBy: { colour: 'asc' } }),
    prisma.product.findMany({ where: { finish: { not: null }, archivedAt: null }, distinct: ['finish'], select: { finish: true }, orderBy: { finish: 'asc' } }),
    prisma.product.findMany({ where: { archivedAt: null }, distinct: ['size'], select: { size: true }, orderBy: { size: 'asc' } }),
    prisma.product.findMany({ where: { thicknessMm: { not: null }, archivedAt: null }, distinct: ['thicknessMm'], select: { thicknessMm: true }, orderBy: { thicknessMm: 'asc' } }),
  ]);
  return {
    colours: colours.map((r) => r.colour),
    finishes: finishes.map((r) => r.finish),
    sizes: sizes.map((r) => r.size),
    thicknesses: thicknesses.map((r) => Number(r.thicknessMm)),
  };
}

/** One variant, in full, with its read-only stock summary. */
export async function get(id) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      ...LIST_SELECT,
      images: {
        orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
        select: {
          id: true, url: true, role: true, source: true, isApproved: true,
          altText: true, catalogueName: true, cataloguePage: true, sortOrder: true,
        },
      },
      websiteMapping: { select: { syncStatus: true, externalProductId: true, lastSyncedAt: true } },
    },
  });
  if (!product) throw new NotFoundError('Product');

  return { ...shape(product), images: product.images, websiteSync: product.websiteMapping };
}

/**
 * The stock summary for a variant. READ ONLY.
 *
 * Inward and outward are counted from the append-only ledger, and
 * on-hand from the balance the ledger maintains. Nothing here can
 * change either: moving stock is the inventory phase's job, and
 * Product Master must never be a second way to do it.
 */
export async function stockSummary(id) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, sku: true, uom: true, reorderLevel: true },
  });
  if (!product) throw new NotFoundError('Product');

  const [balances, movements] = await Promise.all([
    prisma.inventoryBalance.findMany({
      where: { productId: id },
      select: {
        quantityOnHand: true, quantityReserved: true, reorderLevel: true, lastMovementAt: true,
        warehouse: { select: { id: true, code: true, name: true, city: true } },
      },
    }),
    prisma.stockLedgerEntry.groupBy({
      by: ['movementType'],
      where: { productId: id },
      _sum: { quantity: true },
      _count: { _all: true },
    }),
  ]);

  const INWARD = new Set(['INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN']);
  let inward = 0;
  let outward = 0;
  for (const m of movements) {
    const q = Number(m._sum.quantity ?? 0);
    if (INWARD.has(m.movementType)) inward += q; else outward += q;
  }

  const totalOnHand = balances.reduce((s, b) => s + Number(b.quantityOnHand), 0);
  const totalReserved = balances.reduce((s, b) => s + Number(b.quantityReserved), 0);
  const reorderLevel = Number(product.reorderLevel);

  return {
    productId: id,
    sku: product.sku,
    uom: product.uom,
    totalStock: totalOnHand,
    reservedStock: totalReserved,
    // What can actually be promised to a customer.
    availableStock: totalOnHand - totalReserved,
    stockInward: inward,
    stockOutward: outward,
    reorderLevel,
    /* Derived, never stored. "Out of stock" is a fact about
       inventory today, not a decision anybody made about the
       product -- which is why ProductStatus has no such value. */
    isLowStock: totalOnHand > 0 && totalOnHand <= reorderLevel,
    isOutOfStock: totalOnHand <= 0,
    byWarehouse: balances.map((b) => ({
      warehouseId: b.warehouse.id,
      code: b.warehouse.code,
      name: b.warehouse.name,
      city: b.warehouse.city,
      quantityOnHand: Number(b.quantityOnHand),
      quantityReserved: Number(b.quantityReserved),
      reorderLevel: b.reorderLevel === null ? reorderLevel : Number(b.reorderLevel),
      lastMovementAt: b.lastMovementAt,
    })),
  };
}

/** Variants under a head that already match these attributes. */
export async function findDuplicateVariants({ headId, colour, finish, size, excludeId }) {
  if (!headId) return [];
  const siblings = await prisma.product.findMany({
    where: { collectionId: headId, archivedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, sku: true, name: true, colour: true, finish: true, size: true },
  });
  return siblings.filter((v) =>
    normaliseName(v.colour ?? '') === normaliseName(colour ?? '')
    && normaliseName(v.finish ?? '') === normaliseName(finish ?? '')
    && normaliseName(v.size ?? '') === normaliseName(size ?? ''));
}

export async function create(input, actor) {
  const { headId, sku: manualSku, confirmDistinct = false, ...data } = input;

  // The category decides which fields are required, so it has to
  // be resolved before anything is validated.
  let categoryId = data.categoryId;
  let head = null;
  if (headId) {
    head = await prisma.collection.findUnique({ where: { id: headId }, include: { brand: true } });
    if (!head) throw new ValidationError([{ field: 'headId', message: 'No such product head.' }]);
    if (!categoryId) categoryId = head.categoryId ?? undefined;
    if (!data.brandId) data.brandId = head.brandId;
    if (head.brandId !== data.brandId) {
      throw new ValidationError([{
        field: 'brandId',
        message: 'This product head belongs to ' + head.brand.name + '. A variant cannot sit under a head of another brand.',
      }]);
    }
  }

  if (!categoryId) {
    throw new ValidationError([{ field: 'categoryId', message: 'Category is required (the head has none set).' }]);
  }
  const category = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);

  const { warnings } = validateProduct({ ...data, brandId: data.brandId }, category.code);

  const brand = await prisma.brand.findUnique({ where: { id: data.brandId } });
  if (!brand) throw new ValidationError([{ field: 'brandId', message: 'No such brand.' }]);

  /* The same colour, finish and size under the same head is
     almost certainly the variant being entered twice. Almost --
     so it is raised, not refused outright. */
  if (headId && !confirmDistinct) {
    const dupes = await findDuplicateVariants({ headId, colour: data.colour, finish: data.finish, size: data.size });
    if (dupes.length > 0) {
      throw new NeedsReviewError(
        'A variant of this head already has that colour, finish and size.',
        dupes,
      );
    }
  }

  const product = await createWithSku(
    prisma,
    { brandCode: brand.code, headCode: head?.code ?? category.code, colour: data.colour, finish: data.finish, size: data.size },
    manualSku,
    (sku) => prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          sku,
          name: String(data.name).trim(),
          brandId: data.brandId,
          categoryId,
          collectionId: headId ?? null,
          size: data.size,
          lengthMm: data.lengthMm ?? null,
          widthMm: data.widthMm ?? null,
          thicknessMm: data.thicknessMm ?? null,
          finish: data.finish ?? null,
          colour: data.colour ?? null,
          uom: data.uom ?? 'BOX',
          piecesPerUnit: data.piecesPerUnit ?? null,
          areaSqftPerUnit: data.areaSqftPerUnit ?? null,
          purchasePrice: data.purchasePrice ?? 0,
          sellingPrice: data.sellingPrice ?? 0,
          mrp: data.mrp ?? null,
          priceBasis: data.priceBasis ?? 'PER_SQFT',
          hsnCode: data.hsnCode ?? category.hsnCode ?? null,
          reorderLevel: data.reorderLevel ?? 0,
          imageUrl: data.imageUrl ?? null,
          attributes: data.attributes ?? null,
          status: data.status ?? 'ACTIVE',
          createdById: actor?.id ?? null,
          updatedById: actor?.id ?? null,
        },
        select: LIST_SELECT,
      });

      await record(tx, {
        entityType: 'Product',
        entityId: created.id,
        action: 'CREATE',
        actorUserId: actor?.id,
        after: { sku: created.sku, name: created.name, status: created.status, colour: created.colour, size: created.size },
        summary: 'Created variant ' + created.sku + ' (' + created.name + ')',
      });

      // The SKU is an assignment in its own right, logged
      // separately so "when did this get its number, and was it
      // chosen by hand?" is answerable without reading a diff.
      await record(tx, {
        entityType: 'Product',
        entityId: created.id,
        action: 'CREATE',
        actorUserId: actor?.id,
        after: { sku: created.sku, assignment: manualSku ? 'manual' : 'generated' },
        summary: 'Assigned SKU ' + created.sku + (manualSku ? ' (entered by hand)' : ' (generated)'),
      });

      return created;
    }),
  );

  return { ...shape(product), warnings };
}

export async function update(id, patch, actor) {
  const before = await prisma.product.findUnique({
    where: { id },
    include: { category: true },
  });
  if (!before) throw new NotFoundError('Product');

  /* A SKU IS NOT EDITABLE HERE. Not "ignored" — refused, loudly,
     so a caller that thinks it is renumbering a product finds out
     rather than believing it worked. */
  if (patch.sku !== undefined && patch.sku !== before.sku) {
    throw new ConflictError(
      'A SKU cannot be changed once issued: stock movements and order lines already quote '
      + before.sku + '. Create a new variant if this is genuinely a different product.',
      { currentSku: before.sku },
    );
  }

  const categoryId = patch.categoryId ?? before.categoryId;
  const category = categoryId === before.categoryId
    ? before.category
    : await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new ValidationError([{ field: 'categoryId', message: 'No such category.' }]);

  // Validated as a MERGE of what is stored and what is being
  // changed, so an edit that touches one field is not treated as
  // an attempt to clear the rest.
  const merged = { ...before, ...patch, brandId: patch.brandId ?? before.brandId };
  const { warnings } = validateProduct(merged, category.code);

  const data = {};
  for (const key of [
    'name', 'size', 'lengthMm', 'widthMm', 'thicknessMm', 'finish', 'colour',
    'uom', 'piecesPerUnit', 'areaSqftPerUnit', 'purchasePrice', 'sellingPrice',
    'mrp', 'priceBasis', 'hsnCode', 'reorderLevel', 'imageUrl', 'attributes', 'status',
  ]) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (patch.categoryId !== undefined) data.categoryId = patch.categoryId;
  if (patch.headId !== undefined) data.collectionId = patch.headId || null;
  data.updatedById = actor?.id ?? null;

  return prisma.$transaction(async (tx) => {
    const after = await tx.product.update({ where: { id }, data, select: LIST_SELECT });
    await record(tx, {
      entityType: 'Product',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated variant ' + before.sku,
    });
    return { ...shape(after), warnings };
  });
}

/** ACTIVE / INACTIVE / DISCONTINUED. Never "out of stock". */
export async function setStatus(id, status, actor, reason) {
  const before = await prisma.product.findUnique({ where: { id }, select: { id: true, sku: true, status: true } });
  if (!before) throw new NotFoundError('Product');

  return prisma.$transaction(async (tx) => {
    const after = await tx.product.update({
      where: { id },
      data: { status, updatedById: actor?.id ?? null },
      select: LIST_SELECT,
    });
    await record(tx, {
      entityType: 'Product',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before: { status: before.status },
      after: { status },
      summary: before.sku + ': status ' + before.status + ' -> ' + status
        + (reason ? ' (' + reason + ')' : ''),
    });
    return shape(after);
  });
}

/**
 * Archive — the supported answer to "delete this product".
 *
 * A product with stock movements CANNOT be deleted: the database
 * restricts it, because deleting it would orphan the entries that
 * explain where the stock went. Archiving hides it from every
 * default list and keeps all of that intact.
 */
export async function archive(id, actor, reason) {
  const before = await prisma.product.findUnique({
    where: { id },
    select: { id: true, sku: true, name: true, archivedAt: true,
      _count: { select: { stockEntries: true, purchaseOrderLines: true, salesOrderLines: true } } },
  });
  if (!before) throw new NotFoundError('Product');
  if (before.archivedAt) throw new ConflictError('This product is already archived.');

  return prisma.$transaction(async (tx) => {
    const after = await tx.product.update({
      where: { id },
      data: { archivedAt: new Date(), archivedById: actor?.id ?? null, updatedById: actor?.id ?? null },
      select: LIST_SELECT,
    });
    await record(tx, {
      entityType: 'Product',
      entityId: id,
      action: 'DELETE',
      actorUserId: actor?.id,
      after: { archivedAt: after.archivedAt },
      summary: 'Archived ' + before.sku + ' (' + before.name + ')'
        + '. ' + before._count.stockEntries + ' stock movement(s) and '
        + (before._count.purchaseOrderLines + before._count.salesOrderLines)
        + ' order line(s) preserved.'
        + (reason ? ' Reason: ' + reason : ''),
    });
    return shape(after);
  });
}

export async function restore(id, actor) {
  const before = await prisma.product.findUnique({ where: { id }, select: { id: true, sku: true, archivedAt: true } });
  if (!before) throw new NotFoundError('Product');
  if (!before.archivedAt) throw new ConflictError('This product is not archived.');

  return prisma.$transaction(async (tx) => {
    const after = await tx.product.update({
      where: { id },
      data: { archivedAt: null, archivedById: null, updatedById: actor?.id ?? null },
      select: LIST_SELECT,
    });
    await record(tx, {
      entityType: 'Product',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      summary: 'Restored ' + before.sku + ' from the archive',
    });
    return shape(after);
  });
}

function shape(p) {
  const onHand = (p.inventory ?? []).reduce((s, i) => s + Number(i.quantityOnHand), 0);
  const reserved = (p.inventory ?? []).reduce((s, i) => s + Number(i.quantityReserved), 0);
  const reorderLevel = Number(p.reorderLevel ?? 0);

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    productHead: p.collection,
    size: p.size,
    lengthMm: p.lengthMm,
    widthMm: p.widthMm,
    thicknessMm: p.thicknessMm === null ? null : Number(p.thicknessMm),
    finish: p.finish,
    colour: p.colour,
    uom: p.uom,
    piecesPerUnit: p.piecesPerUnit,
    areaSqftPerUnit: p.areaSqftPerUnit === null ? null : Number(p.areaSqftPerUnit),
    purchasePrice: Number(p.purchasePrice),
    sellingPrice: Number(p.sellingPrice),
    mrp: p.mrp === null ? null : Number(p.mrp),
    priceBasis: p.priceBasis,
    hsnCode: p.hsnCode,
    reorderLevel,
    imageUrl: p.imageUrl,
    attributes: p.attributes ?? null,
    status: p.status,
    isArchived: p.archivedAt !== null,
    archivedAt: p.archivedAt,
    // Derived from inventory on every read. Never a stored field,
    // never a product status.
    stock: {
      onHand,
      reserved,
      available: onHand - reserved,
      isLowStock: onHand > 0 && onHand <= reorderLevel,
      isOutOfStock: onHand <= 0,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
