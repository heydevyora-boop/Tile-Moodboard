import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { CreateProductInput, UpdateProductInput, ListProductsQuery } from '@validators/catalogHierarchy.validators';

async function requireCollection(collectionId: string) {
  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection) throw AppError.badRequest('Collection does not exist');
  return collection;
}

export async function createProduct(input: CreateProductInput) {
  await requireCollection(input.collectionId);

  return prisma.product.create({
    data: {
      name: input.name,
      collectionId: input.collectionId,
      code: input.code,
      description: input.description,
      specifications: input.specifications,
      coverImageUrl: input.coverImageUrl,
      category: input.category,
    },
    include: { collection: { include: { brand: true } } },
  });
}

export async function listProducts(query: ListProductsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.collectionId ? { collectionId: query.collectionId } : {}),
    ...(query.brandId ? { collection: { brandId: query.brandId } } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      include: { collection: { include: { brand: true } }, _count: { select: { tiles: true } } },
    }),
    prisma.product.count({ where }),
  ]);

  return { products, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

/**
 * One product with every variant beneath it, plus the distinct finish
 * and size values a catalog UI needs to drive "finish selection filters
 * valid sizes, size selection resolves the variant" -- computed here,
 * once, rather than re-derived in the frontend from the full variant list.
 */
export async function getProductById(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      collection: { include: { brand: true } },
      tiles: { orderBy: [{ finish: 'asc' }, { size: 'asc' }] },
    },
  });
  if (!product) throw AppError.notFound('Product not found');

  const finishes = [...new Set(product.tiles.map((t) => t.finish).filter((f): f is string => !!f))];
  const sizes = [...new Set(product.tiles.map((t) => t.size).filter((s): s is string => !!s))];
  const finishSizePairs = product.tiles
    .filter((t) => t.finish && t.size)
    .map((t) => ({ finish: t.finish as string, size: t.size as string, tileId: t.id }));

  return { ...product, finishes, sizes, finishSizePairs };
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Product not found');

  return prisma.product.update({
    where: { id },
    data: {
      name: input.name,
      code: input.code,
      description: input.description,
      specifications: input.specifications,
      coverImageUrl: input.coverImageUrl,
      category: input.category,
      isActive: input.isActive,
    },
    include: { collection: { include: { brand: true } } },
  });
}

/**
 * Resolves exactly one Tile (variant) for a product given a finish and
 * size pair. Returns null rather than guessing when the combination
 * does not exist -- the catalog UI must never display an invalid
 * combination as if it resolved to something.
 */
export async function resolveVariant(productId: string, finish: string, size: string) {
  return prisma.tile.findFirst({ where: { productId, finish, size } });
}

/** Assigns an existing Tile to this product. The Tile keeps its own id
 * and every other field -- only productId changes. */
export async function assignVariant(productId: string, tileId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw AppError.notFound('Product not found');

  const tile = await prisma.tile.findUnique({ where: { id: tileId } });
  if (!tile) throw AppError.notFound('Tile not found');

  return prisma.tile.update({ where: { id: tileId }, data: { productId } });
}

/** Removes a Tile from this product without touching the Tile itself --
 * it goes back to productId = null, exactly like a Tile that was never
 * assigned. Never deletes the Tile. */
export async function unassignVariant(productId: string, tileId: string) {
  const tile = await prisma.tile.findFirst({ where: { id: tileId, productId } });
  if (!tile) throw AppError.notFound('This tile is not assigned to this product');

  return prisma.tile.update({ where: { id: tileId }, data: { productId: null } });
}
