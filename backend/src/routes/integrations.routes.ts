import { Router } from 'express';
import * as integrationsController from '@controllers/integrations.controller';
import { authenticate, authorize } from '@middlewares/auth';

const router = Router();

/*
 * PUBLIC, and before the guards below on purpose.
 *
 * Google sends the owner's browser back here as a top-level
 * navigation, which carries no Authorization header -- behind
 * authenticate() it could never succeed. What replaces the guard is
 * the signed `state` the flow started with: the callback refuses
 * anything it did not issue, and an issued one expires in fifteen
 * minutes.
 *
 * THE EXACT URL to register in the Google Cloud console as an
 * Authorized redirect URI:
 *
 *   <BACKEND_PUBLIC_URL>/api/v1/integrations/google/callback
 */
router.get('/google/callback', integrationsController.googleOAuthCallback);

router.use(authenticate);
router.use(authorize('OWNER'));

router.get('/gemini/status', integrationsController.getGeminiStatus);
router.post('/gemini/test', integrationsController.testGeminiConnection);
router.get('/drive/status', integrationsController.getDriveStatus);
router.post('/drive/test', integrationsController.testDriveConnection);

// The real end-to-end proof: folder, Theme/Room tree, one upload, a
// public link, and the upload removed again.
router.post('/drive/self-test', integrationsController.runDriveSelfTest);

// Connecting the studio's own Google account -- the only credential a
// personal Gmail can use for Drive. See googleOAuth.service.ts.
router.get('/google/status', integrationsController.getGoogleOAuthStatus);
router.post('/google/connect', integrationsController.startGoogleOAuth);
router.post('/google/disconnect', integrationsController.disconnectGoogleOAuth);
router.post('/google/picker-token', integrationsController.getGooglePickerToken);
router.get('/python-ai/status', integrationsController.getPythonAiStatus);
router.post('/python-ai/test', integrationsController.testPythonAiConnection);

export default router;
