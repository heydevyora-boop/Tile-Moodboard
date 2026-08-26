import { Router } from 'express';
import * as referenceImagesController from '@controllers/referenceImages.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { uploadReferenceImage } from '@middlewares/uploadReferenceImage';
import {
  uploadReferenceImageSchema,
  updateReferenceImageSchema,
  listReferenceImagesQuerySchema,
} from '@validators/referenceImages.validators';

const router = Router();

router.use(authenticate);

router.get('/categories', requirePermission('reference_images:read'), referenceImagesController.listCategories);

router.get('/', requirePermission('reference_images:read'), validate(listReferenceImagesQuerySchema, 'query'), referenceImagesController.listReferenceImages);
router.post(
  '/',
  requirePermission('reference_images:write'),
  uploadReferenceImage,
  validate(uploadReferenceImageSchema),
  referenceImagesController.uploadReferenceImage,
);

router.get('/:id', requirePermission('reference_images:read'), referenceImagesController.getReferenceImage);
router.patch('/:id', requirePermission('reference_images:write'), validate(updateReferenceImageSchema), referenceImagesController.updateReferenceImage);
router.put('/:id/image', requirePermission('reference_images:write'), uploadReferenceImage, referenceImagesController.replaceReferenceImage);
router.delete('/:id', requirePermission('reference_images:write'), referenceImagesController.deleteReferenceImage);

export default router;
