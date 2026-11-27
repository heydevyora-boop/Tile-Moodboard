import { Router } from 'express';
import * as controller from '@controllers/catalogHierarchy.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuerySchema,
  createCollectionSchema,
  updateCollectionSchema,
  listCollectionsQuerySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  assignVariantSchema,
} from '@validators/catalogHierarchy.validators';

/* ============================================================
   Companies, Collections and Products -- the catalog hierarchy
   above Tile. Browsing (GET) uses tiles:read, the same permission
   the rest of the catalog browsing surface already requires.
   Creating/editing uses catalogs:write, matching the existing
   Brand/Catalog admin surface in catalogExtractor.routes.ts.
   ============================================================ */

export const companiesRouter = Router();
companiesRouter.use(authenticate);
companiesRouter.get('/', requirePermission('tiles:read'), validate(listCompaniesQuerySchema, 'query'), controller.listCompanies);
companiesRouter.post('/', requirePermission('catalogs:write'), validate(createCompanySchema), controller.createCompany);
companiesRouter.get('/:id', requirePermission('tiles:read'), controller.getCompany);
companiesRouter.patch('/:id', requirePermission('catalogs:write'), validate(updateCompanySchema), controller.updateCompany);

export const collectionsRouter = Router();
collectionsRouter.use(authenticate);
collectionsRouter.get('/', requirePermission('tiles:read'), validate(listCollectionsQuerySchema, 'query'), controller.listCollections);
collectionsRouter.post('/', requirePermission('catalogs:write'), validate(createCollectionSchema), controller.createCollection);
collectionsRouter.get('/:id', requirePermission('tiles:read'), controller.getCollection);
collectionsRouter.patch('/:id', requirePermission('catalogs:write'), validate(updateCollectionSchema), controller.updateCollection);

export const productsRouter = Router();
productsRouter.use(authenticate);
productsRouter.get('/', requirePermission('tiles:read'), validate(listProductsQuerySchema, 'query'), controller.listProducts);
productsRouter.post('/', requirePermission('catalogs:write'), validate(createProductSchema), controller.createProduct);
productsRouter.get('/:id', requirePermission('tiles:read'), controller.getProduct);
productsRouter.patch('/:id', requirePermission('catalogs:write'), validate(updateProductSchema), controller.updateProduct);
productsRouter.get('/:id/resolve-variant', requirePermission('tiles:read'), controller.resolveVariant);
productsRouter.post('/:id/variants', requirePermission('catalogs:write'), validate(assignVariantSchema), controller.assignVariant);
productsRouter.delete('/:id/variants/:tileId', requirePermission('catalogs:write'), controller.unassignVariant);
