import { z } from 'zod';

const boolFromQuery = z
  .union([z.literal('true'), z.literal('false')])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const loginHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  email: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  success: boolFromQuery,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const errorLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  statusCode: z.coerce.number().int().optional(),
  path: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const catalogLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  brandId: z.string().trim().optional(),
});

export type LoginHistoryQuery = z.infer<typeof loginHistoryQuerySchema>;
export type ErrorLogsQuery = z.infer<typeof errorLogsQuerySchema>;
export type CatalogLogsQuery = z.infer<typeof catalogLogsQuerySchema>;
