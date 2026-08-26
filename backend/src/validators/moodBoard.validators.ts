import { z } from 'zod';

export const generateBriefSchema = z.object({
  customerId: z.string().optional(),
  text: z.string().trim().min(3, 'Describe the client brief in at least a few words').max(2000),
  style: z.string().trim().toUpperCase().max(40).optional(),
  room: z.string().trim().toUpperCase().max(40).optional(),
  budget: z.string().trim().max(40).optional(),
  brandId: z.string().optional(),
  combinationCount: z.coerce.number().int().min(1).max(6).optional(),
});

export type GenerateBriefInput = z.infer<typeof generateBriefSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Save / update / approve — the persistence layer on top of /generate
// ─────────────────────────────────────────────────────────────────────────

const combinationTileSchema = z.object({
  role: z.enum(['base', 'highlight', 'border', 'accent']),
  tileId: z.string().min(1),
  name: z.string().default(''),
});

// Same shape /generate returns — Save persists exactly what staff reviewed
// on screen, so the schema here must match GeneratedCombination exactly.
export const combinationSchema = z.object({
  board_name: z.string().min(1),
  tiles: z.array(combinationTileSchema).min(1, 'Each combination needs at least one tile'),
  grout_recommendation: z.string().default(''),
  rooms_suitable: z.array(z.string()).default([]),
  reason_for_selection: z.string().default(''),
});

export const saveMoodBoardSchema = z.object({
  customerId: z.string().optional(),
  clientBrief: z.string().trim().min(3).max(2000),
  style: z.string().trim().toUpperCase().max(40),
  room: z.string().trim().toUpperCase().max(40),
  combinations: z.array(combinationSchema).min(1, 'At least one combination is required to save a mood board'),
});

export const updateMoodBoardSchema = z
  .object({
    clientBrief: z.string().trim().min(3).max(2000).optional(),
    style: z.string().trim().toUpperCase().max(40).optional(),
    room: z.string().trim().toUpperCase().max(40).optional(),
    selectedIndex: z.number().int().min(0).optional(),
    // APPROVED is deliberately excluded — that transition only happens
    // through POST /:id/approve, which has its own validation and logging.
    status: z.enum(['DRAFT', 'GENERATED', 'REFINED', 'REJECTED', 'ARCHIVED']).optional(),
    combinations: z.array(combinationSchema).min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const approveMoodBoardSchema = z.object({
  selectedIndex: z.number().int().min(0),
});

export const listMoodBoardsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['DRAFT', 'GENERATED', 'REFINED', 'APPROVED', 'REJECTED', 'ARCHIVED']).optional(),
  customerId: z.string().optional(),
});

export type SaveMoodBoardInput = z.infer<typeof saveMoodBoardSchema>;
export type UpdateMoodBoardInput = z.infer<typeof updateMoodBoardSchema>;
export type ApproveMoodBoardInput = z.infer<typeof approveMoodBoardSchema>;
export type ListMoodBoardsQuery = z.infer<typeof listMoodBoardsQuerySchema>;
export type CombinationInput = z.infer<typeof combinationSchema>;
