import { config } from '@config/index';
import { logger } from '@utils/logger';

/* ============================================================
   READING FROM THE ERP — SERVER-SIDE ONLY
   ============================================================
   Step 9: this backend consuming company/collection/product-line/
   product/inventory data FROM the ERP's own /api/v1, through its
   dedicated /integrations/casa/catalog-feed route (gated by a
   shared secret, the mirror of this backend's own erpAuth.ts —
   see erp/server/middleware/casaAuth.mjs).

   Nothing here ever runs in, or sends anything to, the browser.
   The base URL and the shared secret live only in this server's
   own environment (ERP_API_BASE_URL, ERP_INTEGRATION_API_KEY); no
   route in this backend echoes either one back in a response, and
   no frontend code imports this file — grep for 'erpClient' outside
   src/services and src/routes/controllers finds nothing.

   EVERY CALL CAN FAIL SAFELY. The ERP is a separate service, on a
   separate database, that can be down, slow, or simply not
   configured in this environment. Nothing here throws an
   unexpected exception for that — every failure becomes an
   ErpUnavailableError, a known, operational outcome a caller
   decides what to do with (see catalogErpPreview.service.ts for
   the one caller this step adds).
   ============================================================ */

export class ErpUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ErpUnavailableError';
  }
}

export interface ErpVariant {
  id: string;
  sku: string;
  finish: string | null;
  size: string | null;
  colour: string | null;
  status: string;
  inventory: {
    onHand: number;
    reserved: number;
    damaged: number;
    inTransit: number;
    available: number;
  };
}

export interface ErpCatalogFeedRow {
  company: { id: string; name: string };
  collection: { id: string; name: string } | null;
  productLine: {
    id: string;
    code: string | null;
    name: string;
    description: string | null;
    imageUrl: string | null;
  };
  variants: ErpVariant[];
}

export interface ErpCatalogFeedMeta {
  currentPage: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  version: string;
}

export interface ErpCatalogFeedPage {
  data: ErpCatalogFeedRow[];
  meta: ErpCatalogFeedMeta;
}

/** True once ERP_INTEGRATION_API_KEY is set. Checked before ever
 *  sending a request — an unconfigured integration reports
 *  unavailable, it does not call out unauthenticated. */
export function isErpIntegrationConfigured(): boolean {
  return Boolean(config.erpIntegration.apiKey);
}

/**
 * One page of the ERP's catalog feed.
 *
 * Retries exactly once, and only for a genuine network-level
 * failure (connection refused, DNS, timeout) — never for an HTTP
 * error response, which is a deterministic answer from the ERP
 * that retrying cannot change.
 */
export async function fetchErpCatalogFeedPage(params: {
  page?: number;
  pageSize?: number;
  brandId?: string;
  collectionId?: string;
} = {}): Promise<ErpCatalogFeedPage> {
  if (!isErpIntegrationConfigured()) {
    throw new ErpUnavailableError(
      'The ERP integration is not configured on this server (ERP_INTEGRATION_API_KEY is unset).',
    );
  }

  const url = new URL(`${config.erpIntegration.baseUrl}/integrations/casa/catalog-feed`);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.pageSize) url.searchParams.set('pageSize', String(params.pageSize));
  if (params.brandId) url.searchParams.set('brandId', params.brandId);
  if (params.collectionId) url.searchParams.set('collectionId', params.collectionId);

  let lastNetworkError: unknown;
  let response: Response | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-casa-key': config.erpIntegration.apiKey as string,
        },
        signal: AbortSignal.timeout(config.erpIntegration.timeoutMs),
      });
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt === 1) {
        logger.warn(`ERP catalog feed: attempt 1 failed (${error instanceof Error ? error.message : String(error)}), retrying once`);
      }
    }
  }

  if (!response) {
    throw new ErpUnavailableError(
      `Unable to connect to the ERP at ${config.erpIntegration.baseUrl}: `
      + `${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
      lastNetworkError,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ErpUnavailableError(
      `The ERP returned a non-JSON response (HTTP ${response.status}).`,
      error,
    );
  }

  if (!response.ok) {
    const message = (body as { message?: string } | null)?.message;
    throw new ErpUnavailableError(
      `The ERP refused the request${message ? `: ${message}` : ''} (HTTP ${response.status}).`,
    );
  }

  const envelope = body as { success?: boolean; data?: unknown; meta?: unknown } | null;
  if (
    !envelope
    || envelope.success !== true
    || !Array.isArray(envelope.data)
    || typeof envelope.meta !== 'object'
    || envelope.meta === null
  ) {
    throw new ErpUnavailableError(
      'The ERP returned a response that does not match the expected catalog-feed shape.',
    );
  }

  return {
    data: envelope.data as ErpCatalogFeedRow[],
    meta: envelope.meta as ErpCatalogFeedMeta,
  };
}

/**
 * The entire feed, one bounded loop of pages — for a one-shot
 * report, not a live display. `maxPages` is a hard safety cap, not
 * a tuning knob to raise casually: at the default page size this
 * already covers 5,000 product lines, far beyond CASA's current
 * catalogue.
 */
export async function fetchEntireErpCatalogFeed(params: {
  brandId?: string;
  collectionId?: string;
  maxPages?: number;
} = {}): Promise<{ rows: ErpCatalogFeedRow[]; pagesRead: number; truncated: boolean }> {
  const maxPages = params.maxPages ?? 50;
  const rows: ErpCatalogFeedRow[] = [];
  let page = 1;
  let totalPages = 1;

  for (; page <= maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await fetchErpCatalogFeedPage({
      page, pageSize: 100, brandId: params.brandId, collectionId: params.collectionId,
    });
    rows.push(...result.data);
    totalPages = result.meta.totalPages;
    if (page >= totalPages) break;
  }

  return { rows, pagesRead: Math.min(page, totalPages), truncated: totalPages > maxPages };
}
