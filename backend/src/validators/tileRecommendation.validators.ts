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
});

export type ListTilesQuery = z.infer<typeof listTilesQuerySchema>;
