import { NextFunction, Request, Response } from 'express';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

/**
 * Authenticates service-to-service calls that have no user session.
 *
 * The Python catalog_processor runs as a standalone script with no
 * login and no JWT, so the internal /master-sync route can't sit behind
 * the normal `authenticate` middleware. It presents a shared secret in
 * the x-internal-key header instead, which this compares against
 * INTERNAL_SYNC_API_KEY.
 *
 * Fails closed: if INTERNAL_SYNC_API_KEY isn't configured the route is
 * unusable rather than open, so a missing env var can never silently
 * expose an unauthenticated write path into the Tile table.
 */
export function internalAuth(req: Request, _res: Response, next: NextFunction): void {
  const expected = config.internal.syncApiKey;

  if (!expected) {
    next(AppError.forbidden('Internal sync is not configured on this server (INTERNAL_SYNC_API_KEY is unset)'));
    return;
  }

  const providedHeader = req.headers['x-internal-key'];
  const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;

  if (!provided || provided !== expected) {
    next(AppError.forbidden('Invalid or missing x-internal-key'));
    return;
  }

  next();
}
