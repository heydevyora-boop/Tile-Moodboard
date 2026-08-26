import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as logsService from '@services/logs.service';
import * as analyticsService from '@services/analytics.service';
import * as loginAttemptService from '@services/loginAttempt.service';
import * as errorLogService from '@services/errorLog.service';
import * as jobQueue from '@services/jobQueue.service';
import { getExtractionQueueStats } from '@services/catalogExtractor.service';
import { LogsQuery } from '@validators/logs.validators';
import { LoginHistoryQuery, ErrorLogsQuery, CatalogLogsQuery } from '@validators/loggingSystem.validators';
import { JobsQuery } from '@validators/jobs.validators';

export const getLogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as LogsQuery;
  const { logs, meta } = await logsService.listLogs(query);
  res.status(200).json({ success: true, data: { logs }, meta });
});

export const getLogActions = catchAsync(async (_req: Request, res: Response) => {
  const actions = await logsService.listDistinctActions();
  res.status(200).json({ success: true, data: { actions } });
});

export const getAnalytics = catchAsync(async (req: Request, res: Response) => {
  const days = Number(req.query.days) || 30;
  const overview = await analyticsService.getAnalyticsOverview(days);
  res.status(200).json({ success: true, data: overview });
});

export const getLoginHistory = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as LoginHistoryQuery;
  const { attempts, meta } = await loginAttemptService.listLoginHistory(query);
  res.status(200).json({ success: true, data: { attempts }, meta });
});

export const getErrorLogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ErrorLogsQuery;
  const { errors, meta } = await errorLogService.listErrorLogs(query);
  res.status(200).json({ success: true, data: { errors }, meta });
});

export const getCatalogLogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as CatalogLogsQuery;
  const { catalogs, meta } = await logsService.listCatalogLogs(query);
  res.status(200).json({ success: true, data: { catalogs }, meta });
});

export const getMoodBoardLogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as LogsQuery;
  const { logs, meta } = await logsService.listMoodBoardLogs(query);
  res.status(200).json({ success: true, data: { logs }, meta });
});

export const getPrintBoardLogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as LogsQuery;
  const { logs, meta } = await logsService.listPrintBoardLogs(query);
  res.status(200).json({ success: true, data: { logs }, meta });
});

export const getQueueStats = catchAsync(async (_req: Request, res: Response) => {
  const [catalog, imageProcessing, exportQueue] = await Promise.all([
    getExtractionQueueStats(),
    jobQueue.getQueueStats('IMAGE_PROCESSING'),
    jobQueue.getQueueStats('EXPORT'),
  ]);
  res.status(200).json({ success: true, data: { catalog, imageProcessing, export: exportQueue } });
});

export const getJobs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as JobsQuery;
  const { jobs, total } = await jobQueue.listJobs(query);
  res.status(200).json({ success: true, data: { jobs }, meta: { total, page: query.page, limit: query.limit } });
});

export const retryJob = catchAsync(async (req: Request, res: Response) => {
  const result = await jobQueue.retryJob(req.params.id);
  if (!result) throw AppError.notFound('Job not found or not in a FAILED state');
  res.status(200).json({ success: true, data: { job: result } });
});
