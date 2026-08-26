import { z } from 'zod';

export const uploadReferenceImageSchema = z.object({
  styleTag: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  style: z.string().trim().toUpperCase().max(40).optional(),
  room: z.string().trim().toUpperCase().max(40).optional(),
});

export const updateReferenceImageSchema = z
  .object({
    styleTag: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    style: z.string().trim().toUpperCase().max(40).optional().nullable(),
    room: z.string().trim().toUpperCase().max(40).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listReferenceImagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().optional(),
  style: z.string().trim().toUpperCase().optional(),
  room: z.string().trim().toUpperCase().optional(),
});

export type UploadReferenceImageInput = z.infer<typeof uploadReferenceImageSchema>;
export type UpdateReferenceImageInput = z.infer<typeof updateReferenceImageSchema>;
export type ListReferenceImagesQuery = z.infer<typeof listReferenceImagesQuerySchema>;
