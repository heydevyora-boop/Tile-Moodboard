import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '@utils/jwt';
import { AppError } from '@utils/AppError';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * Verifies the access token and attaches { id, email, role, permissions }
 * to req.user. Deliberately stateless (no DB hit) — that's the point of
 * using short-lived JWTs. Deactivating a user or changing their role
 * takes effect within one access-token lifetime (default 15 minutes),
 * or immediately for anything gated by revoking refresh tokens.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    next(AppError.unauthorized('Authentication required'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      permissions: payload.permissions,
    };
    next();
  } catch (err) {
    next(err); // jsonwebtoken's TokenExpiredError/JsonWebTokenError are normalized by the global error handler
  }
}

/**
 * Like `authenticate`, but doesn't fail the request if no/invalid token
 * is present — just leaves req.user undefined. Useful for endpoints that
 * behave differently for logged-in vs anonymous callers without requiring
 * auth outright.
 */
export function authenticateOptional(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role, permissions: payload.permissions };
  } catch {
    // ignore — treat as anonymous
  }
  next();
}

/** Route-level role gate, e.g. authorize('OWNER', 'ADMIN'). Must run after `authenticate`. */
export function authorize(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      next(AppError.forbidden('You do not have permission to perform this action'));
      return;
    }
    next();
  };
}

/**
 * Finer-grained gate than `authorize` — checks the permission strings
 * embedded in the access token (sourced from Role.permissions at
 * login/refresh time). A permission of "*" (the OWNER role's default)
 * always passes.
 */
export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }
    const hasPermission = req.user.permissions.includes('*') || req.user.permissions.includes(permission);
    if (!hasPermission) {
      next(AppError.forbidden(`Missing required permission: ${permission}`));
      return;
    }
    next();
  };
}
