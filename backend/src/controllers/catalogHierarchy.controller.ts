import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import * as brandService from '@services/brand.service';
import * as collectionService from '@services/collection.service';
import * as productService from '@services/product.service';
import {
  CreateCompanyInput,
  UpdateCompanyInput,
  ListCompaniesQuery,
  CreateCollectionInput,
  UpdateCollectionInput,
  ListCollectionsQuery,
  CreateProductInput,
  UpdateProductInput,
  ListProductsQuery,
  AssignVariantInput,
} from '@validators/catalogHierarchy.validators';

/* ============================================================
   COMPANY
   ============================================================ */

export const listCompanies = catchAsync(async (req: Request, res: Response) => {
  const companies = await brandService.listCompanies(req.query as unknown as ListCompaniesQuery);
  res.status(200).json({ success: true, data: { companies } });
});

export const getCompany = catchAsync(async (req: Request, res: Response) => {
  const company = await brandService.getCompanyById(req.params.id);
  res.status(200).json({ success: true, data: { company } });
});

export const createCompany = catchAsync(async (req: Request, res: Response) => {
  const company = await brandService.createCompany(req.body as CreateCompanyInput);
  res.status(201).json({ success: true, data: { company } });
});

export const updateCompany = catchAsync(async (req: Request, res: Response) => {
  const company = await brandService.updateCompany(req.params.id, req.body as UpdateCompanyInput);
  res.status(200).json({ success: true, data: { company } });
});

/* ============================================================
   COLLECTION
   ============================================================ */

export const listCollections = catchAsync(async (req: Request, res: Response) => {
  const { collections, meta } = await collectionService.listCollections(req.query as unknown as ListCollectionsQuery);
  res.status(200).json({ success: true, data: { collections }, meta });
});

export const getCollection = catchAsync(async (req: Request, res: Response) => {
  const collection = await collectionService.getCollectionById(req.params.id);
  res.status(200).json({ success: true, data: { collection } });
});

export const createCollection = catchAsync(async (req: Request, res: Response) => {
  const collection = await collectionService.createCollection(req.body as CreateCollectionInput);
  res.status(201).json({ success: true, data: { collection } });
});

export const updateCollection = catchAsync(async (req: Request, res: Response) => {
  const collection = await collectionService.updateCollection(req.params.id, req.body as UpdateCollectionInput);
  res.status(200).json({ success: true, data: { collection } });
});

/* ============================================================
   PRODUCT
   ============================================================ */

export const listProducts = catchAsync(async (req: Request, res: Response) => {
  const { products, meta } = await productService.listProducts(req.query as unknown as ListProductsQuery);
  res.status(200).json({ success: true, data: { products }, meta });
});

export const getProduct = catchAsync(async (req: Request, res: Response) => {
  const product = await productService.getProductById(req.params.id);
  res.status(200).json({ success: true, data: { product } });
});

export const createProduct = catchAsync(async (req: Request, res: Response) => {
  const product = await productService.createProduct(req.body as CreateProductInput);
  res.status(201).json({ success: true, data: { product } });
});

export const updateProduct = catchAsync(async (req: Request, res: Response) => {
  const product = await productService.updateProduct(req.params.id, req.body as UpdateProductInput);
  res.status(200).json({ success: true, data: { product } });
});

export const resolveVariant = catchAsync(async (req: Request, res: Response) => {
  const { finish, size } = req.query as { finish?: string; size?: string };
  if (!finish || !size) {
    res.status(200).json({ success: true, data: { tile: null } });
    return;
  }
  const tile = await productService.resolveVariant(req.params.id, finish, size);
  res.status(200).json({ success: true, data: { tile } });
});

export const assignVariant = catchAsync(async (req: Request, res: Response) => {
  const { tileId } = req.body as AssignVariantInput;
  const tile = await productService.assignVariant(req.params.id, tileId);
  res.status(200).json({ success: true, data: { tile } });
});

export const unassignVariant = catchAsync(async (req: Request, res: Response) => {
  const tile = await productService.unassignVariant(req.params.id, req.params.tileId);
  res.status(200).json({ success: true, data: { tile } });
});
