import { z } from 'zod';

export const tileRecommendationsQuerySchema = z.object({
  room: z.string().trim().toUpperCase().max(40).optional(),
  style: z.string().trim().toUpperCase().max(40).optional(),
  colorTone: z.string().trim().max(40).optional(),
  brandId: z.string().optional(),
  type: z.enum(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type TileRecommendationsQuery = z.infer<typeof tileRecommendationsQuerySchema>;

// Plain paginated/searchable browse of the tile archive, distinct from the
// style-scored /recommendations above -- the Catalog page's "Surface
// Archive" just needs every tile, optionally filtered, not a ranked match.
export const listTilesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().max(100).optional(),
  collection: z.string().trim().max(100).optional(),
  brandId: z.string().optional(),
  collectionId: z.string().optional(),
  productId: z.string().optional(),
  finish: z.string().trim().max(60).optional(),
  size: z.string().trim().max(60).optional(),
});

export type ListTilesQuery = z.infer<typeof listTilesQuerySchema>;

// Step 10: live ERP stock for a batch of SKUs the Catalog page is
// about to render. Comma-separated in the query string, same
// convention as moodBoardTileLookupQuerySchema's `ids` -- these are
// plain SKU strings, not a JSON body, and this is a GET.
export const tileStockQuerySchema = z.object({
  skus: z
    .string()
    .min(1, 'skus is required')
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string()).min(1, 'At least one SKU is required').max(100, 'At most 100 SKUs per request')),
});

export type TileStockQuery = z.infer<typeof tileStockQuerySchema>;
