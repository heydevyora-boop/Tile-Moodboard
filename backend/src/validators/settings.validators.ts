import { z } from 'zod';

export const companySettingsSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Casa de Aurum'),
  address: z.string().trim().max(500).optional().default(''),
  phone: z.string().trim().max(50).optional().default(''),
  email: z.string().trim().email().optional().or(z.literal('')).default(''),
  taxId: z.string().trim().max(100).optional().default(''),
  website: z.string().trim().max(200).optional().default(''),
});

export const printSettingsSchema = z.object({
  defaultDpi: z.coerce.number().int().min(72).max(1200).default(300),
  defaultFormat: z.enum(['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM']).default('CASSETTE_PANEL'),
  defaultFileFormat: z.enum(['PNG', 'PDF']).default('PDF'),
  defaultUnit: z.enum(['FT', 'IN', 'CM', 'MM']).default('FT'),
});

export const rulesSettingsSchema = z.object({
  defaultMinTiles: z.coerce.number().int().min(1).max(50).default(3),
  defaultMaxCombinations: z.coerce.number().int().min(1).max(20).default(4),
  defaultRoomType: z.string().trim().max(100).optional().default(''),
  defaultStyleTag: z.string().trim().max(100).optional().default(''),
});

export const generalSettingsSchema = z.object({
  timezone: z.string().trim().min(1).max(100).default('Asia/Kolkata'),
  currency: z.string().trim().min(1).max(10).default('INR'),
  dateFormat: z.string().trim().min(1).max(30).default('DD/MM/YYYY'),
  sessionTimeoutMinutes: z.coerce.number().int().min(5).max(1440).default(60),
});

export const settingsSchemasByCategory = {
  company: companySettingsSchema,
  print: printSettingsSchema,
  rules: rulesSettingsSchema,
  general: generalSettingsSchema,
} as const;

export type SettingsCategory = keyof typeof settingsSchemasByCategory;

export const settingsCategoryParamSchema = z.object({
  category: z.enum(['company', 'print', 'rules', 'general']),
});

export type CompanySettings = z.infer<typeof companySettingsSchema>;
export type PrintSettings = z.infer<typeof printSettingsSchema>;
export type RulesSettings = z.infer<typeof rulesSettingsSchema>;
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
