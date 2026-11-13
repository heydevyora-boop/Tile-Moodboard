/**
 * The physical sample module's HTTP surface.
 *
 * Reads are open to anyone who may see the catalogue -- including the
 * barcode lookup, because a scanner in a staff member's hand is the
 * whole point of the feature. Registering and removing samples is a
 * catalogue write. Approving a move is the Admin's alone, and that gate
 * is on the route, not here.
 */

import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as samples from '@services/sample.service';
import * as placements from '@services/samplePlacement.service';

// ── colours ──────────────────────────────────────────────────────

export const listColours = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: await samples.coloursForProduct(String(req.query.productId)),
  });
});

export const upsertColour = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as samples.ColourInput;
  const colour = await samples.upsertColour(body, req.user?.id, req);
  res.status(201).json({ success: true, data: { colour } });
});

/** The four states, served rather than hard-coded in the page. */
export const availabilityOptions = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      availability: [
        { id: 'PHYSICAL_SAMPLE', label: 'Physical sample available', needsPlacement: true },
        { id: 'CATALOGUE_ONLY', label: 'Catalogue only', needsPlacement: false },
        { id: 'CUTOUT_ONLY', label: 'Cutout only', needsPlacement: false },
        { id: 'NOT_AVAILABLE', label: 'Not available', needsPlacement: false },
      ],
    },
  });
});

// ── samples ──────────────────────────────────────────────────────

export const registerSample = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as samples.RegisterSampleInput;
  const file = req.file;

  const result = await samples.registerSample(
    String(req.params.colourId),
    body,
    file ? { buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname } : undefined,
    req.user!.id,
    req,
  );

  // 201 even when the photograph failed: the sample IS registered, and
  // the reason rides along rather than being raised as an error that
  // would suggest nothing was saved.
  res.status(201).json({ success: true, data: result });
});

export const byBarcode = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { sample: await samples.findByBarcode(String(req.params.code)) },
  });
});

/**
 * DUPLICATE FOR OTHER COLOURS.
 *
 * The colours arrive as JSON in a multipart field, because the
 * photograph rides in the same request -- one upload, several samples,
 * each still its own record with its own id and barcode.
 */
export const registerForColours = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as {
    productId: string; cassetteNo: string; panelNo: string; note?: string; colours: string;
  };
  if (!req.file) throw AppError.badRequest('A physical sample needs a photograph of it.');

  let colours;
  try {
    colours = JSON.parse(String(body.colours ?? '[]'));
  } catch {
    throw AppError.badRequest('The list of colours could not be read.');
  }
  if (!Array.isArray(colours)) throw AppError.badRequest('`colours` must be a list.');

  const result = await samples.registerForColours(
    body.productId,
    colours,
    { cassetteNo: body.cassetteNo, panelNo: body.panelNo, note: body.note },
    { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname },
    req.user!.id,
    req,
  );

  // 207-ish in spirit, 201 in fact: some colours may have been skipped
  // with a reason, and the caller is told which rather than being given
  // an error that suggests none of it worked.
  res.status(201).json({ success: true, data: result });
});

/** Every registered sample, searchable -- what the placement screen reads. */
export const listSamples = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: await samples.listSamples(req.query as samples.SampleListQuery),
  });
});

/**
 * Ask for a sample to come off the shelf.
 *
 * A request, not a deletion: nothing happens until an Admin agrees, and
 * when they do the record, the barcode and the history all stay.
 */
export const requestRemoval = catchAsync(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { reason?: string };
  const request = await placements.requestRemoval(
    String(req.params.id),
    { reason: body.reason },
    req.user?.id,
    req,
  );
  res.status(201).json({ success: true, data: { request } });
});

export const history = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: await placements.history(String(req.params.id)),
  });
});

export const contents = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as { cassetteNo: string; panelNo?: string };
  res.status(200).json({
    success: true,
    data: await placements.contentsOf(query.cassetteNo, query.panelNo),
  });
});

// ── moving a sample ──────────────────────────────────────────────

export const requestRelocation = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as placements.RelocationInput;
  const request = await placements.requestRelocation(
    String(req.params.id),
    body,
    req.user?.id,
    req,
  );
  res.status(201).json({ success: true, data: { request } });
});

export const listRequests = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as { status?: string; page: number; limit: number };
  res.status(200).json({
    success: true,
    data: await placements.listRequests(query.status ?? 'PENDING', query.page, query.limit),
  });
});

export const approve = catchAsync(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string };
  const result = await placements.approveRequest(String(req.params.id), req.user!.id, body.note);
  res.status(200).json({
    success: true,
    data: {
      request: result.request,
      placement: result.placement,
      sampleId: result.sampleId,
    },
  });
});

export const reject = catchAsync(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string };
  const request = await placements.rejectRequest(String(req.params.id), req.user!.id, body.note);
  res.status(200).json({ success: true, data: { request } });
});
