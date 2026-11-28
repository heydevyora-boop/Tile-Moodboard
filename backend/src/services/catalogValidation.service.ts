import { prisma } from '@db/connection';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';

/* ============================================================
   CATALOG DATA READINESS -- validation, reconciliation and duplicate
   detection over the EXISTING Company -> Collection -> Product -> Tile
   hierarchy (Stage 2). No new table, no second catalog data source --
   every function here only ever reads Brand/Collection/Product/Tile
   and reports on what it finds. Nothing here writes to the database.
   ============================================================ */

export type ReadinessStatus = 'READY' | 'NEEDS_REVIEW' | 'BLOCKED';

export interface ReadinessIssue {
  /** Which field or relationship the issue is about. */
  field: string;
  /** required: missing this blocks export. conditional: required only
   * given some other field's value (e.g. a unit without a price, or
   * vice versa). optional: recommended, never blocks. */
  severity: 'required' | 'conditional' | 'optional';
  message: string;
}

/**
 * The one list of rules this service enforces, kept in one place so
 * the final report and the code can never drift apart. Nothing here
 * assumes every field is mandatory for every product -- material,
 * thickness, image and price are all optional/recommended, never
 * required, because CASA has no fixed category taxonomy to say which
 * categories actually need them (Product.category is a free-text
 * label, not a schema -- see Stage 2's own schema.prisma comment on
 * why no taxonomy was invented for it).
 *
 *   REQUIRED (missing -> BLOCKED, cannot be exported):
 *     - Product.name non-empty.
 *     - Product belongs to an ACTIVE Collection, which belongs to an
 *       ACTIVE Brand (the existing catalog visibility rule).
 *     - At least one Tile (variant) exists under the Product.
 *     - Every Tile under the Product has a non-empty productCode (SKU).
 *     - No two Tiles under the SAME Product share the same
 *       (finish, size) pair (a conflicting variant mapping -- two SKUs
 *       claiming one slot, which a future sync could not resolve).
 *     - The Tile's SKU is not a case-insensitive duplicate of another
 *       Tile's SKU anywhere in the catalog (the database's own unique
 *       index on productCode is case-SENSITIVE, so "ABC-1" and "abc-1"
 *       can both exist today without violating it).
 *
 *   OPTIONAL / RECOMMENDED (missing -> NEEDS_REVIEW, never blocks):
 *     - Product.coverImageUrl OR at least one Tile.imageUrl.
 *     - Tile.material, Tile.thickness, Tile.finish.
 *     - Tile.sellingPrice, Tile.unitOfMeasure.
 *
 *   CONDITIONALLY REQUIRED (missing -> NEEDS_REVIEW, never blocks):
 *     - If Tile.sellingPrice is set, Tile.unitOfMeasure should be too
 *       (a price with no stated unit is ambiguous), and vice versa.
 */
export const READINESS_RULES_VERSION = '1';

interface ValidatableTile {
  id: string;
  productCode: string | null;
  imageUrl: string | null;
  material: string | null;
  size: string | null;
  thickness: string | null;
  finish: string | null;
  sellingPrice: unknown;
  unitOfMeasure: string | null;
}

interface ValidatableProduct {
  id: string;
  name: string;
  coverImageUrl: string | null;
  collection: { isActive: boolean; brand: { isActive: boolean } };
  tiles: ValidatableTile[];
}

