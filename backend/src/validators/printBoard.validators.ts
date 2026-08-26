import { z } from 'zod';

const dimensionFields = {
  format: z.enum(['CASSETTE_PANEL', 'ACP_SIGNBOARD', 'MOOD_BOARD_PRINT', 'CUSTOM']),
  layout: z.enum(['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE']),
  widthValue: z.number().positive(),
  heightValue: z.number().positive(),
  unit: z.enum(['FT', 'IN', 'CM', 'MM']),
  dpi: z.number().int().min(72).max(1200).default(300),
};

export const generatePrintBoardSchema = z
  .object({
    moodBoardId: z.string().min(1),
    combinationIndex: z.number().int().min(0).optional(),
    templateId: z.string().optional(),
    format: dimensionFields.format.optional(),
    layout: dimensionFields.layout.optional(),
    widthValue: dimensionFields.widthValue.optional(),
    heightValue: dimensionFields.heightValue.optional(),
    unit: dimensionFields.unit.optional(),
    dpi: dimensionFields.dpi.optional(),
    fileFormat: z.enum(['PDF', 'PNG']).default('PDF'),
  })
  .refine((data) => data.templateId || (data.format && data.layout && data.widthValue && data.heightValue && data.unit), {
    message: 'Provide either templateId or format+layout+widthValue+heightValue+unit',
  });

export const updatePrintBoardSchema = z
  .object({
    format: dimensionFields.format.optional(),
    layout: dimensionFields.layout.optional(),
    widthValue: dimensionFields.widthValue.optional(),
    heightValue: dimensionFields.heightValue.optional(),
    unit: dimensionFields.unit.optional(),
    dpi: z.number().int().min(72).max(1200).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listPrintBoardsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  moodBoardId: z.string().optional(),
  fileFormat: z.enum(['PDF', 'PNG']).optional(),
});

export const exportHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createPrintBoardTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ...dimensionFields,
});

export type GeneratePrintBoardInput = z.infer<typeof generatePrintBoardSchema>;
export type UpdatePrintBoardInput = z.infer<typeof updatePrintBoardSchema>;
export type ListPrintBoardsQuery = z.infer<typeof listPrintBoardsQuerySchema>;
export type ExportHistoryQuery = z.infer<typeof exportHistoryQuerySchema>;
export type CreatePrintBoardTemplateInput = z.infer<typeof createPrintBoardTemplateSchema>;
