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
