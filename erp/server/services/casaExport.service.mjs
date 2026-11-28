import * as productLines from './productLine.service.mjs';
import { productLineStock } from './inventory.service.mjs';

/* ============================================================
   THE ONE FEED CASA PULLS FROM THE ERP
   ============================================================
   The mirror of erpExport.service.ts on the CASA side: one
   standardized, paginated feed, built from the SAME data every
   other reader of this API sees -- productLine.service.mjs's own
   list() for the hierarchy, inventory.service.mjs's own
   productLineStock() for the numbers -- never a second, parallel
   query written just for this endpoint.

   Paginated over PRODUCT LINES (the "Product" level), each row
   carrying its company (Brand) and collection context plus every
   finish/size variant beneath it and that variant's own live
   stock totals, summed from the same InventoryBalance rows the
   whole ledger reads. Nothing is pre-computed or cached here:
   calling this twice in a row can answer differently, because the
   stock actually changed.

   This is read-only, exactly like erpExport.service.ts's feed: it
   writes nothing, to either database, and connects to nothing but
   this one process's own Postgres connection pool.
   ============================================================ */

/** Bump whenever a field is added, removed, renamed, or a rule's
 *  meaning changes in a way CASA would need to react to. */
const CASA_CATALOG_FEED_VERSION = '1';

export async function getCasaCatalogFeed({ page = 1, pageSize = 50, brandId, collectionId } = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
  const linesPage = await productLines.list({
    brandId, collectionId, isActive: true,
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
  });

  const data = await Promise.all(linesPage.rows.map(async (row) => {
    // One more read per row, same as the Inventory screen's own
    // drill-down does for a single product -- acceptable at this
    // feed's scale (bounded by pageSize, same as every other list
    // endpoint in this API), and the one place this feed's numbers
    // come from, rather than a second aggregate written for it.
    const detail = await productLineStock(row.id);

    return {
      company: { id: detail.productLine.brand.id, name: detail.productLine.brand.name },
      collection: detail.productLine.collection
        ? { id: detail.productLine.collection.id, name: detail.productLine.collection.name }
        : null,
      productLine: {
        id: detail.productLine.id,
        code: row.code,
        name: detail.productLine.name,
        description: row.description,
        imageUrl: row.imageUrl,
      },
      variants: detail.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        finish: v.finish,
        size: v.size,
        colour: v.colour,
        status: v.status,
        inventory: {
          onHand: v.totals.physical,
          reserved: v.totals.reserved,
          damaged: v.totals.damaged,
          inTransit: v.totals.inTransit,
          available: v.totals.available,
        },
      })),
    };
  }));

  // Shaped exactly like every other list endpoint in this API
  // (`{rows, page, pageSize, total, pageCount, ...rest}`), so the
  // existing v1 envelope middleware recognises it structurally and
  // moves the pagination fields into `meta` for free -- `version`
  // survives into `meta` through that same `...rest` spread,
  // the same way CASA's own feed carries its `reconciliation`
  // block.
  return {
    rows: data,
    page: linesPage.page,
    pageSize: linesPage.pageSize,
    total: linesPage.total,
    pageCount: linesPage.pageCount,
    version: CASA_CATALOG_FEED_VERSION,
  };
}
