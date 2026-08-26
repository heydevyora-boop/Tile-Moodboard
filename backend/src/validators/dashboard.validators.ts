import { z } from 'zod';

export const recentActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type RecentActivityQuery = z.infer<typeof recentActivityQuerySchema>;
