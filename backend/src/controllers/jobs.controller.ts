import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as jobQueue from '@services/jobQueue.service';

export const getJob = catchAsync(async (req: Request, res: Response) => {
  const job = await jobQueue.getJob(req.params.id);
  if (!job) throw AppError.notFound('Job not found');
  res.status(200).json({ success: true, data: { job } });
});
