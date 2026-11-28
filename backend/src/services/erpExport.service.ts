import { prisma } from '@db/connection';
import { normalizeDriveImageUrl } from './referenceImages.service';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { ErpCatalogFeedQuery } from '@validators/catalogHierarchy.validators';
import { countUnassignedTiles, findUnassignedTiles, visibleProductWhere, validateProduct } from './catalogValidation.service';

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
 *
 * DOCUMENTED BEHAVIOR CHANGE (Phase 3): a visible Product that
 * catalogValidation.service.ts's validateProduct() marks BLOCKED (no
 * tiles at all, a tile with no SKU, or two tiles claiming the same
 * finish+size) is now also excluded from `data` -- it has nothing an
 * ERP could usefully sync. NEEDS_REVIEW and READY products are
 * returned exactly as before; nothing about their shape changed. Full
 * visibility into what was excluded and why is the readiness
 * endpoint's job (GET /integrations/erp/catalog-feed never explained
 * exclusions itself, and still doesn't -- it just no longer returns
 * rows with nothing usable in them).
 *
 * This also changes the query itself: because "is this product
 * BLOCKED" depends on its own tiles and cannot be expressed as a SQL
 * WHERE clause, pagination is now applied in application code AFTER
 * loading every visible product for the requested company/collection,
 * rather than with a database-level LIMIT/OFFSET. At CASA's actual
 * scale (thousands of tiles, not millions) this is one bounded query;
 * it is called out here as a known tradeoff, not left silent.
 */
export async function getErpCatalogFeed(query: ErpCatalogFeedQuery) {
  const { page, limit, skip, take } = getPagination(query);

  // Same visibility rule catalogValidation.service.ts's readiness
  // report applies -- shared so the feed and the readiness check can
  // never silently disagree about which products are visible.
  const where = visibleProductWhere(query);

  const allVisible = await prisma.product.findMany({
    where,
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
  });

  // `where` already guarantees an active product/collection/brand, so
  // isActive is supplied literally here rather than re-selected, just
  // to satisfy validateProduct's shape.
  const exportable = allVisible.filter((p) => {
    const { status } = validateProduct({ ...p, collection: { isActive: true, brand: { isActive: true } } });
    return status !== 'BLOCKED';
  });

  const total = exportable.length;
  const products = exportable.slice(skip, skip + take);

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
    skipUnassigned ? Promise.resolve(0) : countUnassignedTiles(brandFilter),
  ]);

  // Visibility: page 1 only, so the same list is never repeated on
  // every page of `data` -- this is reconciliation + visibility, not a
  // second paginated resource of its own. Shared with
  // catalogValidation.service.ts's own unassigned-tile reporting --
  // one query, not a second catalog data source.
  const unassignedTiles = (!skipUnassigned && page === 1) ? await findUnassignedTiles(brandFilter) : [];

  const meta = buildPaginationMeta(total, page, limit) as PaginationMeta;

  return {
    data,
    unassignedTiles,
    meta: {
      ...meta,
      version: ERP_CATALOG_FEED_VERSION,
      reconciliation: { assignedTileCount, unassignedTileCount },
    },
  };
}
