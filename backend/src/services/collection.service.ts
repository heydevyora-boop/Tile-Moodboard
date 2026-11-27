import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { CreateCollectionInput, UpdateCollectionInput, ListCollectionsQuery } from '@validators/catalogHierarchy.validators';

async function requireBrand(brandId: string) {
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw AppError.badRequest('Company does not exist');
  return brand;
}

export async function createCollection(input: CreateCollectionInput) {
  await requireBrand(input.brandId);

  return prisma.collection.create({
    data: {
      name: input.name,
      brandId: input.brandId,
      description: input.description,
      coverImageUrl: input.coverImageUrl,
      catalogueDocumentUrl: input.catalogueDocumentUrl,
    },
    include: { brand: true },
  });
}

export async function listCollections(query: ListCollectionsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    ...(query.brandId ? { brandId: query.brandId } : {}),
    ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
  };

  const [collections, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      include: { brand: true, _count: { select: { products: true } } },
    }),
    prisma.collection.count({ where }),
  ]);

  return { collections, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getCollectionById(id: string) {
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: { brand: true, products: { where: { isActive: true }, orderBy: { name: 'asc' } } },
  });
  if (!collection) throw AppError.notFound('Collection not found');
  return collection;
}

export async function updateCollection(id: string, input: UpdateCollectionInput) {
  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Collection not found');

  return prisma.collection.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      coverImageUrl: input.coverImageUrl,
      catalogueDocumentUrl: input.catalogueDocumentUrl,
      isActive: input.isActive,
    },
    include: { brand: true },
  });
}

/**
 * Finds the collection a free-text label resolves to within one company,
 * matching by normalized name (trimmed, case-insensitive) -- never across
 * companies. Used by the backfill tool and by anything that needs to
 * resolve `Tile.collection` text against the real Collection table
 * without guessing a company. Returns null rather than creating one:
 * creation is always an explicit, separate step.
 */
export async function findCollectionByNormalizedName(brandId: string, name: string) {
  const normalized = name.trim();
  if (!normalized) return null;
  return prisma.collection.findFirst({
    where: { brandId, name: { equals: normalized, mode: 'insensitive' } },
  });
}
