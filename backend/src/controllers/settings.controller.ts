import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as settingsService from '@services/settings.service';
import { settingsSchemasByCategory, SettingsCategory } from '@validators/settings.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const getAll = catchAsync(async (_req: Request, res: Response) => {
  const settings = await settingsService.getAllSettings();
  res.status(200).json({ success: true, data: { settings } });
});

export const getCategory = catchAsync(async (req: Request, res: Response) => {
  const category = req.params.category as SettingsCategory;
  const settings = await settingsService.getSettings(category);
  res.status(200).json({ success: true, data: { category, settings } });
});

export const updateCategory = catchAsync(async (req: Request, res: Response) => {
  const category = req.params.category as SettingsCategory;
  const schema = settingsSchemasByCategory[category];
  const parsed = schema.parse(req.body);
  const settings = await settingsService.updateSettings(category, parsed, requireActorId(req), req);
  res.status(200).json({ success: true, data: { category, settings } });
});
