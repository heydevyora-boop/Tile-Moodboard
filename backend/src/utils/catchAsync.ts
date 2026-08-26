import { NextFunction, Request, Response } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Wraps an async controller/route handler so any thrown error or rejected
 * promise is forwarded to next(err) automatically, instead of every
 * controller needing its own try/catch block.
 *
 * Usage: router.get('/tiles', catchAsync(tilesController.list));
 */
export const catchAsync = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res, next).catch(next);
};
