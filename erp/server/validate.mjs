import { ValidationError } from './errors.mjs';

/* Turn a zod failure into the same field-level shape every other
   rejection uses, so the frontend has one error format to render
   rather than two. */
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.map((i) => ({
      field: i.path.join('.') || '(body)',
      message: i.message,
    })),
  );
}

/** Wrap an async handler so a rejection reaches the error middleware. */
export const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
