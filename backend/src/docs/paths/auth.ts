import { standardErrors, errorResponses } from '../responses';

export const authPaths = {
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Log in with email and password',
      description:
        'Returns a short-lived JWT access token in the response body and sets a long-lived, httpOnly refresh token cookie. Send the access token as `Authorization: Bearer <token>` on every subsequent authenticated request. Rate-limited to 10 attempts per 15 minutes per IP (successful logins do not count against the limit).',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } } },
            example: { email: 'owner@casadeaurum.com', password: 'YourPassword123' },
          },
        },
      },
      responses: {
        200: {
          description: 'Login succeeded.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { accessToken: { type: 'string' }, expiresIn: { type: 'integer' }, user: { $ref: '#/components/schemas/User' } } } } },
              example: { success: true, data: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.abc123', expiresIn: 900, user: { id: 'clx1user001', name: 'Store Owner', email: 'owner@casadeaurum.com', role: { name: 'OWNER' } } } },
            },
          },
        },
        401: errorResponses[401],
        429: errorResponses[429],
      },
    },
  },
  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Exchange the refresh cookie for a new access token',
      description: 'Reads the httpOnly refresh token cookie set at login (no request body needed) and issues a new short-lived access token. Call this when a request comes back 401 with an expired token, then retry the original request.',
      security: [],
      responses: {
        200: { description: 'A new access token.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/AuthTokens' } } } } } },
        401: { description: 'The refresh cookie is missing, expired, or has been revoked (e.g. after logout).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    },
  },
  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke the current refresh token and clear the cookie',
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: 'Logged out.' }, ...standardErrors() },
    },
  },
  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: "Get the currently authenticated user's profile",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'The current user.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } } } } } } },
        ...standardErrors(),
      },
    },
  },
  '/auth/forgot-password': {
    post: {
      tags: ['Auth'],
      summary: 'Request a password reset',
      description: 'Always returns 200 regardless of whether the email exists, to avoid leaking which emails have accounts. Rate-limited to 5 requests per hour per IP.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
      responses: { 200: { description: 'A reset email was sent if the account exists.' }, 429: errorResponses[429] },
    },
  },
  '/auth/reset-password': {
    post: {
      tags: ['Auth'],
      summary: 'Complete a password reset using the emailed token',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'newPassword'], properties: { token: { type: 'string' }, newPassword: { type: 'string', format: 'password', minLength: 8 } } } } } },
      responses: { 200: { description: 'Password updated.' }, 400: { description: 'Token is invalid or expired.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } } },
    },
  },
};
