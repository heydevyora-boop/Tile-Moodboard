import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import { config } from '@config/index';
import * as promptBuilderService from '@services/promptBuilder.service';
import * as moodBoardService from '@services/moodBoard.service';
import {
  GenerateBriefInput,
  SaveMoodBoardInput,
  UpdateMoodBoardInput,
  ApproveMoodBoardInput,
  ListMoodBoardsQuery,
  MoodBoardTileLookupQuery,
  RespondToSharedMoodBoardInput,
  ExportMoodBoardPdfInput,
} from '@validators/moodBoard.validators';
import { renderMoodBoardPdf } from '@services/moodBoardPdf.service';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

/**
 * The open mood board as a PDF at the chosen physical size.
 *
 * Takes the board in the request rather than an id because the results
 * page shows combinations that have not been saved yet -- /generate is
 * stateless, so there is frequently no row to export from. Nothing is
 * written here either: it reads the posted board, draws it, and streams
 * the bytes back.
 */
export const exportPdf = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as ExportMoodBoardPdfInput;
  const pdf = await renderMoodBoardPdf({
    boardName: input.boardName,
    brief: input.brief,
    grout: input.grout,
    widthFt: input.widthFt,
    heightFt: input.heightFt,
    sceneImageUrl: input.sceneImageUrl,
    tiles: input.tiles,
  });

  const filename = input.boardName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'mood-board';

  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${input.widthFt}x${input.heightFt}ft.pdf"`);
  res.setHeader('Content-Length', String(pdf.byteLength));
  res.end(Buffer.from(pdf));
});

export const generate = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as GenerateBriefInput;
  const result = await promptBuilderService.generateCombinations(input, requireActorId(req), req);

  res.status(200).json({
    success: true,
    data: {
      combinations: result.combinations,
      warnings: result.warnings,
      tilesConsidered: result.tilesConsidered,
    },
  });
});

export const save = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as SaveMoodBoardInput;
  const board = await moodBoardService.saveMoodBoard(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { board } });
});

export const list = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListMoodBoardsQuery;
  const { boards, meta } = await moodBoardService.listMoodBoards(query);
  res.status(200).json({ success: true, data: { boards }, meta });
});

export const getTiles = catchAsync(async (req: Request, res: Response) => {
  const { ids } = req.query as unknown as MoodBoardTileLookupQuery;
  const tiles = await moodBoardService.getTilesByIds(ids);
  res.status(200).json({ success: true, data: { tiles } });
});

export const getOne = catchAsync(async (req: Request, res: Response) => {
  const board = await moodBoardService.getMoodBoardById(req.params.id);
  res.status(200).json({ success: true, data: { board } });
});

export const update = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateMoodBoardInput;
  const board = await moodBoardService.updateMoodBoard(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { board } });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await moodBoardService.deleteMoodBoard(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Mood board deleted' });
});

export const approve = catchAsync(async (req: Request, res: Response) => {
  const { selectedIndex } = req.body as ApproveMoodBoardInput;
  const board = await moodBoardService.approveMoodBoard(req.params.id, selectedIndex, requireActorId(req), req);
  res.status(200).json({ success: true, data: { board } });
});

// ─────────────────────────────────────────────────────────────────────────
// Client Share/Approve — `share` is staff-authenticated (normal middleware
// chain); `getShared` and `respondToShared` are public/token-scoped and are
// registered in moodBoard.routes.ts before `router.use(authenticate)`.
// ─────────────────────────────────────────────────────────────────────────

export const share = catchAsync(async (req: Request, res: Response) => {
  const share = await moodBoardService.shareMoodBoard(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, data: { token: share.token, shareUrl: `${config.frontend.url}/shared.html?token=${share.token}` } });
});

export const getShared = catchAsync(async (req: Request, res: Response) => {
  const board = await moodBoardService.getSharedMoodBoardByToken(req.params.token);
  res.status(200).json({ success: true, data: board });
});

export const respondToShared = catchAsync(async (req: Request, res: Response) => {
  const { response } = req.body as RespondToSharedMoodBoardInput;
  const result = await moodBoardService.respondToSharedMoodBoard(req.params.token, response, req);
  res.status(200).json({ success: true, data: result });
});
