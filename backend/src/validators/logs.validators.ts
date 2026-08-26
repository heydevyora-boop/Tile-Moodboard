import { z } from 'zod';

export const logsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().optional(),
  entityType: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type LogsQuery = z.infer<typeof logsQuerySchema>;
