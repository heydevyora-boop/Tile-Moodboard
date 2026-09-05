import { z } from 'zod';

export const uploadCatalogSchema = z
  .object({
    brandId: z.string().optional(),
    brandName: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.brandId || data.brandName, {
    message: 'Provide either brandId or brandName',
  });

export const listCatalogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  brandId: z.string().optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});

export const listCatalogTilesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateExtractedTileSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    size: z.string().trim().optional().nullable(),
    finish: z.string().trim().optional().nullable(),
    type: z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
    colorTone: z.string().trim().optional().nullable(),
    bestRoom: z.string().trim().optional().nullable(),
    collection: z.string().trim().optional().nullable(),
    productCode: z.string().trim().optional().nullable(),
    inStock: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

/**
 * Payload the Python catalog_processor posts to /master-sync for each
 * product it appends to the Google Sheets MASTER tab. Only productCode
 * and brandName are required — MASTER rows are written before
 * classification, so most attributes are still blank at that point.
 */
export const masterTileSyncSchema = z.object({
  productCode: z.string().trim().min(1),
  productName: z.string().trim().optional(),
  brandName: z.string().trim().min(1),
  imageUrl: z.string().trim().optional(),
  size: z.string().trim().optional(),
  finish: z.string().trim().optional(),
  colorTone: z.string().trim().optional(),
  bestRoom: z.string().trim().optional(),
  collection: z.string().trim().optional(),
  type: z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
  sheetRowRef: z.coerce.number().int().min(0).optional(),
});

export type UploadCatalogInput = z.infer<typeof uploadCatalogSchema>;
export type MasterTileSyncInput = z.infer<typeof masterTileSyncSchema>;
export type ListCatalogsQuery = z.infer<typeof listCatalogsQuerySchema>;
export type ListCatalogTilesQuery = z.infer<typeof listCatalogTilesQuerySchema>;
export type UpdateExtractedTileInput = z.infer<typeof updateExtractedTileSchema>;