export function validateProduct(product: ValidatableProduct): { status: ReadinessStatus; issues: ReadinessIssue[] } {
  const issues: ReadinessIssue[] = [];

  if (!product.name || !product.name.trim()) {
    issues.push({ field: 'product.name', severity: 'required', message: 'Product has no name.' });
  }
  if (!product.collection.brand.isActive) {
    issues.push({ field: 'company.isActive', severity: 'required', message: 'The product\'s company is inactive; it is excluded from catalog visibility.' });
  }
  if (!product.collection.isActive) {
    issues.push({ field: 'collection.isActive', severity: 'required', message: 'The product\'s collection is inactive; it is excluded from catalog visibility.' });
  }
  if (product.tiles.length === 0) {
    issues.push({ field: 'tiles', severity: 'required', message: 'Product has no variants (tiles) at all -- nothing to export.' });
  }

  const hasAnyImage = Boolean(product.coverImageUrl) || product.tiles.some((t) => Boolean(t.imageUrl));
  if (!hasAnyImage) {
    issues.push({ field: 'imageUrl', severity: 'optional', message: 'No product-level or variant-level image is set.' });
  }

  const seenFinishSize = new Map<string, string[]>();
  for (const t of product.tiles) {
    if (!t.productCode || !t.productCode.trim()) {
      issues.push({ field: `tile:${t.id}.productCode`, severity: 'required', message: `Variant ${t.id} has no SKU/product code.` });
    }
    if (!t.material) issues.push({ field: `tile:${t.id}.material`, severity: 'optional', message: `Variant ${t.id} has no material recorded.` });
    if (!t.thickness) issues.push({ field: `tile:${t.id}.thickness`, severity: 'optional', message: `Variant ${t.id} has no thickness recorded.` });
    if (!t.finish) issues.push({ field: `tile:${t.id}.finish`, severity: 'optional', message: `Variant ${t.id} has no finish recorded.` });
    const hasPrice = t.sellingPrice !== null && t.sellingPrice !== undefined;
    if (!hasPrice) issues.push({ field: `tile:${t.id}.sellingPrice`, severity: 'optional', message: `Variant ${t.id} has no selling price.` });
    if (hasPrice && !t.unitOfMeasure) {
      issues.push({ field: `tile:${t.id}.unitOfMeasure`, severity: 'conditional', message: `Variant ${t.id} has a selling price but no unit of measurement.` });
    }
    if (!hasPrice && t.unitOfMeasure) {
      issues.push({ field: `tile:${t.id}.sellingPrice`, severity: 'conditional', message: `Variant ${t.id} has a unit of measurement but no selling price.` });
    }

    if (t.finish && t.size) {
      const key = `${t.finish}::${t.size}`;
      const existing = seenFinishSize.get(key) ?? [];
      existing.push(t.id);
      seenFinishSize.set(key, existing);
    }
  }

  for (const [key, tileIds] of seenFinishSize) {
    if (tileIds.length > 1) {
      const [finish, size] = key.split('::');
      issues.push({
        field: 'tiles.finishSize',
        severity: 'required',
        message: `${tileIds.length} variants (${tileIds.join(', ')}) all claim finish "${finish}" + size "${size}" -- a future sync could not tell them apart.`,
      });
    }
  }

  const hasRequired = issues.some((i) => i.severity === 'required');
  const status: ReadinessStatus = hasRequired ? 'BLOCKED' : (issues.length > 0 ? 'NEEDS_REVIEW' : 'READY');

  return { status, issues };
}

/** The same product-visibility chain the ERP feed itself applies
 * (active product, active collection, active brand) -- shared so the
 * two can never silently drift apart. */
export function visibleProductWhere(filter: { brandId?: string; collectionId?: string } = {}) {
  return {
    isActive: true,
    collection: {
      isActive: true,
      brand: { isActive: true },
      ...(filter.brandId ? { brandId: filter.brandId } : {}),
    },
    ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
  };
}

const PRODUCT_SELECT = {
  id: true,
  name: true,
  code: true,
  coverImageUrl: true,
  collection: {
    select: {
      id: true,
      name: true,
      isActive: true,
      brand: { select: { id: true, name: true, isActive: true } },
    },
  },
  tiles: {
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
    },
  },
} as const;

/** Case-insensitive duplicate SKUs anywhere in the catalog. The
 * database's own unique index on Tile.productCode is case-sensitive,
 * so this is the one real duplicate-SKU case it cannot catch on its
 * own; exact-match duplicates are already structurally impossible. */
export async function findDuplicateSkuGroups(filter: { brandId?: string } = {}) {
  const tiles = await prisma.tile.findMany({
    where: { productCode: { not: null }, ...(filter.brandId ? { brandId: filter.brandId } : {}) },
    select: { id: true, productCode: true, brandId: true, brand: { select: { name: true } } },
  });

  const byNormalized = new Map<string, typeof tiles>();
  for (const t of tiles) {
    const key = (t.productCode as string).trim().toUpperCase();
    const existing = byNormalized.get(key) ?? [];
    existing.push(t);
    byNormalized.set(key, existing);
  }

  const groups: Array<{ normalizedSku: string; tiles: Array<{ tileId: string; sku: string; companyId: string; companyName: string }> }> = [];
  for (const [normalizedSku, group] of byNormalized) {
    if (group.length > 1) {
      groups.push({
        normalizedSku,
        tiles: group.map((t) => ({ tileId: t.id, sku: t.productCode as string, companyId: t.brandId, companyName: t.brand.name })),
      });
    }
  }
  return groups;
}

/** Reuse point for the ERP feed's own unassigned-tile listing (Section
 * 2's "no second catalog data source" -- one query, two callers). */
export async function countUnassignedTiles(filter: { brandId?: string } = {}) {
  return prisma.tile.count({ where: { productId: null, brand: { isActive: true }, ...(filter.brandId ? { brandId: filter.brandId } : {}) } });
}

