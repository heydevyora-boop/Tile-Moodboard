import { prisma } from '@db/connection';
import {
  fetchEntireErpCatalogFeed,
  isErpIntegrationConfigured,
  ErpUnavailableError,
  ErpCatalogFeedRow,
} from '@services/erpClient.service';
import { logger } from '@utils/logger';

/* ============================================================
   MAPPING ERP DATA ONTO CASA'S CATALOG SHAPE — READ ONLY
   ============================================================
   Step 9's whole deliverable: pull the ERP's company/collection/
   product-line/product/inventory feed, map each row onto what the
   equivalent would look like in CASA's own Brand/Collection/
   Product/Tile hierarchy, and compare it against what is actually
   in CASA's database today.

   NOTHING HERE WRITES TO EITHER DATABASE. This is explicitly out
   of scope for this step: no website stock display, no live
   production migration (the brief's own words). What this produces
   is a report a person reads — how many ERP variants already have
   a matching CASA SKU, how many do not, how many CASA tiles have
   no ERP counterpart — the foundation a LATER, separately-approved
   step would act on, the same relationship
   docs/ERP_SYNC_CONTRACT.md already documents for the opposite
   direction (ERP consuming CASA's feed).

   The matching key is Tile.productCode / the ERP variant's own
   sku, compared case-insensitively — the same caveat
   docs/ERP_SYNC_CONTRACT.md §3 already states about this exact
   field for the other direction, applied here too.
   ============================================================ */

export interface ErpCatalogPreviewMatch {
  erpSku: string;
  erpVariantId: string;
  casaTileId: string;
  casaTileName: string;
}

export interface ErpCatalogPreviewUnmatchedErpVariant {
  sku: string;
  erpVariantId: string;
  company: string;
  productLine: string;
  finish: string | null;
  size: string | null;
}

export interface ErpCatalogPreviewOrphanCasaTile {
  tileId: string;
  tileName: string;
  productCode: string;
}

export interface ErpCatalogPreviewReport {
  erpReachable: boolean;
  /** Set only when erpReachable is false — never a stack trace, a
   *  single sentence a person can act on. */
  erpUnavailableReason?: string;
  erp?: {
    pagesRead: number;
    truncated: boolean;
    companies: number;
    collections: number;
    productLines: number;
    variants: number;
  };
  casa?: {
    tilesWithProductCode: number;
  };
  matches?: {
    count: number;
    sample: ErpCatalogPreviewMatch[];
  };
  unmatchedErpVariants?: {
    count: number;
    sample: ErpCatalogPreviewUnmatchedErpVariant[];
  };
  orphanCasaTiles?: {
    count: number;
    sample: ErpCatalogPreviewOrphanCasaTile[];
  };
}

const SAMPLE_LIMIT = 25;

function distinctCount<T, K>(rows: T[], keyOf: (row: T) => K): number {
  return new Set(rows.map(keyOf)).size;
}

/**
 * The read-only reconciliation report: pulls the ERP's full feed
 * (bounded, see erpClient.service.ts), reads CASA's own tiles with
 * a product code, and reports where they do and do not agree.
 *
 * Never throws for an ERP problem — a down, slow, or unconfigured
 * ERP is a normal, expected outcome this function reports through
 * `erpReachable: false`, not an exception a caller has to catch.
 * An unexpected failure reading CASA's OWN database is still a real
 * throw: that is this server's own data, and masking a failure to
 * read it would be the wrong kind of "safe".
 */
export async function getErpCatalogPreview(params: {
  brandId?: string;
  collectionId?: string;
} = {}): Promise<ErpCatalogPreviewReport> {
  if (!isErpIntegrationConfigured()) {
    return {
      erpReachable: false,
      erpUnavailableReason: 'The ERP integration is not configured on this server (ERP_INTEGRATION_API_KEY is unset).',
    };
  }

  let erpRows: ErpCatalogFeedRow[];
  let pagesRead: number;
  let truncated: boolean;
  try {
    const feed = await fetchEntireErpCatalogFeed({ brandId: params.brandId, collectionId: params.collectionId });
    erpRows = feed.rows;
    pagesRead = feed.pagesRead;
    truncated = feed.truncated;
  } catch (error) {
    if (error instanceof ErpUnavailableError) {
      logger.warn(`ERP catalog preview: ERP unavailable (${error.message})`);
      return { erpReachable: false, erpUnavailableReason: error.message };
    }
    // Not an ERP-shaped failure (a bug in this function, say) --
    // let it surface as a real error rather than quietly reporting
    // "unavailable" for something that was actually this server's
    // own mistake.
    throw error;
  }

  const erpVariants = erpRows.flatMap((row) => row.variants.map((variant) => ({ row, variant })));

  // CASA's own data, read once. Only tiles that already carry a
  // product code are candidates for matching -- one with none
  // cannot be compared against anything by SKU.
  const casaTiles = await prisma.tile.findMany({
    where: { productCode: { not: null } },
    select: { id: true, name: true, productCode: true },
  });

  const casaByCode = new Map<string, { id: string; name: string; productCode: string }>();
  for (const tile of casaTiles) {
    if (tile.productCode) casaByCode.set(tile.productCode.toUpperCase(), { id: tile.id, name: tile.name, productCode: tile.productCode });
  }

  const matches: ErpCatalogPreviewMatch[] = [];
  const unmatched: ErpCatalogPreviewUnmatchedErpVariant[] = [];
  const matchedCasaIds = new Set<string>();
  let matchedErpVariantCount = 0;

  for (const { row, variant } of erpVariants) {
    const casaTile = variant.sku ? casaByCode.get(variant.sku.toUpperCase()) : undefined;
    if (casaTile) {
      matchedErpVariantCount += 1;
      matchedCasaIds.add(casaTile.id);
      if (matches.length < SAMPLE_LIMIT) {
        matches.push({
          erpSku: variant.sku, erpVariantId: variant.id, casaTileId: casaTile.id, casaTileName: casaTile.name,
        });
      }
    } else if (unmatched.length < SAMPLE_LIMIT) {
      unmatched.push({
        sku: variant.sku, erpVariantId: variant.id,
        company: row.company.name, productLine: row.productLine.name,
        finish: variant.finish, size: variant.size,
      });
    }
  }

  const orphanTiles = casaTiles.filter((t) => !matchedCasaIds.has(t.id));

  return {
    erpReachable: true,
    erp: {
      pagesRead,
      truncated,
      companies: distinctCount(erpRows, (r) => r.company.id),
      collections: distinctCount(erpRows.filter((r) => r.collection), (r) => r.collection!.id),
      productLines: distinctCount(erpRows, (r) => r.productLine.id),
      variants: erpVariants.length,
    },
    casa: {
      tilesWithProductCode: casaTiles.length,
    },
    matches: {
      count: matchedErpVariantCount,
      sample: matches,
    },
    unmatchedErpVariants: {
      count: erpVariants.length - matchedErpVariantCount,
      sample: unmatched,
    },
    orphanCasaTiles: {
      count: orphanTiles.length,
      sample: orphanTiles.slice(0, SAMPLE_LIMIT).map((t) => ({
        tileId: t.id, tileName: t.name, productCode: t.productCode as string,
      })),
    },
  };
}
