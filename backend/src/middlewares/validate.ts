import { NextFunction, Request, Response } from 'express';
import { ZodTypeAny } from 'zod';

type RequestPart = 'body' | 'query' | 'params';

/**
 * Validates req[part] against a Zod schema and replaces it with the
 * parsed (and thus type-coerced/defaulted) value. Throws via next() on
 * failure — the global error handler already knows how to format
 * ZodErrors into a clean 400 response.
 *
 * Accepts any ZodTypeAny (not just ZodObject) so schemas built with
 * `.refine()`/`.transform()` — which return ZodEffects — work too.
 */
export const validate = (schema: ZodTypeAny, part: RequestPart = 'body') => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const parsed = schema.parse(req[part]);
    req[part] = parsed;
    next();
  } catch (err) {
    next(err);
  }
};
