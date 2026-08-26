import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import * as dashboardService from '@services/dashboard.service';
import { RecentActivityQuery } from '@validators/dashboard.validators';

export const getStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await dashboardService.getStats();
  res.status(200).json({ success: true, data: { stats } });
});

export const getRecentActivity = catchAsync(async (req: Request, res: Response) => {
  const { limit } = req.query as unknown as RecentActivityQuery;
  const activity = await dashboardService.getRecentActivity(limit);
  res.status(200).json({ success: true, data: { activity } });
});

export const getOverview = catchAsync(async (_req: Request, res: Response) => {
  const overview = await dashboardService.getOverview(10);
  res.status(200).json({ success: true, data: overview });
});
