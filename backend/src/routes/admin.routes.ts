import { Router } from 'express';
import * as adminController from '@controllers/admin.controller';
import { authenticate, authorize } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { logsQuerySchema } from '@validators/logs.validators';
import { loginHistoryQuerySchema, errorLogsQuerySchema, catalogLogsQuerySchema } from '@validators/loggingSystem.validators';
import { jobsQuerySchema } from '@validators/jobs.validators';

const router = Router();

router.use(authenticate);
router.use(authorize('OWNER'));

router.get('/logs', validate(logsQuerySchema, 'query'), adminController.getLogs);
router.get('/logs/actions', adminController.getLogActions);
router.get('/logs/login-history', validate(loginHistoryQuerySchema, 'query'), adminController.getLoginHistory);
router.get('/logs/errors', validate(errorLogsQuerySchema, 'query'), adminController.getErrorLogs);
router.get('/logs/catalog', validate(catalogLogsQuerySchema, 'query'), adminController.getCatalogLogs);
router.get('/logs/mood-boards', validate(logsQuerySchema, 'query'), adminController.getMoodBoardLogs);
router.get('/logs/print-boards', validate(logsQuerySchema, 'query'), adminController.getPrintBoardLogs);
router.get('/analytics', adminController.getAnalytics);
router.get('/queues', adminController.getQueueStats);
router.get('/queues/jobs', validate(jobsQuerySchema, 'query'), adminController.getJobs);
router.post('/queues/jobs/:id/retry', adminController.retryJob);

export default router;
