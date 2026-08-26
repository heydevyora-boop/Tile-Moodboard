import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as promptBuilderService from '@services/promptBuilder.service';
import * as moodBoardService from '@services/moodBoard.service';
import {
  GenerateBriefInput,
  SaveMoodBoardInput,
  UpdateMoodBoardInput,
  ApproveMoodBoardInput,
  ListMoodBoardsQuery,
} from '@validators/moodBoard.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

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
