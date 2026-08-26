import { z } from 'zod';

export const jobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  type: z.enum(['IMAGE_PROCESSING', 'EXPORT']).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});

export type JobsQuery = z.infer<typeof jobsQuerySchema>;
