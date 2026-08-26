import { z } from 'zod';

export const PERMISSION_STRINGS = [
  'analytics:read',
  'catalogs:read',
  'catalogs:write',
  'customers:read',
  'customers:write',
  'design_rules:read',
  'design_rules:write',
  'logs:read',
  'mood_boards:read',
  'mood_boards:write',
  'print_boards:read',
  'print_boards:write',
  'reference_images:read',
  'reference_images:write',
  'tiles:read',
  'tiles:write',
  'users:read',
  'users:write',
] as const;

export const updateRoleSchema = z.object({
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.enum(PERMISSION_STRINGS)).optional(),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
