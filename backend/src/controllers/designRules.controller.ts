import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as designRulesService from '@services/designRules.service';
import {
  CreateDesignRuleInput,
  UpdateDesignRuleInput,
  PublishRulesInput,
  ListVersionsQuery,
  CompareVersionsQuery,
} from '@validators/designRules.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const listDesignRules = catchAsync(async (_req: Request, res: Response) => {
  const rules = await designRulesService.listDesignRules();
  res.status(200).json({ success: true, data: { rules } });
});

export const getDesignRule = catchAsync(async (req: Request, res: Response) => {
  const rule = await designRulesService.getDesignRule(req.params.id);
  res.status(200).json({ success: true, data: { rule } });
});

export const createDesignRule = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as CreateDesignRuleInput;
  const rule = await designRulesService.createDesignRule(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { rule } });
});

export const updateDesignRule = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateDesignRuleInput;
  const rule = await designRulesService.updateDesignRule(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { rule } });
});

export const deleteDesignRule = catchAsync(async (req: Request, res: Response) => {
  await designRulesService.deleteDesignRule(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Design rule deleted' });
});

export const previewDraft = catchAsync(async (_req: Request, res: Response) => {
  const preview = await designRulesService.previewDraft();
  res.status(200).json({ success: true, data: preview });
});

export const publishRules = catchAsync(async (req: Request, res: Response) => {
  const { changeSummary } = req.body as PublishRulesInput;
  const version = await designRulesService.publishRules(changeSummary, requireActorId(req), req);
  res.status(201).json({ success: true, data: { version } });
});

export const getLiveVersion = catchAsync(async (_req: Request, res: Response) => {
  const version = await designRulesService.getLiveVersion();
  res.status(200).json({ success: true, data: { version } });
});

export const listVersionHistory = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListVersionsQuery;
  const { versions, meta } = await designRulesService.listVersionHistory(query);
  res.status(200).json({ success: true, data: { versions }, meta });
});

export const getVersion = catchAsync(async (req: Request, res: Response) => {
  const version = await designRulesService.getVersionById(req.params.id);
  res.status(200).json({ success: true, data: { version } });
});

export const compareVersions = catchAsync(async (req: Request, res: Response) => {
  const { from, to } = req.query as unknown as CompareVersionsQuery;
  const result = await designRulesService.compareVersions(from, to);
  res.status(200).json({ success: true, data: result });
});

export const restoreVersion = catchAsync(async (req: Request, res: Response) => {
  const rules = await designRulesService.restoreVersion(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, data: { rules }, message: 'Draft restored. Publish to make it live.' });
});

export const deleteVersion = catchAsync(async (req: Request, res: Response) => {
  await designRulesService.deleteVersion(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Version deleted' });
});
