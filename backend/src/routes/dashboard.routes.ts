import { Router } from 'express';
import * as dashboardController from '@controllers/dashboard.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { recentActivityQuerySchema } from '@validators/dashboard.validators';

const router = Router();

router.use(authenticate);

// Aggregate counts only — no PII beyond what analytics:read already gates elsewhere.
router.get('/stats', requirePermission('analytics:read'), dashboardController.getStats);

// Includes per-event user/IP/user-agent, so it's gated the same as the Logs module.
router.get('/recent-activity', requirePermission('logs:read'), validate(recentActivityQuerySchema, 'query'), dashboardController.getRecentActivity);

// Combines both — requires the stricter of the two.
router.get('/overview', requirePermission('logs:read'), dashboardController.getOverview);

export default router;
