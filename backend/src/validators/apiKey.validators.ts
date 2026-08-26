import { z } from 'zod';

export const createApiKeySchema = z.object({
  service: z.enum(['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM']),
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
});

export const rotateApiKeySchema = z.object({
  value: z.string().trim().min(1).max(4000),
});

export const listApiKeysQuerySchema = z.object({
  service: z.enum(['GEMINI', 'GOOGLE_DRIVE', 'CUSTOM']).optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>;
export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;
