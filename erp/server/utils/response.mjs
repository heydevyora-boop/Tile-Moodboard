import { AppError } from '../errors.mjs';

/* ============================================================
   THE STANDARD RESPONSE ENVELOPE — /api/v1 ONLY
   ============================================================

   Step 8 asks for a consistent

     { success: true,  message, data, meta }
     { success: false, message, code, errors }

   shape. Nothing before this step used one: every route up to now
   sends back whatever its service returns -- a bare array, a
   `{rows, page, pageSize, total, pageCount}` page, a single
   entity -- and the frontend's one `request()` function unwraps
   exactly that. Rewriting every existing route to speak the new
   shape would touch sixty-odd handlers across seven modules for a
   change that is about the WRAPPER, not the DATA inside it, and
   "maintain backward compatibility" was explicit in the brief.

   So /api/* is untouched, byte for byte, and this file is what
   turns the SAME service responses into the envelope for
   /api/v1/* instead -- applied once, as response-shaping
   middleware (see server/middleware/apiV1.mjs), not copied into
   every route. A route written the ordinary way
   (`res.json(await thing.list(query))`) gets the v1 shape for
   free the moment it is mounted under /api/v1; nothing about how
   routes are written has to change.
   ============================================================ */

const DEFAULT_MESSAGE = {
  GET: 'Request completed successfully',
  POST: 'Operation completed successfully',
  PATCH: 'Updated successfully',
  PUT: 'Updated successfully',
  DELETE: 'Deleted successfully',
};

/**
 * Is this the shape every list endpoint in the project already
 * returns? `{ rows: [...], page, pageSize, total, pageCount }`.
 * Detected structurally, not by a per-route flag, so a route
 * someone writes next year is picked up automatically as long as
 * it follows the same convention every other list endpoint
 * already does.
 */
function isPage(payload) {
  return Boolean(payload)
    && typeof payload === 'object'
    && Array.isArray(payload.rows)
    && typeof payload.page === 'number'
    && typeof payload.pageSize === 'number'
    && typeof payload.total === 'number'
    && typeof payload.pageCount === 'number';
}

/**
 * The payload a route handed to `res.json()`, reshaped into the
 * v1 success envelope. A paginated list becomes `data` = the rows
 * with the pagination numbers moved into `meta`, renamed to the
 * brief's own field names; everything else becomes `data` as-is,
 * with no `meta` invented for it.
 */
export function successEnvelope(payload, { method = 'GET', status = 200 } = {}) {
  if (isPage(payload)) {
    const { rows, page, pageSize, total, pageCount, ...rest } = payload;
    return {
      success: true,
      message: DEFAULT_MESSAGE[method] ?? DEFAULT_MESSAGE.GET,
      data: rows,
      meta: {
        currentPage: page,
        pageSize,
        totalRecords: total,
        totalPages: pageCount,
        ...rest,
      },
    };
  }
  return {
    success: true,
    message: status === 201 ? 'Created successfully' : (DEFAULT_MESSAGE[method] ?? DEFAULT_MESSAGE.GET),
    data: payload === undefined ? null : payload,
    meta: {},
  };
}

/**
 * Which stock-layer errors (db/stock.mjs's own, not AppError
 * subclasses -- that module knows nothing about HTTP) are answers
 * rather than faults, and the extra detail each one carries. The
 * single source of truth for this map: the legacy /api error
 * middleware and the v1 one both call errorEnvelope() below, so
 * there is exactly one place this list is written.
 */
const STOCK_REFUSALS = {
  DuplicateMovementError: (e) => ({
    idempotencyKey: e.idempotencyKey,
    resolution: 'This movement is already on the ledger. Nothing further was posted.',
  }),
  InsufficientStockError: (e) => ({
    dimension: e.dimension,
    available: e.available,
    requested: e.requested,
  }),
  StockValidationError: (e) => ({ fields: e.fields }),
};

/**
 * One error, in both shapes this API now speaks: the legacy
 * `{error:{code,message,details}}` every existing screen already
 * parses, and the v1 `{success:false,message,code,errors}` the
 * brief asks for. Always returns both so a single error-handling
 * middleware can pick the one that matches the request without
 * computing anything twice.
 *
 * `errors` is always an array, because the brief's shape is a
 * list and inventing a single-object-vs-array distinction per
 * error type would be one more thing a consumer has to branch on.
 * A validation failure's `fields` becomes that array directly; a
 * refusal that carries one block of detail (duplicate movement,
 * insufficient stock, a near-duplicate to review) becomes a
 * single-element array, so nothing in `details` is ever dropped
 * going from the legacy shape to the new one.
 */
export function errorEnvelope(err) {
  if (err instanceof AppError) {
    const details = err.details;
    return {
      status: err.status,
      legacy: { error: { code: err.code, message: err.message, ...(details ? { details } : {}) } },
      v1: {
        success: false,
        message: err.message,
        code: err.code,
        errors: Array.isArray(details?.fields) ? details.fields : (details ? [details] : []),
      },
    };
  }

  if (STOCK_REFUSALS[err?.name]) {
    const details = STOCK_REFUSALS[err.name](err);
    return {
      status: err.status,
      legacy: { error: { code: err.code, message: err.message, details } },
      v1: {
        success: false,
        message: err.message,
        code: err.code,
        // Same rule as the AppError branch above: a validation
        // failure's own fields array is the errors array, not an
        // extra wrapper around it. StockValidationError is the one
        // STOCK_REFUSALS member that carries `fields` rather than a
        // single block of detail (duplicate key, insufficient
        // stock), so it is the one this applies to.
        errors: Array.isArray(details?.fields) ? details.fields : [details],
      },
    };
  }

  // Anything else is a 500 with a generic message -- a Prisma
  // error carries table and column names, and none of that
  // belongs in a browser response in either shape.
  return {
    status: 500,
    legacy: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. The details are in the server log.' } },
    v1: {
      success: false,
      message: 'Something went wrong. The details are in the server log.',
      code: 'INTERNAL_ERROR',
      errors: [],
    },
  };
}
