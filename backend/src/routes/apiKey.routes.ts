import { Router } from 'express';
import * as apiKeyController from '@controllers/apiKey.controller';
import { authenticate, authorize } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { createApiKeySchema, rotateApiKeySchema, listApiKeysQuerySchema } from '@validators/apiKey.validators';

const router = Router();

router.use(authenticate);
router.use(authorize('OWNER'));

router.get('/', validate(listApiKeysQuerySchema, 'query'), apiKeyController.list);
router.post('/deactivate-all', apiKeyController.deactivateAll);
router.post('/', validate(createApiKeySchema), apiKeyController.create);
router.post('/:id/rotate', validate(rotateApiKeySchema), apiKeyController.rotate);
router.post('/:id/activate', apiKeyController.activate);
router.post('/:id/deactivate', apiKeyController.deactivate);
router.delete('/:id', apiKeyController.remove);

export default router;
