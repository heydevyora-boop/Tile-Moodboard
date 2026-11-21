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

  reference: {
    categories: () => request('/reference/categories'),
    productRules: () => request('/reference/product-rules'),
    warehouses: () => request('/reference/warehouses'),
  },
};
