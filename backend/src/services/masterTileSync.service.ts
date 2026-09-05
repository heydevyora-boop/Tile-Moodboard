import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { resolveBrand } from './brand.service';
import { logActivity } from './activityLog.service';
import { MasterTileSyncInput } from '@validators/catalogExtractor.validators';

/**
 * Bridges a product extracted from a pen drive into the Tile table.
 *
 * Why this exists: the Python catalog_processor writes extracted
 * products to the Google Sheets MASTER tab and Drive only — it has no
 * Postgres client at all. Combination generation, meanwhile, reads
 * exclusively from the Tile table (promptBuilder.service.getAvailableTiles
 * -> tileRecommendation.service.getRecommendedTiles -> prisma.tile.findMany).
 * Without this endpoint the two halves never meet, so combinations can
 * only ever be built from UI-uploaded catalogs.
 *
 * sheetRowRef is the provenance marker. It is written ONLY here — the
 * UI-upload insert path (catalogExtractor.service.ts) never sets it — so
 * a non-null sheetRowRef reliably means "this tile came from the MASTER
 * sheet". getRecommendedTiles uses that to keep MASTER tiles selectable
 * even though they have no Catalog row.
 */
export async function syncMasterTile(input: MasterTileSyncInput, req?: Request) {
  const brand = await resolveBrand({ brandName: input.brandName });
  if (!brand) throw AppError.badRequest('Could not resolve a brand for this product');

  // MASTER rows are written before classification, so productName is
  // often blank at extraction time — fall back to the product code so
  // the tile is still identifiable in the UI instead of being nameless.
  const name = input.productName?.trim() || input.productCode;

  // findFirst rather than findUnique deliberately: productCode carries a
  // @unique constraint in some deployments but not others, and findUnique
  // only compiles against the former. findFirst behaves identically here
  // (extraction syncs one product at a time, sequentially) while working
  // against either schema.
  const existing = await prisma.tile.findFirst({ where: { productCode: input.productCode } });

  const data = {
    name,
    brandId: brand.id,
    size: input.size ?? undefined,
    finish: input.finish ?? undefined,
    type: (input.type ?? 'BASE') as never,
    colorTone: input.colorTone ?? undefined,
    bestRoom: input.bestRoom ?? undefined,
    collection: input.collection ?? undefined,
    imageUrl: input.imageUrl ?? undefined,
    // 0 means "from MASTER, exact row unknown" — the extraction script
    // appends rows without reading back the row number. What matters
    // downstream is only that it is non-null.
    sheetRowRef: input.sheetRowRef ?? 0,
  };

  const tile = existing
    ? await prisma.tile.update({ where: { id: existing.id }, data })
    : await prisma.tile.create({ data: { ...data, productCode: input.productCode } });

  await logActivity({
    action: existing ? 'tile.master_synced.updated' : 'tile.master_synced.created',
    entityType: 'Tile',
    entityId: tile.id,
    metadata: { productCode: input.productCode, brandName: input.brandName, source: 'MASTER_SHEET' },
    req,
  });

  return { tile, created: !existing };
}
