/**
 * What a caller may send about a sample.
 *
 * Deliberately small, and nothing about identity: the sample id and the
 * barcode are generated on the server and appear in no schema here. A
 * browser that could choose a barcode could point two colours at one
 * piece of tile.
 */

import { z } from 'zod';

export const AVAILABILITY = z.enum([
  'PHYSICAL_SAMPLE',
  'CATALOGUE_ONLY',
  'CUTOUT_ONLY',
  'NOT_AVAILABLE',
]);

export const upsertColourSchema = z.object({
  productId: z.string().trim().min(1, 'Which product?'),
  colourName: z.string().trim().min(1, 'A colour needs a name.').max(120),
  colourCode: z.string().trim().max(60).optional().or(z.literal('')),
  availability: AVAILABILITY.optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * Cassette and panel are free text, not numbers.
 *
 * A studio's cassettes are labelled "4", "4A", "B-12" and "Back wall"
 * in the same week. Forcing an integer here would make the module
 * unusable in exactly the showrooms it is for, and nothing in the
 * system does arithmetic on them.
 */
const CASSETTE = z.string().trim().min(1, 'Which cassette?').max(40);
const PANEL = z.string().trim().min(1, 'Which panel?').max(40);

export const registerSampleSchema = z.object({
  cassetteNo: CASSETTE,
  panelNo: PANEL,
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export const relocationRequestSchema = z.object({
  cassetteNo: CASSETTE,
  panelNo: PANEL,
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});

export const decisionSchema = z.object({
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export const coloursQuerySchema = z.object({
  productId: z.string().trim().min(1, 'Which product?'),
});

export const requestsQuerySchema = z.object({
  status: z.string().trim().toUpperCase().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const contentsQuerySchema = z.object({
  cassetteNo: CASSETTE,
  panelNo: z.string().trim().max(40).optional(),
});

/**
 * The bulk registration's own fields.
 *
 * `colours` is a JSON string rather than an array because the request
 * is multipart -- it carries the photograph -- and a multipart field is
 * text. The controller parses it and the service checks every entry
 * belongs to the named product.
 */
export const bulkRegisterSchema = z.object({
  productId: z.string().trim().min(1, 'Which product?'),
  cassetteNo: z.string().trim().min(1, 'Which cassette?').max(40),
  panelNo: z.string().trim().min(1, 'Which panel?').max(40),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  colours: z.string().trim().min(2, 'Choose at least one colour to register.'),
});

export const removalRequestSchema = z.object({
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});

/** A refusal has to say why, so this one is not optional. */
export const rejectionSchema = z.object({
  note: z.string().trim().min(1, 'Rejecting a request needs a reason.').max(500),
});

export const sampleListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  colourName: z.string().trim().max(120).optional(),
  cassetteNo: z.string().trim().max(40).optional(),
  panelNo: z.string().trim().max(40).optional(),
  availability: z.string().trim().toUpperCase().max(30).optional(),
  status: z.string().trim().toUpperCase().max(10).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
