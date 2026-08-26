import { Router } from 'express';
import * as catalogExtractorController from '@controllers/catalogExtractor.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { uploadCatalogPdf } from '@middlewares/upload';
import {
  uploadCatalogSchema,
  listCatalogsQuerySchema,
  listCatalogTilesQuerySchema,
  updateExtractedTileSchema,
} from '@validators/catalogExtractor.validators';

const router = Router();

router.use(authenticate);

router.get('/brands', requirePermission('catalogs:read'), catalogExtractorController.listBrands);

router.post(
  '/upload',
  requirePermission('catalogs:write'),
  uploadCatalogPdf,
  validate(uploadCatalogSchema),
  catalogExtractorController.uploadCatalog,
);

router.get('/catalogs', requirePermission('catalogs:read'), validate(listCatalogsQuerySchema, 'query'), catalogExtractorController.listCatalogs);
router.get('/catalogs/:id', requirePermission('catalogs:read'), catalogExtractorController.getCatalog);
router.get(
  '/catalogs/:id/tiles',
  requirePermission('catalogs:read'),
  validate(listCatalogTilesQuerySchema, 'query'),
  catalogExtractorController.getCatalogTiles,
);
router.post('/catalogs/:id/retry', requirePermission('catalogs:write'), catalogExtractorController.retryExtraction);
router.delete('/catalogs/:id', requirePermission('catalogs:write'), catalogExtractorController.deleteCatalog);

router.patch('/tiles/:tileId', requirePermission('tiles:write'), validate(updateExtractedTileSchema), catalogExtractorController.updateExtractedTile);
router.delete('/tiles/:tileId', requirePermission('tiles:write'), catalogExtractorController.deleteExtractedTile);

export default router;
