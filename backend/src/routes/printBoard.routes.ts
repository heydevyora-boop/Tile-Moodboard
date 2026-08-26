import { Router } from 'express';
import * as printBoardController from '@controllers/printBoard.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { printBoardExportRateLimiter } from '@middlewares/rateLimiters';
import {
  generatePrintBoardSchema,
  updatePrintBoardSchema,
  listPrintBoardsQuerySchema,
  createPrintBoardTemplateSchema,
  exportHistoryQuerySchema,
} from '@validators/printBoard.validators';

const router = Router();

router.use(authenticate);

// Templates and export-history — static paths registered before the "/:id" catch-all.
router.get('/templates', requirePermission('print_boards:read'), printBoardController.listTemplates);
router.post('/templates', requirePermission('print_boards:write'), validate(createPrintBoardTemplateSchema), printBoardController.createTemplate);
router.delete('/templates/:id', requirePermission('print_boards:write'), printBoardController.deleteTemplate);
router.get('/export-history', requirePermission('print_boards:read'), validate(exportHistoryQuerySchema, 'query'), printBoardController.exportHistory);

router.get('/', requirePermission('print_boards:read'), validate(listPrintBoardsQuerySchema, 'query'), printBoardController.list);
router.post('/generate', requirePermission('print_boards:write'), printBoardExportRateLimiter, validate(generatePrintBoardSchema), printBoardController.generate);
router.post('/generate-async', requirePermission('print_boards:write'), printBoardExportRateLimiter, validate(generatePrintBoardSchema), printBoardController.generateAsync);
router.get('/:id', requirePermission('print_boards:read'), printBoardController.getOne);
router.patch('/:id', requirePermission('print_boards:write'), validate(updatePrintBoardSchema), printBoardController.update);
router.delete('/:id', requirePermission('print_boards:write'), printBoardController.remove);
router.post('/:id/share', requirePermission('print_boards:write'), printBoardController.shareToDrive);

export default router;
