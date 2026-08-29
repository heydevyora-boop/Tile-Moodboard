import { Router } from 'express';
import * as integrationsController from '@controllers/integrations.controller';
import { authenticate, authorize } from '@middlewares/auth';

const router = Router();

router.use(authenticate);
router.use(authorize('OWNER'));

router.get('/gemini/status', integrationsController.getGeminiStatus);
router.post('/gemini/test', integrationsController.testGeminiConnection);
router.get('/drive/status', integrationsController.getDriveStatus);
router.post('/drive/test', integrationsController.testDriveConnection);
router.get('/python-ai/status', integrationsController.getPythonAiStatus);
router.post('/python-ai/test', integrationsController.testPythonAiConnection);

export default router;
