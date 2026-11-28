import { AppError } from '../errors.mjs';

/* ============================================================
   THE ONE ROUTE A SEPARATE SERVICE (CASA) CAN CALL
   ============================================================
   Mirrors erpAuth.ts on the CASA side exactly, in the opposite
   direction: CASA's catalog-feed route trusts a shared secret
   presented as x-erp-key, compared against ERP_EXPORT_API_KEY.
   This is that same idea for calls going the other way -- CASA's
   backend reading ERP's company/collection/product-line/product/
   inventory data -- gated by x-casa-key, compared against
   CASA_INTEGRATION_API_KEY.

   Deliberately its own secret, not a reused one: a leak of the key
   CASA presents to ERP must never also expose the key ERP presents
   to CASA, and neither is the x-erp-user placeholder identity that
   everything else in this file's sibling routes still runs on. This
   middleware does not resolve or trust any identity at all -- the
   shared secret IS the whole check, exactly as on the CASA side.

   FAILS CLOSED: if CASA_INTEGRATION_API_KEY isn't configured, the
   route is unusable rather than open to anyone who finds it.
   ============================================================ */
export function requireCasaKey(req, _res, next) {
  const expected = process.env.CASA_INTEGRATION_API_KEY;

  if (!expected) {
    next(new AppError(
      'The CASA integration is not configured on this server (CASA_INTEGRATION_API_KEY is unset).',
      { status: 403, code: 'FORBIDDEN' },
    ));
    return;
  }

  const provided = req.header('x-casa-key');
  if (!provided || provided !== expected) {
    next(new AppError('Invalid or missing x-casa-key.', { status: 403, code: 'FORBIDDEN' }));
    return;
  }

  next();
}
