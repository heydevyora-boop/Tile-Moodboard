import { Router } from 'express';
import * as settingsController from '@controllers/settings.controller';
import { authenticate, authorize } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { settingsCategoryParamSchema } from '@validators/settings.validators';

const router = Router();

router.use(authenticate);

router.get('/', settingsController.getAll);
router.get('/:category', validate(settingsCategoryParamSchema, 'params'), settingsController.getCategory);

router.put('/:category', authorize('OWNER'), validate(settingsCategoryParamSchema, 'params'), settingsController.updateCategory);

export default router;
