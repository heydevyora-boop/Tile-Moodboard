import { successEnvelope } from '../utils/response.mjs';

/* ============================================================
   WHAT MAKES /api/v1 DIFFERENT FROM /api
   ============================================================
   Three small pieces of middleware, applied once to the whole
   /api/v1 router (see server/routes/v1.mjs), not to any
   individual route:

     1. mark the request as v1, so the one shared error
        middleware in app.mjs knows which envelope to send back
        when something throws;
     2. accept the brief's own query parameter name (`limit`) as
        an alias for the `pageSize` every existing route already
        reads, so GET /api/v1/products?page=1&limit=20 works
        without that route file knowing v1 exists;
     3. wrap whatever a route hands to res.json() in the standard
        success envelope.

   Every route under /api/v1 is the SAME router, the SAME Zod
   schemas and the SAME service calls as under /api -- nothing
   about how a route is written changes. Only what wraps it does.
   ============================================================ */

/** Routes this session as v1, for the shared error middleware. */
export function markApiVersion(req, _res, next) {
  req.apiVersion = 'v1';
  next();
}

/** `limit` is the brief's own pagination parameter name; every
 *  existing route reads `pageSize`. Accepted as an alias here,
 *  once, rather than teaching every route file a second name for
 *  the same thing. */
export function translateLegacyQueryParams(req, _res, next) {
  if (req.query && req.query.limit !== undefined && req.query.pageSize === undefined) {
    req.query.pageSize = req.query.limit;
  }
  next();
}

/** Wraps every res.json() call made anywhere downstream in the
 *  standard v1 success envelope. A 204 (no body) is left alone --
 *  there is nothing to wrap, and a route that sends one is saying
 *  so on purpose.
 *
 *  The original, unwrapped res.json is kept as res.locals.sendRaw
 *  so the shared error middleware in app.mjs -- which already has
 *  to build the v1 error shape itself -- can send it without this
 *  wrapper folding an error body into `data` as if it were a
 *  success. Error and success are two different envelopes; only
 *  one of them is this middleware's job. */
export function wrapJsonEnvelope(req, res, next) {
  const original = res.json.bind(res);
  res.locals.sendRaw = original;
  res.json = (payload) => original(successEnvelope(payload, { method: req.method, status: res.statusCode }));
  next();
}
