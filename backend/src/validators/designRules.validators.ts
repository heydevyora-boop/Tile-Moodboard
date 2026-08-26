import { z } from 'zod';

const RULE_SECTIONS = ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'] as const;

export const createDesignRuleSchema = z
  .object({
    section: z.enum(RULE_SECTIONS),
    key: z.string().trim().toUpperCase().regex(/^[A-Z_]+$/, 'key must be uppercase letters/underscores only').optional(),
    title: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(4000),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
  })
  .refine((data) => (data.section === 'GENERAL' ? data.key === undefined : !!data.key), {
    message: 'key is required for STYLE/ROOM/CLIENT rules, and must be omitted for GENERAL',
    path: ['key'],
  });

export const updateDesignRuleSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    content: z.string().trim().min(1).max(4000).optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const publishRulesSchema = z.object({
  changeSummary: z.string().trim().max(500).optional(),
});

export const listVersionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const compareVersionsQuerySchema = z.object({
  from: z.string().min(1, 'from is required'),
  to: z.string().min(1, 'to is required'),
});

export type CreateDesignRuleInput = z.infer<typeof createDesignRuleSchema>;
export type UpdateDesignRuleInput = z.infer<typeof updateDesignRuleSchema>;
export type PublishRulesInput = z.infer<typeof publishRulesSchema>;
export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;
export type CompareVersionsQuery = z.infer<typeof compareVersionsQuerySchema>;
