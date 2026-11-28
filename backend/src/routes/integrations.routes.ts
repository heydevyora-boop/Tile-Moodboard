import { Router } from 'express';
import * as integrationsController from '@controllers/integrations.controller';
import { authenticate, authorize } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { erpAuth } from '@middlewares/erpAuth';
import { erpCatalogFeedQuerySchema, catalogReadinessQuerySchema } from '@validators/catalogHierarchy.validators';

const router = Router();

/*
 * PUBLIC (no CASA user session), same reasoning as the Google callback
 * below: an external reader has no JWT to present. Gated instead by the
 * x-erp-key shared secret -- see erpAuth.ts. Read-only; writes nothing,
 * connects nowhere.
 */
router.get(
  '/erp/catalog-feed',
  erpAuth,
  validate(erpCatalogFeedQuerySchema, 'query'),
  integrationsController.getErpCatalogFeedHandler,
);

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

/*
 * OWNER-gated, same as every other status report above -- a human
 * reviewing data quality before a future ERP sync, not the ERP itself.
 * Read-only: validates and reconciles, never repairs or reassigns.
 */
router.get(
  '/erp/catalog-readiness',
  validate(catalogReadinessQuerySchema, 'query'),
  integrationsController.getCatalogReadinessHandler,
);

/*
 * Step 9, the other direction: OWNER-gated, same as every other
 * report above -- a human reviewing what the ERP has against what
 * CASA already has, before any future sync. Read-only: reads from
 * the ERP over HTTP and from CASA's own database, writes to
 * neither.
 */
router.get(
  '/erp/catalog-preview',
  integrationsController.getErpCatalogPreviewHandler,
);

export default router;
