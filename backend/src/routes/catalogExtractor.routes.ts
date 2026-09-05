import { Router } from 'express';
import * as catalogExtractorController from '@controllers/catalogExtractor.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { internalAuth } from '@middlewares/internalAuth';
import { validate } from '@middlewares/validate';
import { uploadCatalogPdf } from '@middlewares/upload';
import {
  uploadCatalogSchema,
  listCatalogsQuerySchema,
  listCatalogTilesQuerySchema,
  updateExtractedTileSchema,
  masterTileSyncSchema,
} from '@validators/catalogExtractor.validators';

const router = Router();

// Internal service-to-service route. Declared ABOVE router.use(authenticate)
// deliberately: the Python catalog_processor is a standalone script with no
// login and no JWT, so it authenticates with a shared secret header instead.
// Moving this below the authenticate line would break pen-drive syncing.
router.post('/master-sync', internalAuth, validate(masterTileSyncSchema), catalogExtractorController.syncMasterTile);

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