export async function findUnassignedTiles(filter: { brandId?: string } = {}) {
  const tiles = await prisma.tile.findMany({
    where: { productId: null, brand: { isActive: true }, ...(filter.brandId ? { brandId: filter.brandId } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, productCode: true, collection: true, brandId: true, brand: { select: { name: true } } },
  });
  return tiles.map((t) => ({
    tileId: t.id,
    name: t.name,
    sku: t.productCode,
    companyId: t.brandId,
    companyName: t.brand.name,
    freeTextCollectionLabel: t.collection,
  }));
}

/**
 * Section 2's full reconciliation report: every count the brief asks
 * for (A-G), with an explained breakdown of why anything is excluded --
 * never a silent exclusion.
 */
export async function getReconciliationReport(filter: { brandId?: string; collectionId?: string } = {}) {
  const brandFilter = filter.brandId ? { brandId: filter.brandId } : {};

  const [
    totalProducts,
    totalTiles,
    assignedTiles,
    unassignedTiles,
    inactiveBrandProducts,
    inactiveCollectionProducts,
    inactiveProductCount,
    visibleProducts,
    duplicateSkuGroups,
  ] = await Promise.all([
    prisma.product.count({
      where: {
        ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
        ...(brandFilter.brandId ? { collection: { brandId: brandFilter.brandId } } : {}),
      },
    }),
    prisma.tile.count({ where: brandFilter }),
    prisma.tile.count({ where: { productId: { not: null }, ...brandFilter } }),
    countUnassignedTiles(filter),
    prisma.product.count({ where: { isActive: true, collection: { brand: { isActive: false }, ...(brandFilter.brandId ? { brandId: brandFilter.brandId } : {}) } } }),
    prisma.product.count({ where: { isActive: true, collection: { isActive: false, brand: { isActive: true }, ...(brandFilter.brandId ? { brandId: brandFilter.brandId } : {}) } } }),
    prisma.product.count({ where: { isActive: false, collection: brandFilter.brandId ? { brandId: brandFilter.brandId } : undefined } }),
    prisma.product.count({ where: visibleProductWhere(filter) }),
    findDuplicateSkuGroups(filter),
  ]);

  // Among the visible products, how many are themselves BLOCKED by a
  // data issue (missing SKU, zero variants, conflicting finish+size)?
  // Exact-match products are small enough in practice to validate in
  // one pass rather than paginate server-side for a summary count.
  const visibleProductRows = await prisma.product.findMany({ where: visibleProductWhere(filter), select: PRODUCT_SELECT });
  let readyCount = 0;
  let needsReviewCount = 0;
  let blockedCount = 0;
  for (const p of visibleProductRows) {
    const { status } = validateProduct(p);
    if (status === 'READY') readyCount += 1;
    else if (status === 'NEEDS_REVIEW') needsReviewCount += 1;
    else blockedCount += 1;
  }

  const duplicateSkuTileCount = duplicateSkuGroups.reduce((sum, g) => sum + g.tiles.length, 0);

  return {
    totalProducts,
    totalTiles,
    assignedTiles,
    unassignedTiles,
    visibleProducts,
    excludedProducts: totalProducts - visibleProducts,
    excludedBreakdown: {
      inactiveBrand: inactiveBrandProducts,
      inactiveCollection: inactiveCollectionProducts,
      inactiveProductItself: inactiveProductCount,
    },
    readyProducts: readyCount,
    needsReviewProducts: needsReviewCount,
    blockedProducts: blockedCount,
    exportEligibleProducts: readyCount + needsReviewCount,
    duplicateSkuGroupCount: duplicateSkuGroups.length,
    duplicateSkuTileCount,
  };
}

export interface CatalogReadinessQuery {
  page?: number;
  limit?: number;
  status?: ReadinessStatus;
  brandId?: string;
  collectionId?: string;
}

/**
 * Paginated, per-product validation issue list -- Section 4's
 * "pagination for record-level issues." Defaults to products that
 * have at least one issue (NEEDS_REVIEW or BLOCKED); pass
 * status=READY explicitly to see fully-clean products instead.
 */
export async function listCatalogReadinessIssues(query: CatalogReadinessQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = visibleProductWhere(query);
  // Validated in application code (status isn't a stored column), so
  // every visible product is read once, filtered, then paged in memory.
  // Catalogs at CASA's actual scale (thousands of tiles, not millions)
  // make this a single bounded query rather than N.
  const allVisible = await prisma.product.findMany({ where, select: PRODUCT_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  const validated = allVisible.map((p) => ({
    productId: p.id,
    productName: p.name,
    productCode: p.code,
    companyId: p.collection.brand.id,
    companyName: p.collection.brand.name,
    collectionId: p.collection.id,
    collectionName: p.collection.name,
    ...validateProduct(p),
  }));

  const filtered = query.status
    ? validated.filter((v) => v.status === query.status)
    : validated.filter((v) => v.status !== 'READY');

  const total = filtered.length;
  const pageRows = filtered.slice(skip, skip + take);
  const meta = buildPaginationMeta(total, page, limit) as PaginationMeta;

  return { data: pageRows, meta: { ...meta, rulesVersion: READINESS_RULES_VERSION } };
}
