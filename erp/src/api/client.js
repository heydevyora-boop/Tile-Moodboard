/* ============================================================
   TALKING TO THE ERP API
   ============================================================
   One place that knows the base URL, how an error comes back and
   how a query string is built. Every screen uses it, so when
   authentication arrives it is added here once.

   The base URL is a build-time variable with a localhost default,
   because the API is not deployed anywhere yet and hard-coding a
   production host it does not have would be a lie.

   STEP 8 moved this onto /api/v1, which answers in the brief's
   {success,message,data,meta} / {success,message,code,errors}
   envelope rather than the bare payload every route used to send
   straight back (see server/utils/response.mjs for why the server
   side speaks both). `unwrapData()` below undoes exactly that
   wrapping, so every one of the 24 screens that already calls
   `api.*` keeps working unchanged: this file is the only place
   that needed to know the envelope exists.
   ============================================================ */

const BASE = import.meta.env.VITE_ERP_API ?? 'http://127.0.0.1:4310/api/v1';

/** An error the UI can actually render, field list and all. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || ('Request failed with status ' + status));
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.code || 'UNKNOWN';
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    /* A field-validation failure's `fields` array IS `errors`
       (server/utils/response.mjs keeps the two in step for exactly
       this reason); anything else is one block of detail sitting
       in errors[0] -- a near-duplicate's candidates among them. */
    this.fields = errors.length && errors[0] && 'field' in errors[0] ? errors : null;
    /** Near-matches, where the server wants a person to decide. */
    this.candidates = errors[0]?.candidates ?? null;
  }
}

/**
 * The v1 envelope, unwrapped back into the plain shape every
 * screen already expects. A paginated list gets its own
 * `{rows, page, pageSize, total, pageCount}` object back exactly
 * as before -- the server only renamed those four fields into
 * `meta` for the trip, and this renames them back -- and anything
 * else is just `data`, since a non-list payload was never wrapped
 * in extra structure to begin with.
 */
