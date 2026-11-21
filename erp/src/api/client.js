/* ============================================================
   TALKING TO THE ERP API
   ============================================================
   One place that knows the base URL, how an error comes back and
   how a query string is built. Every screen uses it, so when
   authentication arrives it is added here once.

   The base URL is a build-time variable with a localhost default,
   because the API is not deployed anywhere yet and hard-coding a
   production host it does not have would be a lie.
   ============================================================ */

const BASE = import.meta.env.VITE_ERP_API ?? 'http://127.0.0.1:4310/api';

/** An error the UI can actually render, field list and all. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || ('Request failed with status ' + status));
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code || 'UNKNOWN';
    /** [{ field, message }] where the server named the fields. */
    this.fields = payload?.error?.details?.fields ?? null;
    /** Near-matches, where the server wants a person to decide. */
    this.candidates = payload?.error?.details?.candidates ?? null;
  }
}

/** Only the parameters that have a value; blank filters are absent. */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? '?' + s : '';
}

async function request(path, { method = 'GET', body, params } = {}) {
  let response;
  try {
    response = await fetch(BASE + path + qs(params), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    /* A failed fetch is almost always "the API is not running",
       and saying so beats "Failed to fetch" -- which sends people
       looking at their network. */
    const err = new ApiError(0, {
      error: {
        code: 'API_UNREACHABLE',
        message: 'The ERP API is not responding at ' + BASE
          + '. Start it with: npm run api',
      },
    });
    err.cause = cause;
    throw err;
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const api = {
  health: () => request('/health'),

  products: {
    list: (params) => request('/products', { params }),
    filterOptions: () => request('/products/filter-options'),
    get: (id) => request('/products/' + id),
    stock: (id) => request('/products/' + id + '/stock'),
    create: (body) => request('/products', { method: 'POST', body }),
    update: (id, body) => request('/products/' + id, { method: 'PATCH', body }),
    setStatus: (id, status, reason) =>
      request('/products/' + id + '/status', { method: 'POST', body: { status, reason } }),
    archive: (id, reason) => request('/products/' + id + '/archive', { method: 'POST', body: { reason } }),
    restore: (id) => request('/products/' + id + '/restore', { method: 'POST' }),
  },

  brands: {
    list: (params) => request('/brands', { params }),
    get: (id) => request('/brands/' + id),
    similar: (name) => request('/brands/similar', { params: { name } }),
    create: (body) => request('/brands', { method: 'POST', body }),
    update: (id, body) => request('/brands/' + id, { method: 'PATCH', body }),
    activate: (id) => request('/brands/' + id + '/activate', { method: 'POST' }),
    deactivate: (id) => request('/brands/' + id + '/deactivate', { method: 'POST' }),
  },

  productHeads: {
    list: (params) => request('/product-heads', { params }),
    get: (id) => request('/product-heads/' + id),
    similar: (params) => request('/product-heads/similar', { params }),
    create: (body) => request('/product-heads', { method: 'POST', body }),
    update: (id, body) => request('/product-heads/' + id, { method: 'PATCH', body }),
  },

  imports: {
    sources: () => request('/imports/sources'),
    /* The file goes up as raw bytes with its name in a header.
       No multipart, so no boundary parsing and no extra library
       to keep patched. */
    upload: async (file, sheet) => {
      const response = await fetch(BASE + '/imports/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-filename': file.name,
          ...(sheet ? { 'x-sheet': sheet } : {}),
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, payload);
      return payload;
    },
    inspect: async (file) => {
      const response = await fetch(BASE + '/imports/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-filename': file.name },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, payload);
      return payload;
    },
    batches: (params) => request('/imports/batches', { params }),
    batch: (id) => request('/imports/batches/' + id),
    preview: (id, params) => request('/imports/batches/' + id + '/preview', { params }),
    confirm: (id, body) => request('/imports/batches/' + id + '/confirm', { method: 'POST', body: body ?? {} }),
    retry: (id) => request('/imports/batches/' + id + '/retry', { method: 'POST' }),
    errorReportUrl: (id) => BASE + '/imports/batches/' + id + '/errors.csv',
  },

  /* INVENTORY.
     Every write here is a POST that posts a movement. There is no
     PATCH and no DELETE on a stock figure, because there is no
     such thing: a balance is the sum of its ledger, and the only
     way to change it is to add a movement. A correction is an
     adjustment with a reason on it. */
  inventory: {
    list: (params) => request('/inventory', { params }),
    totals: () => request('/inventory/totals'),
    dashboard: () => request('/inventory/dashboard'),
    ledger: (params) => request('/inventory/ledger', { params }),
    reconciliation: () => request('/inventory/reconciliation'),

    opening: (body) => request('/inventory/opening', { method: 'POST', body }),
    inward: (body) => request('/inventory/inward', { method: 'POST', body }),
    outward: (body) => request('/inventory/outward', { method: 'POST', body }),
    adjust: (body) => request('/inventory/adjustments', { method: 'POST', body }),
    reserve: (body) => request('/inventory/reservations', { method: 'POST', body }),
    release: (body) => request('/inventory/reservations/release', { method: 'POST', body }),
    markDamaged: (body) => request('/inventory/damage', { method: 'POST', body }),
    recoverDamaged: (body) => request('/inventory/damage/recover', { method: 'POST', body }),
    /* Not a delete. The opposite movement, linked to the one it
       corrects, so the stock card shows both. */
    reverse: (entryId, remarks) =>
      request('/inventory/ledger/reverse', { method: 'POST', body: { entryId, remarks } }),
  },

  warehouses: {
    list: (params) => request('/warehouses', { params }),
    get: (id) => request('/warehouses/' + id),
    stock: (id, params) => request('/warehouses/' + id + '/stock', { params }),
    create: (body) => request('/warehouses', { method: 'POST', body }),
    update: (id, body) => request('/warehouses/' + id, { method: 'PATCH', body }),
    /* Activate and deactivate. There is deliberately no remove: a
       warehouse with stock history cannot be deleted without
       orphaning the entries that explain where the stock went. */
    setActive: (id, isActive, reason) =>
      request('/warehouses/' + id + '/active', { method: 'POST', body: { isActive, reason } }),

    transfers: (params) => request('/warehouses/transfers', { params }),
    transfer: (id) => request('/warehouses/transfers/' + id),
    createTransfer: (body) => request('/warehouses/transfers', { method: 'POST', body }),
    dispatch: (id) => request('/warehouses/transfers/' + id + '/dispatch', { method: 'POST' }),
    receive: (id) => request('/warehouses/transfers/' + id + '/receive', { method: 'POST' }),
    cancelTransfer: (id, reason) =>
      request('/warehouses/transfers/' + id + '/cancel', { method: 'POST', body: { reason } }),
  },

  reference: {
    categories: () => request('/reference/categories'),
    productRules: () => request('/reference/product-rules'),
    warehouses: () => request('/reference/warehouses'),
  },
};
