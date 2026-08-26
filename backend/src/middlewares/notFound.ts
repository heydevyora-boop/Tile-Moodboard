import { NextFunction, Request, Response } from 'express';
import { AppError } from '@utils/AppError';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
