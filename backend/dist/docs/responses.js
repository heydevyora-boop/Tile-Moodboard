"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bearerAuth = exports.errorResponses = void 0;
exports.standardErrors = standardErrors;
exports.errorResponses = {
    400: { description: "Bad request — either malformed in a way validation didn't specifically catch (e.g. wrong file content type), or the request body failed schema validation, in which case the response additionally includes an `errors` array of `{ path, message }` pairs.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } } } },
    401: { description: 'Missing, expired, or invalid access token.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'Invalid or expired token' } } } },
    403: { description: "Authenticated, but the account's role lacks the required permission.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'You do not have permission to perform this action' } } } },
    404: { description: 'The requested resource does not exist.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    409: { description: "Conflict — e.g. trying to favorite a tile that's already favorited for this customer.", content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    429: { description: 'Rate limit exceeded. Check the Retry-After / RateLimit-* response headers for when to try again.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, status: 'fail', message: 'Too many requests, please try again later.' } } } },
    500: { description: 'Unexpected server error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
};
function standardErrors(...extra) {
    const resolved = extra.map((code) => (code === 422 ? 400 : code));
    const codes = [401, 403, ...resolved];
    const out = {};
    for (const code of codes)
        out[code] = exports.errorResponses[code];
    return out;
}
exports.bearerAuth = [{ bearerAuth: [] }];
//# sourceMappingURL=responses.js.map