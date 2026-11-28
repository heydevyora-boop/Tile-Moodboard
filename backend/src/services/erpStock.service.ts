import {
  fetchErpStockBySkus,
  isErpIntegrationConfigured,
  ErpUnavailableError,
  ErpStockRow,
} from '@services/erpClient.service';
import { logger } from '@utils/logger';

/* ============================================================
   WEBSITE STOCK DISPLAY — READ ONLY, SKU-ONLY
   ============================================================
   Step 10's whole deliverable: for a batch of CASA Tile.productCode
   values, ask the ERP for live stock and report back one of four
   states per SKU -- never a bare true/false, because "we don't
   know" and "the ERP says zero" are different facts a shopper
   should not see as the same thing:

     - available  -- the ERP has this SKU and it has stock right now
     - zero        -- the ERP has this SKU and it has none right now
     - unknown     -- no SKU to ask about, or the ERP has never heard
                      of this one (no ERP counterpart at all)
     - unavailable -- the ERP integration is unconfigured, or this
                      particular call to it failed (down, slow,
                      malformed response) -- a fact about THIS
                      request, not about the product

   NOTHING HERE WRITES TO EITHER DATABASE, and this module never
   reads CASA's own database either -- the caller already has the
   Tile rows it is about to render and already knows their
   productCode; this is purely a pass-through to the ERP, shaped for
   display. Matches by SKU alone (see erpClient.service.ts /
   erp/docs/API_REFERENCE.md §6.14), never by product name.
   ============================================================ */

export type ErpStockState = 'available' | 'zero' | 'unknown' | 'unavailable';

export interface ErpStockInfo {
  state: ErpStockState;
  /** Only set for 'available' / 'zero' -- the ERP's own current
   *  available-to-sell figure (onHand - reserved - damaged). */
  quantity?: number;
}

/**
 * Looks up live ERP stock for a batch of SKUs. Always resolves, one
 * entry per requested string (duplicates collapse to the same
 * entry), keyed exactly as given -- never throws for an ERP problem,
 * so a caller can always render the catalog even when this says
 * nothing useful.
 */
export async function getErpStockForSkus(skus: string[]): Promise<Record<string, ErpStockInfo>> {
  const distinct = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  const result: Record<string, ErpStockInfo> = {};
  if (distinct.length === 0) return result;

  if (!isErpIntegrationConfigured()) {
    for (const sku of distinct) result[sku] = { state: 'unavailable' };
    return result;
  }

  let rows: ErpStockRow[];
  try {
    rows = await fetchErpStockBySkus(distinct);
  } catch (error) {
    if (error instanceof ErpUnavailableError) {
      logger.warn(`ERP stock lookup: ERP unavailable (${error.message})`);
      for (const sku of distinct) result[sku] = { state: 'unavailable' };
      return result;
    }
    // Not an ERP-shaped failure (a bug in this function, say) -- let
    // it surface as a real error rather than quietly reporting
    // "unavailable" for something that was actually this server's
    // own mistake.
    throw error;
  }

  const bySku = new Map(rows.map((r) => [r.sku, r]));
  for (const sku of distinct) {
    const row = bySku.get(sku);
    if (!row || !row.found || !row.totals) {
      result[sku] = { state: 'unknown' };
      continue;
    }
    const { available } = row.totals;
    result[sku] = available > 0 ? { state: 'available', quantity: available } : { state: 'zero', quantity: available };
  }

  return result;
}
