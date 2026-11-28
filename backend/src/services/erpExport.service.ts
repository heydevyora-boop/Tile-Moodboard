import { prisma } from '@db/connection';
import { normalizeDriveImageUrl } from './referenceImages.service';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { ErpCatalogFeedQuery } from '@validators/catalogHierarchy.validators';

/** Bump this whenever the shape of a row in `data` changes in a way a
 * consumer would need to react to. Carried in every response's
 * `meta.version` so a reader can tell which contract it is parsing. */
const ERP_CATALOG_FEED_VERSION = '1';

/**
 * The one standardized, paginated catalog feed an external reader (the
 * ERP, or anything else) gets from CASA — built from the same
 * Brand/Collection/Product/Tile data the catalog website itself reads,
 * never a second, parallel structure. One row per Product, each
 * carrying its Company and Collection context plus every variant
 * (Tile) beneath it, in the standardized field order: company,
 * collection, product, then variant-level sku/material/dimensions/
 * thickness/finish/price/unit.
 *
 * Paginated over Products (not pre-loading the whole catalog into one
 * response) with optional company/collection filters, matching the
 * existing list-endpoint convention (getPagination/buildPaginationMeta)
 * used everywhere else in this API.
 *
 * Only active Brands/Collections/Products are included -- the existing
 * catalog visibility rule, the same one the catalog website itself
 * reads by (Tile carries no separate visibility flag of its own: a
 * removed Tile is hard-deleted, so it is simply absent from the query).
 *
 * A Tile not yet assigned to a Product has no row in `data`: a
 * Product-shaped entry would have to either leave `product` empty
 * (breaking the documented contract) or invent a Product that does not
 * exist. Per Section 3's "do not invent a relationship," none is
 * created and none is guessed here either -- this feed only ever
 * reports what already exists.
 *
 * It is NOT, however, silently dropped. `meta.reconciliation` always
 * carries real counts (how many tiles are assigned vs. unassigned,
 * scoped the same way `data` is), and page 1 additionally lists the
 * unassigned tiles themselves under `unassignedTiles` -- visibility
 * and reconciliation, nothing more. Resolving them into a Product is
 * Stage 2's backfill tool's job (a person's decision, with every
 * ambiguous case flagged), not this feed's.
 */
export async function getErpCatalogFeed(query: ErpCatalogFeedQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = {
    isActive: true,
    collection: {
      isActive: true,
      brand: { isActive: true },
      ...(query.brandId ? { brandId: query.brandId } : {}),
    },
    ...(query.collectionId ? { collectionId: query.collectionId } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      // createdAt first, id as a tiebreaker: a stable, deterministic
      // order so paging through this feed never skips or repeats a row.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        specifications: true,
        coverImageUrl: true,
        collection: {
          select: {
            id: true,
            name: true,
            brand: { select: { id: true, name: true } },
          },
        },
        tiles: {
          orderBy: [{ finish: 'asc' }, { size: 'asc' }],
          select: {
            id: true,
            productCode: true,
            imageUrl: true,
            material: true,
            size: true,
            thickness: true,
            finish: true,
            sellingPrice: true,
            unitOfMeasure: true,
            inStock: true,
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const data = products.map((product) => ({
    company: {
      id: product.collection.brand.id,
      name: product.collection.brand.name,
    },
    collection: {
      id: product.collection.id,
      name: product.collection.name,
    },
    product: {
      id: product.id,
      name: product.name,
      code: product.code,
      category: product.category,
      specifications: product.specifications,
      imageUrl: normalizeDriveImageUrl(product.coverImageUrl),
      variants: product.tiles.map((t) => ({
        tileId: t.id,
        sku: t.productCode,
        imageUrl: normalizeDriveImageUrl(t.imageUrl),
        material: t.material,
        dimensions: t.size,
        thickness: t.thickness,
        finish: t.finish,
        price: t.sellingPrice === null ? null : Number(t.sellingPrice),
        unit: t.unitOfMeasure,
        inStock: t.inStock,
      })),
    },
  }));

  // Reconciliation: assigned/unassigned tile counts, scoped the same
  // way `data` is (an active brand, and -- for "assigned" -- an active
  // collection and product too, matching the visibility rule `data`
  // already applies). `collectionId` has no meaning for a tile with no
  // product, so it narrows `assignedTileCount` only; given alone it
  // excludes unassigned tiles from the count and the list entirely,
  // rather than show unassigned tiles unrelated to the collection asked for.
  const brandFilter = query.brandId ? { brandId: query.brandId } : {};
  const skipUnassigned = Boolean(query.collectionId);

  const [assignedTileCount, unassignedTileCount] = await Promise.all([
    prisma.tile.count({
      where: {
        productId: { not: null },
        ...brandFilter,
        product: { isActive: true, collection: { isActive: true, brand: { isActive: true }, ...(query.collectionId ? { id: query.collectionId } : {}) } },
      },
    }),
    skipUnassigned
      ? Promise.resolve(0)
      : prisma.tile.count({ where: { productId: null, brand: { isActive: true }, ...brandFilter } }),
  ]);

  // Visibility: page 1 only, so the same list is never repeated on
  // every page of `data` -- this is reconciliation + visibility, not a
  // second paginated resource of its own.
  const unassignedTiles = (!skipUnassigned && page === 1)
    ? await prisma.tile.findMany({
      where: { productId: null, brand: { isActive: true }, ...brandFilter },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        productCode: true,
        collection: true,
        brandId: true,
        brand: { select: { name: true } },
      },
    })
    : [];

  const meta = buildPaginationMeta(total, page, limit) as PaginationMeta;

  return {
    data,
    unassignedTiles: unassignedTiles.map((t) => ({
      tileId: t.id,
      name: t.name,
      sku: t.productCode,
      companyId: t.brandId,
      companyName: t.brand.name,
      freeTextCollectionLabel: t.collection,
    })),
    meta: {
      ...meta,
      version: ERP_CATALOG_FEED_VERSION,
      reconciliation: { assignedTileCount, unassignedTileCount },
    },
  };
}
