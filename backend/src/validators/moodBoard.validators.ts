import { z } from 'zod';

export const generateBriefSchema = z.object({
  customerId: z.string().optional(),
  text: z.string().trim().min(3, 'Describe the client brief in at least a few words').max(2000),
  style: z.string().trim().toUpperCase().max(40).optional(),
  room: z.string().trim().toUpperCase().max(40).optional(),
  // The wizard sends the whole commercial envelope here, not a label:
  // the reference room, its floor and wall coverage, what is excluded,
  // the quantities and every selected band. 40 characters rejected that
  // outright. 800 holds the envelope with all five bands named and room
  // to spare; the measured worst case is under 700.
  budget: z.string().trim().max(800).optional(),
  brandId: z.string().optional(),
  combinationCount: z.coerce.number().int().min(1).max(6).optional(),
});

export type GenerateBriefInput = z.infer<typeof generateBriefSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Mood board PDF export
//
// The nine board sizes the wizard offers, in feet. A closed set, not a
// range: the client picks a physical panel size, and an arbitrary number
// here would reach the renderer as a page nobody can print.
// ─────────────────────────────────────────────────────────────────────────

export const BOARD_SIZES_FT: ReadonlyArray<readonly [number, number]> = [
  [2, 2], [2, 4], [4, 2], [4, 4], [4, 6], [6, 4], [8, 4], [9, 4], [10, 4],
];

export const exportMoodBoardPdfSchema = z
  .object({
    boardName: z.string().trim().min(1).max(200),
    brief: z.string().trim().max(600).optional(),
    grout: z.string().trim().max(120).optional(),
    widthFt: z.coerce.number().positive(),
    heightFt: z.coerce.number().positive(),
    sceneImageUrl: z.string().trim().url().max(2000).optional(),
    /*
     * The generated scene's own bytes, for the usual case where it has
     * no address this server could fetch -- Python embeds it as a data:
     * URL and that is all the browser ever holds.
     *
     * The cap is the same 6 MB of characters the visualization route
     * already allows for one of these, and sits under the 10 MB request
     * body limit in app.ts with the board's own payload to spare.
     */
    sceneImage: z
      .string()
      .trim()
      .max(6 * 1024 * 1024)
      .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/\r\n]+={0,2}$/i, 'sceneImage must be a base64 image data URL')
      .optional(),
    tiles: z
      .array(
        z.object({
          role: z.string().trim().max(40),
          name: z.string().trim().min(1).max(200),
          brandName: z.string().trim().max(120).optional(),
          size: z.string().trim().max(60).optional(),
          colorTone: z.string().trim().max(60).optional(),
          imageUrl: z.string().trim().url().max(2000).optional(),
        }),
      )
      .max(8),
  })
  .refine(
    (value) => BOARD_SIZES_FT.some(([w, h]) => w === value.widthFt && h === value.heightFt),
    { message: 'Pick one of the offered board sizes', path: ['widthFt'] },
  );

export type ExportMoodBoardPdfInput = z.infer<typeof exportMoodBoardPdfSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Save / update / approve — the persistence layer on top of /generate
// ─────────────────────────────────────────────────────────────────────────

const combinationTileSchema = z.object({
  role: z.string().trim().toLowerCase().pipe(z.enum(['base', 'highlight', 'border', 'accent'])),
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
  // Free-text match against client name, room, or style -- the Projects
  // page's search box, same pattern as the Catalog page's tile search.
  search: z.string().trim().max(100).optional(),
});

// Resolves the tileId references inside a /generate response's combinations
// (which only carry {role, tileId, name} -- no image/size/finish/stock) back
// to real Tile rows, so the UI can render what it actually picked instead of
// a bare ID. Comma-separated in the query string since these are simple IDs,
// not a JSON body, and this is a GET.
export const moodBoardTileLookupQuerySchema = z.object({
  ids: z
    .string()
    .min(1, 'ids is required')
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string()).min(1, 'At least one tile id is required').max(50, 'At most 50 tile ids per request')),
});

// ─────────────────────────────────────────────────────────────────────────
// Client Share/Approve — the client responds through a public, token-based
// link with no login, so this is the only body a public route accepts.
// ─────────────────────────────────────────────────────────────────────────

export const respondToSharedMoodBoardSchema = z.object({
  response: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
});

export type SaveMoodBoardInput = z.infer<typeof saveMoodBoardSchema>;
export type UpdateMoodBoardInput = z.infer<typeof updateMoodBoardSchema>;
export type ApproveMoodBoardInput = z.infer<typeof approveMoodBoardSchema>;
export type ListMoodBoardsQuery = z.infer<typeof listMoodBoardsQuerySchema>;
export type MoodBoardTileLookupQuery = z.infer<typeof moodBoardTileLookupQuerySchema>;
export type CombinationInput = z.infer<typeof combinationSchema>;
export type RespondToSharedMoodBoardInput = z.infer<typeof respondToSharedMoodBoardSchema>;
