import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as apiKeyService from '@services/apiKey.service';
import { CreateApiKeyInput, RotateApiKeyInput, ListApiKeysQuery } from '@validators/apiKey.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const list = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListApiKeysQuery;
  const keys = await apiKeyService.listApiKeys(query);
  res.status(200).json({ success: true, data: { keys } });
});

export const create = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as CreateApiKeyInput;
  const key = await apiKeyService.createApiKey(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { key } });
});

export const rotate = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as RotateApiKeyInput;
  const key = await apiKeyService.rotateApiKey(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { key } });
});

export const activate = catchAsync(async (req: Request, res: Response) => {
  const key = await apiKeyService.setApiKeyActive(req.params.id, true, requireActorId(req), req);
  res.status(200).json({ success: true, data: { key } });
});

export const deactivate = catchAsync(async (req: Request, res: Response) => {
  const key = await apiKeyService.setApiKeyActive(req.params.id, false, requireActorId(req), req);
  res.status(200).json({ success: true, data: { key } });
});

export const deactivateAll = catchAsync(async (req: Request, res: Response) => {
  const result = await apiKeyService.deactivateAllKeys(requireActorId(req), req);
  res.status(200).json({ success: true, data: result });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await apiKeyService.deleteApiKey(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'API key deleted' });
});
