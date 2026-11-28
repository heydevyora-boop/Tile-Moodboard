import { NextFunction, Request, Response } from 'express';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

/**
 * Authenticates the one read-only route an external reader (the ERP, or
 * anything else) can call with no CASA user session: the catalog export
 * feed. Presents a shared secret as the x-erp-key header, compared
 * against ERP_EXPORT_API_KEY.
 *
 * Deliberately a separate secret from internalAuth's
 * INTERNAL_SYNC_API_KEY: that one lets the Python pipeline write tiles
 * in, this one only lets a reader pull the catalog out, and a leak of
 * one must never also expose the other.
 *
 * Fails closed: if ERP_EXPORT_API_KEY isn't configured the route is
 * unusable rather than open.
 */
export function erpAuth(req: Request, _res: Response, next: NextFunction): void {
  const expected = config.internal.erpExportApiKey;

  if (!expected) {
    next(AppError.forbidden('The ERP catalog export is not configured on this server (ERP_EXPORT_API_KEY is unset)'));
    return;
  }

  const providedHeader = req.headers['x-erp-key'];
  const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;

  if (!provided || provided !== expected) {
    next(AppError.forbidden('Invalid or missing x-erp-key'));
    return;
  }

  next();
}