function unwrapData(payload) {
  if (!payload || typeof payload !== 'object' || !('success' in payload)) return payload;
  const { data, meta } = payload;
  if (meta && typeof meta.currentPage === 'number') {
    const { currentPage, pageSize, totalRecords, totalPages, ...rest } = meta;
    return { rows: data, page: currentPage, pageSize, total: totalRecords, pageCount: totalPages, ...rest };
  }
  return data;
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
      code: 'API_UNREACHABLE',
      message: 'The ERP API is not responding at ' + BASE
        + '. Start it with: npm run api',
      errors: [],
    });
    err.cause = cause;
    throw err;
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return unwrapData(payload);
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
      return unwrapData(payload);
    },
    inspect: async (file) => {
      const response = await fetch(BASE + '/imports/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-filename': file.name },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, payload);
      return unwrapData(payload);
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

  /* PURCHASE.
     Note which of these move stock and which do not. Creating or
     approving a purchase order moves nothing; recording a
     supplier invoice moves nothing. Only a goods receipt and a
     purchase return touch inventory, and they do it through the
     same stock service every other movement goes through. */
  suppliers: {
    list: (params) => request('/suppliers', { params }),
    options: () => request('/suppliers/options'),
    get: (id) => request('/suppliers/' + id),
    history: (id, params) => request('/suppliers/' + id + '/history', { params }),
    create: (body) => request('/suppliers', { method: 'POST', body }),
    update: (id, body) => request('/suppliers/' + id, { method: 'PATCH', body }),
    // No remove(). A supplier with history cannot be deleted
    // without orphaning it, and the API has no endpoint for it.
    setActive: (id, isActive, reason) =>
      request('/suppliers/' + id + '/active', { method: 'POST', body: { isActive, reason } }),
  },

  purchaseOrders: {
    list: (params) => request('/purchase-orders', { params }),
    get: (id) => request('/purchase-orders/' + id),
    create: (body) => request('/purchase-orders', { method: 'POST', body }),
    update: (id, body) => request('/purchase-orders/' + id, { method: 'PATCH', body }),
    submit: (id) => request('/purchase-orders/' + id + '/submit', { method: 'POST' }),
    approve: (id) => request('/purchase-orders/' + id + '/approve', { method: 'POST' }),
    returnToDraft: (id, reason) =>
      request('/purchase-orders/' + id + '/return-to-draft', { method: 'POST', body: { reason } }),
    cancel: (id, reason) =>
      request('/purchase-orders/' + id + '/cancel', { method: 'POST', body: { reason } }),
    close: (id, reason) =>
      request('/purchase-orders/' + id + '/close', { method: 'POST', body: { reason } }),
    receivable: (id) => request('/purchase-orders/' + id + '/receivable'),
  },

  goodsReceipts: {
    list: (params) => request('/goods-receipts', { params }),
    get: (id) => request('/goods-receipts/' + id),
    // THE ONE CALL IN THE PURCHASE MODULE THAT INCREASES STOCK.
    receive: (body) => request('/goods-receipts', { method: 'POST', body }),
    cancel: (id, reason) =>
      request('/goods-receipts/' + id + '/cancel', { method: 'POST', body: { reason } }),
  },

  purchaseReturns: {
    list: (params) => request('/purchase-returns', { params }),
    get: (id) => request('/purchase-returns/' + id),
    eligibility: (params) => request('/purchase-returns/eligibility', { params }),
    post: (body) => request('/purchase-returns', { method: 'POST', body }),
  },

  supplierInvoices: {
    list: (params) => request('/supplier-invoices', { params }),
    get: (id) => request('/supplier-invoices/' + id),
    create: (body) => request('/supplier-invoices', { method: 'POST', body }),
    setStatus: (id, status, note) =>
      request('/supplier-invoices/' + id + '/status', { method: 'POST', body: { status, note } }),
  },

  purchase: {
    dashboard: (params) => request('/dashboard', { params }),
    history: (params) => request('/history', { params }),
  },

  reference: {
    categories: () => request('/reference/categories'),
    productRules: () => request('/reference/product-rules'),
    warehouses: () => request('/reference/warehouses'),
  },

  /* SALES.
     Note which of these move stock and which do not, the same
     discipline as purchase: a quotation, a sales order, an
     approval and a sales invoice move nothing. Only a reservation
     (the RESERVED dimension, not physical stock), a delivery
     challan (OUTWARD) and a sales return (INWARD/DAMAGE) touch
     inventory, and all three go through the same stock service
     everything else in this ERP does. */
  customers: {
    list: (params) => request('/customers', { params }),
    options: () => request('/customers/options'),
    get: (id) => request('/customers/' + id),
    history: (id, params) => request('/customers/' + id + '/history', { params }),
    create: (body) => request('/customers', { method: 'POST', body }),
    update: (id, body) => request('/customers/' + id, { method: 'PATCH', body }),
    // No remove(). A customer with history cannot be deleted.
    setActive: (id, isActive, reason) =>
      request('/customers/' + id + '/active', { method: 'POST', body: { isActive, reason } }),
  },

  quotations: {
    list: (params) => request('/quotations', { params }),
    get: (id) => request('/quotations/' + id),
    create: (body) => request('/quotations', { method: 'POST', body }),
    update: (id, body) => request('/quotations/' + id, { method: 'PATCH', body }),
    send: (id) => request('/quotations/' + id + '/send', { method: 'POST' }),
    respond: (id, status) => request('/quotations/' + id + '/respond', { method: 'POST', body: { status } }),
    cancel: (id, reason) => request('/quotations/' + id + '/cancel', { method: 'POST', body: { reason } }),
    revise: (id, body) => request('/quotations/' + id + '/revise', { method: 'POST', body }),
    // THE ONE PATH FROM A QUOTE TO AN ORDER. Never automatic.
    convert: (id, warehouseId) =>
      request('/quotations/' + id + '/convert', { method: 'POST', body: { warehouseId: warehouseId || undefined } }),
  },

  salesOrders: {
    list: (params) => request('/sales-orders', { params }),
    get: (id) => request('/sales-orders/' + id),
    create: (body) => request('/sales-orders', { method: 'POST', body }),
    update: (id, body) => request('/sales-orders/' + id, { method: 'PATCH', body }),
    submit: (id) => request('/sales-orders/' + id + '/submit', { method: 'POST' }),
    approve: (id) => request('/sales-orders/' + id + '/approve', { method: 'POST' }),
    returnToDraft: (id, reason) =>
      request('/sales-orders/' + id + '/return-to-draft', { method: 'POST', body: { reason } }),
    cancel: (id, reason) => request('/sales-orders/' + id + '/cancel', { method: 'POST', body: { reason } }),
    close: (id, reason) => request('/sales-orders/' + id + '/close', { method: 'POST', body: { reason } }),

    // STOCK AVAILABILITY & RESERVATION. Reserving moves the
    // RESERVED dimension only -- physical stock is unchanged.
    availability: (id) => request('/sales-orders/' + id + '/availability'),
    reserve: (id, lines, clientKey) =>
      request('/sales-orders/' + id + '/reserve', { method: 'POST', body: { lines, clientKey } }),
    release: (id, lines, clientKey) =>
      request('/sales-orders/' + id + '/release', { method: 'POST', body: { lines, clientKey } }),

    dispatchable: (id) => request('/sales-orders/' + id + '/dispatchable'),
    invoiceable: (id) => request('/sales-orders/' + id + '/invoiceable'),
    returnable: (id) => request('/sales-orders/' + id + '/returnable'),
  },

  deliveryChallans: {
    list: (params) => request('/delivery-challans', { params }),
    get: (id) => request('/delivery-challans/' + id),
    // THE ONE CALL IN THE SALES MODULE THAT DECREASES STOCK.
    dispatch: (body) => request('/delivery-challans', { method: 'POST', body }),
  },

  salesInvoices: {
    list: (params) => request('/sales-invoices', { params }),
    get: (id) => request('/sales-invoices/' + id),
    create: (body) => request('/sales-invoices', { method: 'POST', body }),
    cancel: (id, reason) => request('/sales-invoices/' + id + '/cancel', { method: 'POST', body: { reason } }),
    balance: (id) => request('/sales-invoices/' + id + '/balance'),
  },

  salesReturns: {
    list: (params) => request('/sales-returns', { params }),
    get: (id) => request('/sales-returns/' + id),
    post: (body) => request('/sales-returns', { method: 'POST', body }),
  },

  customerPayments: {
    list: (params) => request('/customer-payments', { params }),
    record: (body) => request('/customer-payments', { method: 'POST', body }),
  },

  sales: {
    dashboard: (params) => request('/sales-dashboard', { params }),
    history: (params) => request('/sales-history', { params }),
  },
};
