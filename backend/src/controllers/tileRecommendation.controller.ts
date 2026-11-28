import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { prisma } from '@db/connection';
import { getRecommendedTiles, listAllTiles, listCatalogTileSizes } from '@services/tileRecommendation.service';
import { getErpStockForSkus } from '@services/erpStock.service';
import { TileRecommendationsQuery, ListTilesQuery, TileStockQuery } from '@validators/tileRecommendation.validators';

export const getRecommendations = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as TileRecommendationsQuery;
  const tiles = await getRecommendedTiles(prisma, query);
  res.status(200).json({ success: true, data: { tiles } });
});

export const listTileSizes = catchAsync(async (_req: Request, res: Response) => {
  const sizes = await listCatalogTileSizes();
  res.status(200).json({ success: true, data: { sizes } });
});

export const listTiles = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListTilesQuery;
  const { tiles, meta } = await listAllTiles(query);
  res.status(200).json({ success: true, data: { tiles }, meta });
});

// Step 10: live ERP stock for a batch of SKUs, never CASA's own
// database -- the caller already has the Tile rows it is about to
// render. Always 200: an unreachable ERP is a normal, reported
// outcome (state: 'unavailable' per SKU), not an HTTP error.
export const getTileStock = catchAsync(async (req: Request, res: Response) => {
  const { skus } = req.query as unknown as TileStockQuery;
  const stock = await getErpStockForSkus(skus);
  res.status(200).json({ success: true, data: { stock } });
});
