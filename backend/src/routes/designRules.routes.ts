import { Router } from 'express';
import * as designRulesController from '@controllers/designRules.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import {
  createDesignRuleSchema,
  updateDesignRuleSchema,
  publishRulesSchema,
  listVersionsQuerySchema,
  compareVersionsQuerySchema,
} from '@validators/designRules.validators';

const router = Router();

router.use(authenticate);

// ---- Live preview & publish (specific paths, before the /:id catch-all) ----
router.get('/preview', requirePermission('design_rules:read'), designRulesController.previewDraft);
router.post('/publish', requirePermission('design_rules:write'), validate(publishRulesSchema), designRulesController.publishRules);
router.get('/live', requirePermission('design_rules:read'), designRulesController.getLiveVersion);

// ---- Version history (static paths like "compare" must be registered before "/:id") ----
router.get('/versions', requirePermission('design_rules:read'), validate(listVersionsQuerySchema, 'query'), designRulesController.listVersionHistory);
router.get('/versions/compare', requirePermission('design_rules:read'), validate(compareVersionsQuerySchema, 'query'), designRulesController.compareVersions);
router.get('/versions/:id', requirePermission('design_rules:read'), designRulesController.getVersion);
router.post('/versions/:id/restore', requirePermission('design_rules:write'), designRulesController.restoreVersion);
router.delete('/versions/:id', requirePermission('design_rules:write'), designRulesController.deleteVersion);

// ---- Draft rule CRUD ----
router.get('/', requirePermission('design_rules:read'), designRulesController.listDesignRules);
router.post('/', requirePermission('design_rules:write'), validate(createDesignRuleSchema), designRulesController.createDesignRule);
router.get('/:id', requirePermission('design_rules:read'), designRulesController.getDesignRule);
router.patch('/:id', requirePermission('design_rules:write'), validate(updateDesignRuleSchema), designRulesController.updateDesignRule);
router.delete('/:id', requirePermission('design_rules:write'), designRulesController.deleteDesignRule);

export default router;
