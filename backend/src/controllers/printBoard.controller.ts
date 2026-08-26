import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as printBoardService from '@services/printBoard.service';
import { enqueueJob } from '@services/jobQueue.service';
import {
  GeneratePrintBoardInput,
  UpdatePrintBoardInput,
  ListPrintBoardsQuery,
  CreatePrintBoardTemplateInput,
  ExportHistoryQuery,
} from '@validators/printBoard.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const generate = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as GeneratePrintBoardInput;
  const board = await printBoardService.generatePrintBoard(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { board } });
});

/**
 * Same validated input and same underlying render/DB-write logic as
 * POST /print-boards/generate — the only difference is this returns
 * immediately with a job id instead of waiting for the render to finish.
 * Useful for large/high-DPI exports where the synchronous request could
 * otherwise sit open for a while.
 */
export const generateAsync = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as GeneratePrintBoardInput;
  const actorId = requireActorId(req);
  const job = await enqueueJob('EXPORT', { input, actorId }, { createdById: actorId });
  res.status(202).json({ success: true, data: { job } });
});

export const list = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListPrintBoardsQuery;
  const { boards, meta } = await printBoardService.listPrintBoards(query);
  res.status(200).json({ success: true, data: { boards }, meta });
});

export const getOne = catchAsync(async (req: Request, res: Response) => {
  const board = await printBoardService.getPrintBoardById(req.params.id);
  res.status(200).json({ success: true, data: { board } });
});

export const update = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdatePrintBoardInput;
  const board = await printBoardService.updatePrintBoard(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { board } });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await printBoardService.deletePrintBoard(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Print board deleted' });
});

export const listTemplates = catchAsync(async (_req: Request, res: Response) => {
  const templates = await printBoardService.listTemplates();
  res.status(200).json({ success: true, data: { templates } });
});

export const createTemplate = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as CreatePrintBoardTemplateInput;
  const template = await printBoardService.createTemplate(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { template } });
});

export const deleteTemplate = catchAsync(async (req: Request, res: Response) => {
  await printBoardService.deleteTemplate(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Template deleted' });
});

export const exportHistory = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ExportHistoryQuery;
  const { events, meta } = await printBoardService.getExportHistory(query);
  res.status(200).json({ success: true, data: { events }, meta });
});

export const shareToDrive = catchAsync(async (req: Request, res: Response) => {
  const board = await printBoardService.shareToDrive(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, data: { board } });
});
