/**
 * Standard error responses, reused across nearly every path so error
 * documentation stays consistent instead of being re-typed (and
 * accidentally drifting) on every single endpoint.
 */
export const errorResponses = {
  // Covers both a generic malformed request (e.g. wrong file content type)
  // AND a failed Zod schema validation — this app's error handler
  // (src/middlewares/errorHandler.ts) routes both through the same
  // AppError.badRequest(), so both genuinely come back as 400, never 422.
  // A validation failure's body additionally includes the `errors` array;
  // a generic bad request doesn't. ValidationErrorResponse's shape is a
  // superset of ErrorResponse, so it's used here as the documented schema.
  400: { description: "Bad request — either malformed in a way validation didn't specifically catch (e.g. wrong file content type), or the request body failed schema validation, in which case the response additionally includes an `errors` array of `{ path, message }` pairs.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } } },
  401: { description: 'Missing, expired, or invalid access token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'Invalid or expired token' } } } },
  403: { description: "Authenticated, but the account's role lacks the required permission.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'You do not have permission to perform this action' } } } },
  404: { description: 'The requested resource does not exist.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
  409: { description: "Conflict — e.g. trying to favorite a tile that's already favorited for this customer.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
  429: { description: 'Rate limit exceeded. Check the Retry-After / RateLimit-* response headers for when to try again.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'Too many requests, please try again later.' } } } },
  500: { description: 'Unexpected server error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
};

/**
 * The subset of errorResponses that applies to essentially every
 * authenticated endpoint. Accepts 422 as a legacy/convenience alias for
 * "this endpoint validates its body" — every call site across the path
 * files was written expecting a validation-specific status, so rather
 * than touching ~40 call sites when the real status turned out to be 400
 * (not 422 — this app never actually returns 422), the alias is resolved
 * here in one place instead.
 */
export function standardErrors(...extra: (keyof typeof errorResponses | 422)[]) {
  const resolved = extra.map((code) => (code === 422 ? 400 : code)) as (keyof typeof errorResponses)[];
  const codes: (keyof typeof errorResponses)[] = [401, 403, ...resolved];
  const out: Record<string, unknown> = {};
  for (const code of codes) out[code] = errorResponses[code];
  return out;
}

export const bearerAuth = [{ bearerAuth: [] as string[] }];
