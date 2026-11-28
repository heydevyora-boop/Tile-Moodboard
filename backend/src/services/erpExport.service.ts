import { prisma } from '@db/connection';
import { normalizeDriveImageUrl } from './referenceImages.service';

/**
 * The one standardized catalog payload an external reader (the ERP, or
 * anything else) gets from CASA — built from the same
 * Brand/Collection/Product/Tile data the catalog website itself reads,
 * never a second, parallel structure. Field order within each object
 * follows the standardized sequence this stage establishes: company,
 * collection, product, then variant-level SKU/image/material/
 * dimensions/thickness/finish/price/unit.
 *
 * Tiles not yet assigned to a Product (productId = null) are not
 * invented a home here — they are listed separately, per company, so
 * nothing is silently dropped or guessed into the wrong product.
 */
export async function getErpCatalogFeed() {
  const brands = await prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      code: true,
      collections: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          products: {
            where: { isActive: true },
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              code: true,
              category: true,
              specifications: true,
              coverImageUrl: true,
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
          },
        },
      },
      tiles: {
        where: { productId: null },
        select: {
          id: true,
          name: true,
          productCode: true,
          imageUrl: true,
          collection: true,
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

  function variantPayload(t: {
    id: string; productCode: string | null; imageUrl: string | null; material: string | null;
    size: string | null; thickness: string | null; finish: string | null;
    sellingPrice: unknown; unitOfMeasure: string | null; inStock: boolean;
  }) {
    return {
      variantId: t.id,
      sku: t.productCode,
      imageUrl: normalizeDriveImageUrl(t.imageUrl),
      material: t.material,
      dimensions: t.size,
      thickness: t.thickness,
      finish: t.finish,
      sellingPrice: t.sellingPrice === null ? null : String(t.sellingPrice),
      unitOfMeasure: t.unitOfMeasure,
      inStock: t.inStock,
    };
  }

  const companies = brands.map((brand) => ({
    companyId: brand.id,
    companyName: brand.name,
    companyCode: brand.code,
    collections: brand.collections.map((collection) => ({
      collectionId: collection.id,
      collectionName: collection.name,
      products: collection.products.map((product) => ({
        productId: product.id,
        productName: product.name,
        productCode: product.code,
        category: product.category,
        specifications: product.specifications,
        imageUrl: normalizeDriveImageUrl(product.coverImageUrl),
        availableSizes: [...new Set(product.tiles.map((t) => t.size).filter((s): s is string => !!s))],
        availableFinishes: [...new Set(product.tiles.map((t) => t.finish).filter((f): f is string => !!f))],
        variants: product.tiles.map(variantPayload),
      })),
    })),
    unassignedVariants: brand.tiles.map((t) => ({
      ...variantPayload(t),
      name: t.name,
      freeTextCollectionLabel: t.collection,
    })),
  }));

  return {
    generatedAt: new Date().toISOString(),
    companies,
  };
}
