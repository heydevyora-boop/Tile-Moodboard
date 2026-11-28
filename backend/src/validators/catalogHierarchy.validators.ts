import { z } from 'zod';

/* ============================================================
   COMPANY (Brand)
   ============================================================ */

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().max(40).optional(),
  description: z.string().trim().max(2000).optional(),
  logoUrl: z.string().trim().max(2000).optional(),
});

export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: z.string().trim().max(40).nullish(),
    description: z.string().trim().max(2000).nullish(),
    logoUrl: z.string().trim().max(2000).nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listCompaniesQuerySchema = z.object({
  search: z.string().trim().optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/* ============================================================
   COLLECTION
   ============================================================ */

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  brandId: z.string().min(1, 'Company is required.'),
  description: z.string().trim().max(2000).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  catalogueDocumentUrl: z.string().trim().max(2000).optional(),
});

export const updateCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullish(),
    coverImageUrl: z.string().trim().max(2000).nullish(),
    catalogueDocumentUrl: z.string().trim().max(2000).nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listCollectionsQuerySchema = z.object({
  brandId: z.string().min(1).optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* ============================================================
   PRODUCT
   ============================================================ */

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(160),
  collectionId: z.string().min(1, 'Collection is required.'),
  code: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  specifications: z.string().trim().max(4000).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
});

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: z.string().trim().max(60).nullish(),
    description: z.string().trim().max(2000).nullish(),
    specifications: z.string().trim().max(4000).nullish(),
    coverImageUrl: z.string().trim().max(2000).nullish(),
    category: z.string().trim().max(80).nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listProductsQuerySchema = z.object({
  collectionId: z.string().min(1).optional(),
  brandId: z.string().min(1).optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Assigning an existing Tile (variant) to a Product. Deliberately its
 * own small schema rather than folded into updateProductSchema: it is
 * a relationship change, not a Product field edit. */
export const assignVariantSchema = z.object({
  tileId: z.string().min(1),
});

/* ============================================================
   ERP CATALOG FEED
   ============================================================ */

export const erpCatalogFeedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // 100, not 200: the shared getPagination/MAX_LIMIT in utils/pagination.ts
  // silently caps every list endpoint in this API at 100 regardless of
  // what a validator allows. A higher ceiling here would validate but
  // never actually be honored -- matching it is what "reuse the shared
  // helper" means in practice, not just importing the function.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  brandId: z.string().min(1).optional(),
  collectionId: z.string().min(1).optional(),
});

export type ErpCatalogFeedQuery = z.infer<typeof erpCatalogFeedQuerySchema>;

/* ============================================================
   ERP CATALOG READINESS (data validation / reconciliation)
   ============================================================ */

export const catalogReadinessQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['READY', 'NEEDS_REVIEW', 'BLOCKED']).optional(),
  brandId: z.string().min(1).optional(),
  collectionId: z.string().min(1).optional(),
});

export type CatalogReadinessApiQuery = z.infer<typeof catalogReadinessQuerySchema>;

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
export type ListCollectionsQuery = z.infer<typeof listCollectionsQuerySchema>;

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type AssignVariantInput = z.infer<typeof assignVariantSchema>;
