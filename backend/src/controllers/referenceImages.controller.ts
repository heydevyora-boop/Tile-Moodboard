import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as referenceImagesService from '@services/referenceImages.service';
import { UploadReferenceImageInput, UpdateReferenceImageInput, ListReferenceImagesQuery } from '@validators/referenceImages.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const uploadReferenceImage = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('No file uploaded — attach an image under field name "file"');
  const input = req.body as UploadReferenceImageInput;
  const image = await referenceImagesService.uploadReferenceImage(req.file, input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { image } });
});

export const listReferenceImages = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListReferenceImagesQuery;
  const { images, meta } = await referenceImagesService.listReferenceImages(query);
  res.status(200).json({ success: true, data: { images }, meta });
});

export const listCategories = catchAsync(async (_req: Request, res: Response) => {
  const categories = await referenceImagesService.listCategories();
  res.status(200).json({ success: true, data: categories });
});

export const getReferenceImage = catchAsync(async (req: Request, res: Response) => {
  const image = await referenceImagesService.getReferenceImage(req.params.id);
  res.status(200).json({ success: true, data: { image } });
});

export const updateReferenceImage = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateReferenceImageInput;
  const image = await referenceImagesService.updateReferenceImage(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { image } });
});

export const replaceReferenceImage = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('No file uploaded — attach an image under field name "file"');
  const image = await referenceImagesService.replaceReferenceImage(req.params.id, req.file, requireActorId(req), req);
  res.status(200).json({ success: true, data: { image } });
});

export const deleteReferenceImage = catchAsync(async (req: Request, res: Response) => {
  await referenceImagesService.deleteReferenceImage(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Reference image deleted' });
});
