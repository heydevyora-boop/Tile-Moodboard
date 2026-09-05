import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as catalogExtractorService from '@services/catalogExtractor.service';
import * as brandService from '@services/brand.service';
import * as masterTileSyncService from '@services/masterTileSync.service';
import {
  UploadCatalogInput,
  ListCatalogsQuery,
  ListCatalogTilesQuery,
  UpdateExtractedTileInput,
  MasterTileSyncInput,
} from '@validators/catalogExtractor.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const listBrands = catchAsync(async (_req: Request, res: Response) => {
  const brands = await brandService.listBrands();
  res.status(200).json({ success: true, data: { brands } });
});

export const uploadCatalog = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('No file uploaded — attach a PDF under field name "file"');

  const input = req.body as UploadCatalogInput;
  const catalog = await catalogExtractorService.uploadAndCreateCatalog(req.file, input, requireActorId(req), req);

  res.status(202).json({ success: true, data: { catalog }, message: 'Upload received — extraction started in the background' });
});

export const listCatalogs = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListCatalogsQuery;
  const { catalogs, meta } = await catalogExtractorService.listCatalogs(query);
  res.status(200).json({ success: true, data: { catalogs }, meta });
});

export const getCatalog = catchAsync(async (req: Request, res: Response) => {
  const catalog = await catalogExtractorService.getCatalogById(req.params.id);
  res.status(200).json({ success: true, data: { catalog } });
});

export const getCatalogTiles = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListCatalogTilesQuery;
  const { tiles, meta } = await catalogExtractorService.getCatalogTiles(req.params.id, query);
  res.status(200).json({ success: true, data: { tiles }, meta });
});

export const retryExtraction = catchAsync(async (req: Request, res: Response) => {
  const catalog = await catalogExtractorService.retryExtraction(req.params.id, requireActorId(req), req);
  res.status(202).json({ success: true, data: { catalog }, message: 'Retry started' });
});

export const deleteCatalog = catchAsync(async (req: Request, res: Response) => {
  const deleteTiles = req.query.deleteTiles === 'true';
  await catalogExtractorService.deleteCatalog(req.params.id, deleteTiles, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Catalog deleted' });
});

export const updateExtractedTile = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateExtractedTileInput;
  const tile = await catalogExtractorService.updateExtractedTile(req.params.tileId, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { tile } });
});

export const deleteExtractedTile = catchAsync(async (req: Request, res: Response) => {
  await catalogExtractorService.deleteExtractedTile(req.params.tileId, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Tile deleted' });
});

/**
 * Internal, service-to-service only (x-internal-key, no user session).
 * Called once per product by the Python catalog_processor right after it
 * appends that product to the Google Sheets MASTER tab.
 */
export const syncMasterTile = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as MasterTileSyncInput;
  const { tile, created } = await masterTileSyncService.syncMasterTile(input, req);

  res.status(created ? 201 : 200).json({
    success: true,
    data: { tile: { id: tile.id, productCode: tile.productCode, name: tile.name, brandId: tile.brandId, imageUrl: tile.imageUrl } },
    message: created ? 'Tile created from MASTER' : 'Tile updated from MASTER',
  });
});
