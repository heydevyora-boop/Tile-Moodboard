import { z } from 'zod';

export const recentActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type RecentActivityQuery = z.infer<typeof recentActivityQuerySchema>;

// Dashboard's own card only ever shows the top 3 (the default), but the
// Catalog page reuses this same endpoint to list every curated collection,
// hence the optional higher limit.
export const collectionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(3),
});

export type CollectionsQuery = z.infer<typeof collectionsQuerySchema>;
